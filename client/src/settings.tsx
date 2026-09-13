// Settings dialog: vertical tab sidebar, drilling down to sections on phones.
// API tab: provider connection flow — pick a provider
// (all pi-ai providers, logos, search), name it, paste the key; or define a
// custom OpenAI-compatible / Anthropic endpoint. Keys never leave the server.
import { useEffect, useRef, useState, type ReactNode } from "react"
import { Dialog } from "./ui/dialog"
import { cn } from "./ui/cn"
import { useResource } from "./use-resource"
import { Tabs } from "./ui/tabs"
import { ProviderIcon } from "./ui/provider-icon"
import { Icon } from "./ui/icon"
import { IconSmall } from "./ui/icon"
import { Button } from "./ui/button"
import { IconButton } from "./ui/button"
import { Select } from "./ui/select"
import {
  api,
  connectionsApi,
  mcpApi,
  listProviders,
  personaApi,
  prefs,
  authApi,
  adminUsersApi,
  oauthApi,
  avatarApi,
  speechApi,
  listPromptFormats,
  type PromptFormat,
  type SpeechEndpoint,
  type EngineConnection,
  type EngineProvider,
  type OAuthFlow,
} from "./api"
import type { Me } from "./types"
import { ServerTab } from "./server-settings"
import { LOCALES, setLocale, tr, useLocale, type Locale } from "./i18n/index"

export const inputClass =
  "min-w-0 flex-1 rounded-lg border border-line bg-panel px-3 py-1.5 text-13 text-ink outline-none placeholder:text-ink-faint focus:border-line-focus"

const POPULAR = ["anthropic", "openai", "google", "deepseek", "openrouter", "groq", "mistral", "xai", "github-copilot", "zai"]

type CustomPick = {
  id: "__custom_openai" | "__custom_anthropic" | "__custom_responses" | "__custom_google" | "__custom_text"
  label: string
  kind: "builtin"
  baseUrl: null
  apiKeyAuth: true
  hasKey: false
}
/** A model server the user runs themselves: an OpenAI-compatible endpoint at
 *  the server's default address, usually without a key. */
type LocalPick = {
  id: `__local_${string}`
  label: string
  kind: "builtin"
  baseUrl: string
  apiKeyAuth: true
  hasKey: false
}
const LOCAL_SERVERS: LocalPick[] = [
  { id: "__local_aphrodite", label: "Aphrodite", baseUrl: "http://localhost:2242/v1" },
  { id: "__local_koboldcpp", label: "KoboldCpp", baseUrl: "http://localhost:5001/v1" },
  { id: "__local_llamacpp", label: tr("llama.cpp server"), baseUrl: "http://localhost:8080/v1" },
  { id: "__local_litellm", label: "LiteLLM", baseUrl: "http://localhost:4000/v1" },
  { id: "__local_ollama", label: "Ollama", baseUrl: "http://localhost:11434/v1" },
  { id: "__local_lmstudio", label: "LM Studio", baseUrl: "http://localhost:1234/v1" },
  { id: "__local_textgen", label: "Text Generation WebUI", baseUrl: "http://localhost:5000/v1" },
  { id: "__local_tabbyapi", label: "TabbyAPI", baseUrl: "http://localhost:5000/v1" },
  { id: "__local_vllm", label: "vLLM", baseUrl: "http://localhost:8000/v1" },
].map((s) => ({ ...s, id: s.id as LocalPick["id"], kind: "builtin" as const, apiKeyAuth: true as const, hasKey: false as const }))
/** Sign-in pick, straight to its flow: subscription OAuth or a guided
 *  credential setup (Vertex ADC, AWS profile, Cloudflare ids). */
type OAuthPick = { id: string; providerId: string; label: string; kind: "builtin"; baseUrl: null; apiKeyAuth: false; hasKey: false; authKind: "oauth" | "credentials"; needsGateway?: boolean }
type ProviderPick = EngineProvider | CustomPick | OAuthPick | LocalPick

export type TabValue = "general" | "api" | "speech" | "agent" | "mcp" | "developer" | "server" | "users"

export function SettingsBody(props: { onClose: () => void; me: Me; initialTab?: TabValue | null; onLogout: () => void }) {
  const [tab, setTab] = useState<TabValue>(props.initialTab ?? "api")
  const tabs: Array<{ value: TabValue; label: string; icon: ReactNode }> = [
    { value: "general", label: tr("General"), icon: <IconSmall name="outline-sliders" /> },
    { value: "api", label: tr("API connections"), icon: <Icon name="cloud-upload" /> },
    { value: "speech", label: tr("Speech"), icon: <Icon name="speaker" /> },
    { value: "agent", label: tr("Agent"), icon: <Icon name="brain" /> },
    { value: "mcp", label: tr("MCP servers"), icon: <Icon name="terminal-active" /> },
    { value: "developer", label: tr("Developer"), icon: <Icon name="code" /> },
    ...(props.me.role === "admin"
      ? [
          { value: "server" as const, label: tr("Server"), icon: <Icon name="server" /> },
          { value: "users" as const, label: tr("Users"), icon: <Icon name="bubble-5" /> },
        ]
      : []),
  ]

  // phones get drill-down navigation (menu → section → back) instead of the
  // desktop sidebar: five labels in a tab row can't breathe at 390px
  const [mobile, setMobile] = useState(typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches)
  const [openSection, setOpenSection] = useState<TabValue | null>(null)
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)")
    const fn = () => setMobile(mq.matches)
    mq.addEventListener("change", fn)
    return () => mq.removeEventListener("change", fn)
  }, [])

  const paneFor = (v: TabValue) => (
    <>
      {v === "general" && <GeneralTab me={props.me} onLogout={props.onLogout} />}
      {v === "api" && <ApiTab />}
      {v === "speech" && <SpeechTab />}
      {v === "agent" && <AgentTab />}
      {v === "mcp" && <McpTab />}
      {v === "developer" && <DeveloperTab />}
      {v === "server" && <ServerTab />}
      {v === "users" && <UsersTab me={props.me} />}
    </>
  )

  return (
    <Dialog size="x-large" transition>
      {!mobile ? <Tabs
          orientation="vertical"
          variant="settings"
          value={tab}
          onValueChange={(value) => setTab(value as TabValue)}
          className="h-full"
        >
          <Tabs.List>
            <div className="flex h-full w-full flex-col justify-between">
              <div className="flex w-full flex-col gap-3 pt-3">
                <Tabs.SectionTitle>{tr("Settings")}</Tabs.SectionTitle>
                <div className="flex w-full flex-col gap-1.5">
                  {tabs.map((t) => (
                      <Tabs.Trigger key={t.value} value={t.value}>
                        {t.icon}
                        {t.label}
                      </Tabs.Trigger>
                    ))}
                </div>
              </div>
            </div>
          </Tabs.List>
          <Tabs.Content value="general" className="no-scrollbar">
            <GeneralTab me={props.me} onLogout={props.onLogout} />
          </Tabs.Content>
          <Tabs.Content value="api" className="no-scrollbar">
            <ApiTab />
          </Tabs.Content>
          <Tabs.Content value="speech" className="no-scrollbar">
            <SpeechTab />
          </Tabs.Content>
          <Tabs.Content value="agent" className="no-scrollbar">
            <AgentTab />
          </Tabs.Content>
          <Tabs.Content value="mcp" className="no-scrollbar">
            <McpTab />
          </Tabs.Content>
          <Tabs.Content value="developer" className="no-scrollbar">
            <DeveloperTab />
          </Tabs.Content>
          <Tabs.Content value="server" className="no-scrollbar">
            <ServerTab />
          </Tabs.Content>
          <Tabs.Content value="users" className="no-scrollbar">
            <UsersTab me={props.me} />
          </Tabs.Content>
        </Tabs> : <div className="flex h-full min-h-0 flex-col">
            {openSection ? (
                <>
                  <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-line pl-2 pr-2">
                    <IconButton
                      icon={<IconSmall name="chevron-left" />}
                      variant="ghost-muted"
                      title={tr("Back")}
                      onClick={() => setOpenSection(null)}
                    />
                    <span className="min-w-0 flex-1 truncate text-14 font-medium text-ink">
                      {tabs.find((t) => t.value === (openSection))?.label}
                    </span>
                    <IconButton
                      icon={<IconSmall name="outline-xmark" />}
                      variant="ghost-muted"
                      title={tr("Close settings")}
                      onClick={() => props.onClose()}
                    />
                  </div>
                  <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto">{paneFor(openSection)}</div>
                </>
              ) : <div className="flex h-full min-h-0 flex-col overflow-y-auto px-3 pb-4 pt-4">
                  <div className="flex items-center justify-between px-1.5 pb-2">
                    <h2 className="text-15 font-medium tracking-[-0.13px] text-ink">{tr("Settings")}</h2>
                    <IconButton
                      icon={<IconSmall name="outline-xmark" />}
                      variant="ghost-muted"
                      title={tr("Close settings")}
                      onClick={() => props.onClose()}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {tabs.map((t) => (
                        <button key={t.value}
                          className="flex min-h-12 w-full items-center gap-3 rounded-xl px-3.5 py-2.5 text-left text-14 text-ink transition-colors hover:bg-hover active:bg-pressed"
                          onClick={() => setOpenSection(t.value)}
                        >
                          <span className="flex size-7 shrink-0 items-center justify-center text-icon">{t.icon}</span>
                          <span className="min-w-0 flex-1 truncate">{t.label}</span>
                          <IconSmall name="chevron-right" size="small" />
                        </button>
                      ))}
                  </div>
                </div>}
          </div>}
    </Dialog>
  )
}

export function Pane(props: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col gap-4 px-4 py-4 max-sm:px-3">
      <div className="flex shrink-0 flex-col gap-1">
        <h2 className="text-15 font-medium tracking-[-0.13px] text-ink">{props.title}</h2>
        <p className="text-13 text-ink-muted">{props.description}</p>
      </div>
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto">{props.children}</div>
    </div>
  )
}

// ------------------------------------------------------------------- speech

/** "en-US-AriaNeural" → "Aria — English (US)". The ShortName stays the wire
 *  value (the service requires it verbatim); only the menu shows a label. */
const EDGE_LANG_NAMES: Record<string, string> = {
  "en-US": "English (US)", "en-GB": "English (UK)", "en-AU": "English (Australia)",
  "en-IE": "English (Ireland)", "en-IN": "English (India)", "en-CA": "English (Canada)",
  "es-ES": "Spanish (Spain)", "es-MX": "Spanish (Mexico)", "fr-FR": "French (France)",
  "fr-CA": "French (Canada)", "de-DE": "German", "it-IT": "Italian", "pt-BR": "Portuguese (Brazil)",
  "pt-PT": "Portuguese (Portugal)", "nl-NL": "Dutch", "pl-PL": "Polish", "ru-RU": "Russian",
  "tr-TR": "Turkish", "ja-JP": "Japanese", "ko-KR": "Korean", "zh-CN": "Chinese (Mandarin)",
  "zh-TW": "Chinese (Taiwan)", "ar-EG": "Arabic (Egypt)", "ar-SA": "Arabic (Saudi)",
  "hi-IN": "Hindi", "id-ID": "Indonesian", "vi-VN": "Vietnamese", "th-TH": "Thai", "uk-UA": "Ukrainian",
}
function edgeVoiceLabel(v: string): string {
  const m = /^([a-z]{2}-[A-Z]{2})-(.+?)Neural$/.exec(v)
  if (!m) return v
  return `${m[2]} · ${EDGE_LANG_NAMES[m[1]!] ?? m[1]}`
}


/** Play a synthesized sample through the engine so a provider can be
 *  verified with one click before any app uses it. */
async function playSample(body: { provider: "edge" | "endpoint"; endpointId?: string; voice?: string; model?: string }) {
  const r = await speechApi.speak({ text: tr("Hello. This is your speech connection, working."), ...body })
  await new Audio(r.dataUrl).play()
}

function SpeechTab() {
  const endpoints = useResource(() => speechApi.list())
  const edgeVoices = useResource(() => speechApi.voices())
  const [edgeVoice, setEdgeVoice] = useState("en-US-AriaNeural")
  const [testing, setTesting] = useState<string | null>(null)
  const [err, setErr] = useState("")
  const [adding, setAdding] = useState(false)

  const test = async (id: string) => {
    setTesting(id)
    setErr("")
    try {
      await playSample({ provider: "endpoint", endpointId: id })
    } catch (e: any) {
      setErr(e.message ?? String(e))
    } finally {
      setTesting(null)
    }
  }

  const testEdge = async () => {
    setTesting("edge")
    setErr("")
    try {
      await playSample({ provider: "edge", voice: edgeVoice })
    } catch (e: any) {
      setErr(e.message ?? String(e))
    } finally {
      setTesting(null)
    }
  }

  return (
    <Pane title={tr("Speech")} description={tr("Text-to-speech for every app. Free Edge voices, or your own speech endpoints. Keys stay on your machine.")}>
      <div className="flex flex-col gap-4 pb-4">
        <section className="flex flex-col gap-2 rounded-lg border border-line p-3">
          <div className="flex items-center gap-2">
            <h3 className="flex-1 text-13 font-medium text-ink">{tr("Edge voices")}</h3>
            <Button variant="neutral" size="small" className="gap-1.5" disabled={testing !== null} onClick={() => testEdge()}>
              {testing === "edge" ? tr("Testing…") : tr("Test")}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Select
              className="flex-1"
              placeholder={tr("Edge voice")}
              options={edgeVoices.data ?? []}
              current={edgeVoice}
              value={(v) => v}
              label={(v) => edgeVoiceLabel(v)}
              onSelect={(v) => v && setEdgeVoice(v)}
            />
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <h3 className="flex-1 text-13 font-medium text-ink">{tr("Speech endpoints")}</h3>
            {!adding ? <Button variant="neutral" size="small" className="gap-1.5" onClick={() => { setErr(""); setAdding(true) }}>
                <IconSmall name="grid-plus" />
                {tr("Add endpoint")}
              </Button> : null}
          </div>
          {!endpoints.loading ? <>{(endpoints.data ?? []).map((ep: SpeechEndpoint) => (
                <div key={ep.id} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2 text-13">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{ep.name}</span>
                    <span className="block truncate text-11 text-ink-faint">
                      {ep.model} · {ep.baseUrl}
                    </span>
                  </span>
                  <span className={cn("size-1.5 shrink-0 rounded-full", { "bg-success": ep.hasKey, "bg-ink-faint": !ep.hasKey })} />
                  <Button variant="ghost-muted" size="small" disabled={testing !== null} onClick={() => test(ep.id)}>
                    {testing === ep.id ? tr("Testing…") : tr("Test")}
                  </Button>
                  <IconButton
                    icon={<IconSmall name="outline-xmark" />}
                    variant="ghost-muted"
                    size="small"
                    title={tr("Delete endpoint")}
                    onClick={async () => {
                      try {
                        await speechApi.remove(ep.id)
                        endpoints.refetch()
                      } catch (e: any) {
                        setErr(e.message ?? String(e))
                      }
                    }}
                  />
                </div>
              ))}
            {(endpoints.data ?? []).length === 0 && !adding ? <div className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-13 text-ink-faint">
                {tr("No speech endpoints. OpenAI, Groq or a local server (Kokoro, openedai-speech) all speak /audio/speech.")}
              </div> : null}</>: <div className="text-13 text-ink-faint">{tr("Loading…")}</div>}
          {adding ? <AddSpeechEndpoint
              onCancel={() => setAdding(false)}
              onCreated={() => {
                setAdding(false)
                endpoints.refetch()
              }}
            /> : null}
          {err ? <div className="text-12 text-danger">{err}</div> : null}
        </section>
      </div>
    </Pane>
  )
}

function AddSpeechEndpoint(props: { onCancel: () => void; onCreated: () => void }) {
  const [name, setName] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [model, setModel] = useState("tts-1")
  const [voice, setVoice] = useState("alloy")
  const [key, setKey] = useState("")
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    setErr("")
    try {
      await speechApi.create({ name: name, baseUrl: baseUrl, model: model, voice: voice, ...(key ? { key: key } : {}) })
      props.onCreated()
    } catch (e: any) {
      setErr(e.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-line p-3">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-13 font-medium text-ink">{tr("New speech endpoint")}</h3>
        <IconButton icon={<IconSmall name="outline-xmark" />} variant="ghost-muted" size="small" title={tr("Cancel")} onClick={props.onCancel} />
      </div>
      <input className={inputClass} placeholder={tr("Name (e.g. OpenAI speech)")} value={name} onChange={(e) => setName(e.currentTarget.value)} />
      <input className={inputClass} placeholder="Base URL (https://api.openai.com/v1)" value={baseUrl} onChange={(e) => setBaseUrl(e.currentTarget.value)} />
      <input className={inputClass} placeholder={tr("Model (tts-1, gpt-4o-mini-tts, playai-tts…)")} value={model} onChange={(e) => setModel(e.currentTarget.value)} />
      <input className={inputClass} placeholder={tr("Default voice (alloy, nova…)")} value={voice} onChange={(e) => setVoice(e.currentTarget.value)} />
      <input className={inputClass} type="password" placeholder={tr("API key (stored on this machine only)")} value={key} onChange={(e) => setKey(e.currentTarget.value)} />
      {err ? <div className="text-12 text-danger">{err}</div> : null}
      <Button variant="primary" size="small" className="self-start" disabled={busy || !name || !baseUrl} onClick={submit}>
        {busy ? tr("Saving…") : tr("Save endpoint")}
      </Button>
    </section>
  )
}

// ------------------------------------------------------------------- general

/** Shell language. The choice is local to this browser and applies live. */
function LanguageSection() {
  const locale = useLocale()
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-13 font-medium text-ink">{tr("Language")}</span>
        <Select
          appearance="inline"
          className="w-[200px]"
          options={Object.keys(LOCALES)}
          current={locale}
          value={(x) => x}
          label={(x) => LOCALES[x as Locale] ?? x}
          onSelect={(x) => x && setLocale(x as Locale)}
        />
      </div>
      <p className="text-11 text-ink-faint">{tr("Applies to this browser right away.")}</p>
    </div>
  )
}

function GeneralTab(props: { me: Me; onLogout: () => void }) {
  return (
    <Pane title={tr("General")} description={tr("Your account for this Chrysalis.")}>
      <div className="flex flex-col gap-6 pb-4">
        <LanguageSection />
        <AccountSection me={props.me} onLogout={props.onLogout} />
      </div>
    </Pane>
  )
}

/** Agent behavior: instructions + context management. */
function AgentTab() {
  const persona = useResource(() => personaApi.get())
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const value = () => (draft !== null ? draft! : persona.data ?? "")
  const dirty = () => draft !== null && draft !== (persona.data ?? "")

  const save = async () => {
    setSaving(true)
    try {
      await personaApi.put(draft ?? "")
      persona.mutate(draft ?? "")
      setDraft(null)
      setSaved(true)
      setTimeout(() => setSaved(false), 1500)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Pane title={tr("Agent")} description={tr("How your agent behaves and manages context across every app.")}>
      <div className="flex flex-col gap-6 pb-4">
        <InternetSection />
        <AutoCompactSection />
        <div className="flex flex-col gap-2">
          <h3 className="text-13 font-medium text-ink">{tr("Agent instructions")}</h3>
          <p className="text-12 text-ink-muted">
            {tr("Appended to your agent's system prompt (saved to persona.md, your agent can also edit it for you).")}
          </p>
          <textarea
            className="min-h-[160px] w-full resize-y rounded-lg border border-line bg-panel px-3 py-2 text-13 leading-5 text-ink outline-none placeholder:text-ink-faint focus:border-line-focus"
            placeholder={tr("e.g. Always answer briefly. Prefer TypeScript. When editing apps, run reload after changes.")}
            value={value()}
            onChange={(e) => setDraft(e.currentTarget.value)}
          />
          <div className="flex items-center gap-2">
            <Button variant="neutral" size="normal" disabled={!dirty() || saving} onClick={save}>
              {tr("Save instructions")}
            </Button>
            {dirty() ? <Button variant="ghost" size="normal" onClick={() => setDraft(null)}>
                {tr("Discard")}
              </Button> : null}
            {saved ? <span className="text-12 text-success">{tr("Saved")}</span> : null}
          </div>
        </div>
      </div>
    </Pane>
  )
}

/** Whether the agent's sandbox may reach the internet. Saved outside the
 *  workspace, so the agent cannot switch it back on for itself. */
function InternetSection() {
  const setting = useResource(() => api<{ internet: boolean }>("GET", "/v1/settings/sandbox"))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")

  const toggle = async (internet: boolean) => {
    setBusy(true)
    setErr("")
    try {
      setting.mutate(await api<{ internet: boolean }>("PUT", "/v1/settings/sandbox", { internet }))
    } catch (e: any) {
      setErr(e.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-13 font-medium text-ink">{tr("Sandbox")}</h3>
      <label className="flex items-center gap-2 text-13 text-ink">
        <input
          type="checkbox"
          className="size-4 accent-[var(--c-contrast)]"
          checked={setting.data?.internet ?? false}
          disabled={setting.loading || busy}
          onChange={(e) => void toggle(e.currentTarget.checked)}
        />
        {tr("Agent internet access")}
      </label>
      <p className="text-12 leading-4 text-ink-muted">
        {tr("Give the agent internet access in its sandbox, for curl, wget and pip. Your own computer and local network stay blocked.")}
      </p>
      {err ? <div className="text-12 text-danger">{err}</div> : null}
    </div>
  )
}

/** Auto-compact: fold the session into a summary when context grows past a
 * threshold (default: 80% of the model's context window). */
function AutoCompactSection() {
  const [enabled, setEnabled] = useState(true)
  const [limit, setLimit] = useState("") // "" = automatic (80% of context window)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")

  useEffect(() => {
    void (async () => {
      try {
        const s = await api<{ autoCompact: boolean | number }>("GET", "/v1/settings")
        if (s.autoCompact === false) setEnabled(false)
        else if (typeof s.autoCompact === "number") setLimit(String(s.autoCompact))
      } catch {}
      setLoaded(true)
    })()
  }, [])

  const save = async () => {
    setBusy(true)
    setErr("")
    try {
      const v = !enabled ? null : limit.trim() ? Math.floor(Number(limit)) : true
      if (typeof v === "number" && (!Number.isFinite(v) || v < 1000)) throw new Error(tr("threshold must be ≥ 1000 tokens"))
      await api("PUT", "/v1/settings", { autoCompact: v })
    } catch (e: any) {
      setErr(e.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-13 font-medium text-ink">{tr("Context")}</h3>
      <label className="flex items-center gap-2 text-13 text-ink">
        <input
          type="checkbox"
          className="size-4 accent-[var(--c-contrast)]"
          checked={enabled}
          disabled={!loaded}
          onChange={(e) => setEnabled(e.currentTarget.checked)}
        />
        {tr("Auto-compact long sessions")}
      </label>
      <p className="text-12 leading-4 text-ink-muted">
        {tr("When a session's context passes the threshold, the agent folds it into a summary and keeps going. Old messages stay visible behind a divider but are hidden from the AI. A model whose context size is unknown is only compacted at a threshold you set.")}
      </p>
      {enabled ? <label className="flex items-center gap-2 text-12 text-ink-muted">
          {tr("Threshold (tokens)")}
          <input
            className={inputClass + " max-w-[160px]"}
            placeholder={tr("auto (80% of context window)")}
            inputMode="numeric"
            value={limit}
            onChange={(e) => setLimit(e.currentTarget.value.replace(/[^\d]/g, ""))}
          />
        </label> : null}
      <div>
        <Button variant="neutral" size="normal" disabled={!loaded || busy} onClick={save}>
          {tr("Save")}
        </Button>
      </div>
      {err ? <div className="text-12 text-danger">{err}</div> : null}
    </div>
  )
}

/** Account: avatar, username, password. */
function AccountSection(props: { me: Me; onLogout: () => void }) {
  const [hasPassword, setHasPassword] = useState(!!props.me.hasPassword)
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  const [msg, setMsg] = useState("")
  const [avatarOk, setAvatarOk] = useState(true)
  const [hasAvatar, setHasAvatar] = useState(props.me.hasAvatar !== false)
  const [username, setUsername] = useState(props.me.username)

  const savePassword = async () => {
    setBusy(true)
    setErr("")
    setMsg("")
    try {
      const r = await authApi.changePassword(current, next)
      setHasPassword(r.hasPassword)
      setCurrent("")
      setNext("")
      setMsg(tr("Password changed."))
    } catch (e: any) {
      setErr(e.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  const uploadAvatar = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setErr("")
    setMsg("")
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader()
        fr.onload = () => resolve(String(fr.result).split(",")[1] ?? "")
        fr.onerror = () => reject(new Error(tr("could not read the file")))
        fr.readAsDataURL(file)
      })
      const r = await avatarApi.upload(data, file.type || "image/png")
      prefs.set("chrysalis-avatar-v", String(Date.now()))
      setAvatarOk(true)
      setHasAvatar(true)
      setMsg(tr("Picture saved."))
      void r
    } catch (e: any) {
      setErr(e.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  const rename = async () => {
    setBusy(true)
    setErr("")
    setMsg("")
    try {
      await avatarApi.rename(username.trim(), hasPassword ? current || undefined : undefined)
      setMsg(tr("Username saved, reloading…"))
      setTimeout(() => location.reload(), 900)
    } catch (e: any) {
      setErr(e.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-13 font-medium text-ink">{tr("Account")}</h3>
      <div className="flex items-center gap-3">
        {avatarOk && hasAvatar ? <img
            src={`/v1/auth/avatar/${encodeURIComponent(props.me.username)}?v=${prefs.get("chrysalis-avatar-v") ?? "0"}`}
            alt=""
            className="size-12 shrink-0 rounded-full object-cover"
            onError={() => setAvatarOk(false)}
          /> : <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-pressed text-16 font-medium uppercase text-ink">
              {props.me.username.slice(0, 1)}
            </span>}
        <div className="flex flex-col gap-1">
          <label className="cursor-pointer self-start rounded-md border border-line px-2 py-1 text-12 transition-colors hover:bg-hover">
            {tr("Change picture")}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={(e) => void uploadAvatar(e.currentTarget.files?.[0])}
            />
          </label>
          <span className="text-11 text-ink-faint">{tr("png / jpg / webp / gif, up to 2MB")}</span>
        </div>
      </div>
      <label className="flex flex-col gap-1 text-12 text-ink-muted">
        {tr("Username (your workspace moves with it)")}
        <input
          className={inputClass + " max-w-[320px]"}
          value={username}
          onChange={(e) => setUsername(e.currentTarget.value)}
        />
      </label>
      {username.trim() !== props.me.username && username.trim() ? <div className="flex flex-col gap-1">
          {hasPassword ? <input
              className={inputClass + " max-w-[320px]"}
              type="password"
              placeholder={tr("current password")}
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.currentTarget.value)}
            /> : null}
          <Button variant="neutral" size="normal" disabled={busy || (hasPassword && !current)} onClick={rename}>
            {tr("Rename account")}
          </Button>
        </div> : null}
      <div className="flex flex-col gap-2 border-t border-line pt-3">
        <div className="text-12 text-ink-muted">
          {tr("Password, every account has one. Forgotten? A reset code can be printed in the server terminal from the login screen.")}
        </div>
        <input
          className={inputClass + " max-w-[320px]"}
          type="password"
          placeholder={tr("current password")}
          autoComplete="current-password"
          value={current}
          onChange={(e) => setCurrent(e.currentTarget.value)}
        />
        <input
          className={inputClass + " max-w-[320px]"}
          type="password"
          placeholder={tr("new password (4+ chars)")}
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.currentTarget.value)}
        />
        <div className="flex items-center gap-2">
          <Button variant="neutral" size="normal" disabled={busy || next.length < 4 || !current} onClick={() => void savePassword()}>
            {tr("Change password")}
          </Button>
        </div>
      </div>
      {err ? <div className="text-12 text-danger">{err}</div> : null}
      {msg ? <div className="text-12 text-success">{msg}</div> : null}
      <div className="flex items-center gap-2 border-t border-line pt-3">
        <Button variant="ghost" size="normal" onClick={props.onLogout}>
          {tr("Log out")}
        </Button>
      </div>
    </div>
  )
}


// ----------------------------------------------------------------------- api

function ApiTab() {
  const connections = useResource(() => connectionsApi.list())
  const formats = useResource(() => listPromptFormats())
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<EngineConnection | null>(null)
  const [err, setErr] = useState("")

  return (
    <Pane title={tr("API connections")} description={tr("Name a connection once and pick it by name in any app. Keys never leave this machine.")}>
      <div className="flex flex-col gap-4 pb-4">
        <section className="flex flex-col gap-2">
          {!connections.loading ? <>{(connections.data ?? []).map((c: EngineConnection) => (
                editing?.id !== c.id ? <div key={c.id} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2 text-13">
                    <ProviderIcon id={c.proxyOf ?? c.effectiveProviderId} className="size-5 shrink-0 text-icon" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{c.name}</span>
                      <span className="block truncate text-11 text-ink-faint">
                        {c.proxyOf
                          ? `${c.proxyOf} · reverse proxy · ${c.baseUrl}`
                          : c.providerId
                            ? c.effectiveProviderId
                            : `${c.api === "anthropic-messages" ? "Anthropic" : c.api === "openai-text" ? tr("text completions, {format}", { format: formatLabel(c, formats.data) }) : tr("OpenAI-compatible")} · ${c.baseUrl}`}
                        {c.credentialType === "oauth" ? tr(" · subscription") : c.hasKey || !(c.providerId || c.oauthProvider) ? "" : tr(" · needs key")}
                      </span>
                    </span>
                    <span className={cn("size-1.5 shrink-0 rounded-full", { "bg-success": c.hasKey || !(c.providerId || c.oauthProvider), "bg-ink-faint": !c.hasKey && !!(c.providerId || c.oauthProvider) })} />
                    <IconButton
                      icon={<Icon name="pencil-line" />}
                      variant="ghost-muted"
                      size="small"
                      title={tr("Edit connection")}
                      onClick={() => { setErr(""); setEditing(c) }}
                    />
                    <IconButton
                      icon={<IconSmall name="outline-xmark" />}
                      variant="ghost-muted"
                      size="small"
                      title={tr("Delete connection")}
                      onClick={async () => {
                        try {
                          await connectionsApi.remove(c.id)
                          connections.refetch()
                        } catch (e: any) {
                          setErr(e.message ?? String(e))
                        }
                      }}
                    />
                  </div> : <EditConnection key={c.id} connection={c} onDone={() => { setEditing(null); connections.refetch() }} onCancel={() => setEditing(null)} />
              ))}
            {(connections.data ?? []).length === 0 ? <div className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-13 text-ink-faint">
                {tr("No connections yet, add one below.")}
              </div> : null}</>: <div className="text-13 text-ink-faint">{tr("Loading…")}</div>}
          {err ? <div className="text-12 text-danger">{err}</div> : null}
        </section>

        {editing === null && !adding ? <Button variant="neutral" size="normal" className="self-start gap-2" onClick={() => { setErr(""); setAdding(true) }}>
            <IconSmall name="grid-plus" />
            {tr("Add connection")}
          </Button> : editing ? <></> : <AddConnection
                  onCancel={() => setAdding(false)}
                  onCreated={() => {
                    setAdding(false)
                    connections.refetch()
                  }}
                />}
      </div>
    </Pane>
  )
}

/** Inline edit: rename, re-point a custom endpoint, replace the key,
 * override per-model settings (context window etc.). */
function EditConnection(props: { connection: EngineConnection; onDone: () => void; onCancel: () => void }) {
  const c = props.connection
  const isCustom = () => !c.providerId
  const [name, setName] = useState(c.name)
  const [baseUrl, setBaseUrl] = useState(c.baseUrl ?? "")
  const [key, setKey] = useState("")
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)
  const [format, setFormat] = useState<FormatChoice>({ id: c.promptFormat ?? "auto", custom: c.promptFormatCustom ?? EMPTY_FORMAT })
  const initialModels = Array.isArray(c.models) ? c.models : []
  const [modelsMode, setModelsMode] = useState<"auto" | "manual">(Array.isArray(c.models) ? "manual" : "auto")
  const [models, setModels] = useState(
    initialModels.map((m) => ({
      id: m.id,
      contextWindow: m.contextWindow ? String(m.contextWindow) : "",
      maxTokens: m.maxTokens ? String(m.maxTokens) : "",
      reasoning: m.reasoning === true,
    })),
  )

  const modelDefs = () =>
    modelsMode === "auto"
      ? ("auto" as const)
      : models
          .filter((m) => m.id.trim())
          .map((m) => ({
            id: m.id.trim(),
            ...(m.contextWindow.trim() && Number(m.contextWindow) > 0 ? { contextWindow: Number(m.contextWindow) } : {}),
            ...(m.maxTokens.trim() && Number(m.maxTokens) > 0 ? { maxTokens: Number(m.maxTokens) } : {}),
            ...(m.reasoning ? { reasoning: true } : {}),
          }))

  const submit = async () => {
    setBusy(true)
    setErr("")
    try {
      await connectionsApi.update(c.id, {
        name: name.trim(),
        ...(!c.providerId && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(key.trim() ? { key: key.trim() } : {}),
        ...(isCustom() ? { models: modelDefs() as never } : {}),
        ...(c.api === "openai-text" ? formatBody(format) : {}),
      })
      props.onDone()
    } catch (e: any) {
      setErr(e.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-line-focus p-3">
      <div className="flex items-center gap-2">
        <ProviderIcon id={c.proxyOf ?? c.effectiveProviderId} className="size-5 shrink-0 text-icon" />
        <h3 className="flex-1 text-13 font-medium text-ink">{tr("Edit connection")}</h3>
        <IconButton icon={<IconSmall name="outline-xmark" />} variant="ghost-muted" size="small" title={tr("Cancel")} onClick={props.onCancel} />
      </div>
      <label className="flex flex-col gap-1 text-12 text-ink-muted">
        {tr("Connection name")}
        <input className={inputClass} value={name} onChange={(e) => setName(e.currentTarget.value)} />
      </label>
      {isCustom() ? <><label className="flex flex-col gap-1 text-12 text-ink-muted">
          {tr("Base URL")}
          <input className={inputClass} placeholder="https://…/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.currentTarget.value)} />
        </label>
        <ModelsEditor mode={modelsMode} setMode={setModelsMode} models={models} setModels={setModels} />
        {c.api === "openai-text" ? <PromptFormatEditor value={format} onChange={setFormat} /> : null}</>: null}
      <label className="flex flex-col gap-1 text-12 text-ink-muted">
        {c.credentialType === "oauth"
          ? tr("Signed in with a subscription (OAuth), no key needed")
          : c.hasKey
            ? tr("Replace key (leave blank to keep the current one)")
            : tr("API key")}
        {c.credentialType !== "oauth" ? <input className={inputClass} type="password" placeholder={c.hasKey ? tr("keep current") : tr("paste key")} autoComplete="off" value={key} onChange={(e) => setKey(e.currentTarget.value)} /> : null}
      </label>
      <div className="flex items-center gap-2">
        <Button variant="neutral" size="normal" disabled={busy || !name.trim() || (!c.providerId && !baseUrl.trim())} onClick={submit}>
          {tr("Save")}
        </Button>
        <Button variant="ghost" size="normal" disabled={busy} onClick={props.onCancel}>
          {tr("Cancel")}
        </Button>
      </div>
      {err ? <div className="text-12 text-danger">{err}</div> : null}
    </section>
  )
}

function AddConnection(props: { onCancel: () => void; onCreated: () => void }) {
  const providers = useResource(() => listProviders())
  const [selected, setSelected] = useState<ProviderPick | null>(null)
  const [q, setQ] = useState("")

  const pickable = (): ProviderPick[] => {
    const all = providers.data ?? []
    const signInPicks: OAuthPick[] = [
      ...all
        .filter((p) => p.signIn && p.kind !== "needs-setup")
        .map((p) => ({
          id: `oauth_${p.id}`,
          providerId: p.id,
          label: p.oauth ? (p.oauthLabel ?? p.label) : p.label,
          kind: "builtin" as const,
          baseUrl: null,
          apiKeyAuth: false as const,
          hasKey: false as const,
          authKind: p.oauth ? ("oauth" as const) : ("credentials" as const),
        })),
      { id: "oauth_radius", providerId: "radius", label: tr("Radius gateway"), kind: "builtin" as const, baseUrl: null, apiKeyAuth: false as const, hasKey: false as const, authKind: "oauth" as const, needsGateway: true },
    ]
    const list = all.filter((p) => p.kind !== "needs-setup" && p.apiKeyAuth)
    const customPicks: CustomPick[] = [
      { id: "__custom_openai", label: tr("Custom (OpenAI-compatible)"), kind: "builtin", baseUrl: null, apiKeyAuth: true, hasKey: false },
      { id: "__custom_anthropic", label: tr("Custom (Anthropic)"), kind: "builtin", baseUrl: null, apiKeyAuth: true, hasKey: false },
      { id: "__custom_responses", label: tr("Custom (OpenAI Responses)"), kind: "builtin", baseUrl: null, apiKeyAuth: true, hasKey: false },
      { id: "__custom_google", label: tr("Custom (Gemini-compatible)"), kind: "builtin", baseUrl: null, apiKeyAuth: true, hasKey: false },
      { id: "__custom_text", label: tr("Custom (text completions)"), kind: "builtin", baseUrl: null, apiKeyAuth: true, hasKey: false },
    ]
    return [...signInPicks, ...LOCAL_SERVERS, ...customPicks, ...list]
  }

  const isSignInPick = (p: ProviderPick): p is OAuthPick => p.id.startsWith("oauth_")
  const filtered = () => {
    const needle = q.toLowerCase()
    return pickable().filter((p) => p.id.toLowerCase().includes(needle) || p.label.toLowerCase().includes(needle) || String("providerId" in p ? p.providerId : "").includes(needle))
  }
  const groups = () => {
    // sign-ins = the dedicated oauth_ entries ONLY; plain API-key entries
    // (even for OAuth-capable providers) live in Popular / All providers
    const signIns = filtered().filter(isSignInPick)
    const subs = signIns.filter((p) => p.authKind === "oauth")
    const cloud = signIns.filter((p) => p.authKind === "credentials")
    const popular = filtered().filter((p) => (POPULAR as string[]).includes(p.id)).sort((a, b) => POPULAR.indexOf(a.id) - POPULAR.indexOf(b.id))
    const others = filtered().filter((p) => !(POPULAR as string[]).includes(p.id) && !p.id.startsWith("__") && !p.id.startsWith("oauth_")).sort((a, b) => a.label.localeCompare(b.label))
    const customs = filtered().filter((p) => p.id.startsWith("__custom"))
    const locals = filtered().filter((p) => p.id.startsWith("__local_"))
    // ranked by what a new user reaches for first: the common API keys, the
    // subscription sign-ins, a local server, the guided cloud sign-ins, then
    // custom endpoints and the long tail
    return [
      { title: tr("Popular"), items: popular },
      { title: tr("Subscriptions (OAuth)"), items: subs },
      { title: tr("Local model"), items: locals },
      { title: tr("Cloud sign-ins"), items: cloud },
      { title: tr("Custom endpoint"), items: customs },
      { title: tr("All providers"), items: others },
    ].filter((g) => g.items.length > 0)
  }

  return (
    selected ? (
      selected.id.startsWith("oauth_") && "providerId" in selected ? (
        <OAuthForm pick={selected as OAuthPick} onBack={() => setSelected(null)} onDone={props.onCreated} />
      ) : (
        <ProviderForm provider={selected} onBack={() => setSelected(null)} onDone={props.onCreated} />
      )
    ) : <section className="flex flex-col gap-2 rounded-lg border border-line p-3">
          <div className="flex items-center gap-2">
            <h3 className="flex-1 text-13 font-medium text-ink">{tr("Choose a provider")}</h3>
            <IconButton icon={<IconSmall name="outline-xmark" />} variant="ghost-muted" size="small" title={tr("Cancel")} onClick={props.onCancel} />
          </div>
          <input
            className={inputClass}
            placeholder={tr("Search providers…")}
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
          />
          {(groups()).map((group) => (
              <div key={group.title} className="flex flex-col gap-1">
                <div className="px-1 pt-1 text-11 text-ink-faint">{group.title}</div>
                <div className="grid grid-cols-1 gap-1 max-sm:grid-cols-1">
                  {group.items.map((p) => (
                      <button key={p.id}
                        className="flex items-center gap-3 rounded-lg px-2.5 py-2 text-left text-13 transition-colors hover:bg-hover"
                        onClick={() => setSelected(p)}
                      >
                        <ProviderIcon id={"providerId" in p ? p.providerId : p.id} className="size-5 shrink-0 text-icon" />
                        <span className="flex-1 truncate">{p.label}</span>
                        {isSignInPick(p) && p.authKind === "oauth" ? <span className="shrink-0 rounded-full bg-pressed px-2 py-0.5 text-10 text-ink-muted">{tr("OAuth · subscription")}</span> : null}
                        {p.hasKey ? <span className="shrink-0 text-11 text-success">{tr("key set")}</span> : null}
                      </button>
                    ))}
                </div>
              </div>
            ))}
        </section>
  )
}

/** OAuth subscription sign-in (dedicated entry): create the connection and
 * run pi-ai's flow server-side. Shows the auth URL / device code while the
 * browser login completes; polls until the credential lands in auth.json. */
function OAuthForm(props: { pick: OAuthPick; onBack: () => void; onDone: () => void }) {
  const [name, setName] = useState(props.pick.label)
  const [gateway, setGateway] = useState("")
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)
  const [flow, setFlow] = useState<OAuthFlow | null>(null)
  const [promptValue, setPromptValue] = useState("")
  const [answering, setAnswering] = useState(false)
  const isRadius = () => props.pick.providerId === "radius"
  const poll = useRef<ReturnType<typeof setInterval>>(undefined)
  const timeout = useRef<ReturnType<typeof setTimeout>>(undefined)
  // the connection created for this attempt; dropped again if the sign-in is
  // abandoned, so backing out leaves nothing behind
  const createdId = useRef<string | null>(null)
  const completed = useRef(false)

  const discardCreated = () => {
    const id = createdId.current
    createdId.current = null
    if (id) void connectionsApi.remove(id).catch(() => undefined)
  }

  // walking away ends the server-side flow too: without this, the next
  // provider start fails with "a sign-in is already in progress" for up to
  // the five-minute flow timeout
  const leave = () => {
    clearInterval(poll.current)
    clearTimeout(timeout.current)
    void oauthApi.cancel(props.pick.providerId).catch(() => undefined)
    discardCreated()
    props.onBack()
  }

  useEffect(
    () => () => {
      clearInterval(poll.current)
      clearTimeout(timeout.current)
      if (createdId.current && !completed.current) {
        void oauthApi.cancel(props.pick.providerId).catch(() => undefined)
        discardCreated()
      }
    },
    // mount/unmount only: the cleanup reads refs, never props it could go stale on
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  const start = async () => {
    setBusy(true)
    setErr("")
    setFlow({ providerId: props.pick.providerId, status: "pending" })
    try {
      if (isRadius()) {
        if (!/^https?:\/\/.+/.test(gateway.trim())) throw new Error(tr("enter the Radius gateway URL first"))
        const r = await connectionsApi.create({ name: name, oauthProvider: "radius", gateway: gateway.trim() })
        createdId.current = r.connection.id
      } else {
        const r = await connectionsApi.create({ name: name, providerId: props.pick.providerId })
        createdId.current = r.connection.id
      }
      await oauthApi.start(props.pick.providerId)
      poll.current = setInterval(async () => {
        try {
          const r = await oauthApi.list()
          const fl = r.flow
          if (!fl || fl.providerId !== props.pick.providerId) return
          setFlow({ ...fl })
          if (fl.status === "connected") {
            completed.current = true
            clearInterval(poll.current)
            setBusy(false)
            props.onDone()
          } else if (fl.status === "error") {
            clearInterval(poll.current)
            discardCreated()
            setBusy(false)
          }
        } catch {
          clearInterval(poll.current)
          discardCreated()
          setBusy(false)
        }
      }, 1200)
      timeout.current = setTimeout(() => {
        clearInterval(poll.current)
        discardCreated()
        setBusy((b) => {
          if (b) setErr(tr("sign-in timed out"))
          return false
        })
      }, 5 * 60_000)
    } catch (e: any) {
      discardCreated()
      setErr(e.message ?? String(e))
      setBusy(false)
    }
  }

  /** One guided-flow step; the poll picks up whatever comes next. */
  const answer = async (value: string) => {
    const prompt = flow?.prompt
    if (!prompt) return
    setAnswering(true)
    setErr("")
    try {
      await oauthApi.answer(props.pick.providerId, prompt.id, value)
      setPromptValue("")
    } catch (e: any) {
      setErr(e.message ?? String(e))
    } finally {
      setAnswering(false)
    }
  }

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-line p-3">
      <div className="flex items-center gap-2">
        <IconButton icon={<Icon name="arrow-left" />} variant="ghost-muted" size="small" title={tr("Back")} onClick={leave} />
        <ProviderIcon id={props.pick.providerId} className="size-5 shrink-0 text-icon" />
        <h3 className="flex-1 text-13 font-medium text-ink">{props.pick.label}</h3>
      </div>
      <label className="flex flex-col gap-1 text-12 text-ink-muted">
        {tr("Connection name (how you'll pick it in apps)")}
        <input className={inputClass} value={name} onChange={(e) => setName(e.currentTarget.value)} />
      </label>
      {isRadius() ? <label className="flex flex-col gap-1 text-12 text-ink-muted">
          {tr("Gateway URL")}
          <input className={inputClass} placeholder="https://your-radius-gateway.example" value={gateway} onChange={(e) => setGateway(e.currentTarget.value)} />
        </label> : null}
      <p className="text-12 leading-4 text-ink-muted">
        {props.pick.authKind === "oauth"
          ? tr("No API key, sign in with your account. Chrysalis stores the tokens on this machine only.")
          : tr("Connect with the provider's own sign-in. Credentials stay on this machine.")}
      </p>
      {!flow || flow!.status !== "pending" ? <Button variant="neutral" size="normal" disabled={busy || !name.trim()} onClick={start}>
          {tr("Sign in")}
        </Button> : <div className="flex flex-col gap-2 rounded-lg border border-line-focus p-3">
            {flow!.prompt ? <>
                {flow!.message ? <div className="text-12 text-ink-muted">{flow!.message}</div> : null}
                <div className="text-13 text-ink">{flow!.prompt.message}</div>
                {flow!.prompt.type === "select" ? <div className="flex flex-col gap-1">
                    {(flow!.prompt.options ?? []).map((o) => (
                      <Button key={o.id} variant="neutral" size="normal" disabled={answering} onClick={() => answer(o.id)}>
                        <span className="flex flex-col items-start gap-0.5 text-left">
                          <span>{o.label}</span>
                          {o.description ? <span className="text-11 font-normal text-ink-muted">{o.description}</span> : null}
                        </span>
                      </Button>
                    ))}
                  </div> : <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); answer(promptValue) }}>
                    <input
                      className={inputClass}
                      type={flow!.prompt.type === "secret" ? "password" : "text"}
                      autoComplete="off"
                      placeholder={flow!.prompt.placeholder ?? ""}
                      value={promptValue}
                      onChange={(e) => setPromptValue(e.currentTarget.value)}
                    />
                    <Button variant="neutral" size="normal" type="submit" disabled={answering || !promptValue.trim()}>{tr("Continue")}</Button>
                  </form>}
                <div className="text-11 text-ink-faint">{tr("Answer each step, the connection finishes by itself.")}</div>
              </> : <>
                <div className="flex items-center gap-2 text-13 text-ink">
                  {flow!.url ? <a className="flex-1 truncate text-accent underline" href={flow!.url} target="_blank" rel="noreferrer">
                      {tr("Open the sign-in page ↗")}
                    </a> : <span className="flex-1">{tr("Waiting for the provider…")}</span>}
                </div>
                {flow!.userCode ? <><div className="rounded-md bg-panel px-3 py-2 text-center font-mono text-15 tracking-widest">
                    {flow!.userCode}
                  </div>
                  {flow!.verificationUri ? <div className="text-center text-11 text-ink-faint">
                      {tr("enter this code at {url}", { url: flow!.verificationUri })}
                    </div> : null}</>: null}
                {flow!.message ? <div className="text-12 text-ink-muted">{flow!.message}</div> : null}
                <div className="text-11 text-ink-faint">{tr("Keep this open, the connection finishes by itself.")}</div>
              </>}
          </div>}
      {flow && flow!.status === "error" ? <div className="text-12 text-danger">{flow!.error ?? tr("sign-in failed")}</div> : null}
      {err ? <div className="text-12 text-danger">{err}</div> : null}
    </section>
  )
}

function ProviderForm(props: { provider: ProviderPick; onBack: () => void; onDone: () => void }) {
  const CUSTOM_APIS: Record<string, "openai-completions" | "anthropic-messages" | "openai-responses" | "google-generative-ai" | "openai-text"> = {
    __custom_openai: "openai-completions",
    __custom_anthropic: "anthropic-messages",
    __custom_responses: "openai-responses",
    __custom_google: "google-generative-ai",
    __custom_text: "openai-text",
  }
  const isLocal = () => props.provider.id.startsWith("__local_")
  const isCustom = () => props.provider.id in CUSTOM_APIS || isLocal()
  const isBuiltin = () => !isCustom()
  // a local server speaks both protocols; chat completions lets the server
  // apply the model's own prompt template
  const [localApi, setLocalApi] = useState<"openai-completions" | "openai-text">("openai-completions")
  const customApi = () => (isLocal() ? localApi : CUSTOM_APIS[props.provider.id]!)
  const [format, setFormat] = useState<FormatChoice>({ id: "auto", custom: EMPTY_FORMAT })
  const [name, setName] = useState(props.provider.label)
  const [baseUrl, setBaseUrl] = useState(props.provider.baseUrl ?? "")
  const [key, setKey] = useState("")
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)
  const [modelsMode, setModelsMode] = useState<"auto" | "manual">("auto")
  const [models, setModels] = useState<Array<{ id: string; contextWindow: string; maxTokens: string; reasoning: boolean }>>([])
  // reverse proxy: route a builtin provider through a
  // custom endpoint; the key binds to the proxy, never to the official API
  const [proxyUrl, setProxyUrl] = useState("")
  const [proxyOpen, setProxyOpen] = useState(false)

  const modelDefs = () =>
    modelsMode === "auto"
      ? ("auto" as const)
      : models
          .filter((m) => m.id.trim())
          .map((m) => ({
            id: m.id.trim(),
            ...(m.contextWindow.trim() && Number(m.contextWindow) > 0 ? { contextWindow: Number(m.contextWindow) } : {}),
            ...(m.maxTokens.trim() && Number(m.maxTokens) > 0 ? { maxTokens: Number(m.maxTokens) } : {}),
            ...(m.reasoning ? { reasoning: true } : {}),
          }))

  const usingProxy = () => isBuiltin() && /^https?:\/\/.+/.test(proxyUrl.trim())

  const submit = async () => {
    setBusy(true)
    setErr("")
    try {
      await connectionsApi.create({
        name: name,
        ...(isCustom()
          ? {
              api: customApi(),
              baseUrl: baseUrl,
              ...(modelsMode === "manual" ? { models: modelDefs() as never } : {}),
              ...(customApi() === "openai-text" ? formatBody(format) : {}),
            }
          : usingProxy()
            ? {
                providerId: props.provider.id,
                proxyUrl: proxyUrl.trim(),
                ...(modelsMode === "manual" ? { models: modelDefs() as never } : {}),
              }
            : { providerId: props.provider.id }),
        ...(key.trim() ? { key: key.trim() } : {}),
      })
      props.onDone()
    } catch (e: any) {
      setErr(e.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-line p-3">
      <div className="flex items-center gap-2">
        <IconButton icon={<Icon name="arrow-left" />} variant="ghost-muted" size="small" title={tr("Back")} onClick={props.onBack} />
        <ProviderIcon id={props.provider.id} className="size-5 shrink-0 text-icon" />
        <h3 className="flex-1 text-13 font-medium text-ink">{props.provider.label}</h3>
      </div>
      <label className="flex flex-col gap-1 text-12 text-ink-muted">
        {tr("Connection name (how you'll pick it in apps)")}
        <input className={inputClass} value={name} onChange={(e) => setName(e.currentTarget.value)} />
      </label>
      {isLocal() ? <label className="flex flex-col gap-1 text-12 text-ink-muted">
          {tr("Protocol")}
          <Select
            appearance="inline"
            options={["openai-completions", "openai-text"] as Array<"openai-completions" | "openai-text">}
            current={localApi}
            value={(x) => x}
            label={(x) => (x === "openai-completions" ? tr("Chat completions") : tr("Text completions"))}
            onSelect={(x) => setLocalApi(x ?? "openai-completions")}
          />
        </label> : null}
      {isCustom() ? <label className="flex flex-col gap-1 text-12 text-ink-muted">
          {tr("Base URL")}
          <input className={inputClass} placeholder="https://…/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.currentTarget.value)} />
        </label> : null}
      <label className="flex flex-col gap-1 text-12 text-ink-muted">
        {usingProxy() ? tr("Proxy password / API key") : isCustom() ? tr("API key (optional)") : tr("API key")}
        <input className={inputClass} type="password" placeholder={isCustom() ? tr("leave empty if the server has none") : tr("paste key")} autoComplete="off" value={key} onChange={(e) => setKey(e.currentTarget.value)} />
      </label>
      {isCustom() ? <ModelsEditor mode={modelsMode} setMode={setModelsMode} models={models} setModels={setModels} /> : null}
      {isCustom() && customApi() === "openai-text" ? <PromptFormatEditor value={format} onChange={setFormat} /> : null}
      {isBuiltin() ? <div className="flex flex-col gap-1.5">
          <button
            type="button"
            className="flex items-center gap-1 self-start text-12 text-ink-faint transition-colors hover:text-ink"
            onClick={() => setProxyOpen((v) => !v)}
          >
            <IconSmall name={proxyOpen ? "chevron-down" : "chevron-right"} size="small" />
            {tr("Reverse proxy URL (optional)")}
          </button>
          {proxyOpen ? <>
              <input className={inputClass} placeholder="https://my-proxy.example/v1" value={proxyUrl} onChange={(e) => setProxyUrl(e.currentTarget.value)} />
              {usingProxy() ? <p className="text-11 leading-4 text-ink-faint">
                  {tr("Requests go to your proxy instead of the official API. The key you enter is bound to the proxy endpoint.")}
                </p> : null}
              {usingProxy() ? <ModelsEditor mode={modelsMode} setMode={setModelsMode} models={models} setModels={setModels} /> : null}
            </> : null}
        </div> : null}
      {props.provider.baseUrl && !isCustom() && !usingProxy() ? <div className="text-11 text-ink-faint">{tr("endpoint: {url}", { url: props.provider.baseUrl })}</div> : null}
      {isLocal() ? <p className="text-11 leading-4 text-ink-faint">{tr("Start the server with a model loaded first. On another computer, use its LAN address.")}</p> : null}
      <Button variant="neutral" size="normal" disabled={busy || (isCustom() ? !baseUrl.trim() : !key.trim())} onClick={submit}>
        {tr("Connect")}
      </Button>
      {err ? <div className="text-12 text-danger">{err}</div> : null}
    </section>
  )
}


type FormatChoice = { id: string; custom: PromptFormat }

const EMPTY_FORMAT: PromptFormat = { systemPrefix: "", systemSuffix: "", userPrefix: "", userSuffix: "", assistantPrefix: "", assistantSuffix: "", systemAsUser: false }

const formatBody = (f: FormatChoice) => (f.id === "custom" ? { promptFormat: "custom", promptFormatCustom: f.custom } : { promptFormat: f.id })

function formatLabel(c: EngineConnection, formats: { id: string; name: string }[] | undefined): string {
  if (!c.promptFormat || c.promptFormat === "auto") return tr("format matches the model")
  if (c.promptFormat === "custom") return tr("custom format")
  return `${formats?.find((f) => f.id === c.promptFormat)?.name ?? c.promptFormat} format`
}

/** Sequences are edited on one line each: a typed \n is a newline. */
const escapeSeq = (s: string) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n")
const unescapeSeq = (s: string) => s.replace(/\\(\\|n)/g, (_, ch: string) => (ch === "n" ? "\n" : "\\"))

const FORMAT_FIELDS: [keyof Omit<PromptFormat, "systemAsUser">, string][] = [
  ["systemPrefix", tr("System prefix")],
  ["systemSuffix", tr("System suffix")],
  ["userPrefix", tr("User prefix")],
  ["userSuffix", tr("User suffix")],
  ["assistantPrefix", tr("Assistant prefix")],
  ["assistantSuffix", tr("Assistant suffix")],
]

/** How a text completion connection writes the chat into one prompt. */
function PromptFormatEditor(props: { value: FormatChoice; onChange: (v: FormatChoice) => void }) {
  const formats = useResource(() => listPromptFormats())
  const list = formats.data ?? []
  const byId = new Map(list.map((f) => [f.id, f]))
  const set = (patch: Partial<FormatChoice>) => props.onChange({ ...props.value, ...patch })
  const pick = (id: string) => {
    // starting a custom format from the one on screen beats starting blank
    const base = byId.get(props.value.id)
    set(id === "custom" && base ? { id, custom: { ...base } } : { id })
  }
  const cell = "min-w-0 rounded-md border border-line bg-panel px-2 py-1 font-mono text-12 outline-none focus:border-line-focus"
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line p-2.5">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-12 font-medium text-ink">{tr("Prompt format")}</span>
        <Select
          appearance="inline"
          className="w-[200px]"
          options={["auto", ...list.map((f) => f.id), "custom"]}
          current={props.value.id}
          value={(x) => x}
          label={(x) => (x === "auto" ? tr("Match the model") : x === "custom" ? tr("Custom") : byId.get(x)?.name ?? x)}
          onSelect={(x) => pick(x ?? "auto")}
        />
      </div>
      {props.value.id === "auto" ? <p className="text-11 leading-4 text-ink-faint">
          {tr("Read from the loaded model's chat template, or guessed from its name. ChatML if neither works.")}
        </p> : null}
      {props.value.id === "custom" ? <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {FORMAT_FIELDS.map(([k, label]) => (
            <label key={k} className="flex flex-col gap-0.5 text-11 text-ink-muted">
              {label}
              <input
                className={cell}
                value={escapeSeq(props.value.custom[k])}
                onChange={(e) => set({ custom: { ...props.value.custom, [k]: unescapeSeq(e.currentTarget.value) } })}
              />
            </label>
          ))}
          <label className="flex items-center gap-2 text-12 text-ink sm:col-span-2">
            <input
              type="checkbox"
              className="size-4 accent-[var(--c-contrast)]"
              checked={props.value.custom.systemAsUser}
              onChange={(e) => set({ custom: { ...props.value.custom, systemAsUser: e.currentTarget.checked } })}
            />
            {tr("No system role (later system messages are sent as user)")}
          </label>
          <p className="text-11 leading-4 text-ink-faint sm:col-span-2">{tr("Type \\n for a newline.")}</p>
        </div> : null}
    </div>
  )
}

function ModelsEditor(props: {
  mode: "auto" | "manual"
  setMode: (m: "auto" | "manual") => void
  models: Array<{ id: string; contextWindow: string; maxTokens: string; reasoning: boolean }>
  setModels: (fn: (prev: Array<{ id: string; contextWindow: string; maxTokens: string; reasoning: boolean }>) => Array<{ id: string; contextWindow: string; maxTokens: string; reasoning: boolean }>) => void
}) {
  const row = "flex flex-wrap items-center gap-1.5"
  const cell = "w-[120px] rounded-md border border-line bg-panel px-2 py-1 text-12 outline-none focus:border-line-focus"
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line p-2.5">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-12 font-medium text-ink">{tr("Models")}</span>
        <Select
          appearance="inline"
          className="w-[180px]"
          options={["auto", "manual"] as Array<"auto" | "manual">}
          current={props.mode}
          value={(x) => x}
          label={(x) => (x === "auto" ? tr("Auto-discover (/models)") : tr("Manual list"))}
          onSelect={(x) => props.setMode(x ?? "auto")}
        />
      </div>
      {props.mode === "auto" ? <p className="text-11 leading-4 text-ink-faint">
          {tr("Models are discovered from the endpoint. Pick Manual if the list is wrong or to set context windows.")}
        </p> : null}
      {props.mode === "manual" ? <div className="flex flex-col gap-1.5">
          {props.models.map((m, i) => (
              <div key={i} className={row}>
                <input
                  className="min-w-[140px] flex-1 rounded-md border border-line bg-panel px-2 py-1 text-12 outline-none focus:border-line-focus"
                  placeholder={tr("model id (e.g. my-model-v2)")}
                  value={m.id}
                  onChange={(e) => props.setModels((prev) => prev.map((x, j) => (j === i ? { ...x, id: e.currentTarget.value } : x)))}
                />
                <input
                  className={cell}
                  inputMode="numeric"
                  placeholder={tr("context (tok)")}
                  value={m.contextWindow}
                  onChange={(e) => props.setModels((prev) => prev.map((x, j) => (j === i ? { ...x, contextWindow: e.currentTarget.value.replace(/[^\d]/g, "") } : x)))}
                />
                <input
                  className={cell}
                  inputMode="numeric"
                  placeholder={tr("max out (tok)")}
                  value={m.maxTokens}
                  onChange={(e) => props.setModels((prev) => prev.map((x, j) => (j === i ? { ...x, maxTokens: e.currentTarget.value.replace(/[^\d]/g, "") } : x)))}
                />
                <label className="flex items-center gap-1 text-11 text-ink-muted" title={tr("Model supports reasoning/thinking")}>
                  <input
                    type="checkbox"
                    className="size-3.5"
                    checked={m.reasoning}
                    onChange={(e) => props.setModels((prev) => prev.map((x, j) => (j === i ? { ...x, reasoning: e.currentTarget.checked } : x)))}
                  />
                  {tr("thinking")}
                </label>
                <button
                  className="rounded p-1 text-icon-muted transition-colors hover:text-danger"
                  title={tr("Remove model")}
                  onClick={() => props.setModels((prev) => prev.filter((_, j) => j !== i))}
                >
                  <IconSmall name="outline-xmark" size="small" />
                </button>
              </div>
            ))}
          <button
            className="self-start rounded-md border border-line px-2 py-1 text-12 transition-colors hover:bg-hover"
            onClick={() => props.setModels((prev) => [...prev, { id: "", contextWindow: "", maxTokens: "", reasoning: false }])}
          >
            {tr("+ Add model")}
          </button>
          <p className="text-11 leading-4 text-ink-faint">
            {tr("Context window powers auto-compact thresholds and token estimates. Set it when the endpoint reports wrong defaults.")}
          </p>
        </div> : null}
    </div>
  )
}

// ---------------------------------------------------------------- developer

type AppBuildInfo = {
  buildable: boolean
  needsBuild: boolean
  status: { ok: boolean; mode: "development" | "production"; errors: Array<{ text: string; file?: string; line?: number }>; at: number } | null
}

/** Live editing: apps are built in this browser, in a sandboxed builder
 *  frame, and edits land as hot updates with no page reload. Nothing to
 *  switch on; this pane reports each app's last build. */
function DeveloperTab() {
  const [apps, setApps] = useState<Array<{ id: string; name?: string }>>([])
  const [state, setState] = useState<Record<string, AppBuildInfo>>({})
  const [loaded, setLoaded] = useState(false)
  const [err, setErr] = useState("")

  useEffect(() => {
    void (async () => {
      try {
        const l = await api<{ apps?: Array<{ id: string; name?: string }> }>("GET", "/v1/launch")
        const list = l.apps ?? []
        const entries = await Promise.all(
          list.map(async (a) => {
            const s = await api<AppBuildInfo>("GET", `/v1/apps/${encodeURIComponent(a.id)}/build`)
            return [a.id, s] as const
          }),
        )
        setApps(list)
        setState(Object.fromEntries(entries))
      } catch (e) {
        setErr((e as Error).message ?? String(e))
      }
      setLoaded(true)
    })()
  }, [])

  const describe = (b: AppBuildInfo | undefined): { text: string; tone: "ok" | "bad" | "idle" } => {
    if (!b || !b.buildable) return { text: tr("No page to build"), tone: "idle" }
    if (!b.status) return { text: tr("Builds when you open it"), tone: "idle" }
    if (!b.status.ok) {
      const e = b.status.errors[0]
      return { text: tr("Build failed") + (e ? `: ${e.file ?? ""}${e.line ? `:${e.line}` : ""} ${e.text}` : ""), tone: "bad" }
    }
    const when = b.needsBuild ? " " + tr("(changed since, rebuilds on open)") : ""
    return { text: (b.status.mode === "development" ? tr("Live: edits apply in place") : tr("Production build")) + when, tone: "ok" }
  }

  return (
    <Pane title={tr("Developer")} description={tr("Live hot reload. Always on for every app.")}>
      <div className="flex flex-col gap-4 pb-4">
        <section className="flex flex-col gap-2">
          {loaded ? <>{apps.map((a) => {
                const d = describe(state[a.id])
                return (
                  <div key={a.id} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2 text-13">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{a.name || a.id}</span>
                      <span className={cn("block truncate text-11", d.tone === "bad" ? "text-danger" : "text-ink-faint")}>{d.text}</span>
                    </span>
                    <span className={cn("size-2 shrink-0 rounded-full", { "bg-success": d.tone === "ok", "bg-danger": d.tone === "bad", "bg-ink-faint": d.tone === "idle" })} />
                  </div>
                )
              })}
            {apps.length === 0 ? <div className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-13 text-ink-faint">
                {tr("No apps installed yet.")}
              </div> : null}</>: <div className="text-13 text-ink-faint">{tr("Loading…")}</div>}
        </section>
        <p className="text-12 leading-4 text-ink-muted">
          {tr("Apps are built inside this browser, in a sandbox that can only read the app being built. Edits to an app's source apply in place while it is open, with no page reload.")}
        </p>
        {err ? <div className="text-12 text-danger">{err}</div> : null}
      </div>
    </Pane>
  )
}

// ----------------------------------------------------------------------- mcp

/** Web search preset: paste an Exa API key → the built-in web-search MCP
 * server comes online (key stored with your credentials, never in files). */
function ExaKeySection(props: { onSaved: () => void }) {
  const [key, setKey] = useState("")
  const [state, setState] = useState<"idle" | "busy" | "done" | "err">("idle")
  const [msg, setMsg] = useState("")
  const save = async () => {
    if (!key.trim()) return
    setState("busy")
    setMsg("")
    try {
      await api("POST", "/v1/mcp/exa-key", { key: key.trim() })
      setState("done")
      setMsg(tr("Web search enabled, the agent can search now."))
      setKey("")
      props.onSaved()
    } catch (e) {
      setState("err")
      setMsg((e as Error).message ?? String(e))
    }
  }
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-line p-3">
      <h3 className="text-13 font-medium text-ink">{tr("Web search")}</h3>
      <p className="text-12 text-ink-muted">
        {tr("Give the agent web search (Exa). Paste an API key (free at exa.ai) and the built-in web-search server comes online. The key is stored with your credentials, never in your files.")}
      </p>
      <div className="flex gap-2">
        <input
          className={inputClass}
          type="password"
          placeholder={tr("Exa API key")}
          value={key}
          onChange={(e) => {
            setKey(e.currentTarget.value)
            setState("idle")
            setMsg("")
          }}
        />
        <Button variant="neutral" size="small" disabled={state === "busy" || !key.trim()} onClick={() => void save()}>
          {state === "busy" ? tr("Enabling…") : tr("Enable")}
        </Button>
      </div>
      {msg ? <p className={`text-12 ${state === "err" ? "text-danger" : "text-success"}`}>{msg}</p> : null}
    </section>
  )
}

type McpAccess = "all" | "agent" | "off"
const MCP_ACCESS: McpAccess[] = ["all", "agent", "off"]
const mcpAccessLabel = (a: McpAccess) => (a === "all" ? tr("All apps") : a === "agent" ? tr("Agent only") : tr("Off"))

function McpTab() {
  const servers = useResource(() => mcpApi.list())
  const [id, setId] = useState("")
  const [type, setType] = useState<"stdio" | "http" | "sse">("stdio")
  const [command, setCommand] = useState("")
  const [url, setUrl] = useState("")
  const [env, setEnv] = useState("")
  const [headers, setHeaders] = useState("")
  const [adding, setAdding] = useState(false)
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)

  /** "KEY=value" lines → object (blank lines and # comments skipped) */
  const kvLines = (text: string): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const line of text.split("\n")) {
      const t = line.trim()
      if (!t || t.startsWith("#")) continue
      const eq = t.indexOf("=")
      if (eq > 0) out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
    }
    return out
  }

  const add = async () => {
    setBusy(true)
    setErr("")
    try {
      const parts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((s) => s.replace(/^["']|["']$/g, "")) ?? []
      const envObj = kvLines(env)
      const headersObj = kvLines(headers)
      const cfg =
        type === "stdio"
          ? { type: "stdio" as const, command: parts[0] ?? command, args: parts.slice(1), ...(Object.keys(envObj).length ? { env: envObj } : {}) }
          : { type: type as "http" | "sse", url: url, ...(Object.keys(headersObj).length ? { headers: headersObj } : {}) }
      await mcpApi.upsert(id.trim(), cfg)
      setId("")
      setCommand("")
      setUrl("")
      setEnv("")
      setHeaders("")
      setAdding(false)
      servers.refetch()
    } catch (e: any) {
      setErr(e.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  const setAccess = async (serverId: string, access: McpAccess) => {
    setErr("")
    try {
      await mcpApi.setAccess(serverId, access === "off" ? { enabled: false } : { enabled: true, share: access })
    } catch (e: any) {
      setErr(e.message ?? String(e))
    }
    servers.refetch()
  }

  return (
    <Pane title={tr("MCP servers")} description={tr("Tool servers your agent and apps can call. Apps start with each one off and switch on what they need.")}>
      <div className="flex flex-col gap-4 pb-4">
        <ExaKeySection onSaved={() => servers.refetch()} />
        <section className="flex flex-col gap-2">
          {(servers.data ?? []).map((s) => (
            <div key={s.id} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-13">
              <span
                className={cn("size-1.5 shrink-0 rounded-full", {
                  "bg-success": s.connected,
                  "bg-danger": !s.connected && !!s.error,
                  "bg-ink-faint": !s.connected && !s.error,
                })}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{s.id}</span>
                <span className="block truncate text-11 text-ink-faint" title={s.error ?? ""}>
                  {s.type}
                  {s.connected ? " · " + (s.tools === 1 ? tr("{n} tool", { n: 1 }) : tr("{n} tools", { n: s.tools ?? 0 })) : s.error ? ` · ${s.error}` : s.enabled ? tr(" · offline") : tr(" · off")}
                </span>
              </span>
              <Select<McpAccess>
                appearance="inline"
                options={MCP_ACCESS}
                current={s.enabled ? s.share : "off"}
                value={(x) => x}
                label={mcpAccessLabel}
                onSelect={(v) => {
                  if (v) void setAccess(s.id, v)
                }}
              />
              <IconButton
                icon={<Icon name="arrow-undo-down" />}
                variant="ghost-muted"
                size="small"
                title={tr("Reconnect now")}
                onClick={async () => {
                  try {
                    await mcpApi.reconnect(s.id)
                  } catch (e: any) {
                    setErr(e.message ?? String(e))
                  }
                  setTimeout(() => void servers.refetch(), 400)
                  servers.refetch()
                }}
              />
              <IconButton
                icon={<IconSmall name="outline-xmark" />}
                variant="ghost-muted"
                size="small"
                title={tr("Remove server")}
                onClick={async () => {
                  try {
                    await mcpApi.remove(s.id)
                    servers.refetch()
                  } catch (e: any) {
                    setErr(e.message ?? String(e))
                  }
                }}
              />
            </div>
          ))}
          {(servers.data ?? []).length === 0 ? <div className="rounded-lg border border-dashed border-line px-3 py-4 text-center text-13 text-ink-faint">
              {tr("No MCP servers configured.")}
            </div> : null}
        </section>

        {adding ? (
          <section className="flex flex-col gap-2 rounded-lg border border-line p-3">
            <div className="flex items-center justify-between">
              <h3 className="text-13 font-medium text-ink">{tr("Add server")}</h3>
              <IconButton icon={<IconSmall name="outline-xmark" />} variant="ghost-muted" size="small" title={tr("Close")} onClick={() => setAdding(false)} />
            </div>
            <input className={inputClass} placeholder={tr("Server id (e.g. dice)")} value={id} onChange={(e) => setId(e.currentTarget.value)} />
            <Select
              className="flex-1"
              options={["stdio", "http", "sse"] as Array<"stdio" | "http" | "sse">}
              current={type}
              value={(x) => x}
              label={(x) => (x === "stdio" ? tr("stdio (local command)") : x === "http" ? tr("http (remote URL)") : tr("sse (remote URL, legacy transport)"))}
              onSelect={(x) => setType(x ?? "stdio")}
            />
            {type === "stdio" ? <><input className={inputClass} placeholder={tr("Command (e.g. npx -y some-mcp-server)")} value={command} onChange={(e) => setCommand(e.currentTarget.value)} />
              <textarea
                className={inputClass + " min-h-[56px] resize-y font-mono text-12"}
                placeholder={tr("Environment (KEY=value per line)\nAPI_TOKEN=abc")}
                value={env}
                onChange={(e) => setEnv(e.currentTarget.value)}
              /></>: null}
            {type !== "stdio" ? <><input className={inputClass} placeholder="https://…/mcp" value={url} onChange={(e) => setUrl(e.currentTarget.value)} />
              <textarea
                className={inputClass + " min-h-[56px] resize-y font-mono text-12"}
                placeholder={tr("Headers (Key=value per line)\nAuthorization=Bearer …")}
                value={headers}
                onChange={(e) => setHeaders(e.currentTarget.value)}
              /></>: null}
            <Button variant="neutral" size="normal" className="w-fit" disabled={busy || !id.trim()} onClick={add}>
              {tr("Add server")}
            </Button>
          </section>
        ) : <Button variant="neutral" size="normal" icon="plus" className="w-fit" onClick={() => setAdding(true)}>
            {tr("Add server")}
          </Button>}
        {err ? <div className="text-12 text-danger">{err}</div> : null}
      </div>
    </Pane>
  )
}


// --------------------------------------------------------------------- users

/** Admin: create users, set/clear passwords, enable/disable, delete. */
function UsersTab(props: { me: Me }) {
  const users = useResource(() => adminUsersApi.list())
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [err, setErr] = useState("")
  const [msg, setMsg] = useState("")
  const [busy, setBusy] = useState(false)
  const [resetting, setResetting] = useState<string | null>(null)
  const [resetPw, setResetPw] = useState("")
  const [adminPw, setAdminPw] = useState("")
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const create = async () => {
    setBusy(true)
    setErr("")
    setMsg("")
    try {
      await adminUsersApi.create(username.trim(), password.trim())
      setMsg(tr("Created “{username}”, they can sign in from the login screen.", { username: username.trim() }))
      setUsername("")
      setPassword("")
      users.refetch()
    } catch (e: any) {
      setErr(e.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Pane title={tr("Users")} description={tr("People who can sign in to this Chrysalis. Each gets their own workspace, agent and apps.")}>
      <div className="flex flex-col gap-4 pb-4">
        <section className="flex flex-col gap-2">
          {!users.loading ? (users.data ?? []).map((u) => (
                resetting !== u.username ? <div key={u.username} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2 text-13">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-pressed text-12 font-medium uppercase">
                      {u.username.slice(0, 1)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">
                        {u.username}
                        {u.username === props.me.username ? <span className="ml-1 text-11 text-ink-faint">{tr("(you)")}</span> : null}
                      </span>
                      <span className="block truncate text-11 text-ink-faint">
                        {u.role}
                        {u.enabled ? "" : tr(" · disabled")}
                      </span>
                    </span>
                    <IconButton
                      icon={<Icon name="lock" />}
                      variant="ghost-muted"
                      size="small"
                      title={tr("Change password")}
                      onClick={() => { setErr(""); setAdminPw(""); setResetting(u.username) }}
                    />
                    <IconButton
                      icon={<Icon name={u.enabled ? "circle-check" : "circle-ban-sign"} />}
                      variant="ghost-muted"
                      size="small"
                      title={u.enabled ? tr("Disable account") : tr("Enable account")}
                      onClick={async () => {
                        try {
                          await adminUsersApi.update(u.username, { enabled: !u.enabled })
                          users.refetch()
                        } catch (e: any) {
                          setErr(e.message ?? String(e))
                        }
                      }}
                    />
                    {confirmDelete !== u.username ? <IconButton
                        icon={<IconSmall name="outline-xmark" />}
                        variant="ghost-muted"
                        size="small"
                        title={tr("Delete user")}
                        onClick={() => setConfirmDelete(u.username)}
                      /> : <button
                          className="shrink-0 rounded-md bg-danger-soft px-2 py-1 text-11 text-danger"
                          onClick={async () => {
                            try {
                              await adminUsersApi.remove(u.username)
                              setConfirmDelete(null)
                              users.refetch()
                            } catch (e: any) {
                              setErr(e.message ?? String(e))
                              setConfirmDelete(null)
                            }
                          }}
                        >
                          {tr("delete?")}
                        </button>}
                  </div> : <div key={u.username} className="flex flex-col gap-2 rounded-lg border border-line-focus p-3">
                      <div className="text-13 text-ink">
                        {tr("Change the password for {username}", { username: u.username })}
                      </div>
                      <input
                        className={inputClass + " max-w-[320px]"}
                        type="password"
                        placeholder={tr("your current password (to confirm)")}
                        autoComplete="current-password"
                        value={adminPw}
                        onChange={(e) => setAdminPw(e.currentTarget.value)}
                      />
                      <input
                        className={inputClass + " max-w-[320px]"}
                        type="password"
                        placeholder={tr("new password (4+ chars)")}
                        autoComplete="new-password"
                        value={resetPw}
                        onChange={(e) => setResetPw(e.currentTarget.value)}
                      />
                      <div className="flex items-center gap-2">
                        <Button
                          variant="neutral"
                          size="normal"
                          disabled={resetPw.length < 4 || !adminPw}
                          onClick={async () => {
                            try {
                              await adminUsersApi.update(u.username, { password: resetPw, current: adminPw })
                              setResetting(null)
                              setResetPw("")
                              setAdminPw("")
                              users.refetch()
                            } catch (e: any) {
                              setErr(e.message ?? String(e))
                            }
                          }}
                        >
                          {tr("Save password")}
                        </Button>
                        <Button variant="ghost" size="normal" onClick={() => { setResetting(null); setResetPw(""); setAdminPw("") }}>
                          {tr("Cancel")}
                        </Button>
                      </div>
                    </div>
              )): <div className="text-13 text-ink-faint">{tr("Loading…")}</div>}
        </section>

        <section className="flex flex-col gap-2 rounded-lg border border-line p-3">
          <h3 className="text-13 font-medium text-ink">{tr("Add user")}</h3>
          <input className={inputClass} placeholder={tr("username")} value={username} onChange={(e) => setUsername(e.currentTarget.value)} />
          <input className={inputClass} type="password" placeholder={tr("password (4+ chars, used to sign in)")} value={password} onChange={(e) => setPassword(e.currentTarget.value)} />
          <Button variant="neutral" size="normal" disabled={busy || !username.trim() || password.trim().length < 4} onClick={create}>
            {tr("Create user")}
          </Button>
        </section>

        {err ? <div className="text-12 text-danger">{err}</div> : null}
        {msg ? <div className="text-12 text-success">{msg}</div> : null}
      </div>
    </Pane>
  )
}
