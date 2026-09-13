// Tiny i18n for the shell. English strings ARE the keys: `tr("Save")` looks up
// the current locale's dictionary, falls back to the English key, then to the
// key itself, so a missing translation degrades to English, never to blank UI.
// `{name}` placeholders interpolate from the second argument.
import { useSyncExternalStore } from "react"
import { prefs } from "../prefs"
import { LOCALES, RTL, type Locale } from "./locales"
import de from "./de"
import en from "./en"
import es from "./es"
import fr from "./fr"
import it from "./it"
import ja from "./ja"
import ko from "./ko"
import nl from "./nl"
import pl from "./pl"
import pt from "./pt"
import ru from "./ru"
import trDict from "./tr"
import zh from "./zh"

export { LOCALES, type Locale } from "./locales"

export type Vars = Record<string, string | number>

let locale: Locale = detect()
const listeners = new Set<() => void>()

function detect(): Locale {
  const saved = prefs.get("chrysalis-lang")
  if (saved && saved in LOCALES) return saved as Locale
  const tags = typeof navigator === "undefined" ? [] : [navigator.language, ...(navigator.languages ?? [])]
  for (const tag of tags) {
    const lower = tag.toLowerCase()
    if (lower in LOCALES) return lower as Locale
    const primary = lower.split("-")[0]!
    if (primary in LOCALES) return primary as Locale
  }
  return "en"
}

export const getLocale = (): Locale => locale

export function setLocale(next: Locale): void {
  if (next === locale) return
  locale = next
  prefs.set("chrysalis-lang", next)
  applyDomLocale()
  for (const fn of listeners) fn()
}

function applyDomLocale(): void {
  if (typeof document === "undefined") return
  document.documentElement.lang = locale
  document.documentElement.dir = RTL.has(locale) ? "rtl" : "ltr"
}
applyDomLocale()

const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Re-render a component when the language changes. */
export const useLocale = (): Locale => useSyncExternalStore(subscribe, getLocale, getLocale)

type Dict = Record<string, string>

// Static imports: the shell bundles every dictionary, so a language switch is
// one synchronous lookup with no loading state to design around.
const DICTS: Record<Locale, Dict> = { en, de, es, fr, it, ja, ko, nl, pl, pt, ru, tr: trDict, zh }

export type Key = keyof typeof en

export function tr(key: Key, vars?: Vars): string {
  const dict = DICTS[locale]
  const text = (dict && dict[key]) || en[key] || key
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m))
}

/** Dictionary completeness: every locale answers every English key with no
 *  extras. Used by the test suite and by nothing at runtime. */
export const localeKeys = (l: Locale): string[] => Object.keys(DICTS[l] ?? {})
export const englishKeys = (): string[] => Object.keys(en)
