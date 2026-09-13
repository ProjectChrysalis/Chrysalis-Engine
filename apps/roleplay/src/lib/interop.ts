// ── Import/export interop: browser downloads, plus re-exports of the pure
// portable-shape converters (card PNG reading included) ──
export { presetExport, presetImport, regexImport, regexExport, extractCharaFromPng } from './import-shapes.js'

// ─── Download helper ───
export function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // revoking in the same tick cancels the download on browsers that fetch the
  // blob after the click returns
  setTimeout(() => URL.revokeObjectURL(url), 40_000)
}
