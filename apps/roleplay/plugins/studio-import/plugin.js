/**
 * Studio Import — clean-room data import against public file formats.
 * Two entry points:
 *   POST /import/batch { cards?, worldInfo?, presets?, regex?, personas?, themes?, chats? }
 *     The UI cracks archives open in the browser (it can see PNG binaries,
 *     the sandbox cannot) and posts parsed JSON here.
 *   POST /import/zip   { zipBase64 }
 *     Text-entry archives (worlds, presets, regex, personas, chats, JSON
 *     cards) handled plugin-side via the kernel zip service; PNG binaries are
 *     reported for the /import/batch path.
 * Zero external code — formats from public documentation only.
 */

// ---------- PNG card extraction (own parser) ----------
function b64ToBytes(b64) {
  const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = String(b64).replace(/[^A-Za-z0-9+/]/g, "");
  const out = [];
  for (let i = 0; i < clean.length; i += 4) {
    const n = (table.indexOf(clean[i]) << 18) | (table.indexOf(clean[i + 1]) << 12) | ((table.indexOf(clean[i + 2]) & 63) << 6) | ((table.indexOf(clean[i + 3]) & 63) & 63);
    out.push((n >> 16) & 255);
    if (clean[i + 2] && clean[i + 2] !== "=") out.push((n >> 8) & 255);
    if (clean[i + 3] && clean[i + 3] !== "=") out.push(n & 255);
  }
  return out;
}
function latin1(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}
function extractCardFromPng(bytes) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) return null;
  let off = 8;
  while (off + 8 <= bytes.length) {
    const len = (bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3];
    const type = latin1(bytes.slice(off + 4, off + 8));
    if (type === "tEXt") {
      const data = bytes.slice(off + 8, off + 8 + len);
      const nul = data.indexOf(0);
      if (nul > 0) {
        const keyword = latin1(data.slice(0, nul));
        if (keyword === "ccv3" || keyword === "chara") {
          try {
            const json = latin1(b64ToBytes(latin1(data.slice(nul + 1))));
            return JSON.parse(json);
          } catch { /* next chunk */ }
        }
      }
    }
    off += 12 + len;
    if (type === "IEND") break;
  }
  return null;
}

// ---------- normalizers ----------
const slug = (s) =>
  String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "item";
// Backup zips carry chat titles only as slug filenames ("crossroads-at-dusk-fork-cXXXXXXXXXXXX"):
// recover a readable title by dropping the trailing engine id and un-slugging.
const unslugTitle = (s) => {
  const pretty = String(s)
    .replace(/-[a-z][a-z0-9]{9,}$/i, "")
    .replace(/-/g, " ")
    .replace(/(^|\s)\S/g, (m) => m.toUpperCase())
    .trim();
  return pretty || String(s);
};
const firstOf = (v) => (Array.isArray(v) ? String(v[0] || "") : v === undefined ? "" : String(v));

/** PNG tEXt chunk reader for embedded cards ("chara" base64 JSON, v2, or
 *  "ccv3" JSON) — mirrors what the browser-side importer does with .png
 *  cards, so backup zips with PNG characters import fully plugin-side. */
function cardFromPngBase64(b64) {
  try {
    const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    if (bin.length < 8 || bin[0] !== 0x89 || bin[1] !== 0x50) return null;
    let off = 8;
    const td = new TextDecoder();
    while (off + 12 <= bin.length) {
      const len = (bin[off] << 24) | (bin[off + 1] << 16) | (bin[off + 2] << 8) | bin[off + 3];
      const type = String.fromCharCode(bin[off + 4], bin[off + 5], bin[off + 6], bin[off + 7]);
      if (type === "tEXt" || type === "iTXt") {
        const body = bin.subarray(off + 8, off + 8 + len);
        const nul = body.indexOf(0);
        if (nul > 0) {
          const keyword = td.decode(body.subarray(0, nul));
          let payload = body.subarray(nul + 1);
          if (type === "iTXt") {
            // skip compression flag(1) + method(1) + lang NUL + translated NUL
            let q = nul + 1 + 2;
            q = body.indexOf(0, q) + 1;
            q = body.indexOf(0, q) + 1;
            payload = body.subarray(q);
          }
          if (keyword === "chara" || keyword === "ccv3") {
            const text = td.decode(payload);
            const json = JSON.parse(keyword === "chara" ? atob(text) : text);
            return json;
          }
        }
      }
      if (type === "IEND") break;
      off += 12 + len;
    }
  } catch {}
  return null;
}

/** Fields the normalizer owns; everything else on the card's data object is
 *  copied verbatim (the card spec forbids destroying unknown fields, and v3
 *  additions like nickname/assets/group_only_greetings must survive). */
const CARD_KNOWN_FIELDS = new Set([
  "name", "description", "personality", "scenario", "first_mes", "mes_example",
  "alternate_greetings", "creator_notes", "creatorcomment", "tags", "system_prompt",
  "post_history_instructions", "character_book", "avatar", "extensions",
]);

function normalizeCard(raw, avatarDataUrl) {
  if (!raw) return null;
  const d = raw && typeof raw.data === "object" && raw.data ? raw.data : raw;
  if (!d || typeof d.name !== "string" || !d.name) return null;
  // v3-only and unknown data fields ride the card verbatim
  const passthrough = {};
  for (const [k, v] of Object.entries(d)) {
    if (!CARD_KNOWN_FIELDS.has(k) && v !== undefined && v !== null) passthrough[k] = v;
  }
  const isV3 = raw.spec === "chara_card_v3" || d.spec === "chara_card_v3";
  return {
    spec: isV3 ? "chara_card_v3" : "chara_card_v2", name: d.name,
    ...(isV3 ? { spec_version: "3.0" } : {}),
    ...passthrough,
    description: firstOf(d.description), personality: firstOf(d.personality),
    scenario: firstOf(d.scenario), first_mes: firstOf(d.first_mes), mes_example: firstOf(d.mes_example),
    ...(Array.isArray(d.alternate_greetings) && d.alternate_greetings.length ? { alternate_greetings: d.alternate_greetings.map(String) } : {}),
    ...(typeof d.creator_notes === "string" && d.creator_notes ? { creator_notes: d.creator_notes } : {}),
    ...(typeof d.creatorcomment === "string" && d.creatorcomment ? { creator_notes: d.creatorcomment } : {}),
    ...(Array.isArray(d.tags) && d.tags.length ? { tags: d.tags.map(String) } : {}),
    ...(typeof d.system_prompt === "string" && d.system_prompt ? { system_prompt: d.system_prompt } : {}),
    ...(typeof d.post_history_instructions === "string" && d.post_history_instructions ? { post_history_instructions: d.post_history_instructions } : {}),
    ...(d.extensions && typeof d.extensions === "object" ? { extensions: d.extensions } : {}),
    ...(avatarDataUrl && typeof avatarDataUrl === "string" && avatarDataUrl.startsWith("data:") ? { avatar: avatarDataUrl } : {}),
  };
}

/** Card-spec v3 assets: {type, name, uri, ext}. `icon`+`main` is the default
 *  avatar, `emotion` entries are expression sprites. URIs: __asset:/embeded://
 *  point into the package (assetDict), ccdefault: is the source PNG, data:
 *  carries the bytes inline. Returns {avatar, expressions} with what could be
 *  resolved within size caps; unresolvable assets are skipped, never faked. */
function resolveCardAssets(card, assetDict, sourceAvatar) {
  const out = { avatar: null, expressions: [] };
  const assets = Array.isArray(card && card.assets) ? card.assets : [];
  const MAX_AVATAR = 900 * 1024;
  const MAX_EMOTION = 700 * 1024;
  for (const a of assets) {
    if (!a || typeof a !== "object" || typeof a.uri !== "string") continue;
    let url = null;
    if (a.uri.startsWith("__asset:") || a.uri.startsWith("embeded://")) {
      const b64 = assetDict[a.uri.replace(/^(?:__asset:|embeded:\/\/)/, "")];
      if (b64) url = "data:image/" + (a.ext === "webp" ? "webp" : a.ext === "jpeg" || a.ext === "jpg" ? "jpeg" : "png") + ";base64," + b64;
    } else if (a.uri === "ccdefault:") {
      url = sourceAvatar && sourceAvatar.startsWith("data:") ? sourceAvatar : null;
    } else if (a.uri.startsWith("data:")) {
      url = a.uri;
    }
    if (!url) continue;
    if (a.type === "icon" && a.name === "main") {
      if (url.length < MAX_AVATAR) out.avatar = url;
    } else if (a.type === "emotion" && typeof a.name === "string" && a.name && url.length < MAX_EMOTION) {
      out.expressions.push({ name: a.name, url });
    }
  }
  return out;
}

function keyList(k) {
  if (Array.isArray(k)) return k.filter((x) => typeof x === "string");
  if (typeof k === "string") return k.split(",").map((s) => s.trim()).filter(Boolean);
  return [];
}

/** Card-embedded books (the card-spec shape: flat entries with keys/
 *  secondary_keys/insertion_order + an extensions bag) rebuilt as world-info
 *  entries so the shared normalizer handles both. */
function embeddedBookToWorld(raw) {
  if (!raw || typeof raw !== "object") return null;
  const list = Array.isArray(raw.entries) ? raw.entries : raw.entries && typeof raw.entries === "object" ? Object.values(raw.entries) : null;
  if (!list || !list.length) return null;
  const entries = {};
  list.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const id = typeof entry.id === "number" ? entry.id : index;
    const x = entry.extensions && typeof entry.extensions === "object" ? entry.extensions : {};
    entries[id] = {
      uid: id,
      key: entry.keys, keysecondary: entry.secondary_keys,
      comment: entry.comment || entry.name || "",
      content: entry.content,
      constant: entry.constant === true, selective: entry.selective === true,
      order: typeof entry.insertion_order === "number" ? entry.insertion_order : 100,
      position: typeof x.position === "number" ? x.position : entry.position === "before_char" ? 0 : 1,
      disable: entry.enabled === false,
      excludeRecursion: x.exclude_recursion === true, preventRecursion: x.prevent_recursion === true,
      delayUntilRecursion: x.delay_until_recursion === true,
      probability: x.probability, useProbability: x.useProbability,
      depth: x.depth, selectiveLogic: x.selectiveLogic,
      group: x.group, groupOverride: x.group_override === true, groupWeight: x.group_weight,
      scanDepth: x.scan_depth, caseSensitive: x.case_sensitive,
      matchWholeWords: x.match_whole_words, useGroupScoring: x.use_group_scoring,
      automationId: x.automation_id, role: x.role,
      vectorized: x.vectorized === true,
      sticky: x.sticky, cooldown: x.cooldown, delay: x.delay,
      matchPersonaDescription: x.match_persona_description === true,
      matchCharacterDescription: x.match_character_description === true,
      matchCharacterPersonality: x.match_character_personality === true,
      matchScenario: x.match_scenario === true,
      ignoreBudget: x.ignore_budget === true,
    };
  });
  return { entries };
}

// world_info_position: 0 before-char, 1 after-char, 2 AN-top, 3 AN-bottom,
// 4 at-depth, 5 EM-top, 6 EM-bottom, 7 outlet. The studio engine models
// before/after/at_depth — everything else lands after the char block.
// entry role: 0 system, 1 user, 2 assistant.
function normalizeBook(raw, fallbackName) {
  if (!raw || !raw.entries || typeof raw.entries !== "object") return null;
  const name = typeof raw.name === "string" && raw.name ? raw.name : (fallbackName || "imported-book");
  const LOGIC = ["AND_ANY", "NOT_ALL", "NOT_ANY", "AND_ALL"];
  const ROLE = ["system", "user", "assistant"];
  const entries = [];
  for (const e of Object.values(raw.entries)) {
    if (!e || typeof e !== "object") continue;
    const content = typeof e.content === "string" ? e.content : "";
    if (!content.trim()) continue;
    const stPos = typeof e.position === "number" ? e.position : 0;
    const pos = stPos === 0 ? "before_char" : stPos === 4 ? "at_depth" : "after_char";
    // the comment doubles as the entry title/memo — without it every imported
    // entry renders with a blank name
    const comment = typeof e.comment === "string" ? e.comment.trim() : "";
    const num = (v) => (typeof v === "number" ? v : undefined);
    entries.push({
      uid: typeof e.uid === "number" ? e.uid : undefined,
      title: comment || "Entry " + (entries.length + 1),
      memo: comment,
      keys: keyList(e.key), secondaryKeys: keyList(e.keysecondary),
      ...(typeof e.selectiveLogic === "number" && LOGIC[e.selectiveLogic] ? { selectiveLogic: LOGIC[e.selectiveLogic] } : {}),
      content, enabled: e.disable !== true,
      status: e.vectorized === true ? "vectorized" : e.constant === true ? "constant" : "normal",
      constant: e.constant === true,
      order: typeof e.order === "number" ? e.order : 100,
      position: pos,
      ...(pos === "at_depth" ? { depth: num(e.depth) ?? 4, role: ROLE[e.role] || "system" } : {}),
      // probability applies only when useProbability is on
      ...(e.useProbability !== false && typeof e.probability === "number" && e.probability < 100 ? { probability: e.probability } : {}),
      ...(e.group ? { group: String(e.group) } : {}),
      ...(num(e.groupWeight) != null ? { groupWeight: e.groupWeight } : {}),
      ...(e.groupOverride === true ? { groupOverride: true } : {}),
      ...(e.matchWholeWords === false ? { matchWholeWords: false } : {}),
      ...(e.excludeRecursion === true ? { nonRecursable: true } : {}),
      ...(e.ignoreBudget === true ? { ignoreBudget: true } : {}),
      ...(e.preventRecursion === true ? { preventFurtherRecursion: true } : {}),
      ...(e.delayUntilRecursion ? { delayUntilRecursion: num(e.delayUntilRecursion) ?? true } : {}),
      ...(num(e.sticky) != null ? { sticky: e.sticky } : {}),
      ...(num(e.cooldown) != null ? { cooldown: e.cooldown } : {}),
      ...(num(e.delay) != null ? { delay: e.delay } : {}),
      ...(e.automationId ? { automationId: String(e.automationId) } : {}),
      ...(e.matchCharacterDescription || e.matchCharacterPersonality || e.matchScenario || e.matchPersonaDescription ? {
        matchSources: {
          description: e.matchCharacterDescription === true,
          personality: e.matchCharacterPersonality === true,
          scenario: e.matchScenario === true,
          persona: e.matchPersonaDescription === true,
        },
      } : {}),
    });
  }
  return entries.length ? { name, entries } : null;
}

// The full standard sampler sweep a chat-completion preset can carry. Numeric
// keys copy as-is; the engine forwards them to the provider body (strict
// endpoints ignore or reject unknown ones, textgen endpoints honor them).
// Keep in sync with the engine plugin's forwarded-key list.
const SAMPLER_NUM_KEYS = [
  "top_p", "top_k", "min_p", "top_a", "typical_p", "eta_cutoff", "epsilon_cutoff",
  "repetition_penalty", "rep_pen", "repetition_penalty_range", "encoder_rep_pen",
  "no_repeat_ngram_size", "presence_penalty", "frequency_penalty", "penalty_alpha",
  "guidance_scale", "negative_prompt_scale", "smoothing_factor", "smoothing_curve",
  "dry_multiplier", "dry_base", "dry_allowed_length", "dry_last_n",
  "xtc_probability", "xtc_threshold",
  "dynatemp_min", "dynatemp_max", "dynatemp_exponent",
  "mirostat_mode", "mirostat_tau", "mirostat_eta",
  "seed", "temperature_last",
];
const SAMPLER_STR_KEYS = ["negative_prompt"];
const SAMPLER_BOOL_KEYS = ["temperature_last", "skip_special_tokens", "ban_eos_token", "add_bos_token"];

/** An instruct template's sequences as the text completion format. "wrap"
 *  puts a newline between a sequence and the message, and ends a message
 *  that has no suffix with one. The story string wrapper, when present, is
 *  what surrounds the system block at the top. */
function instructFormat(t) {
  if (!t || typeof t.input_sequence !== "string" || typeof t.output_sequence !== "string") return null;
  const str = (v) => (typeof v === "string" ? v : "");
  const nl = t.wrap === true ? "\n" : "";
  const prefix = (seq) => (seq ? seq + nl : "");
  const suffix = (seq) => str(seq) || nl;
  return {
    systemPrefix: prefix(str(t.story_string_prefix) || (t.system_same_as_user ? str(t.input_sequence) : str(t.system_sequence))),
    systemSuffix: suffix(str(t.story_string_suffix) || (t.system_same_as_user ? str(t.input_suffix) : str(t.system_suffix))),
    userPrefix: prefix(t.input_sequence),
    userSuffix: suffix(t.input_suffix),
    assistantPrefix: prefix(t.output_sequence),
    assistantSuffix: suffix(t.output_suffix),
    systemAsUser: t.system_same_as_user === true,
  };
}

function normalizePreset(raw, fallbackName) {
  if (!raw || typeof raw !== "object") return null;
  const label = typeof raw.name === "string" && raw.name.trim() ? raw.name
    : typeof raw.presetName === "string" && raw.presetName.trim() ? raw.presetName
    : typeof fallbackName === "string" && fallbackName.trim() ? fallbackName
    : "imported";
  const num = (k) => (typeof raw[k] === "number" ? raw[k] : undefined);
  const preset = {
    name: label,
    temperature: num("temperature") ?? num("temp") ?? undefined,
    // token/context ceilings come under several names depending on the source UI
    openai_max_tokens: num("openai_max_tokens") ?? num("max_tokens") ?? num("max_length") ?? num("n_predict") ?? undefined,
    openai_max_context: num("openai_max_context") ?? num("max_context") ?? num("truncation_length") ?? undefined,
  };
  for (const k of SAMPLER_NUM_KEYS) if (num(k) != null) preset[k] = raw[k];
  for (const k of SAMPLER_STR_KEYS) if (typeof raw[k] === "string" && raw[k].trim()) preset[k] = raw[k];
  for (const k of SAMPLER_BOOL_KEYS) if (raw[k] === true || raw[k] === false) preset[k] = raw[k];

  // behavior + utility prompts map onto the studio bag; blank strings are
  // "off" in our schema, so empty sources just don't set them
  const studio = {};
  // numeric enum: -1 never prepend, 0 default (groups), 1 completion name
  // field, 2 always prefix content
  const namesBehavior = { [-1]: "none", 0: "default", 1: "completion", 2: "content" }[raw.names_behavior];
  if (namesBehavior) studio.namesBehavior = namesBehavior;
  if (raw.squash_system_messages === true || raw.squash_system_messages === false) studio.squashSystemMessages = raw.squash_system_messages;
  if (raw.continue_prefill === true || raw.continue_prefill === false) studio.continuePrefill = raw.continue_prefill;
  const instruct = instructFormat(raw.instruct && typeof raw.instruct === "object" ? raw.instruct : raw);
  if (instruct) studio.promptFormat = { use: "custom", custom: instruct };
  if (typeof raw.custom_prompt_post_processing === "string" && raw.custom_prompt_post_processing) {
    const POST = { claude: "merge", merge: "merge", merge_tools: "merge", semi: "semi", semi_tools: "semi", strict: "strict", strict_tools: "strict", single: "single" };
    const mode = POST[raw.custom_prompt_post_processing];
    if (mode) studio.promptPostProcessing = { enabled: true, mode };
  }
  const samplers = {};
  if (typeof raw.assistant_prefill === "string" && raw.assistant_prefill.trim()) samplers.assistantPrefill = raw.assistant_prefill;
  // NEVER trim a stop string: leading whitespace is the point of the most
  // common one ("\nUser:" halts the model as it starts the user's turn).
  const stops = [
    ...(Array.isArray(raw.stop) ? raw.stop.filter((x) => typeof x === "string" && x) : []),
    ...(typeof raw.custom_stop_strings === "string" && raw.custom_stop_strings.trim() ? raw.custom_stop_strings.split("\n") : []),
  ].filter((x) => x.trim());
  if (stops.length) samplers.stopStrings = [...new Set(stops)];
  if (typeof raw.reasoning_effort === "string" && ["low", "medium", "high"].includes(raw.reasoning_effort)) preset.reasoning = raw.reasoning_effort;
  const utilityPrompts = {};
  const utilMap = [
    ["impersonation_prompt", "impersonation"],
    ["continue_nudge_prompt", "continueNudge"],
    ["new_chat_prompt", "newChat"],
    ["group_nudge_prompt", "groupNudge"],
    ["send_if_empty", "emptySend"],
  ];
  for (const [src, dst] of utilMap) {
    if (typeof raw[src] === "string" && raw[src].trim()) utilityPrompts[dst] = raw[src];
  }
  if (Object.keys(samplers).length) studio.samplers = samplers;
  if (Object.keys(studio).length) preset.studio = studio;
  if (Object.keys(utilityPrompts).length) preset.utilityPrompts = utilityPrompts;
  if (Array.isArray(raw.prompts) && raw.prompts.length) {
    // in-chat injection: numeric 0/1 in outside files, "absolute" in our own
    // exports — both spell the same thing here
    const absolute = (p) => p.injection_position === 1 || p.injection_position === "absolute";
    preset.prompts = raw.prompts
      .filter((p) => p && (p.identifier || p.name))
      .map((p) => ({
        identifier: p.identifier || slug(p.name || "prompt"),
        name: p.name || p.identifier,
        role: p.role === "user" || p.role === "assistant" ? p.role : "system",
        marker: p.marker === true,
        // markers carry editable text too (main/jailbreak and hand-built
        // marker entries) — keep whatever content is there
        ...(typeof p.content === "string" && p.content.trim() ? { content: p.content } : {}),
        ...(absolute(p) && typeof p.injection_depth === "number" ? { injection_position: "absolute", injection_depth: p.injection_depth } : {}),
        ...(Array.isArray(p.injection_trigger) && p.injection_trigger.length ? { injection_trigger: p.injection_trigger } : {}),
      }));
    preset.prompt_order = Array.isArray(raw.prompt_order)
      ? raw.prompt_order
      : preset.prompts.map((p) => ({ identifier: p.identifier, enabled: true }));
    // prompt_order arrives as [{character_id, order:[{identifier, enabled}]}]
    if (Array.isArray(raw.prompt_order) && raw.prompt_order.length && raw.prompt_order[0] && Array.isArray(raw.prompt_order[0].order)) {
      preset.prompt_order = raw.prompt_order;
    }
    if (Array.isArray(preset.prompt_order) && preset.prompt_order.length && !Array.isArray(preset.prompt_order[0].order)) {
      preset.prompt_order = [{ character_id: 100000, order: preset.prompt_order }];
    }
  } else {
    // text-completion story_string → single-block layout
    const content = typeof raw.story_string === "string" && raw.story_string.trim() ? raw.story_string : undefined;
    preset.prompts = [
      ...(content ? [{ identifier: "story", name: "Story", role: "system", content }] : []),
      { identifier: "worldInfoBefore", name: "World Info (before)", role: "system", marker: true },
      { identifier: "charDescription", name: "Char Description", role: "system", marker: true },
      { identifier: "charPersonality", name: "Char Personality", role: "system", marker: true },
      { identifier: "scenario", name: "Scenario", role: "system", marker: true },
      { identifier: "personaDescription", name: "Persona", role: "system", marker: true },
      { identifier: "worldInfoAfter", name: "World Info (after)", role: "system", marker: true },
      { identifier: "dialogueExamples", name: "Chat Examples", role: "system", marker: true },
      { identifier: "chatHistory", name: "Chat History", role: "system", marker: true },
    ];
    preset.prompt_order = [{ character_id: 100000, order: preset.prompts.map((p) => ({ identifier: p.identifier, enabled: true })) }];
  }
  return preset;
}

// numeric placement of the portable regex format: 1 user input, 2 AI
// output, 3 slash command, 5 world info, 6 reasoning (0, the retired
// display-only slot, has no meaning any more)
const PLACEMENT = { 1: "user_input", 2: "ai_output", 3: "slash", 5: "wi", 6: "reasoning" };
function normalizeRegex(raw) {
  if (!raw || typeof raw.findRegex !== "string") return null;
  let find = raw.findRegex;
  let flags;
  const m = /^\/(.*)\/([a-z]*)$/s.exec(find);
  if (m) { find = m[1]; flags = m[2] || undefined; }
  const placement = Array.isArray(raw.placement)
    ? Array.from(new Set(raw.placement.map((n) => PLACEMENT[n]).filter(Boolean)))
    : ["ai_output"];
  return {
    scriptName: typeof raw.scriptName === "string" ? raw.scriptName : "imported",
    findRegex: find, replaceString: typeof raw.replaceString === "string" ? raw.replaceString : "",
    placement,
    // WHEN it applies: neither flag = the saved text is rewritten
    markdownOnly: raw.markdownOnly === true,
    promptOnly: raw.promptOnly === true,
    runOnEdit: raw.runOnEdit === true,
    trimStrings: Array.isArray(raw.trimStrings) ? raw.trimStrings.map(String) : [],
    ...(flags ? { flags } : {}),
    minDepth: typeof raw.minDepth === "number" && raw.minDepth >= -1 ? raw.minDepth : null,
    maxDepth: typeof raw.maxDepth === "number" && raw.maxDepth >= 0 ? raw.maxDepth : null,
    disabled: raw.disabled === true,
    ...(raw.substituteRegex === 1 ? { macroMode: "raw" } : raw.substituteRegex === 2 ? { macroMode: "escaped" } : {}),
  };
}

function normalizeChatLines(raw) {
  // raw: {character?: string, file?: string, lines: [public chat-line objects]}
  if (!raw || !Array.isArray(raw.lines) || !raw.lines.length) return null;
  const uid = (p) => p + Math.random().toString(36).slice(2, 9);
  const msgs = [];
  for (const l of raw.lines) {
    if (!l || typeof l.mes !== "string") continue;
    const isUser = l.is_user === true;
    msgs.push({
      id: uid("e"), name: typeof l.name === "string" ? l.name : (isUser ? "User" : "Character"),
      charId: (l.extra && typeof l.extra.chry_char_id === "string" && l.extra.chry_char_id) || null, role: isUser ? "user" : "char",
      text: l.mes, at: l.send_date && !isNaN(Date.parse(l.send_date)) ? Date.parse(l.send_date) : Date.now(),
      swipes: Array.isArray(l.swipes) && l.swipes.length ? l.swipes.map(String) : [l.mes],
      swipe: typeof l.swipe_id === "number" && l.swipe_id >= 0 ? l.swipe_id : 0,
    });
  }
  if (!msgs.length) return null;
  const title = (raw.character ? raw.character + " — " : "") + unslugTitle(raw.file || "imported chat");
  return { title, msgs };
}

// chub's CDN/API rejects default http-client user-agents with a fake
// "not available in your country" page — present as a browser
const BROWSER_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

export function handleRoute(req, host) {
  if (req.method !== "POST") return null;
  if (req.path !== "/import/batch" && req.path !== "/import/zip" && req.path !== "/import/url" && req.path !== "/marketplace/search" && req.path !== "/marketplace/detail") return null;
  // ---------- Marketplace search (chub.ai today; source id keeps the
  // client shape ready for more storefronts) ----------
  // gateway.chub.ai/search is the catalog the chub frontend itself queries —
  // no auth for public listings, but it insists on a browser user-agent.
  // Two-phase host.net fetch like /import/url; no fs writes here.
  if (req.path === "/marketplace/search") {
    const b = req.body && typeof req.body === "object" ? req.body : {};
    const source = String(b.source || "chub");
    if (source !== "chub") return { status: 400, json: { error: "unknown marketplace source: " + source } };
    if (!host.net) return { status: 503, json: { error: "network permission not granted" } };
    // Orderings the catalog actually accepts — an unknown key is a 400, not a
    // fallback, so every option here is verified. Download order is also the
    // catalog's own default, and a search term filters BEFORE the ordering
    // applies, so there is no separate "relevance" mode to offer.
    const SORTS = { downloads: "download_count", rating: "rating", newest: "created_at", updated: "last_activity_at", tokens: "n_tokens", name: "name", random: "random" };
    // "trending" is NOT an ordering: it swaps the whole searchable pool for a
    // ~1.4k-card hot list. Sent as a sort key it silently shrinks every other
    // filter (a tag inside it returns a handful of cards, or none), so it is
    // its own switch and it replaces the ordering while on.
    const sort = b.trending === true ? "trending" : (SORTS[String(b.sort)] ?? "download_count");
    const search = String(b.search || "").slice(0, 120).trim();
    // creator filter ("by <username>" — chub's own author browse param)
    const username = /^[A-Za-z0-9_.-]{1,80}$/.test(String(b.creator || "")) ? String(b.creator) : "";
    const topicList = (v) => (Array.isArray(v) ? v : [])
      .filter((t) => typeof t === "string" && t.trim() && t.length <= 60)
      .slice(0, 12)
      .map((t) => t.replace(/[,&\s]+/g, " ").trim())
      .filter(Boolean);
    const tags = topicList(b.tags);
    const excludeTags = topicList(b.excludeTags);
    const page = Math.max(1, Math.min(1000, Math.floor(Number(b.page) || 1)));
    const first = Math.max(1, Math.min(50, Math.floor(Number(b.first) || 24)));
    const qs = new URLSearchParams({ namespace: "characters", first: String(first), page: String(page) });
    if (sort) qs.set("sort", sort);
    if (search) qs.set("search", search);
    if (username) qs.set("username", username);
    // Maturity: the catalog hides adult listings unless asked, so an absent
    // flag is NOT "no opinion" — it silently cuts the pool by ~95%. Always
    // state all three.
    qs.set("nsfw", b.nsfw === false ? "false" : "true");
    qs.set("nsfl", b.nsfl === true ? "true" : "false");
    qs.set("nsfw_only", b.nsfwOnly === true ? "true" : "false");
    qs.set("include_forks", b.includeForks === false ? "false" : "true");
    // topics=a,b is AND; inclusive_or flips the whole set to OR. (tags_mode
    // is not a parameter the catalog reads — it silently stayed AND.)
    if (tags.length) {
      qs.set("topics", tags.join(","));
      if (String(b.tagsMode) === "any") qs.set("inclusive_or", "true");
    }
    if (excludeTags.length) qs.set("excludetopics", excludeTags.join(","));
    // numeric narrowing — only sent when the client actually set one
    const num = (v, lo, hi) => {
      const n = Math.floor(Number(v));
      return Number.isFinite(n) && n >= lo && n <= hi ? n : null;
    };
    const minTokens = num(b.minTokens, 1, 1000000);
    const maxTokens = num(b.maxTokens, 1, 1000000);
    const maxDaysAgo = num(b.maxDaysAgo, 1, 36500);
    const minAiRating = num(b.minAiRating, 1, 5);
    const minTags = num(b.minTags, 1, 50);
    if (minTokens !== null) qs.set("min_tokens", String(minTokens));
    if (maxTokens !== null) qs.set("max_tokens", String(maxTokens));
    if (maxDaysAgo !== null) qs.set("max_days_ago", String(maxDaysAgo));
    if (minAiRating !== null) qs.set("min_ai_rating", String(minAiRating));
    if (minTags !== null) qs.set("min_tags", String(minTags));
    // "must have" flags: only the enabled ones are sent (false narrows nothing)
    const REQUIRES = {
      requireExamples: "require_example_dialogues",
      requireLore: "require_lore",
      requireLoreEmbedded: "require_lore_embedded",
      requireLoreLinked: "require_lore_linked",
      requireGreetings: "require_alternate_greetings",
      requireCustomPrompt: "require_custom_prompt",
      requireImages: "require_images",
      requireExpressions: "require_expressions",
    };
    for (const key of Object.keys(REQUIRES)) if (b[key] === true) qs.set(REQUIRES[key], "true");
    if (!Object.keys(host.net.results).length) {
      host.net.request("search", {
        url: "https://gateway.chub.ai/search?" + qs.toString(),
        json: true, maxBytes: 4 * 1024 * 1024,
        headers: { "user-agent": BROWSER_UA, accept: "application/json" },
      });
      return { __llmPending: true };
    }
    const r = host.net.results.search;
    const data = r && r.ok && r.json && typeof r.json.data === "object" ? r.json.data : null;
    if (!data) {
      return { status: 502, json: { error: "chub search failed (" + ((r && (r.status || r.error)) || "no response") + ")" } };
    }
    const nodes = Array.isArray(data.nodes) ? data.nodes : [];
    const results = nodes.map((n) => {
      const fullPath = String(n.fullPath || "");
      const topics = Array.isArray(n.topics) ? n.topics.map(String).slice(0, 30) : [];
      return {
        // "user/slug" — the stable id used for the download URL and dedupe
        id: fullPath,
        name: String(n.name || fullPath.split("/")[1] || "Untitled"),
        creator: fullPath.split("/")[0] || "",
        tagline: typeof n.tagline === "string" ? n.tagline.slice(0, 500) : "",
        description: typeof n.description === "string" ? n.description.slice(0, 12000) : "",
        topics,
        // chub naming quirk: starCount IS the download count; n_favorites is
        // the real "likes". nTokens is their token estimate for the card.
        downloads: Number(n.starCount) || 0,
        favorites: Number(n.n_favorites) || 0,
        tokens: Number(n.nTokens) || 0,
        rating: Number(n.rating) || 0,
        ratingCount: Number(n.ratingCount) || 0,
        chats: Number(n.nChats) || 0,
        messages: Number(n.nMessages) || 0,
        // the adult flag on the listing only covers the ARTWORK — an adult
        // card with a tame avatar carries it in its topics instead
        nsfw: n.nsfw_image === true || topics.some((t) => t.toLowerCase() === "nsfw"),
        avatar: typeof n.avatar_url === "string" ? n.avatar_url : null,
        // full-resolution card image; the client downscales it into the
        // imported character's avatar (the listing avatar is a 200px thumb)
        maxRes: typeof n.max_res_url === "string" ? n.max_res_url : null,
        createdAt: typeof n.createdAt === "string" ? n.createdAt : null,
      };
    }).filter((x) => x.id && x.name);
    return {
      status: 200,
      json: { source, count: Number(data.count) || results.length, page: Number(data.page) || page, first, results },
    };
  }

  // ---------- Marketplace detail (full card definition, chub) ----------
  // The listing gives name/tagline/stats; this fetches the actual card fields
  // (greeting, personality, scenario, examples, alternate greetings) so the
  // preview dialog shows exactly what a download brings in.
  if (req.path === "/marketplace/detail") {
    const b = req.body && typeof req.body === "object" ? req.body : {};
    const source = String(b.source || "chub");
    if (source !== "chub") return { status: 400, json: { error: "unknown marketplace source: " + source } };
    if (!host.net) return { status: 503, json: { error: "network permission not granted" } };
    const id = String(b.id || "");
    const parts = /^([A-Za-z0-9_.-]{1,80})\/([A-Za-z0-9_.-]{1,120})$/.exec(id);
    if (!parts) return { status: 400, json: { error: "bad listing id" } };
    if (!Object.keys(host.net.results).length) {
      host.net.request("detail", {
        url: "https://api.chub.ai/api/characters/" + encodeURIComponent(parts[1]) + "/" + encodeURIComponent(parts[2]) + "?full=true",
        json: true, maxBytes: 5 * 1024 * 1024,
        headers: { "user-agent": BROWSER_UA, accept: "application/json" },
      });
      return { __llmPending: true };
    }
    const r = host.net.results.detail;
    const node = r && r.ok && r.json && r.json.node ? r.json.node : null;
    if (!node) {
      return { status: 502, json: { error: "chub detail failed (" + ((r && (r.status || r.error)) || "no response") + ")" } };
    }
    const d = node.definition && typeof node.definition === "object" ? node.definition : {};
    const clip = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
    const book = d.embedded_lorebook && typeof d.embedded_lorebook === "object" ? d.embedded_lorebook : null;
    const bookEntries = book ? (Array.isArray(book.entries) ? book.entries.length : Object.keys(book.entries || {}).length) : 0;
    return {
      status: 200,
      json: {
        source, id,
        greeting: clip(d.first_message, 16000),
        alternateGreetings: Array.isArray(d.alternate_greetings) ? d.alternate_greetings.map((g) => String(g).slice(0, 16000)).slice(0, 40) : [],
        personality: clip(d.personality, 24000),
        scenario: clip(d.scenario, 8000),
        exampleDialogs: clip(d.example_dialogs, 16000),
        creatorNotes: clip(d.description, 8000),
        systemPrompt: clip(d.system_prompt, 8000),
        postHistoryInstructions: clip(d.post_history_instructions, 8000),
        lorebookEntries: bookEntries,
      },
    };
  }

  const fsx = host.fs;
  const writeJson = (rel, v) => fsx.write(rel, JSON.stringify(v, null, 2) + "\n");
  const readJson = (rel, fb) => { try { return JSON.parse(fsx.read(rel)); } catch { return fb; } };
  const summary = { characters: [], groups: [], lorebooks: [], presets: [], regex: [], personas: [], themes: [], chats: [], errors: [] };
  const used = new Set();
  // Id collision guard: dedupes within THIS import batch AND against what
  // already exists on disk — re-importing the same card must never silently
  // overwrite the earlier one (its gallery/edits would be lost).
  const taken = (rel) => { try { fsx.read(rel); return true; } catch { return false; } };
  const uid = (base, dir) => {
    let id = base, n = 2;
    const hit = (x) => used.has(x) || (dir && (taken(dir + "/" + x + "/card.json") || taken(dir + "/" + x + ".json") || taken(dir + "/" + x + ".meta.json")));
    while (hit(id)) id = base + "-" + n++;
    used.add(id);
    return id;
  };

  // ---------- URL import (chub / CharacterHub card links) ----------
  // Page link → character detail JSON + the embedded-card PNG from the CDN
  // (both two-phase host.net fetches, no credentials, manifest allowlist
  // enforced host-side). The PNG card wins (full fidelity incl. v3); the
  // detail JSON is the fallback and fills any missing fields.
  if (req.path === "/import/url") {

    const url = String((req.body && req.body.url) || "");
    if (!url.startsWith("https://")) return { status: 400, json: { error: "https URL required" } };
    if (!host.net) return { status: 503, json: { error: "network permission not granted" } };
    const UA = BROWSER_UA;
    const page = /^https:\/\/(?:www\.)?(?:chub\.ai|characterhub\.(?:ai|org))\/characters\/([^/\s?#]+)\/([^/\s?#]+)/.exec(url)
      || /^https:\/\/api\.chub\.ai\/api\/characters\/([^/\s?#]+)\/([^/\s?#]+)/.exec(url);
    if (!page) {
      if (/^https:\/\/[^/]*chub\.ai|^https:\/\/[^/]*characterhub\.(?:ai|org)/.test(url)) {
        return { status: 400, json: { error: "not a character link — use https://chub.ai/characters/<user>/<name>" } };
      }
      return { status: 400, json: { error: "not a chub / CharacterHub character link" } };
    }
    const [, user, nameSlug] = page;
    // optional client-downscaled avatar (data URI). Wins over the 200px
    // chub thumbnail the importer would otherwise keep.
    const b = req.body && typeof req.body === "object" ? req.body : {};
    const avatarOverride = typeof b.avatar === "string" && b.avatar.startsWith("data:image/") && b.avatar.length < 900 * 1024 ? b.avatar : null;
    const requests = {
      png: { url: "https://avatars.charhub.io/avatars/" + encodeURIComponent(user) + "/" + encodeURIComponent(nameSlug) + "/chara_card_v2.png", binary: true, maxBytes: 16 * 1024 * 1024 },
      detail: { url: "https://api.chub.ai/api/characters/" + encodeURIComponent(user) + "/" + encodeURIComponent(nameSlug) + "?full=true", json: true, maxBytes: 5 * 1024 * 1024 },
      webp: { url: "https://avatars.charhub.io/avatars/" + encodeURIComponent(user) + "/" + encodeURIComponent(nameSlug) + "/avatar.webp", binary: true, maxBytes: 8 * 1024 * 1024 },
    };
    if (!Object.keys(host.net.results).length) {
      for (const k of Object.keys(requests)) {
        const spec = requests[k];
        host.net.request(k, { ...spec, headers: { "user-agent": UA, accept: spec.binary ? "image/*" : "application/json" } });
      }
      return { __llmPending: true };
    }
    // pass B: PNG card first, detail JSON second, webp only as avatar filler
    const png = host.net.results.png;
    const detail = host.net.results.detail;
    const webp = host.net.results.webp;
    // avatars come from the small webp variant — the card PNG is multi-MB and
    // only exists to carry the embedded card JSON
    const avatarOf = (r, mime) => (r && r.ok && r.base64 && r.base64.length < 700000 ? "data:" + mime + ";base64," + r.base64 : null);
    let card = null;
    let avatar = avatarOverride;
    if (png && png.ok && png.base64) {
      card = cardFromPngBase64(png.base64);
      // the PNG only exists to carry the embedded card JSON — the avatar comes
    // from the small webp variant whenever it arrived
      avatar = avatar || avatarOf(webp, "image/webp");
    }
    if (!card && detail && detail.ok && detail.json && detail.json.node) {
      const n = detail.json.node;
      const d = n.definition || {};
      card = {
        spec: "chara_card_v2", spec_version: "2.0",
        name: d.name || n.name || nameSlug,
        description: d.personality || "",
        personality: d.tavern_personality || "",
        scenario: d.scenario || "",
        first_mes: d.first_message || "",
        mes_example: d.example_dialogs || "",
        creator_notes: d.description || "",
        system_prompt: d.system_prompt || "",
        post_history_instructions: d.post_history_instructions || "",
        alternate_greetings: Array.isArray(d.alternate_greetings) ? d.alternate_greetings.map(String) : [],
        tags: Array.isArray(n.topics) ? n.topics.map(String) : [],
        creator: user,
        ...(d.embedded_lorebook && typeof d.embedded_lorebook === "object" ? { character_book: d.embedded_lorebook } : {}),
        ...(d.extensions && typeof d.extensions === "object" ? { extensions: d.extensions } : {}),
      };
      avatar = avatar || avatarOf(webp, "image/webp") || (typeof n.avatar_url === "string" ? n.avatar_url : null);
    }
    if (!card) {
      const why = [];
      if (png && !png.ok) why.push("card image " + (png.status || png.error || "failed"));
      if (detail && !detail.ok) why.push("detail " + (detail.status || detail.error || "failed"));
      return { status: 502, json: { error: "no character card found at that URL" + (why.length ? " (" + why.join("; ") + ")" : "") } };
    }
    const n = normalizeCard(card, avatar || undefined);
        if (!n) return { status: 502, json: { error: "the card at that URL was not recognizable" } };
    writeCardWithBook(n, card, null, avatar || undefined);
    return { status: 200, json: { ...summary, name: n.name } };
  }

  // Hoisted so the /import/url handler above can call it before this line.
  function writeCard(card) {
    const id = uid(slug(card.name), "characters");
    writeJson("characters/" + id + "/card.json", card);
    summary.characters.push(id);
    // regex scripts a card carries run for that character only
    const embedded = card.extensions && Array.isArray(card.extensions.regex_scripts) ? card.extensions.regex_scripts : [];
    embedded.forEach((raw, i) => {
      const n = normalizeRegex(raw);
      if (!n) return;
      const rid = uid(slug(n.scriptName), "regex");
      writeJson("regex/" + rid + ".json", { ...n, id: rid, scope: "character", scopeTargetId: id, order: i });
      summary.regex.push(rid);
    });
  }
  /** Cards may embed a lorebook — write it as a book file and link it via
   *  the card's studio bag so the app scopes it to that character. charx
   *  packages also carry assets: the icon/main avatar and emotion sprites
   *  resolve from the package bytes (assetDict) or inline data: URIs. */
  function writeCardWithBook(card, raw, assetDict, sourceAvatar) {
    if (!card) return;
    const src = raw && raw.data && typeof raw.data === "object" && raw.data.character_book ? raw.data : raw;
    const book = src && src.character_book && typeof src.character_book === "object" ? src.character_book : null;
    const world = book ? embeddedBookToWorld(book) : null;
    if (world) {
      const n = normalizeBook(world, (typeof book.name === "string" && book.name) || card.name + " lore");
      if (n) {
        n.isEmbedded = true;
        // card-spec book-level knobs — full settings shape so the client's
        // replace-on-read doesn't lose the other defaults
        const st = { scanDepth: 4, contextPercent: 25, budgetCap: 0, minActivations: 0, maxRecursion: 2, insertionStrategy: "character_first", caseSensitive: false, wholeWords: true, groupScoring: false, recursiveScan: true, includeNames: true, overflowAlert: true };
        if (typeof book.scan_depth === "number" && book.scan_depth >= 0) st.scanDepth = Math.floor(book.scan_depth);
        if (book.recursive_scanning === false) st.recursiveScan = false;
        n.settings = st;
        const id = uid(slug(n.name), "lorebooks");
        writeJson("lorebooks/" + id + ".json", { ...n, id });
        summary.lorebooks.push(id);
        card.studio = { ...card.studio, embeddedLorebookId: id };
      }
    }
    if (Array.isArray(card.assets)) {
      const resolved = resolveCardAssets(card, assetDict || {}, sourceAvatar || null);
      if (resolved.avatar) card.avatar = resolved.avatar;
      if (resolved.expressions.length) {
        card.studio = { ...card.studio, expressions: resolved.expressions };
      }
    }
    writeCard(card);
  }
  const writeBook = (n, fallback) => {
    if (!n) return;
    const id = uid(slug(n.name || fallback || "book"), "lorebooks");
    writeJson("lorebooks/" + id + ".json", { ...n, id });
    summary.lorebooks.push(id);
  };
  const writePreset = (n) => {
    if (!n) return;
    const id = uid(slug(n.name || "preset"), "presets");
    writeJson("presets/" + id + ".json", { ...n, id });
    summary.presets.push(id);
  };
  const writeRegex = (n) => {
    if (!n) return;
    const id = uid(slug(n.scriptName), "regex");
    writeJson("regex/" + id + ".json", { ...n, id });
    summary.regex.push(id);
  };
  const writePersona = (name, description) => {
    if (!name) return;
    const id = uid(slug(name), "personas");
    writeJson("personas/" + id + ".json", { id, name, description: description || "" });
    summary.personas.push(id);
  };
  const writeChat = (n, characterId, groupId) => {
    const id = uid(slug(n.title), "chats");
    // pinned to the persona in use at import, like a chat made in the app
    const personaId = readJson("settings.json", {}).personaId || null;
    const persona = personaId ? readJson("personas/" + personaId + ".json", null) : null;
    const meta = {
      id, title: n.title, characterId: characterId || null, groupId: groupId || null,
      presetId: "default", personaId: persona ? personaId : null, model: null, userName: (persona && persona.name) || "User",
      authorNote: null, lorebookIds: [], createdAt: Date.now(), updatedAt: Date.now(), tainted: true,
    };
    fsx.write("chats/" + id + ".jsonl", n.msgs.map((m) => JSON.stringify(m)).join("\n") + "\n");
    writeJson("chats/" + id + ".meta.json", meta);
    summary.chats.push(id);
  };

  // ---------- browser-driven batch (can include PNG-extracted cards) ----------
  if (req.path === "/import/batch") {
    const b = req.body && typeof req.body === "object" ? req.body : {};
    for (const c of b.cards || []) {
      try {
        let raw = null;
        let avatar = null;
        if (typeof c === "string") {
          raw = extractCardFromPng(b64ToBytes(c.replace(/^data:[^,]*,/, "")));
        } else if (c && typeof c === "object") {
          // three shapes: {card, avatar} from the UI, {pngBase64, avatar}, or a bare card
          raw = c.pngBase64 ? extractCardFromPng(b64ToBytes(String(c.pngBase64).replace(/^data:[^,]*,/, ""))) : (c.card ?? c);
          avatar = typeof c.avatar === "string" ? c.avatar : null;
        }
        const n = normalizeCard(raw, avatar);
        if (!n) { summary.errors.push("card skipped: no name or unparseable"); continue; }
        writeCardWithBook(n, raw, null, avatar || undefined);
      } catch (err) { summary.errors.push("card failed: " + String((err && err.message) || err).slice(0, 100)); }
    }
    for (const w of b.worldInfo || []) {
      // world files carry no name — the UI passes the file name as `name`
      try { writeBook(normalizeBook(w, "imported-book"), "imported-book"); } catch { summary.errors.push("world info failed"); }
    }
    for (const p of b.presets || []) {
      try { writePreset(normalizePreset(p)); } catch { summary.errors.push("preset failed"); }
    }
    for (const r of b.regex || []) {
      try { writeRegex(normalizeRegex(r)); } catch { summary.errors.push("regex failed"); }
    }
    for (const per of b.personas || []) {
      try { if (per && per.name) writePersona(per.name, per.description); } catch { summary.errors.push("persona failed"); }
    }
    for (const t of b.themes || []) {
      try {
        if (!t || typeof t.name !== "string") continue;
        const id = uid(slug(t.name), "themes");
        writeJson("themes/" + id + ".json", {
          id, name: t.name,
          colors: {
            text: typeof t.main_text_color === "string" ? t.main_text_color : undefined,
            background: typeof t.chat_tint_color === "string" ? t.chat_tint_color : undefined,
            panel: typeof t.main_color === "string" ? t.main_color : undefined,
            accent: typeof t.theme_color === "string" ? t.theme_color : undefined,
          },
        });
        summary.themes.push(id);
      } catch { summary.errors.push("theme failed"); }
    }
    for (const c of b.chats || []) {
      try {
        const n = normalizeChatLines(c);
        if (!n) continue;
        // link to a character by name when one matches
        let characterId = null;
        try {
          for (const cid of fsx.list("characters")) {
            const card = readJson("characters/" + cid + "/card.json", null);
            if (card && c.character && card.name.toLowerCase() === String(c.character).toLowerCase()) { characterId = cid; break; }
          }
        } catch {}
        writeChat(n, characterId);
      } catch { summary.errors.push("chat failed"); }
    }
    return { status: 200, json: summary };
  }

  // ---------- plugin-side zip (text entries only) ----------
  if (req.path === "/import/zip") {
    const rawEntries = host.zip.entries();
    const entries = {};
    const names = Object.keys(rawEntries);
    const isText = (v) => typeof v === "string";

    // Foreign backup layouts normalize to our tree first:
    //  · charx — a card package: card.json at the root
    //  · roleplay-tool backup — data/<user>/default-user/{characters,chats,personas,
    //    worlds,extensions/regex,presets,themes}/…
    for (const raw of names) {
      let name = raw;
      const m = /^data\/[^/]+\/default-user\/(.*)$/.exec(raw);
      if (m) name = m[1];
      if (raw.endsWith(".charx")) continue; // handled as files, not zips
      entries[name] = rawEntries[raw];
    }

    // charx package: card.json at the root + assets/ entries the card
    // references by __asset:/embeded:// URIs
    if (isText(entries["card.json"])) {
      try {
        const assetDict = {};
        for (const name of names) {
          const e = entries[name];
          if (e && typeof e === "object" && e.__b64 && typeof e.base64 === "string") assetDict[name] = e.base64;
        }
        const parsed = JSON.parse(entries["card.json"]);
        const card = normalizeCard(parsed);
        if (card) { writeCardWithBook(card, parsed, assetDict); return { status: 200, json: { ...summary, name: card.name } }; }
      } catch {}
      return { status: 400, json: { error: "charx package has no readable card.json" } };
    }

    for (const name of Object.keys(entries)) {
      if (name.startsWith("characters/") && name.endsWith(".png")) {
        const e = entries[name];
        if (e && typeof e === "object" && e.__b64 && e.base64) {
          const rawCard = cardFromPngBase64(e.base64);
          const n = rawCard && normalizeCard(rawCard);
          // ccdefault: assets point at the card PNG itself
          if (n) writeCardWithBook(n, rawCard, null, "data:image/png;base64," + e.base64);
          else summary.errors.push("png card without embedded data: " + name);
        } else {
          summary.errors.push("png card (binary) — import it directly from the Import button: " + name);
        }
        continue;
      }
      if (name.startsWith("characters/") && name.endsWith(".json") && isText(entries[name])) {
        try {
          const parsed = JSON.parse(entries[name]);
          const n = normalizeCard(parsed);
          if (n) writeCardWithBook(n, parsed, null, typeof parsed.avatar === "string" ? parsed.avatar : undefined);
        } catch { summary.errors.push("card failed: " + name); }
        continue;
      }
      if (name.startsWith("worlds/") && name.endsWith(".json") && isText(entries[name])) {
        try {
          const fallback = name.split("/").pop().replace(/\.json$/i, "");
          writeBook(normalizeBook(JSON.parse(entries[name]), fallback), fallback);
        } catch { summary.errors.push("world failed: " + name); }
        continue;
      }
      if (name.startsWith("groups/") && name.endsWith(".json") && isText(entries[name])) {
        try {
          const g = JSON.parse(entries[name]);
          // characters were re-created under name-derived ids — remap each
          // member by original id first, then by the exported _memberNames
          const memberIds = (g.memberIds || []).map((mid, i) => {
            if (fsx.list("characters").includes(mid)) return mid;
            const nm = (g._memberNames || [])[i];
            if (!nm) return null;
            try {
              for (const cid of fsx.list("characters")) {
                const card = readJson("characters/" + cid + "/card.json", null);
                if (card && card.name === nm) return cid;
              }
            } catch {}
            return null;
          }).filter(Boolean);
          // the id lands in the write path: slug it like every other collection
          // so a crafted backup cannot climb out of groups/
          const gid = typeof g.id === "string" && g.id ? slug(g.id) : uid(slug(g.name || "group"), "groups");
          writeJson("groups/" + gid + ".json", { id: gid, name: g.name || gid, memberIds, mode: g.mode || "natural", mutedIds: g.mutedIds || [] });
          summary.groups.push(gid);
        } catch { summary.errors.push("group failed: " + name); }
        continue;
      }
      if (name.startsWith("extensions/regex/") && name.endsWith(".json") && isText(entries[name])) {
        try { writeRegex(normalizeRegex(JSON.parse(entries[name]))); } catch { summary.errors.push("regex failed: " + name); }
        continue;
      }
      if (name === "personas.json" && isText(entries[name])) {
        // single-file personas map: { "persona name": { ... } }
        try {
          const map = JSON.parse(entries[name]);
          for (const [pname, p] of Object.entries(map || {})) {
            writePersona(pname, typeof p === "string" ? p : String((p && p.description) || (p && p.position !== undefined && p.text) || ""));
          }
        } catch { summary.errors.push("personas failed: " + name); }
        continue;
      }
      if (name.startsWith("personas/") && name.endsWith(".json") && isText(entries[name])) {
        try {
          const p = JSON.parse(entries[name]);
          writePersona(String(p.name || name.split("/").pop().replace(/\.json$/, "")), String(p.description || ""));
        } catch { summary.errors.push("persona failed: " + name); }
        continue;
      }
      if (name.startsWith("presets/") && name.endsWith(".json") && isText(entries[name])) {
        try {
          const n = normalizePreset(JSON.parse(entries[name]), name.split("/").pop().replace(/\.json$/i, ""));
          if (n) writePreset(n);
        } catch { summary.errors.push("preset failed: " + name); }
        continue;
      }
      if (name.startsWith("chats/") && name.endsWith(".jsonl") && isText(entries[name])) {
        try {
          const parts = name.split("/");
          const character = parts[1] || "";
          const file = (parts[2] || "chat").replace(/\.jsonl$/i, "");
          const lines = entries[name].split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          const n = normalizeChatLines({ character, file, lines });
          if (n) {
            let characterId = null;
            try {
              for (const cid of fsx.list("characters")) {
                const card = readJson("characters/" + cid + "/card.json", null);
                if (card && card.name.toLowerCase() === character.toLowerCase()) { characterId = cid; break; }
              }
            } catch {}
            // folder didn't match a card → it's a group chat (folder is the
            // group name slug, or the group id slug from older exports)
            let groupId = null;
            if (!characterId) {
              try {
                for (const gf of fsx.list("groups").filter((x) => x.endsWith(".json"))) {
                  const gr = readJson("groups/" + gf, null);
                  if (gr && (slug(gr.name) === character.toLowerCase() || slug(gr.id) === character.toLowerCase())) { groupId = gr.id; break; }
                }
              } catch {}
            }
            // title prefix from the resolved owner, not the zip folder slug
            const ownerCard = characterId ? readJson("characters/" + characterId + "/card.json", null) : null;
            const ownerGroup = groupId ? readJson("groups/" + groupId + ".json", null) : null;
            const ownerName = ownerCard?.name || ownerGroup?.name;
            if (ownerName) n.title = ownerName + " — " + unslugTitle(file);
            // group message attribution: engine ids changed on restore —
            // remap each msg.charId by id, then by the speaker name
            if (groupId) {
              const byId = new Map(), byName = new Map();
              try {
                for (const cid of fsx.list("characters")) {
                  const card = readJson("characters/" + cid + "/card.json", null);
                  if (card) { byId.set(cid, cid); byName.set(card.name.toLowerCase(), cid); }
                }
              } catch {}
              for (const m of n.msgs) {
                if (m.charId && byId.has(m.charId)) continue;
                m.charId = (m.name && byName.get(String(m.name).toLowerCase())) || null;
              }
            }
            writeChat(n, characterId, groupId);
          }
        } catch { summary.errors.push("chat failed: " + name); }
        continue;
      }
    }

    const presetsText = entries["User Settings/openai_settings.json"];
    if (isText(presetsText)) {
      try {
        const all = JSON.parse(presetsText);
        // the map key IS the preset's name — pass it through so restored
        // presets keep their names instead of all landing on "imported"
        for (const [presetName, preset] of Object.entries(all ?? {})) writePreset(normalizePreset(preset, presetName));
      } catch { summary.errors.push("presets failed"); }
    }
    for (const name of names) {
      if (!name.startsWith("User Settings/regex/") || !name.endsWith(".json") || !isText(entries[name])) continue;
      try { writeRegex(normalizeRegex(JSON.parse(entries[name]))); } catch { summary.errors.push("regex failed: " + name); }
    }
    const personasText = entries["User Settings/personas.json"];
    if (isText(personasText)) {
      try {
        const map = JSON.parse(personasText);
        for (const [pid, desc] of Object.entries(map)) writePersona(pid, String(desc ?? ""));
      } catch { summary.errors.push("personas failed"); }
    }
    return { status: 200, json: summary };
  }

  return null;
}

export const TOOLS = [];
