/** The locales the shell ships. Kept in its own module so the dictionary
 *  parity test can import it without pulling in React. */
export const LOCALES = {
  en: "English",
  de: "Deutsch",
  es: "Español",
  fr: "Français",
  it: "Italiano",
  ja: "日本語",
  ko: "한국어",
  nl: "Nederlands",
  pl: "Polski",
  pt: "Português",
  ru: "Русский",
  tr: "Türkçe",
  zh: "简体中文",
} as const
export type Locale = keyof typeof LOCALES

/** Locales written right to left. */
export const RTL: ReadonlySet<string> = new Set()
