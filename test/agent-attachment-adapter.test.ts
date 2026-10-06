import { expect, it } from "bun:test";
import { AgentAttachmentAdapter } from "../client-agent/src/attachments.js";

it("passes document references to the message and retains native image attachments", async () => {
  const adapter = new AgentAttachmentAdapter(async (url, init) => {
    expect(url).toContain("/v1/agent/attachments?name=notes.txt");
    expect(await (init.body as File).text()).toBe("notes");
    return Response.json({ id: "upload", name: "notes.txt", path: "attachments/upload/notes.txt", readable: "attachments/upload/text.txt" });
  });
  let file: Parameters<AgentAttachmentAdapter["send"]>[0] | undefined;
  for await (const state of adapter.add({ file: new File(["notes"], "notes.txt") })) file = state;
  expect(file?.status.type).toBe("requires-action");
  const sent = await adapter.send(file!);
  expect(JSON.stringify(sent.content)).toContain("read_file: attachments/upload/text.txt");
  expect(JSON.stringify(sent.content)).toContain("/v1/agent/attachments/upload/notes.txt");
  let image: Parameters<AgentAttachmentAdapter["send"]>[0] | undefined;
  for await (const state of adapter.add({ file: new File(["image"], "image.png") })) image = state;
  const result = await adapter.send(image!);
  expect(result.content[0]?.type).toBe("image");
  expect(JSON.stringify(result.content)).toContain("data:image/png;base64,");
});

it("cleans up a document removed before upload finishes", async () => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const requests: string[] = [];
  const adapter = new AgentAttachmentAdapter(async (url, init) => {
    requests.push(init.method + " " + url);
    if (init.method === "POST") { await wait; return Response.json({ id: "pending", name: "notes.txt", path: "attachments/pending/notes.txt" }); }
    return Response.json({ ok: true });
  });
  const upload = adapter.add({ file: new File(["notes"], "notes.txt") });
  const pending = await upload.next();
  const completion = upload.next();
  await adapter.remove(pending.value!);
  release();
  expect((await completion).done).toBe(true);
  expect(requests).toEqual(["POST /v1/agent/attachments?name=notes.txt", "DELETE /v1/agent/attachments/pending"]);
});
