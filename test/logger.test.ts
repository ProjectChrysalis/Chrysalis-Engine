import { expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

it("colors console levels while keeping the file plain and retaining error stacks", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logger-test-"));
  try {
    const logger = path.resolve("src/logger.ts");
    const script = `import {log,logToFile} from ${JSON.stringify(logger)};
      logToFile(${JSON.stringify(dir)});
      log.info("Ready on %s", "localhost");
      log.warn("Slow provider");
      log.error(new Error("Upstream rejected request"));`;
    const run = async (noColor: boolean) => {
      const env: Record<string, string | undefined> = { ...process.env, FORCE_COLOR: "1" };
      delete env.NO_COLOR;
      if (noColor) env.NO_COLOR = "1";
      const proc = Bun.spawn([process.execPath, "--eval", script], { env, stdout: "pipe", stderr: "pipe" });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(code).toBe(0);
      return out + err;
    };
    const colored = await run(false);
    expect(colored).toContain("\x1b[36mINFO");
    expect(colored).toContain("\x1b[33mWARN");
    expect(colored).toContain("\x1b[31mERROR");
    expect(colored).toContain("Ready on localhost");
    const plain = await run(true);
    expect(plain).not.toContain("\x1b[");
    const file = fs.readFileSync(path.join(dir, "logs/chrysalis.log"), "utf8");
    expect(file).not.toContain("\x1b[");
    expect(file).toContain("Error: Upstream rejected request");
    expect(file).toContain("at ");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
