/**
 * <data>/engine.lock: which engine is serving this data folder.
 *
 * Two engines on one data folder overwrite each other's users.json, sessions
 * and chat files. The lock names the running engine's address and a random
 * instance id that /v1/health echoes, so a lock left behind by a crash (or a
 * reused pid after a phone reboot) is told apart from a live engine by asking
 * it, not by trusting the file.
 */
import fs from "node:fs";
import path from "node:path";

export interface EngineLock {
  pid: number;
  instance: string;
  /** URL this computer can reach the engine at. */
  url: string;
  startedAt: number;
}

const lockPath = (dataDir: string): string => path.join(dataDir, "engine.lock");

function readLock(dataDir: string): EngineLock | null {
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath(dataDir), "utf8")) as Partial<EngineLock>;
    if (typeof raw.instance !== "string" || typeof raw.url !== "string") return null;
    return raw as EngineLock;
  } catch {
    return null;
  }
}

/** The live engine serving this data folder, if any. */
export async function runningEngine(dataDir: string): Promise<EngineLock | null> {
  const lock = readLock(dataDir);
  if (!lock) return null;
  try {
    const res = await fetch(`${lock.url}/v1/health`, {
      signal: AbortSignal.timeout(1500),
      // a self-signed certificate is normal for a LAN engine
      tls: { rejectUnauthorized: false },
    });
    const body = (await res.json()) as { instance?: string };
    return body.instance === lock.instance ? lock : null;
  } catch {
    return null;
  }
}

/** Write the lock. A launcher that started the engine (the Android app) can
 *  ask for the same record at a path of its own with CHRYSALIS_STATUS_FILE,
 *  so it finds the engine without knowing its data folder or port. */
export function writeLock(dataDir: string, lock: EngineLock): void {
  const body = `${JSON.stringify(lock, null, 2)}\n`;
  fs.writeFileSync(lockPath(dataDir), body, { mode: 0o600 });
  if (process.env.CHRYSALIS_STATUS_FILE) fs.writeFileSync(process.env.CHRYSALIS_STATUS_FILE, body, { mode: 0o600 });
}

/** Remove the lock if it is still ours. */
export function releaseLock(dataDir: string, instance: string): void {
  if (readLock(dataDir)?.instance === instance) {
    try {
      fs.rmSync(lockPath(dataDir));
    } catch {
      /* already gone */
    }
  }
}
