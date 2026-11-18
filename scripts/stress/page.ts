/** The measuring side of a stress run: everything a scenario can do to the open app. */
import type { Browser } from "./browser.js";
import type { LoadResult, ScrollResult, SettleResult, StressPage, TypingResult } from "./types.js";

/** Frame gaps from requestAnimationFrame, collected until stop() returns them. */
const FRAMES = `
window.__stressFrames = { gaps: [], on: true, last: performance.now() };
const f = window.__stressFrames;
const tick = (t) => { if (!f.on) return; if (t - f.last > 34) f.gaps.push(Math.round(t - f.last)); f.last = t; requestAnimationFrame(tick); };
requestAnimationFrame(tick);`;

const frameStats = (gaps: number[]) => ({
  longFrames: gaps.filter((g) => g > 50).length,
  worstFrame: gaps.length ? Math.max(...gaps) : 0,
  blockedMs: gaps.reduce((a, b) => a + b, 0),
});

export function createPage(browser: Browser, appPath: string, ready: string, model: StressPage["model"]): StressPage {
  const app = async () => {
    for (let i = 0; i < 200; i++) {
      const ctx = await browser.frame(appPath);
      if (ctx) return ctx;
      await Bun.sleep(50);
    }
    const urls = (await browser.contexts()).map((c) => c.url.slice(0, 80));
    throw new Error(`no frame for ${appPath} among ${urls.join(", ")}`);
  };
  const page: StressPage = {
    model,
    async eval<T>(body: string) {
      return browser.run<T>(await app(), body);
    },
    shell<T>(body: string) {
      return browser.run<T>(browser.top, body);
    },
    async waitFor(condition, timeoutMs = 30_000) {
      const end = Date.now() + timeoutMs;
      let last = "";
      for (;;) {
        const ok = await page.eval<boolean>(`try { return !!(${condition}) } catch { return false }`).catch((e: Error) => {
          last = e.message;
          return false;
        });
        if (ok) return;
        if (Date.now() > end) throw new Error(`timed out waiting for ${condition}${last ? ` (last error: ${last})` : ""}`);
        await Bun.sleep(50);
      }
    },
    async type(selector, text, gapMs = 90): Promise<TypingResult> {
      const sel = JSON.stringify(selector);
      const found = await page.eval<boolean>(`
        const el = document.querySelector(${sel}); if (!el) return false;
        el.focus(); el.setSelectionRange?.(el.value.length, el.value.length);
        window.__stressEl = el; window.__stressBefore = el.value.length; window.__stressKeys = [];
        window.__stressObs?.disconnect();
        window.__stressObs = new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === "keydown") window.__stressKeys.push(Math.round(e.duration)); });
        window.__stressObs.observe({ type: "event", durationThreshold: 16 });
        ${FRAMES}
        return true;`);
      if (!found) throw new Error(`nothing matches ${selector}`);
      await page.shell(`document.querySelector('iframe[src*=${JSON.stringify(appPath)}]')?.focus(); return 1`);
      const keys = [];
      for (const ch of text) keys.push({ type: "keyDown", value: ch }, { type: "keyUp", value: ch }, { type: "pause", duration: gapMs });
      await browser.send("input.performActions", { context: await app(), actions: [{ type: "key", id: "keyboard", actions: keys }] });
      await Bun.sleep(500);
      const r = await page.eval<{ landed: number; keys: number[]; gaps: number[] }>(`
        window.__stressFrames.on = false; window.__stressObs.disconnect();
        return { landed: window.__stressEl.value.length - window.__stressBefore, keys: window.__stressKeys, gaps: window.__stressFrames.gaps };`);
      const all = [...r.keys, ...Array(Math.max(0, text.length - r.keys.length)).fill(0)].sort((a, b) => a - b);
      const q = (x: number) => all[Math.min(all.length - 1, Math.floor(all.length * x))] ?? 0;
      return { landed: r.landed, typed: text.length, p50: q(0.5), p90: q(0.9), max: all[all.length - 1] ?? 0, longFrames: frameStats(r.gaps).longFrames };
    },
    async act(action, until): Promise<SettleResult> {
      const r = await page.eval<{ settled: number; gaps: number[] }>(`
        const t0 = performance.now(); const gaps = []; let last = t0, settled = t0, met = ${until ? "0" : "t0"};
        ${action};
        await new Promise((done) => {
          const tick = (t) => {
            if (t - last > 34) { gaps.push(Math.round(t - last)); settled = t; }
            last = t;
            if (!met) { try { if (${until ?? "true"}) { met = t; settled = Math.max(settled, t); } } catch {} }
            if ((met && t - settled > 400 && t - t0 > 400) || t - t0 > 60000) done(); else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        if (!met) throw new Error("never became true: " + ${JSON.stringify(until ?? "")});
        return { settled: Math.round(settled - t0), gaps };`);
      const s = frameStats(r.gaps);
      return { settleMs: r.settled, worstFrame: s.worstFrame, blockedMs: s.blockedMs };
    },
    async open(timeoutMs = 120_000, onStatus) {
      const end = Date.now() + timeoutMs;
      const frameSel = JSON.stringify(`iframe[src*=${JSON.stringify(appPath)}]`);
      const appId = JSON.stringify(appPath.split("/").filter(Boolean).pop());
      // asked again only now and then: the frame appears once a first build
      // is done, and every ask is an app activation in the engine
      for (let asked = 0; ; ) {
        const done = await page.shell<boolean>(`
          if (document.querySelector(${frameSel})) return true;
          if (${Date.now() - asked > 5000}) window.dispatchEvent(new CustomEvent("chrysalis:open-app", { detail: { appId: ${appId} } }));
          return false;`).catch(() => false);
        if (done) break;
        if (Date.now() - asked > 5000) asked = Date.now();
        if (Date.now() > end) throw new Error("the shell did not open the app");
        await Bun.sleep(100);
      }
      let shown = "";
      for (;;) {
        if (await page.eval<boolean>(`try { return !!(${ready}) } catch { return false }`).catch(() => false)) return;
        if (Date.now() > end) throw new Error(`the app was not ready within ${Math.round(timeoutMs / 1000)} s`);
        const status = await page.shell<string>(`return document.querySelector('[role=status]')?.textContent?.trim() ?? ""`).catch(() => "");
        if (status && status !== shown) onStatus?.(status);
        shown = status;
        await Bun.sleep(50);
      }
    },
    async reload(): Promise<LoadResult> {
      const t0 = performance.now();
      await browser.send("browsingContext.reload", { context: browser.top, wait: "complete" });
      await page.open();
      const readyMs = Math.round(performance.now() - t0);
      return page.shell<LoadResult>(`
        performance.setResourceTimingBufferSize(100000);
        const rs = performance.getEntriesByType("resource").filter((r) => r.name.includes("/v1/"));
        return { readyMs: ${readyMs}, requests: rs.length, kb: Math.round(rs.reduce((a, r) => a + (r.encodedBodySize || 0), 0) / 1024) };`);
    },
    async scroll(selector, px): Promise<ScrollResult> {
      const sel = JSON.stringify(selector);
      const box = await page.eval<{ x: number; y: number } | null>(`
        const el = document.querySelector(${sel}); if (!el) return null;
        const r = el.getBoundingClientRect(); ${FRAMES}
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + Math.min(r.height / 2, 300)) };`);
      if (!box) throw new Error(`nothing matches ${selector}`);
      const step = Math.sign(px) * 240;
      const actions = [];
      for (let moved = 0; Math.abs(moved) < Math.abs(px); moved += step) {
        actions.push({ type: "scroll", x: box.x, y: box.y, deltaX: 0, deltaY: step, origin: "viewport" }, { type: "pause", duration: 16 });
      }
      await browser.send("input.performActions", { context: await app(), actions: [{ type: "wheel", id: "wheel", actions }] });
      await Bun.sleep(400);
      const gaps = await page.eval<number[]>(`window.__stressFrames.on = false; return window.__stressFrames.gaps`);
      return frameStats(gaps);
    },
    async screenshot(file) {
      const r = (await browser.send("browsingContext.captureScreenshot", { context: browser.top })) as { data: string };
      await Bun.write(file, Buffer.from(r.data, "base64"));
    },
  };
  return page;
}
