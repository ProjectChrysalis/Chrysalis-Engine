import { afterEach, describe, it, expect, beforeEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { UserModelService } from "../src/models.js";
import { defaultInstanceConfig } from "../src/config.js";
import { bootstrapUserDir } from "../src/paths.js";

let dataDir: string;
let server: http.Server;
let received: { url: string; body: Record<string, unknown> } | null = null;

/** Wait for something the engine does out of band (an abort travels on its own
 *  connection), so the assertion is about the request, not the timing. */
const untilTrue = async (check: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
};

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "textcomp-test-"));
  server = http.createServer((req, res) => {
    let buf = "";
    req.on("data", (c) => { buf += c; });
    req.on("end", () => {
      const body = buf ? (JSON.parse(buf) as Record<string, unknown>) : {};
      received = { url: req.url ?? "", body };
      if (req.method === "GET" && req.url?.includes("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "tiny-story" }] }));
        return;
      }
      // SSE text-completion stream; the </think> tag is split across events
      // on purpose — the incremental splitter must survive chunk boundaries
      const events = [
        JSON.stringify({ choices: [{ text: "<think>plan" }] }),
        JSON.stringify({ choices: [{ text: " briefly</think>Ember " }] }),
        JSON.stringify({ choices: [{ text: "waves." }] }),
        JSON.stringify({ usage: { prompt_tokens: 17, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3 } } }),
        "[DONE]",
      ];
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const e of events) res.write(`data: ${e}\n\n`);
      res.end();
    });
  });
});

afterEach(() => {
  try { server.close(); } catch { /* already closed */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* watcher races */ }
});

describe("openai-text connections (local serving stack protocol)", () => {
  it("flattens chat to a prompt, streams deltas, splits think tags, maps usage", async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;

    const p = bootstrapUserDir(dataDir, "alice");
    fs.writeFileSync(
      p.connections,
      JSON.stringify({
        connections: {
          c_local: { name: "Local stack", api: "openai-text", baseUrl: `http://127.0.0.1:${port}/v1`, models: [{ id: "tiny-story" }] },
        },
      }),
    );
    // a saved key rides along as the bearer
    fs.writeFileSync(path.join(p.auth), JSON.stringify({ c_local: { type: "api_key", key: "local-placeholder", boundBaseUrl: `http://127.0.0.1:${port}/v1` } }));
    const svc = new UserModelService("alice", p, defaultInstanceConfig());

    const deltas: string[] = [];
    const thinks: string[] = [];
    const result = await svc.generate(
      {
        model: "c_local/tiny-story",
        systemPrompt: "You are a narrator.",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
          { role: "user", content: "continue" },
        ],
        assistantPrefill: "Emb",
        reasoningTags: { open: "<think>", close: "</think>" },
        presetParams: { temperature: 0.7, max_tokens: 128, params: { top_k: 40, min_p: 0.05 } },
      },
      (d) => deltas.push(d),
      (t) => thinks.push(t),
    );

    expect(received?.url).toBe("/v1/completions");
    const sent = received!.body;
    expect(sent.model).toBe("tiny-story");
    expect(sent.temperature).toBe(0.7);
    expect(sent.max_tokens).toBe(128);
    expect(sent.top_k).toBe(40);
    expect(sent.min_p).toBe(0.05);
    expect((sent.stop as string[])).toContain("<|im_end|>");
    // no template and an unknown model name: ChatML. System first, turns in
    // order, open assistant turn carrying the prefill
    const prompt = sent.prompt as string;
    expect(prompt).toContain("<|im_start|>system\nYou are a narrator.<|im_end|>");
    expect(prompt).toContain("<|im_start|>user\nhello<|im_end|>");
    expect(prompt).toContain("<|im_start|>assistant\nhi<|im_end|>");
    expect(prompt.endsWith("<|im_start|>assistant\nEmb")).toBe(true);

    // think content streamed through onThinking despite the tag crossing
    // chunk boundaries; the answer through onDelta
    expect(thinks.join("")).toBe("plan briefly");
    expect(deltas.join("")).toBe("Ember waves.");
    expect(result.text).toBe("Ember waves.");
    expect(result.reasoning).toBe("plan briefly");
    expect(result.usage).toMatchObject({ input: 17, output: 5, cacheRead: 3, costTotal: 0 });
    expect(result.model).toBe("c_local/tiny-story");
  }, 20_000);

  it("refuses non-loopback plain-http endpoints (same policy as embeddings)", async () => {
    const p = bootstrapUserDir(dataDir, "bob");
    fs.writeFileSync(
      p.connections,
      JSON.stringify({
        connections: {
          c_remote: { name: "Remote", api: "openai-text", baseUrl: "http://text.example:8000/v1", models: [{ id: "m" }] },
        },
      }),
    );
    fs.writeFileSync(path.join(p.auth), JSON.stringify({ c_remote: { type: "api_key", key: "x", boundBaseUrl: "http://text.example:8000/v1" } }));
    const svc = new UserModelService("bob", p, defaultInstanceConfig());
    await expect(
      svc.generate({ model: "c_remote/m", messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/https|localhost/);
  }, 20_000);
});

describe("text completion prompt formats", () => {
  it("writes a chat in the model's markers and ends on the open assistant turn", async () => {
    const { promptFormatById, renderPrompt, stopStrings } = await import("../src/providers/prompt-formats.js");
    const llama3 = promptFormatById("llama3")!;
    const prompt = renderPrompt(llama3, "Narrate.", [
      { role: "system", content: "World: a harbor." },
      { role: "user", content: "hello" },
      { role: "system", content: "[Keep it short]" },
      { role: "assistant", content: "The gulls" },
    ]);
    expect(prompt).toBe(
      "<|start_header_id|>system<|end_header_id|>\n\nNarrate.\n\nWorld: a harbor.<|eot_id|>" +
        "<|start_header_id|>user<|end_header_id|>\n\nhello<|eot_id|>" +
        "<|start_header_id|>system<|end_header_id|>\n\n[Keep it short]<|eot_id|>" +
        "<|start_header_id|>assistant<|end_header_id|>\n\nThe gulls",
    );
    expect(stopStrings(llama3)).toEqual(["<|eot_id|>", "<|start_header_id|>user<|end_header_id|>", "<|start_header_id|>system<|end_header_id|>"]);

    // no system role: a mid-chat system entry becomes a user turn, and the
    // generation header loses its trailing space
    const mistral = promptFormatById("mistral-v2")!;
    expect(renderPrompt(mistral, undefined, [{ role: "user", content: "hi" }, { role: "system", content: "note" }])).toBe("[INST] hi[INST] note[/INST]");
    // a prefill starts the open turn when the chat ends on the user
    expect(renderPrompt(promptFormatById("chatml")!, undefined, [{ role: "user", content: "hi" }], "Emb")).toBe("<|im_start|>user\nhi<|im_end|>\n<|im_start|>assistant\nEmb");
  });

  it("names the format from a chat template, then from the model name", async () => {
    const { formatFromTemplate, formatFromModelName } = await import("../src/providers/prompt-formats.js");
    expect(formatFromTemplate("{{ '<|start_header_id|>' + message['role'] + '<|end_header_id|>\n\n' }}")).toBe("llama3");
    expect(formatFromTemplate("{{ '[SYSTEM_PROMPT]' + system + '[/SYSTEM_PROMPT]' }}{{ '[INST]' + m + '[/INST]' }}")).toBe("mistral-v7-tekken");
    expect(formatFromTemplate("{{ '[INST] ' + m + '[/INST]' }}")).toBe("mistral-v2");
    expect(formatFromTemplate("{{bos_token}}{{ '<start_of_turn>' + role }}")).toBe("gemma");
    expect(formatFromTemplate("{{'<|im_start|>' + message['role'] + '\n'}}")).toBe("chatml");
    expect(formatFromTemplate("")).toBeNull();
    expect(formatFromModelName("Meta-Llama-3.1-8B-Instruct-Q4_K_M")).toBe("llama3");
    expect(formatFromModelName("koboldcpp/Mistral-Nemo-12B")).toBe("mistral-v3-tekken");
    expect(formatFromModelName("Qwen2.5-14B")).toBe("chatml");
    expect(formatFromModelName("mystery-model")).toBeNull();
  });

  it("validates a connection's choice", async () => {
    const { validatePromptFormatInput } = await import("../src/connections.js");
    expect(validatePromptFormatInput(undefined, undefined)).toEqual({ ok: true, value: { promptFormat: "auto" } });
    expect(validatePromptFormatInput("gemma", undefined)).toEqual({ ok: true, value: { promptFormat: "gemma" } });
    expect(validatePromptFormatInput("nope", undefined).ok).toBe(false);
    expect(validatePromptFormatInput("custom", { userPrefix: 1 }).ok).toBe(false);
    expect(validatePromptFormatInput("custom", { userPrefix: "U: ", assistantPrefix: "A: " })).toEqual({
      ok: true,
      value: { promptFormat: "custom", promptFormatCustom: { systemPrefix: "", systemSuffix: "", userPrefix: "U: ", userSuffix: "", assistantPrefix: "A: ", assistantSuffix: "", systemAsUser: false } },
    });
  });

  it("matches the loaded model's template, and a request or connection choice wins over it", async () => {
    const prompts: string[] = [];
    let propsHits = 0;
    const local = http.createServer((req, res) => {
      let buf = "";
      req.on("data", (c) => { buf += c; });
      req.on("end", () => {
        if (req.url === "/props") {
          propsHits++;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ chat_template: "{{ '<start_of_turn>' + role + '\n' + content + '<end_of_turn>\n' }}" }));
          return;
        }
        prompts.push((JSON.parse(buf) as { prompt: string }).prompt);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ choices: [{ text: "ok" }] })}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>((r) => local.listen(0, "127.0.0.1", r));
    try {
      const base = `http://127.0.0.1:${(local.address() as AddressInfo).port}/v1`;
      const p = bootstrapUserDir(dataDir, "formats");
      const write = (def: Record<string, unknown>) =>
        fs.writeFileSync(p.connections, JSON.stringify({ connections: { c_text: { name: "Local", api: "openai-text", baseUrl: base, models: [{ id: "some-finetune" }], ...def } } }));
      write({});
      const svc = new UserModelService("formats", p, defaultInstanceConfig());
      const chat = [{ role: "user" as const, content: "hi" }];

      expect(await svc.resolvePromptFormat("c_text", "some-finetune")).toMatchObject({ id: "gemma", source: "template" });
      await svc.generate({ model: "c_text/some-finetune", messages: chat });
      expect(prompts.at(-1)).toBe("<start_of_turn>user\nhi<end_of_turn>\n<start_of_turn>model\n");
      // the answer is remembered rather than asked again per request
      expect(propsHits).toBe(1);

      await svc.generate({ model: "c_text/some-finetune", messages: chat, promptFormat: { userPrefix: "U: ", userSuffix: "\n", assistantPrefix: "A:", assistantSuffix: "\n", systemPrefix: "", systemSuffix: "", systemAsUser: true } });
      expect(prompts.at(-1)).toBe("U: hi\nA:");

      write({ promptFormat: "alpaca" });
      const pinned = new UserModelService("formats", p, defaultInstanceConfig());
      await pinned.generate({ model: "c_text/some-finetune", messages: chat });
      expect(prompts.at(-1)).toBe("### Instruction:\nhi\n\n### Response:\n");
      expect(await pinned.resolvePromptFormat("c_text", "some-finetune", "auto")).toMatchObject({ id: "gemma", source: "template" });
    } finally {
      local.closeAllConnections();
      local.close();
    }
  }, 20_000);
});

describe("local model servers", () => {
  it("knows a local address from a public one", async () => {
    const { isLocalEndpoint } = await import("../src/providers/custom.js");
    for (const url of ["http://localhost:5001/v1", "http://127.0.0.1:8080", "http://[::1]:11434/v1", "http://192.168.1.50:5001/v1", "http://10.0.0.2:8000/v1", "http://gaming-pc:5001/v1", "http://desktop.local:1234/v1"]) {
      expect(isLocalEndpoint(url), url).toBe(true);
    }
    for (const url of ["https://api.openai.com/v1", "http://text.example:8000/v1", "http://8.8.8.8/v1", "http://169.254.169.254/latest", "not a url"]) {
      expect(isLocalEndpoint(url), url).toBe(false);
    }
  });

  it("a keyless server lists its model with the loaded context size, and Stop tells it to abort", async () => {
    const hits: { method: string; url: string; auth: string | undefined }[] = [];
    let release: (() => void) | null = null;
    const local = http.createServer((req, res) => {
      hits.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization });
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "koboldcpp/Mistral-Nemo-12B" }] }));
      } else if (req.url === "/props") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ default_generation_settings: { n_ctx: 16384 } }));
      } else if (req.url === "/api/extra/abort") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ success: "true" }));
        release?.();
      } else {
        // a reply that never finishes on its own, like a long generation
        req.resume();
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "The" } }] })}\n\n`);
        release = () => res.end();
      }
    });
    await new Promise<void>((r) => local.listen(0, "127.0.0.1", r));
    try {
      const base = `http://127.0.0.1:${(local.address() as AddressInfo).port}/v1`;
      const p = bootstrapUserDir(dataDir, "kobold");
      fs.writeFileSync(p.connections, JSON.stringify({ connections: { c_kobold: { name: "KoboldCpp", api: "openai-completions", baseUrl: base, models: "auto" } } }));
      const svc = new UserModelService("kobold", p, defaultInstanceConfig());

      const listed = (await svc.available()).filter((m) => m.provider === "c_kobold");
      expect(listed.map((m) => [m.modelId, m.contextWindow])).toEqual([["koboldcpp/Mistral-Nemo-12B", 16384]]);
      // no key saved, so none is sent while listing
      expect(hits.find((h) => h.url === "/v1/models")?.auth).toBeUndefined();

      const controller = new AbortController();
      const run = svc.generate(
        { model: "c_kobold/koboldcpp/Mistral-Nemo-12B", messages: [{ role: "user", content: "hi" }], signal: controller.signal },
        () => controller.abort(),
      ).catch(() => null);
      await run;
      await untilTrue(() => hits.some((h) => h.method === "POST" && h.url === "/api/extra/abort"));
    } finally {
      local.closeAllConnections();
      local.close();
    }
  }, 20_000);
});
