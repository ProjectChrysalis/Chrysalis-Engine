import { SimpleImageAttachmentAdapter, type AttachmentAdapter, type Attachment, type PendingAttachment, type CompleteAttachment } from "@assistant-ui/react"

interface UploadedFile { id: string; name: string; path: string; readable?: string; notice?: string }
const imageAdapter = new SimpleImageAttachmentAdapter()

export class AgentAttachmentAdapter implements AttachmentAdapter {
  accept = "*"
  private uploaded = new Map<string, UploadedFile>()
  private removed = new Set<string>()

  constructor(private request: (url: string, init: RequestInit) => Promise<Response> = (url, init) => globalThis.fetch(url, init)) {}

  async *add({ file }: { file: File }): AsyncGenerator<PendingAttachment, void> {
    const mime = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" } as Record<string, string>)[file.name.split(".").pop()?.toLowerCase() ?? ""]
    if (!file.type && mime) file = new File([file], file.name, { type: mime })
    if (/^image\/(png|jpeg|gif|webp)$/.test(file.type)) {
      yield await imageAdapter.add({ file })
      return
    }
    const id = crypto.randomUUID()
    const attachment = { id, type: "document", name: file.name, contentType: file.type, file }
    yield { ...attachment, status: { type: "running", reason: "uploading", progress: 0 } }
    try {
      if (file.size > 64 * 1024 ** 2) throw new Error("File exceeds 64 MB")
      const response = await this.request(`/v1/agent/attachments?name=${encodeURIComponent(file.name)}`, {
        method: "POST", headers: { "content-type": "application/octet-stream" }, body: file,
      })
      const result = await response.json() as UploadedFile & { error?: string }
      if (!response.ok) throw new Error(result.error || `Upload failed (${response.status})`)
      if (this.removed.delete(id)) {
        await this.request(`/v1/agent/attachments/${result.id}`, { method: "DELETE" })
        return
      }
      this.uploaded.set(id, result)
      yield { ...attachment, status: { type: "requires-action", reason: "composer-send" } }
    } catch (error) {
      if (this.removed.delete(id)) return
      yield { ...attachment, status: { type: "incomplete", reason: "error", message: error instanceof Error ? error.message : String(error) } }
    }
  }

  async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    if (attachment.type === "image") return imageAdapter.send(attachment)
    const file = this.uploaded.get(attachment.id)
    if (!file) throw new Error("File upload did not complete")
    this.uploaded.delete(attachment.id)
    const url = `/v1/agent/attachments/${file.id}/${encodeURIComponent(file.name)}`
    const label = file.name.replace(/([\\\[\]])/g, "\\$1")
    const text = `Attached file: [${label}](${url})\nOriginal path: ${file.path}\n${file.readable ? `Read its text with read_file: ${file.readable}` : "Use tools to inspect the original file."}${file.notice ? `\n${file.notice}` : ""}`
    return { ...attachment, status: { type: "complete" }, content: [{ type: "text", text }] }
  }

  async remove(attachment: Attachment): Promise<void> {
    const file = this.uploaded.get(attachment.id)
    if (!file) {
      if (attachment.type !== "image" && attachment.status.type !== "complete") this.removed.add(attachment.id)
      return
    }
    const response = await this.request(`/v1/agent/attachments/${file.id}`, { method: "DELETE" })
    if (!response.ok) throw new Error(`Could not remove file (${response.status})`)
    this.uploaded.delete(attachment.id)
  }
}
