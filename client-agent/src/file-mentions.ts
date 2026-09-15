import type {
  Unstable_DirectiveFormatter,
  Unstable_TriggerAdapter,
  Unstable_TriggerItem,
} from "@assistant-ui/core"

/**
 * What a picked file leaves in the message: the path, after the "@" that opened
 * the picker. The stock formatter writes the directive syntax it uses to render
 * mentions as chips (`:file[plugin.js]{name=plugins/…}`), which is not what
 * anyone meant to say, and is what the model would have read.
 */
export const filePathDirective: Unstable_DirectiveFormatter = {
  serialize: (item) => `@${item.id}`,
  // the result is ordinary text, so there is nothing to parse back out
  parse: (text) => [{ kind: "text", text }],
}

export const fileTriggerItem = (path: string): Unstable_TriggerItem => ({
  id: path,
  type: "file",
  label: path.split("/").pop() || path,
  description: path,
})

/**
 * A flat trigger adapter over a list of workspace paths.
 *
 * Flat matters: offering a category makes the popover open on a folder to drill
 * into rather than on the files, and since it only renders items once a
 * category is active or a search is running, it opens as an empty sliver and
 * stays that way until something is typed.
 *
 * `onQuery` is how the caller refreshes `files` from the engine — the adapter
 * contract is synchronous, so a search answers from what is already loaded and
 * asks for what was just typed.
 */
export function fileTriggerAdapter(files: readonly string[], onQuery: (q: string) => void): Unstable_TriggerAdapter {
  return {
    categories: () => [],
    categoryItems: () => [],
    search: (query: string) => {
      const q = query.toLowerCase()
      onQuery(q)
      return files.filter((p) => p.toLowerCase().includes(q)).map(fileTriggerItem)
    },
  }
}
