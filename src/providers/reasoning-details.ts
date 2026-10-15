/**
 * Signed reasoning on OpenAI-compatible streams. The signature of a model's
 * thinking can arrive as a reasoning_details delta of its own,
 * `{ type: "reasoning.text", signature, index }`, with no text field. The
 * stream parser only accepts a text entry that has text, so such a delta is
 * dropped: the stored reply keeps its thinking but not the signature, and the
 * next turn cannot hand the thinking back. This fetch gives such an
 * entry an empty text on the way in, so the signature joins the entry it
 * belongs to.
 */

type Fetch = typeof globalThis.fetch;

function repairLine(line: string): string {
  if (!line.startsWith("data:") || !line.includes("reasoning_details")) return line;
  let chunk: { choices?: { delta?: { reasoning_details?: unknown } }[] };
  try {
    chunk = JSON.parse(line.slice(5));
  } catch {
    return line;
  }
  let changed = false;
  for (const choice of chunk.choices ?? []) {
    const details = choice?.delta?.reasoning_details;
    if (!Array.isArray(details)) continue;
    for (const d of details as Record<string, unknown>[]) {
      if (d && d.type === "reasoning.text" && typeof d.text !== "string") {
        d.text = "";
        changed = true;
      }
    }
  }
  return changed ? `data: ${JSON.stringify(chunk)}` : line;
}

/** Rewrites an event stream line by line; anything else passes untouched. */
function repairStream(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(bytes, out) {
        pending += decoder.decode(bytes, { stream: true });
        const end = pending.lastIndexOf("\n");
        if (end < 0) return;
        const complete = pending.slice(0, end + 1);
        pending = pending.slice(end + 1);
        out.enqueue(encoder.encode(complete.split("\n").map(repairLine).join("\n")));
      },
      flush(out) {
        pending += decoder.decode();
        if (pending) out.enqueue(encoder.encode(repairLine(pending)));
      },
    }),
  );
}

/** Without a base, the global fetch as it stands at each call. */
export function reasoningDetailsFetch(base?: Fetch): Fetch {
  const wrapped = async (input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]): Promise<Response> => {
    const res = await (base ?? globalThis.fetch)(input, init);
    if (!res.body || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) return res;
    return new Response(repairStream(res.body), { status: res.status, statusText: res.statusText, headers: res.headers });
  };
  return Object.assign(wrapped, { preconnect: (...args: Parameters<Fetch["preconnect"]>) => (base ?? globalThis.fetch).preconnect(...args) }) as Fetch;
}
