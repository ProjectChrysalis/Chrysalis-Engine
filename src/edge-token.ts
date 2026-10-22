/**
 * The Sec-MS-GEC token the Edge read-aloud service requires (version 2):
 * "<cs64>-<sha256>" over the 5-minute-floored Windows filetime plus the
 * client token. The SHA-256 starts from a fixed midstate with altered
 * constants, so node:crypto cannot compute it; every step below is the
 * service's, and test/edge-token.test.ts pins a known value.
 */

const INITIAL = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const STATE = [0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a, 0x6c006f49, 0x04bd35ab, 0xfeb0a7e4, 0x03effbd2];
const SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba, 0xa622ee8c, 0xd1dd9491, 0xc0dd25a0,
  0xf9e70ab6, 0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33, 0xd258b060, 0x72766564,
];
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const ADJUSTMENT = 0xc9dc06a7;
const K_FIRST_BLOCK = [...K.slice(0, 14), ADJUSTMENT, ...K.slice(15)];
const SIGMA0_ADJUSTMENT = 0x059c0b80;
const SIGMA1_ADJUSTMENT = 0x000b92c0;
const CS64 = [
  [0xe82e91b1, 0xb32700d0], [0x44de24c6, 0x88dff51d], [0x3beb65bc, 0x29514038], [0xc89c5933, 0xb328cbdf],
  [0x8d1ec211, 0xd405b4d5], [0x314ef5d5, 0x26e55f3c], [0xe92491b1, 0x607801c6], [0xf0a5b9d5, 0x82b2c1fb],
  [0x06064cf3, 0xfa51a3da], [0xda79fa60, 0x207cc464], [0xbed20560, 0x3c3c74f3], [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1], [0xcb49e3c6, 0xc5626167],
] as const;
const CS64_FACTOR = 0x82893933;
const CS64_ADJUSTMENT0 = 0xf2f90b1a;
const CS64_ADJUSTMENT1 = 0x0b1a0000;

const u = (n: number) => n >>> 0;
const rotr = (x: number, n: number) => u((x >>> n) | (x << (32 - n)));
const rol16 = (x: number) => u((x << 16) | (x >>> 16));
const mul = (a: number, b: number) => u(Math.imul(a, b));
const sigma0 = (x: number) => u(rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3));
const sigma1 = (x: number) => u(rotr(x, 17) ^ rotr(x, 19) ^ (x >>> 10));

function expand(w: number[], from = 16): void {
  for (let i = from; i < 64; i++) w[i] = u(sigma1(w[i - 2]!) + w[i - 7]! + sigma0(w[i - 15]!) + w[i - 16]!);
}

function rounds(state: number[], w: number[], first = 0): number[] {
  let [a, b, c, d, e, f, g, h] = state as [number, number, number, number, number, number, number, number];
  const k = first === 14 ? K_FIRST_BLOCK : K;
  for (let i = first; i < 64; i++) {
    const t1 = u(h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + (g ^ (e & (f ^ g))) + k[i]! + w[i]!);
    const t2 = u((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) | (c & (a | b))));
    h = g; g = f; f = e; e = u(d + t1); d = c; c = b; b = a; a = u(t1 + t2);
  }
  return [a, b, c, d, e, f, g, h];
}

/** The state after the first seven bytes, which share the altered block. */
function initial(head: Buffer): number[] {
  const w: number[] = new Array(14).fill(0);
  w.push((head[0]! << 16) | (head[1]! << 8) | head[2]!, head.readUInt32BE(3));
  for (let i = 16; i < 30; i++) {
    let v = SCHEDULE[i - 16]!;
    if (i - 2 >= 14) v += i === 16 ? u(sigma1(w[i - 2]!) ^ SIGMA1_ADJUSTMENT) : sigma1(w[i - 2]!);
    if (i - 7 >= 14) v += w[i - 7]!;
    if (i - 15 >= 14) v += i === 29 ? u(sigma0(w[i - 15]!) ^ SIGMA0_ADJUSTMENT) : sigma0(w[i - 15]!);
    w.push(u(v));
  }
  w.push(u(sigma1(w[28]!) + w[23]! + sigma0(w[15]!) + w[14]! + ADJUSTMENT - K[14]!));
  expand(w, 31);
  const worked = rounds(STATE, w, 14);
  return INITIAL.map((x, i) => u(x + worked[i]!));
}

function sha256(data: Buffer): Buffer {
  const length = 57 + data.length;
  const pad = (((55 - length) % 64) + 64) % 64;
  const len = Buffer.alloc(8);
  len.writeBigUInt64BE(BigInt(length * 8));
  const padded = Buffer.concat([data.subarray(7), Buffer.from([0x80]), Buffer.alloc(pad), len]);
  let state = initial(data.subarray(0, 7));
  for (let off = 0; off < padded.length; off += 64) {
    const w: number[] = [];
    for (let i = 0; i < 16; i++) w.push(padded.readUInt32BE(off + i * 4));
    expand(w);
    const worked = rounds(state, w);
    state = state.map((x, i) => u(x + worked[i]!));
  }
  const out = Buffer.alloc(32);
  state.forEach((x, i) => out.writeUInt32BE(x, i * 4));
  return out;
}

function cs64(data: Buffer, digest: Buffer): [number, number] {
  const keyA = u(digest.readUInt32LE(0) | 1);
  const keyB = u(digest.readUInt32LE(4) | 1);
  const factors = [mul(keyA, CS64_FACTOR), mul(keyB, CS64_FACTOR)];
  const terms = CS64.map(([coefficient], i) => mul(coefficient, factors[i % 2]!));
  const offsets: number[] = CS64.map(([, offset]) => offset);
  const bytes = Buffer.concat([Buffer.from([0]), data]);
  const padded = Buffer.concat([bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4)]);
  const words: number[] = [];
  for (let off = 0; off < padded.length; off += 4) words.push(padded.readUInt32LE(off));
  if (words.length % 2) words.push(0);
  words.forEach((word, i) => {
    let term = mul(word, i % 2 === 0 ? keyA : keyB);
    let offset = mul(rol16(word), i % 2 === 0 ? 0xef0569fb : 0xc31713db);
    if (i === 0) {
      term = u(term + mul(CS64_ADJUSTMENT0, factors[0]!));
      offset = u(offset + CS64_ADJUSTMENT1);
    }
    terms.push(term);
    offsets.push(offset);
  });
  let swapAcc = 0;
  let swapLast = 0;
  let state = 0;
  let acc = 0;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i]!;
    const y = terms[i + 1]!;
    let q = mul(rol16(u(offsets[i]! + x)), 0x76f50f34);
    swapAcc = u(swapAcc + u(mul(rol16(q), 0xc3efea97) + q));
    q = mul(rol16(u(offsets[i + 1]! + y)), 0x1881ce3c);
    swapLast = u(mul(rol16(q), 0x35bd1ec9) + q);
    swapAcc = u(swapAcc + swapLast);

    state = u(mul(state, keyA) + x);
    state = mul(rol16(state), 0xcf98b111);
    state = mul(rol16(state), 0x87085b9f);
    state = mul(rol16(state), 0x12ceb96d);
    state = mul(rol16(state), 0x257e1d83);
    acc = u(acc + state);
    let t = u(mul(state, keyB) + y);
    t = mul(rol16(t), 0xa27416f5);
    t = mul(rol16(t), 0xd38396ff);
    state = mul(rol16(mul(rol16(t), 0x7c932b89)), 0xbfa49f69);
    acc = u(acc + state);
  }
  return [u(swapLast ^ state), u(swapAcc ^ acc)];
}

/** Token for a unix time in seconds and the service's client token. */
export function edgeToken(unixSeconds: number, clientToken: string): string {
  const ticks = BigInt(Math.floor((unixSeconds + 11_644_473_600) / 300) * 300) * 10_000_000n;
  const data = Buffer.from(`${ticks}${clientToken}`, "ascii");
  const digest = sha256(data);
  const [lo, hi] = cs64(data, digest);
  const head = Buffer.alloc(8);
  head.writeUInt32LE(lo, 0);
  head.writeUInt32LE(hi, 4);
  return `${head.toString("hex").toUpperCase()}-${digest.toString("hex").toUpperCase()}`;
}
