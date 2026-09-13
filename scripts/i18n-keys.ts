// Keep client/src/i18n/en.ts in step with the tr("…") call sites in the shell.
// Run after adding or removing user-facing copy:
//   bun scripts/i18n-keys.ts
// Then fill the new keys in every locale dictionary (test/i18n.test.ts fails
// until each locale answers all of them). Run from the repo root.
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve("client/src")
const keys = new Set<string>()
function walk(dir: string) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === "i18n") continue
      walk(p)
    } else if (/\.tsx?$/.test(e.name)) {
      const src = fs.readFileSync(p, "utf8")
      for (const m of src.matchAll(/\btr\(\s*("(?:[^"\\]|\\.)*")/g)) {
        keys.add(JSON.parse(m[1]!) as string)
      }
    }
  }
}
walk(ROOT)

const sorted = [...keys].sort()
const en = `// English source keys for the shell. The keys ARE the copy: tr() interpolates
// {name} placeholders and falls back to the key itself, so a locale dictionary
// only needs the entries it translates.
const en = {
${sorted.map((k) => `  ${JSON.stringify(k)}: "",`).join("\n")}
} as const

export default en
`
fs.writeFileSync("client/src/i18n/en.ts", en)
console.log(`wrote en.ts (${sorted.length} keys)`)
