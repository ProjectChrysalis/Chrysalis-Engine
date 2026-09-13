/** Browser-persisted UI preferences (theme, language, tab strip, split).
 *  Touching localStorage THROWS where a browser blocks site data (private
 *  windows, "block all cookies", an embedded frame). The shell reads these
 *  while it is being constructed, so an unguarded read takes down the whole
 *  app before it paints. */
export const prefs = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value)
    } catch {
      // preference is session-only; never fail the action it rode along with
    }
  },
  remove(key: string): void {
    try {
      localStorage.removeItem(key)
    } catch {
      // nothing stored means nothing to clear
    }
  },
}
