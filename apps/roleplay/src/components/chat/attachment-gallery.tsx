
import { useState } from "react"
import { FileText } from '@phosphor-icons/react'
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import type { Message } from "@/lib/types"
import { DEFAULT_AVATAR } from '../../lib/utils'

type Attachment = NonNullable<Message["attachments"]>[number]

/** Renders message attachments: image thumbnails (click for lightbox) and file
 *  chips. A generated picture shows large, with the prompt that drew it. */
export function AttachmentGallery({ attachments, picture = false }: { attachments?: Message["attachments"]; picture?: boolean }) {
  const [lightbox, setLightbox] = useState<Attachment | null>(null)
  if (!attachments || attachments.length === 0) return null

  const images = attachments.filter((a) => a.type.startsWith("image/") && a.url)
  const files = attachments.filter((a) => !a.type.startsWith("image/") || !a.url)

  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {images.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setLightbox(a)}
              className="overflow-hidden rounded-md border border-border transition-opacity hover:opacity-90"
              aria-label={`View image ${a.name}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={a.url || DEFAULT_AVATAR} alt={a.name} className={picture ? "max-h-96 max-w-full object-contain" : "max-h-40 max-w-60 object-cover"} />
            </button>
          ))}
        </div>
      )}
      {picture && images[0]?.name && (
        <p className="line-clamp-2 text-xs italic leading-relaxed text-muted-foreground" title={images[0].name}>{images[0].name}</p>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {files.map((a) => (
            <span key={a.id} className="flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs">
              <FileText className="size-3.5 text-muted-foreground" aria-hidden />
              {a.name}
            </span>
          ))}
        </div>
      )}
      <Dialog open={!!lightbox} onOpenChange={(v) => !v && setLightbox(null)}>
        <DialogContent className="max-w-3xl p-2">
          <DialogTitle className="sr-only">{lightbox?.name ?? "Image"}</DialogTitle>
          {lightbox?.url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={lightbox.url || DEFAULT_AVATAR} alt={lightbox.name} className="max-h-[80dvh] w-full rounded object-contain" />
          )}
          {picture && lightbox?.name && <p className="px-1 pb-1 text-xs text-muted-foreground">{lightbox.name}</p>}
        </DialogContent>
      </Dialog>
    </div>
  )
}
