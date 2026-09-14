/**
 * <data>/format.json: the data layout this folder was last used with.
 *
 * Every start runs its migrations, then records DATA_FORMAT and its own
 * version here. A version that finds a higher format refuses to start instead
 * of reading data it does not understand and writing it back wrong, which is
 * what an older copy (a downgrade, a restored backup of the program, an old
 * Android build) would otherwise do after a newer one migrated the folder.
 *
 * Raise DATA_FORMAT only with a migration older versions cannot live with.
 */
import fs from "node:fs";
import path from "node:path";

export const DATA_FORMAT = 1;

interface FormatRecord {
  format: number;
  version: string;
}

const formatPath = (dataDir: string): string => path.join(dataDir, "format.json");

function readFormat(dataDir: string): FormatRecord | null {
  try {
    const raw = JSON.parse(fs.readFileSync(formatPath(dataDir), "utf8")) as Partial<FormatRecord>;
    if (typeof raw.format !== "number") return null;
    return { format: raw.format, version: typeof raw.version === "string" ? raw.version : "a newer version" };
  } catch {
    return null;
  }
}

/** Why this version must not open the folder, or null when it may. */
export function dataFormatProblem(dataDir: string, format: number = DATA_FORMAT): string | null {
  const found = readFormat(dataDir);
  if (!found || found.format <= format) return null;
  return `This data folder was last used by Chrysalis ${found.version}, which stores data in a newer way than this version can read. Install Chrysalis ${found.version} or newer to open it. Nothing was changed.`;
}

/** Record that the folder now holds this version's layout. */
export function recordDataFormat(dataDir: string, version: string, format: number = DATA_FORMAT): void {
  const found = readFormat(dataDir);
  if (found && found.format === format && found.version === version) return;
  const next = `${formatPath(dataDir)}.next`;
  fs.writeFileSync(next, `${JSON.stringify({ format, version }, null, 2)}\n`, "utf8");
  fs.renameSync(next, formatPath(dataDir));
}
