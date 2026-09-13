/**
 * LLM trace — every generation that funnels through the model layer prints
 * its full request and outcome to the engine console, colored — the
 * outgoing JSON payload, tool calls as they execute, the complete
 * output text, and tokens + cost. Anyone running the engine can debug a
 * prompt straight from the terminal:
 *
 *   ╭─ LLM ▸ app:roleplay/engine · c_mocklab/mock-rp-8b via mocklab · 3 msgs · ~412t
 *   │ ── request ─────────────────────────────────────────────
 *   │ {
 *   │   "model": "mock-rp-8b",
 *   │   "temperature": 0.7,
 *   │   "stream": true,
 *   │   "messages": [
 *   │     {"role":"system","content":"Write Ember's next reply…"},
 *   │     {"role":"user","content":"tell me about your lantern"}
 *   │   ]
 *   │ }
 *   │ ⚙ tool round 1 · roll_dice {"sides":"20"} → "20"
 *   │ ── output ──────────────────────────────────────────────
 *   │ *The lantern gutters. She turns it in her hands…*
 *   ╰─ finished in 1.2s · in 412t out 56t · $0.0001
 *
 * Errors print the full failure in red. Works for ANY app/plugin/agent —
 * callers tag `source` on the GenerateRequest. ANSI colors only when stdout
 * is a TTY (piped/redirected logs stay plain).
 */
const TTY = typeof process !== "undefined" && Boolean(process.stdout?.isTTY);
const c = TTY
  ? {
      dim: "\x1b[2m", bold: "\x1b[1m", cyan: "\x1b[36m", green: "\x1b[32m",
      yellow: "\x1b[33m", red: "\x1b[31m", gray: "\x1b[90m", magenta: "\x1b[35m", reset: "\x1b[0m",
    }
  : { dim: "", bold: "", cyan: "", green: "", yellow: "", red: "", gray: "", magenta: "", reset: "" };

const est = (s: string): number => Math.ceil(s.length / 4);
const bar = (label: string): string =>
  `${c.gray}│ ${c.dim}── ${label} ${"─".repeat(Math.max(3, 46 - label.length))}${c.reset}`;
const row = (line: string): string => `${c.gray}│${c.reset} ${line}`;

export interface TracePayload {
  /** resolved "provider/model-id" — the ref that actually runs */
  model: string;
  /** human connection name, when the provider is a named connection */
  connection?: string | null;
  /** effective generation options handed to the provider layer */
  params: Record<string, unknown>;
  systemPrompt?: string;
  /** text-completion transports: the flattened prompt replaces messages */
  prompt?: string;
  messages?: { role: string; content: string }[];
}

export function llmLogRequest(source: string | undefined, p: TracePayload): void {
  const [provider, ...rest] = p.model.split("/");
  const via = p.connection ? ` ${c.gray}via ${c.reset}${c.bold}${p.connection}${c.reset}` : "";
  const tokens = p.prompt != null
    ? est(p.prompt)
    : (p.systemPrompt ? est(p.systemPrompt) : 0) + (p.messages ?? []).reduce((n, m) => n + est(m.content), 0);
  const head =
    `${c.bold}${c.cyan}╭─ LLM${c.reset}${c.gray} ▸ ${source ?? "engine"}${c.reset} · ` +
    `${c.bold}${provider}/${c.cyan}${rest.join("/")}${c.reset}${via}` +
    `${c.gray} · ${p.prompt != null ? "prompt" : `${(p.messages?.length ?? 0)} msgs`} · ~${tokens}t${c.reset}`;

  // one message per line, role+content compact — readable AND valid JSON
  const wire: { role: string; content: string }[] = [
    ...(p.systemPrompt ? [{ role: "system", content: p.systemPrompt }] : []),
    ...(p.messages ?? []).filter((m) => m.role !== "system"),
  ];
  const body: string[] = [`  "model": ${JSON.stringify(rest.join("/"))},`];
  for (const [k, v] of Object.entries(p.params)) body.push(`  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
  body.push(`  "stream": true,`);
  body.push(`  "messages": [`);
  wire.forEach((m, i) => body.push(`    ${JSON.stringify(m)}${i < wire.length - 1 ? "," : ""}`));
  body.push(`  ]`);

  console.log([head, bar("request"), row(c.gray + "{" + c.reset), ...body.map((l) => row(c.gray + l + c.reset)), row(c.gray + "}" + c.reset)].join("\n"));
}

export function llmLogTool(
  round: number,
  name: string,
  args: Record<string, unknown>,
  result: { text: string; isError?: boolean },
): void {
  const outcome = result.isError ? `${c.red}✗ ${result.text.slice(0, 160)}` : c.green + result.text.slice(0, 160);
  console.log(
    row(`${c.magenta}⚙ tool round ${round}${c.reset} · ${c.bold}${name}${c.reset} ${JSON.stringify(args)} ${c.gray}→${c.reset} ${outcome}${c.reset}`),
  );
}

export function llmLogResult(
  source: string | undefined,
  model: string,
  ms: number,
  res: { text: string; reasoning?: string; usage?: { input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number; costTotal?: number } },
): void {
  const u = res.usage ?? {};
  const cache =
    (u.cacheRead ?? 0) > 0 || (u.cacheWrite ?? 0) > 0
      ? ` · cache ${u.cacheRead ?? 0}r/${u.cacheWrite ?? 0}w`
      : "";
  const think = u.reasoning != null ? ` · think ${u.reasoning}t` : "";
  const cost = u.costTotal ? ` · $${u.costTotal.toFixed(4)}` : "";
  const lines = res.text.split("\n");
  const out = [
    bar("output"),
    ...(lines.length === 1 && lines[0] === "" ? [row(c.dim + "(empty response)" + c.reset)] : lines.map((l) => row(l))),
  ];
  if (res.reasoning) {
    out.unshift(bar("thinking"), ...res.reasoning.split("\n").slice(0, 8).map((l) => row(c.dim + l + c.reset)));
  }
  console.log(
    [
      ...out,
      `${c.gray}╰─${c.reset} ${c.green}finished${c.reset} ${c.dim}${source ?? "engine"} · ${model} in ${(ms / 1000).toFixed(1)}s${c.reset}` +
        ` · ${c.dim}in ${u.input ?? "?"}t out ${u.output ?? "?"}t${cache}${think}${cost} · ${res.text.length} chars${c.reset}`,
      "",
    ].join("\n"),
  );
}

export function llmLogError(source: string | undefined, model: string, ms: number, cause: unknown): void {
  const msg = cause instanceof Error ? `${cause.message}\n${cause.stack ?? ""}` : String(cause);
  console.log(
    `${c.red}╰─ ✗ FAILED${c.reset} ${c.red}${source ?? "engine"} · ${model} after ${(ms / 1000).toFixed(1)}s${c.reset}\n${c.red}  ${msg}${c.reset}`,
  );
}
