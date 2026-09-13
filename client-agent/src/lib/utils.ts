import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Display name for a model label or qualified ref: the segment after the
 *  last slash, without the "Vendor: " prefix aggregator catalogs put in front
 *  of the name. Selection keys stay full — display only. */
export function shortModelName(id: string): string {
  const i = id.lastIndexOf("/");
  const name = i === -1 ? id : id.slice(i + 1);
  return name.replace(/^[^:]{1,40}:\s+(?=\S)/, "");
}

/** Clipboard write that survives an insecure origin (plain http on a LAN
 *  address): `navigator.clipboard` is undefined there, and where it exists
 *  writeText still rejects when the document isn't focused. The fallback
 *  selects a throwaway textarea, which must sit inside the topmost open
 *  dialog or the selection is blocked. Resolves to whether the text actually
 *  reached the clipboard. */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the selection-based path
    }
  }
  if (typeof document === "undefined") return false;
  const dialogs = document.querySelectorAll<HTMLElement>(
    'dialog[open], [role="dialog"]',
  );
  const parent = dialogs[dialogs.length - 1] ?? document.body;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText =
    "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
  parent.appendChild(area);
  try {
    area.focus();
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
