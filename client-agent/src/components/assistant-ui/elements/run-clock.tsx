import { useEffect, useState } from "react";
import { useAgent } from "@/store";
import { tr } from "@/i18n";

export function RunClock() {
  const running = useAgent((s) => s.running);
  const started = useAgent((s) => s.runStartedAt);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running || !started) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running, started]);
  if (!running || !started || !Number.isFinite(started)) return null;
  const seconds = Math.max(0, Math.floor((now - started) / 1000));
  const elapsed = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return <div className="text-muted-foreground px-1 text-xs" role="timer" aria-label={tr("Run elapsed time")}>
    {tr("Working")} · {elapsed}
  </div>;
}
