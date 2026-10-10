export class BuildBodyError extends Error {
  constructor(message: string, readonly status: 400 | 413 | 415) { super(message); }
}

/** Bound the decoded size too, so compression cannot bypass upload limits. */
export async function readBuildBody(request: Request, cap: number): Promise<Uint8Array> {
  const encoding = request.headers.get("content-encoding")?.trim().toLowerCase();
  if (encoding && encoding !== "identity" && encoding !== "gzip") throw new BuildBodyError("unsupported content encoding", 415);
  if (Number(request.headers.get("content-length")) > cap) throw new BuildBodyError("build body too large", 413);
  if (!request.body) return new Uint8Array();
  const body = encoding === "gzip" ? request.body.pipeThrough(new DecompressionStream("gzip")) : request.body;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > cap) throw new BuildBodyError("build body too large", 413);
      chunks.push(value);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* already closed */ }
    if (error instanceof BuildBodyError) throw error;
    throw new BuildBodyError("invalid build body", 400);
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
