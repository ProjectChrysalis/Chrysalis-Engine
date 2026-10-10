/** Compress large build saves before they cross a remote connection. */
export async function buildUpload(value: unknown): Promise<Pick<RequestInit, "body" | "headers">> {
  const body = JSON.stringify(value);
  if (body.length < 64 * 1024 || typeof CompressionStream === "undefined") return { body };
  const source = new Blob([body]);
  const compressed = await new Response(source.stream().pipeThrough(new CompressionStream("gzip"))).blob();
  return compressed.size < source.size ? { body: compressed, headers: { "content-encoding": "gzip" } } : { body };
}
