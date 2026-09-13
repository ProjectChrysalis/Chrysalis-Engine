/** Minimal timestamped logger. No dependency.
 *
 *  Once the data folder is known, lines also go to <data>/logs/chrysalis.log:
 *  installed copies and the Android launcher have no terminal, and one-time
 *  secrets (setup link, password reset codes) must still reach the owner. The
 *  file is private to the account running the engine and rolls over at 5 MB. */
import fs from "node:fs";
import path from "node:path";
import { format } from "node:util";

const t = () => new Date().toISOString().slice(11, 23);
const MAX_BYTES = 5 * 1024 * 1024;

let logFile: string | null = null;
let written = 0;

function toFile(level: string, args: unknown[]): void {
  if (!logFile) return;
  const line = `${new Date().toISOString()} ${level} ${format(...args)}\n`;
  try {
    if (written + line.length > MAX_BYTES) {
      fs.renameSync(logFile, `${logFile}.1`);
      written = 0;
    }
    fs.appendFileSync(logFile, line, { mode: 0o600 });
    written += line.length;
  } catch {
    /* the console copy still went out */
  }
}

export const log = {
  info: (...a: unknown[]) => {
    console.log(`[${t()}] INFO `, ...a);
    toFile("INFO ", a);
  },
  warn: (...a: unknown[]) => {
    console.warn(`[${t()}] WARN `, ...a);
    toFile("WARN ", a);
  },
  error: (...a: unknown[]) => {
    console.error(`[${t()}] ERROR`, ...a);
    toFile("ERROR", a);
  },
};

/** Start copying log lines to <dataDir>/logs/chrysalis.log. */
export function logToFile(dataDir: string): string {
  const dir = path.join(dataDir, "logs");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  logFile = path.join(dir, "chrysalis.log");
  try {
    written = fs.statSync(logFile).size;
  } catch {
    written = 0;
  }
  return logFile;
}
