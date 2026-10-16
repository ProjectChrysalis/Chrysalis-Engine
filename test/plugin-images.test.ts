import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { PluginSandbox } from '../src/plugins/sandbox.js';

it('reads compressed image metadata and stores stripped artwork inside the app', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-images-'));
  const box = new PluginSandbox();
  const chunk = (type: string, data: Buffer) => {
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length); out.write(type, 4); data.copy(out, 8);
    return out;
  };
  const png = Buffer.concat([
    Buffer.from([137,80,78,71,13,10,26,10]),
    chunk('tEXt', Buffer.from('plain\0Plain text')),
    chunk('zTXt', Buffer.concat([Buffer.from('compressed\0\0'), deflateSync(Buffer.from('Compressed text'))])),
    chunk('iTXt', Buffer.concat([Buffer.from('unicode\0\x01\0\0\0'), deflateSync(Buffer.from('こんにちは'))])),
    chunk('tEXt', Buffer.from('chara\0' + Buffer.from('{"name":"Élodie 🙂"}').toString('base64'))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  const request = {
    source: 'export function handleRoute(ctx, host) { return host.fs.image(ctx.image); }', hook: '__route',
    ctx: { image: 'data:image/png;base64,' + png.toString('base64') }, storeSnapshot: {}, fsAllowed: true, fsRoot: root,
  };
  try {
    const result = await box.eval(request);
    expect(result.ok).toBe(true);
    const out = result.out as { url: string; metadata: Record<string, string>; text: Record<string, string> };
    expect(out.metadata).toMatchObject({ plain: 'Plain text', compressed: 'Compressed text', unicode: 'こんにちは' });
    // base64 fields (card data) arrive decoded too, so the guest does not decode them itself
    expect(out.text).toEqual({ chara: '{"name":"Élodie 🙂"}' });
    const imageFile = path.join(root, '__media', path.basename(out.url));
    const stored = fs.readFileSync(imageFile);
    expect(stored.includes(Buffer.from('zTXt'))).toBe(false);
    expect(stored.includes(Buffer.from('iTXt'))).toBe(false);
    const denied = await box.eval({ ...request, fsAllowed: false });
    expect(denied.ok).toBe(false);
    const malformed = await box.eval({ ...request, ctx: { image: 'data:image/png;base64,AA==' } });
    expect(malformed.ok).toBe(false);
  } finally { await box.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});

it('reads many files in one call, null for any it cannot read, and only inside the app', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-readmany-'));
  fs.writeFileSync(path.join(root, 'a.json'), '{"a":1}');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'bee');
  const box = new PluginSandbox();
  const run = (paths: unknown) => box.eval({
    source: 'export function handleRoute(ctx, host) { return host.fs.readMany(ctx.paths); }', hook: '__route',
    ctx: { paths }, storeSnapshot: {}, fsAllowed: true, fsRoot: root,
  });
  try {
    const result = await run(['a.json', 'sub/b.txt', 'missing.json', '../outside.json']);
    expect(result.ok).toBe(true);
    expect(result.out).toEqual(['{"a":1}', 'bee', null, null]);
    expect((await run('a.json')).ok).toBe(false);
  } finally { await box.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});
