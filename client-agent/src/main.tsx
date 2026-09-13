import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "@fontsource-variable/inter"
import "@fontsource/ibm-plex-mono/400.css"
import "@fontsource/ibm-plex-mono/600.css"
import "@/globals.css"
import App from "./App"
import { connectWs, useAgent } from "./store"

// theme comes from the launcher (same-origin localStorage), defaulting to dark
function applyTheme(): void {
  document.documentElement.classList.toggle("dark", (localStorage.getItem("chrysalis-theme") || "dark") === "dark")
}
applyTheme()
window.addEventListener("storage", (e) => {
  if (e.key === "chrysalis-theme") applyTheme()
})

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// The shell can hand the agent a task (an app update's merge, say): it opens
// a fresh chat with that message. Announced only once init has restored the
// last thread, so the restore cannot swap the new chat out from under it.
window.addEventListener("message", (e) => {
  if (e.origin !== location.origin || e.source !== window.parent) return
  const d = e.data as { __chrysalisAgent?: unknown; text?: unknown } | null
  if (d?.__chrysalisAgent !== "start" || typeof d.text !== "string" || !d.text.trim()) return
  const agent = useAgent.getState()
  agent.newChat()
  void agent.send(d.text)
})

connectWs()
void useAgent.getState().init().finally(() => {
  if (window.parent !== window) window.parent.postMessage({ __chrysalisAgent: "ready" }, location.origin)
})
