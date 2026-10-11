// .agents/lib/data-tools.js
var forbidden = new Set(["__proto__", "prototype", "constructor"]);
var own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
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
export {
  inspect
};
