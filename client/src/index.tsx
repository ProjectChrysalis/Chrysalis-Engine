import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "./App"
import "./styles/shell.css"

/** Host scripts the shell needs before it renders anything: the bridge host
 *  (from public/) plus the builder and sandbox hosts, which the engine bundles
 *  on demand at these URLs. Loaded here rather than as tags in index.html so
 *  the page holds only its module entry, which is what both the build
 *  pipeline and the dev server can bundle. */
const HOST_SCRIPTS = ["/client/app-bridge-host.js", "/client/builder/host.js", "/client/sandbox/host.js"]

const loadScript = (src: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const el = document.createElement("script")
    el.src = src
    el.onload = () => resolve()
    el.onerror = () => reject(new Error(`could not load ${src}`))
    document.head.append(el)
  })

// error text goes through textContent — innerHTML would let server/proxy
// strings (which can ride inside Error messages) inject markup into the page
const errPre = (label: string, text: string): HTMLPreElement => {
  const pre = document.createElement("pre")
  pre.className = "jserr"
  pre.style.cssText = "color:#e26a75;white-space:pre-wrap;padding:8px 20px"
  pre.textContent = `${label}${text}`
  return pre
}

try {
  await Promise.all(HOST_SCRIPTS.map(loadScript))
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
} catch (e: any) {
  const pre = errPre("boot error: ", String(e?.stack ?? e))
  pre.style.padding = "20px"
  document.getElementById("root")!.replaceChildren(pre)
}
window.addEventListener("error", (e) => {
  document.getElementById("root")!.append(errPre("", String(e.error?.stack ?? e.message)))
})
window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason as { stack?: string; message?: string } | undefined
  document.getElementById("root")!.append(errPre("async: ", `${String(reason)}\n${String(reason?.stack ?? "")}`))
})
