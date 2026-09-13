
import { useEffect, useState } from "react"
import { ArrowCounterClockwise } from '@phosphor-icons/react'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Markdown } from "@/components/markdown"
import { useApp } from "@/lib/store"

const SAMPLE = `*She sets the lantern down, and the shadows lean away from it.* "You came back," she says — quieter than you expected. "I'd started to think you wouldn't."

*A pause.* "Sit. There's something you should hear before the others wake."`

/**
 * Quote and narration colors: the theme supplies defaults and these
 * two pickers override them globally. Live preview uses the real renderer so
 * what you see is exactly what messages will look like.
 */
export function ProseColorsSection() {
  const settings = useApp((s) => s.settings)
  const updateSettings = useApp((s) => s.updateSettings)
  const themes = useApp((s) => s.themes)
  const theme = themes.find((t) => t.id === settings.activeThemeId)

  const quoteFallback = theme?.colors.quotes ?? "#8fb8e0"
  const italicsFallback = theme?.colors.italics ?? "#9d9d9d"

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Prose colors</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Applies to every message, including text that is still streaming in.
        </p>
      </div>

      <ColorRow
        id="quote-color"
        label="Quoted dialogue"
        hint={`Theme default: ${quoteFallback}`}
        value={settings.quoteColor}
        fallback={quoteFallback}
        onChange={(v) => updateSettings({ quoteColor: v })}
      />
      <ColorRow
        id="italics-color"
        label="Narration / *actions*"
        hint={`Theme default: ${italicsFallback}`}
        value={settings.italicsColor}
        fallback={italicsFallback}
        onChange={(v) => updateSettings({ italicsColor: v })}
      />

      <div className="flex flex-col gap-1.5">
        <Label className="text-xs">Preview</Label>
        <div className="rounded-lg border border-border bg-card p-3">
          <Markdown content={SAMPLE} />
        </div>
      </div>
    </div>
  )
}

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

function ColorRow({
  id, label, hint, value, fallback, onChange,
}: {
  id: string
  label: string
  hint: string
  value: string
  fallback: string
  onChange: (v: string) => void
}) {
  // The text field holds a local draft and only commits valid hex (or empty,
  // which means "follow the theme") — otherwise a half-typed "#e" would be
  // stored and coerce the live quote color to black while you type.
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])

  const commitDraft = (raw: string) => {
    const v = raw.trim()
    setDraft(v)
    if (v === "" || HEX_RE.test(v)) onChange(v)
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <Label htmlFor={id} className="text-sm">{label}</Label>
          <p className="text-[11px] text-muted-foreground">{value ? "Custom override" : hint}</p>
        </div>
        <input
          id={id}
          type="color"
          value={value || fallback}
          onChange={(e) => onChange(e.target.value)}
          className="size-8 shrink-0 cursor-pointer rounded border border-border bg-transparent"
          aria-label={`${label} color`}
        />
        <Input
          value={draft}
          onChange={(e) => commitDraft(e.target.value)}
          placeholder={fallback}
          className="h-8 w-28 font-mono text-xs"
          aria-label={`${label} hex value`}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => onChange("")}
          disabled={!value}
          aria-label={`Reset ${label} to theme default`}
          title="Reset to theme default"
        >
          <ArrowCounterClockwise aria-hidden="true" />
        </Button>
      </div>
    </div>
  )
}
