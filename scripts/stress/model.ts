/** An OpenAI-compatible model that streams a long markdown reply in small deltas. */
const WORDS = 'She *leans* closer, voice low. "You came back," she says, and the lantern **flickers** as rain needles the window.\n\n'.split(/(?<= )/);

export function startModel(settings: { deltas: number; delayMs: number }): { port: number; stop(): void } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "stress-model", object: "model" }] });
      if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
      const { deltas, delayMs } = settings;
      const enc = new TextEncoder();
      const chunk = (delta: object, finish: string | null, extra: object = {}) =>
        enc.encode(`data: ${JSON.stringify({ id: "stress", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`);
      let i = 0;
      const stream = new ReadableStream({
        async pull(ctrl) {
          if (i >= deltas) {
            ctrl.enqueue(chunk({}, "stop", { usage: { prompt_tokens: 1000, completion_tokens: deltas, total_tokens: 1000 + deltas } }));
            ctrl.enqueue(enc.encode("data: [DONE]\n\n"));
            ctrl.close();
            return;
          }
          if (delayMs) await Bun.sleep(delayMs);
          ctrl.enqueue(chunk({ content: WORDS[i++ % WORDS.length] }, null));
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
    },
  });
  return { port: server.port ?? 0, stop: () => server.stop(true) };
}
