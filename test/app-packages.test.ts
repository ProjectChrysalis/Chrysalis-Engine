import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { damagedPackages } from "../src/apps/packages.js";

let app: string;
beforeEach(() => {
  app = fs.mkdtempSync(path.join(os.tmpdir(), "app-packages-"));
});
afterEach(() => {
  fs.rmSync(app, { recursive: true, force: true });
});

const put = (rel: string, body: string | Buffer) => {
  const file = path.join(app, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};

describe("damagedPackages", () => {
  it("passes a healthy install, BOMs and folders without a manifest", () => {
    put("node_modules/react/package.json", '{"name":"react"}');
    put("node_modules/react/index.js", '"use strict";\n');
    put("node_modules/@scope/ok/package.json", '﻿{"name":"@scope/ok"}');
    put("node_modules/.bin/tool", "#!/bin/sh");
    put("node_modules/stray/readme.md", "no manifest");
    expect(damagedPackages(app, ["node_modules/react/index.js", "node_modules/react/missing.js"])).toEqual([]);
  });

  it("names a package whose manifest does not parse, scoped or not", () => {
    put("node_modules/@base-ui/react/package.json", Buffer.from([0x0e, 0x91, 0x22, 0x7b]));
    put("node_modules/plain/package.json", '{"name": ');
    expect(damagedPackages(app).sort()).toEqual(["@base-ui/react", "plain"]);
  });

  it("names a package whose file a build failed on starts with a control byte", () => {
    put("node_modules/@base-ui/react/package.json", '{"name":"@base-ui/react"}');
    put("node_modules/@base-ui/react/alert-dialog/index.js", Buffer.from([0x0e, 0x00, 0x41]));
    put("node_modules/fine/package.json", '{"name":"fine"}');
    put("node_modules/fine/index.js", "\texport default 1\n");
    expect(damagedPackages(app, ["node_modules/@base-ui/react/alert-dialog/index.js", "node_modules/fine/index.js", "src/main.tsx"])).toEqual(["@base-ui/react"]);
  });

  it("is empty when nothing is installed", () => {
    expect(damagedPackages(app)).toEqual([]);
  });
});
