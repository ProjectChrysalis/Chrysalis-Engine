/** Minimal timestamped logger. No dependency.
 *
 *  Once the data folder is known, lines also go to <data>/logs/chrysalis.log:
 *  installed copies and the Android launcher have no terminal, and one-time
 *  secrets (setup link, password reset codes) must still reach the owner. The
 *  file is private to the account running the engine and rolls over at 5 MB. */
import fs from "node:fs";
import path from "node:path";
import { format, stripVTControlCharacters } from "node:util";
import { consoleStyle as c } from "./console-style.js";

const t = () => new Date().toISOString().slice(11, 23);
const MAX_BYTES = 5 * 1024 * 1024;

let logFile: string | null = null;
let written = 0;

function toFile(level: string, args: unknown[]): void {
  if (!logFile) return;
  const line = `${new Date().toISOString()} ${level} ${stripVTControlCharacters(format(...args))}\n`;
  try {
    const bytes = Buffer.byteLength(line);
    if (written + bytes > MAX_BYTES) {
      fs.renameSync(logFile, `${logFile}.1`);
      written = 0;
    }
    fs.appendFileSync(logFile, line, { mode: 0o600 });
    written += bytes;
  } catch {
    /* the console copy still went out */
  }
}

export const log = {
  info: (...a: unknown[]) => {
    process.stdout.write(`${c.dim}[${t()}]${c.reset} ${c.cyan}INFO ${c.reset} ${format(...a)}\n`);
    toFile("INFO ", a);
  },
  warn: (...a: unknown[]) => {
    process.stderr.write(`${c.dim}[${t()}]${c.reset} ${c.yellow}WARN ${c.reset} ${format(...a)}\n`);
    toFile("WARN ", a);
  },
  error: (...a: unknown[]) => {
    process.stderr.write(`${c.dim}[${t()}]${c.reset} ${c.red}ERROR${c.reset} ${format(...a)}\n`);
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
