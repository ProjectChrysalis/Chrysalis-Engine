
import { useEffect, useState } from 'react'
import { SpeakerHigh } from '@phosphor-icons/react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { useApp } from '@/lib/store'
import { fetchEdgeVoices, fetchSpeechEndpoints, type SpeechEndpointInfo } from '@/lib/engine'
import { edgeVoiceLabel, speakText, stopSpeaking, TTS_PROVIDERS } from '@/lib/tts'

const TEST_LINE = 'The lantern light caught the rain as she stepped into the alley.'

export function TtsTab() {
  const tts = useApp((s) => s.settings.tts)
  const updateSettings = useApp((s) => s.updateSettings)
  const up = (patch: Partial<typeof tts>) => updateSettings({ tts: { ...tts, ...patch } })
  const [testing, setTesting] = useState(false)
  const [edgeVoices, setEdgeVoices] = useState<string[]>([])
  const [endpoints, setEndpoints] = useState<SpeechEndpointInfo[]>([])

  const isEngine = tts.provider === 'Engine'
  const isSystem = tts.provider === 'System (Web Speech)'
  const engineIsEdge = (tts.engineProvider ?? 'edge') === 'edge'
  const activeEndpoint = endpoints.find((e) => e.id === tts.engineProvider)

  useEffect(() => {
    if (isEngine) {
      void fetchEdgeVoices().then(setEdgeVoices)
      void fetchSpeechEndpoints().then(setEndpoints)
    }
  }, [isEngine])

  const test = async () => {
    setTesting(true)
    try {
      const played = await speakText(TEST_LINE, tts)
      if (!played) toast.info('Pick a provider first')
    } catch (e) {
      toast.error('TTS failed', { description: (e as Error).message })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className="flex max-w-lg flex-col gap-4">
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <SpeakerHigh className="size-4 shrink-0" aria-hidden="true" />
        Per-message Speak and auto-play, from the browser’s voices or the engine.
      </p>
      <FieldGroup>
        <Field>
          <FieldLabel>Provider</FieldLabel>
          <Select value={tts.provider || TTS_PROVIDERS[0]} onValueChange={(v) => v && up({ provider: v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {TTS_PROVIDERS.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>

        {isEngine && (
          <>
            <Field>
              <FieldLabel>Engine voice source</FieldLabel>
              <Select
                value={tts.engineProvider ?? 'edge'}
                onValueChange={(v) => v && up({ engineProvider: v, narratorVoice: v === 'edge' ? 'en-US-AriaNeural' : (endpoints.find((e) => e.id === v)?.voice ?? 'alloy') })}
              >
                <SelectTrigger aria-label="Engine voice source">
                  <SelectValue>
                    {(v) => v === 'edge' ? 'Edge voices (free, no key)' : (endpoints.find((e) => e.id === v)?.name ?? String(v))}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="edge">Edge voices (free, no key)</SelectItem>
                    {endpoints.map((e) => (
                      <SelectItem key={e.id} value={e.id}>{e.name} · {e.model}</SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>

            {engineIsEdge ? (
              <Field>
                <FieldLabel>Voice</FieldLabel>
                <Select
                  value={(edgeVoices.length ? edgeVoices : ['en-US-AriaNeural']).includes(tts.narratorVoice) ? tts.narratorVoice : 'en-US-AriaNeural'}
                  onValueChange={(v) => v && up({ narratorVoice: v })}
                >
                  <SelectTrigger aria-label="Voice">
                    <SelectValue>{(v) => edgeVoiceLabel(String(v))}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {(edgeVoices.length ? edgeVoices : ['en-US-AriaNeural']).map((v) => (
                        <SelectItem key={v} value={v}>{edgeVoiceLabel(v)}</SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            ) : (
              <>
                <Field>
                  <FieldLabel>Speech model</FieldLabel>
                  <Input
                    value={tts.model}
                    onChange={(e) => up({ model: e.target.value })}
                    placeholder={activeEndpoint?.model ?? 'tts-1'}
                    className="font-mono text-xs"
                    aria-label="Speech model"
                  />
                </Field>
                <Field>
                  <FieldLabel>Voice</FieldLabel>
                  <Input
                    value={tts.narratorVoice}
                    onChange={(e) => up({ narratorVoice: e.target.value })}
                    placeholder={activeEndpoint?.voice ?? 'alloy'}
                    className="font-mono text-xs"
                    aria-label="Voice"
                  />
                </Field>
              </>
            )}
          </>
        )}
        {isSystem && (
          <Field>
            <FieldLabel>Narrator voice</FieldLabel>
            <Input
              value={tts.narratorVoice}
              onChange={(e) => up({ narratorVoice: e.target.value })}
              placeholder="matches your OS voice list, e.g. aria / google us english"
              className="text-xs"
              aria-label="Narrator voice"
            />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Matched loosely against the browser&apos;s voice names (per-message Speak + auto-play).
            </p>
          </Field>
        )}

        <Field>
          <FieldLabel>Speed: {tts.speed.toFixed(2)}x</FieldLabel>
          <Slider value={[tts.speed]} min={0.5} max={2} step={0.05} onValueChange={(v) => up({ speed: (Array.isArray(v) ? v[0] : (v as number)) })} />
        </Field>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void test()} disabled={testing || tts.provider === 'None'}>
            Test voice
          </Button>
          <Button variant="ghost" size="sm" onClick={() => stopSpeaking()}>
            Stop
          </Button>
        </div>

        <Field orientation="horizontal">
          <FieldLabel htmlFor="tts-auto">Auto-play new replies</FieldLabel>
          <Switch id="tts-auto" checked={tts.autoPlay} onCheckedChange={(v) => up({ autoPlay: v })} />
        </Field>
        <Field orientation="horizontal">
          <FieldLabel htmlFor="tts-quotes">Only narrate quotes</FieldLabel>
          <Switch id="tts-quotes" checked={tts.onlyQuotes} onCheckedChange={(v) => up({ onlyQuotes: v })} />
        </Field>
        <Field orientation="horizontal">
          <FieldLabel htmlFor="tts-ast">Skip *asterisked* text</FieldLabel>
          <Switch id="tts-ast" checked={tts.skipAsterisks} onCheckedChange={(v) => up({ skipAsterisks: v })} />
        </Field>
        <Field orientation="horizontal">
          <FieldLabel htmlFor="tts-code">Skip code blocks</FieldLabel>
          <Switch id="tts-code" checked={tts.skipCodeblocks} onCheckedChange={(v) => up({ skipCodeblocks: v })} />
        </Field>
      </FieldGroup>
    </div>
  )
}
