// .agents/lib/data-tools.js
var forbidden = new Set(["__proto__", "prototype", "constructor"]);
var own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
var clone = (value) => JSON.parse(JSON.stringify(value));
function keys(pointer) {
  if (typeof pointer !== "string" || pointer && !pointer.startsWith("/"))
    throw new Error("Fields use JSON pointers, for example /ui/theme");
  return pointer ? pointer.slice(1).split("/").map((key) => key.replace(/~1/g, "/").replace(/~0/g, "~")).map((key) => {
    if (forbidden.has(key))
      throw new Error("Unsafe field");
    return key;
  }) : [];
}
function valueAt(record, pointer) {
  return keys(pointer).reduce((value, key) => value && own(value, key) ? value[key] : undefined, record);
}
function selectedFields(record, fields) {
  if (!Array.isArray(fields) || fields.some((field) => typeof field !== "string"))
    throw new Error("fields must be JSON pointers");
  const values = {}, missing = [];
  for (const field of fields) {
    const value = valueAt(record, field);
    if (value === undefined)
      missing.push(field);
    else
      values[field] = value;
  }
  return { values, missing };
}
function merge(target, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    throw new Error("patch must be an object");
  for (const [key, value] of Object.entries(patch)) {
    if (forbidden.has(key))
      throw new Error("Unsafe field");
    if (key.startsWith("/"))
      throw new Error("patch uses stored property names, for example {disabled:true}; JSON pointers are only for inspection fields");
    if (value && typeof value === "object" && !Array.isArray(value)) {
      if (target[key] !== undefined && target[key] !== null && (typeof target[key] !== "object" || Array.isArray(target[key])))
        throw new Error("Field type changed: " + key);
      if (!target[key])
        target[key] = {};
      merge(target[key], value);
    } else {
      if (target[key] !== undefined && target[key] !== null && value !== null && (typeof target[key] !== typeof value || Array.isArray(target[key]) !== Array.isArray(value)))
        throw new Error("Field type changed: " + key);
      target[key] = clone(value);
    }
  }
  return target;
}

// .agents/skills/preset-editing/inspect.source.js
function words(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}
function matches(query, name, id) {
  if (query === id)
    return true;
  const sought = words(query), tokens = words(name);
  if (!sought.length)
    return false;
  const initials = tokens.map((token) => token[0]).join("");
  return sought.every((term) => tokens.some((token) => token.startsWith(term)) || term.length >= 2 && initials.startsWith(term));
}
function sectionResult(record, prompt, includeContent) {
  const layouts = record.prompt_order ?? [];
  const layout = layouts.find((item) => String(item.character_id) === "100001" && item.order?.length) ?? layouts.find((item) => item.order?.length);
  const entry = layout?.order.find((item) => item.identifier === prompt.identifier);
  const editor = record.studio?.sections?.find((item) => item.id === prompt.identifier);
  const index = layout ? layout.order.findIndex((item) => item.identifier === prompt.identifier) : record.prompts.indexOf(prompt);
  const enabled = layout ? Boolean(entry && entry.enabled !== false) : true;
  const result = {
    identifier: prompt.identifier,
    name: prompt.name,
    role: prompt.role,
    enabled,
    editorEnabled: editor?.enabled ?? null,
    position: index < 0 ? null : index + 1,
    layout: layout?.character_id ?? null,
    editorPresent: Boolean(editor),
    consistent: { content: editor ? prompt.content === editor.content : null, enabled: editor ? enabled === editor.enabled : null }
  };
  if (includeContent) {
    result.content = prompt.content ?? "";
    if (editor && prompt.content !== editor.content)
      result.editorContent = editor.content;
  }
  return result;
}
function inspect(args, host) {
  if (typeof args.preset !== "string" || !args.preset.trim())
    throw new Error("Provide preset: a name, abbreviation, or exact ID");
  if (args.section !== undefined && (typeof args.section !== "string" || !args.section.trim()))
    throw new Error("Section must be a name fragment or identifier");
  if (args.includeContent !== undefined && typeof args.includeContent !== "boolean")
    throw new Error("includeContent must be boolean");
  const found = [], errors = [];
  let scanned = 0;
  let files = host.fs.list("presets").filter((name) => !name.startsWith("_") && name.endsWith(".json"));
  if (files.includes(args.preset + ".json"))
    files = [args.preset + ".json"];
  for (const file of files) {
    let record, revision = null;
    try {
      const version = host.fs.readVersioned ? host.fs.readVersioned("presets/" + file) : { text: host.fs.read("presets/" + file), revision: null };
      record = JSON.parse(version.text);
      revision = version.revision;
    } catch (e) {
      errors.push({ file, error: String(e.message ?? e) });
      continue;
    }
    scanned++;
    const id = record.id ?? file.slice(0, -5);
    if (!matches(args.preset, record.name, id) && !matches(args.preset, record.studio?.name, id))
      continue;
    const prompts = record.prompts ?? [];
    if (!Array.isArray(prompts)) {
      errors.push({ file, error: "prompts must be an array" });
      continue;
    }
    const selected = args.section ? prompts.filter((prompt) => matches(args.section, prompt.name, prompt.identifier)) : prompts;
    try {
      found.push({
        id,
        name: record.name,
        editorName: record.studio?.name ?? null,
        file: "presets/" + file,
        revision,
        ...args.fields ? selectedFields(record, args.fields) : {},
        readOnly: Boolean(record.studio?.readOnly),
        isDefault: Boolean(record.studio?.isDefault),
        sections: selected.map((prompt) => sectionResult(record, prompt, args.includeContent ?? Boolean(args.section))),
        ...args.section && !selected.length ? { availableSections: prompts.map(({ identifier, name }) => ({ identifier, name })) } : {}
      });
    } catch (e) {
      errors.push({ file, error: String(e.message ?? e) });
    }
  }
  return {
    query: { preset: args.preset, section: args.section ?? null },
    scanned,
    ambiguous: found.length > 1,
    matches: found,
    errors,
    guidance: found.length > 1 ? "Multiple matching presets. Show the requested field for each, or ask which preset to edit. Do not infer the current chat's preset from defaults or historical chat references." : found.length === 0 ? "No matching preset. Ask for its full name or ID." : null
  };
}

// .agents/skills/preset-editing/edit.source.js
var safeId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
var samplerKeys = { temperature: "temperature", top_p: "top_p", top_k: "top_k", min_p: "min_p", rep_pen: "repetition_penalty", freq_pen: "frequency_penalty", pres_pen: "presence_penalty" };
function samplers(record, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch))
    throw new Error("samplers must be an object");
  record.studio.samplers ??= {};
  merge(record.studio.samplers, patch);
  for (const [key, portable] of Object.entries(samplerKeys))
    if (Object.hasOwn(patch, key)) {
      const value = record.studio.samplers[key];
      if (typeof value.enabled !== "boolean" || !Number.isFinite(value.value))
        throw new Error("Invalid sampler: " + key);
      if (value.enabled)
        record[portable] = value.value;
      else
        delete record[portable];
    }
  for (const [key, portable] of [["maxTokens", "openai_max_tokens"], ["contextSize", "openai_max_context"], ["seed", "seed"], ["stopStrings", "stop"]])
    if (Object.hasOwn(patch, key)) {
      if (key === "stopStrings" ? !Array.isArray(patch[key]) || patch[key].some((value) => typeof value !== "string") : !Number.isFinite(patch[key]))
        throw new Error("Invalid sampler: " + key);
      record[portable] = patch[key];
    }
  if (patch.reasoning) {
    const value = record.studio.samplers.reasoning;
    if (!["off", "min", "low", "med", "high", "max"].includes(value.effort))
      throw new Error("Invalid reasoning effort");
    if (value.enabled && value.effort !== "off")
      record.reasoning = value.effort === "med" ? "medium" : value.effort;
    else
      delete record.reasoning;
    if (value.enabled && value.autoParse && value.thinkTagOpen && value.thinkTagClose)
      record.reasoningTags = { open: value.thinkTagOpen, close: value.thinkTagClose };
    else
      delete record.reasoningTags;
    if (value.enabled && value.budget > 0)
      record.thinkingBudget = value.budget;
    else
      delete record.thinkingBudget;
  }
}
function edit(args, host) {
  let file, version, record;
  if (args.operation !== "create" && !["patch", "studio", "samplers", "utilityPrompts", "extendedSamplers"].some((key) => args[key] && Object.keys(args[key]).length))
    throw new Error("Provide the fields to change");
  if (args.operation === "create") {
    if (!safeId.test(args.id ?? ""))
      throw new Error("Creation needs a unique path-safe ID");
    record = JSON.parse(host.fs.read("_templates/_preset.json"));
    delete record._note;
    record.id = args.id;
    record.studio.id = args.id;
    record.studio.readOnly = false;
    record.studio.isDefault = false;
    record.studio.createdAt = Date.now();
    file = "presets/" + args.id + ".json";
    version = { revision: null };
  } else {
    const found = inspect({ preset: args.preset, section: args.section }, host);
    if (found.matches.length !== 1)
      throw new Error("Edit needs exactly one matching preset");
    file = found.matches[0].file;
    version = host.fs.readVersioned(file);
    if (args.revision !== version.revision)
      throw new Error("Record changed or revision missing. Inspect the preset again.");
    record = JSON.parse(version.text);
    if (record.studio?.readOnly)
      throw new Error("Preset is locked. Create an editable copy.");
  }
  record.studio ??= {};
  if (args.section !== undefined) {
    const found = inspect({ preset: args.preset, section: args.section }, host).matches[0];
    if (!found || found.sections.length !== 1)
      throw new Error("Choose exactly one section");
    const id = found.sections[0].identifier;
    const prompts = record.prompts.filter((item) => item.identifier === id), sections = (record.studio.sections ?? []).filter((item) => item.id === id);
    const layout = (record.prompt_order ?? []).find((item) => String(item.character_id) === "100001" && item.order?.length) ?? (record.prompt_order ?? []).find((item) => item.order?.length);
    const orders = layout?.order.filter((item) => item.identifier === id) ?? [];
    if (prompts.length !== 1 || sections.length !== 1 || orders.length !== 1)
      throw new Error("Section mapping is missing or duplicated; inspect and repair it before editing");
    const prompt = prompts[0], section = sections[0], patch = args.patch ?? {};
    if (Object.keys(patch).some((key) => !["content", "enabled", "name", "role", "position", "depth", "injectionTriggers", "condition", "groupId", "forbidOverrides"].includes(key)))
      throw new Error("Unsupported section field; follow the prompt schema for structural changes");
    merge(section, patch);
    for (const key of ["content", "name", "role"])
      if (Object.hasOwn(patch, key))
        prompt[key] = section[key];
    if (Object.hasOwn(patch, "role") && !["system", "user", "assistant"].includes(section.role))
      throw new Error("Invalid section role");
    if (Object.hasOwn(patch, "enabled"))
      orders[0].enabled = section.enabled;
    if (Object.hasOwn(patch, "injectionTriggers"))
      prompt.injection_trigger = section.injectionTriggers;
    if (Object.hasOwn(patch, "position") || Object.hasOwn(patch, "depth")) {
      if (!["relative", "in-chat"].includes(section.position))
        throw new Error("Invalid section position");
      if (section.position === "in-chat") {
        if (!Number.isInteger(section.depth) || section.depth < 0)
          throw new Error("Invalid injection depth");
        prompt.injection_position = "absolute";
        prompt.injection_depth = section.depth;
      } else {
        delete prompt.injection_position;
        delete prompt.injection_depth;
      }
    }
  } else if (args.patch) {
    if (Object.keys(args.patch).some((key) => ["id", "prompts", "prompt_order", "studio", "utilityPrompts"].includes(key) || Object.values(samplerKeys).includes(key) || ["openai_max_tokens", "openai_max_context", "seed", "stop", "reasoning", "thinkingBudget", "reasoningTags"].includes(key)))
      throw new Error("Use section, samplers, utilityPrompts, or studio arguments for paired values");
    merge(record, args.patch);
    if (Object.hasOwn(args.patch, "name"))
      record.studio.name = record.name;
  }
  if (args.studio) {
    if (["id", "name", "sections", "samplers", "utilityPrompts", "readOnly", "extendedSamplers"].some((key) => Object.hasOwn(args.studio, key)))
      throw new Error("Use paired arguments for these editor fields");
    merge(record.studio, args.studio);
  }
  if (args.samplers)
    samplers(record, args.samplers);
  if (args.utilityPrompts) {
    merge(record.utilityPrompts ??= {}, args.utilityPrompts);
    merge(record.studio.utilityPrompts ??= {}, args.utilityPrompts);
  }
  if (args.extendedSamplers) {
    merge(record.studio.extendedSamplers ??= {}, args.extendedSamplers);
    for (const [key, value] of Object.entries(args.extendedSamplers)) {
      if (!["number", "boolean", "string"].includes(typeof value) || ["id", "name", "studio", "prompts", "prompt_order", "utilityPrompts", "openai_max_tokens", "openai_max_context", "seed", "stop", "reasoning", "thinkingBudget", "reasoningTags", ...Object.values(samplerKeys)].includes(key) || record[key] !== undefined && typeof record[key] === "object")
        throw new Error("Invalid extended sampler");
      record[key] = value;
    }
  }
  return { writes: [{ path: file, expectedRevision: version.revision, content: JSON.stringify(record, null, 2) + `
` }], result: { id: record.id, section: args.section ?? null } };
}
export {
  edit
};
