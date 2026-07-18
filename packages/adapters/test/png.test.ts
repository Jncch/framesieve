import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { decodePng, encodePng } from "../src/node/png.ts";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures");

test("encode -> decode round-trips RGBA pixels exactly", () => {
  const width = 33; // odd size exercises non-aligned strides
  const height = 7;
  const data = new Uint8ClampedArray(width * height * 4);
  // Deterministic pattern with all channels exercised.
  for (let i = 0; i < data.length; i++) {
    data[i] = (i * 31 + (i >> 3)) & 0xff;
  }
  const decoded = decodePng(encodePng({ data, width, height }));
  assert.equal(decoded.width, width);
  assert.equal(decoded.height, height);
  assert.deepEqual(Array.from(decoded.data), Array.from(data));
});

test("decode rejects corrupted and non-PNG input", () => {
  assert.throws(() => decodePng(new Uint8Array([1, 2, 3])), SyntaxError);
  const good = encodePng({
    data: new Uint8ClampedArray(4 * 4 * 4),
    width: 4,
    height: 4,
  });
  const corrupted = new Uint8Array(good);
  corrupted[40] = corrupted[40]! ^ 0xff; // flip a byte inside IDAT
  assert.throws(() => decodePng(corrupted), SyntaxError);
});

test("checked-in fixtures decode with the expected dimensions", () => {
  for (const name of ["slide-flip", "cursor", "video-noise"]) {
    const dir = join(FIXTURES, name);
    const files = readdirSync(dir).filter((f) => f.endsWith(".png")).sort();
    assert.ok(files.length > 0, `${name} has frames`);
    const img = decodePng(readFileSync(join(dir, files[0]!)));
    assert.equal(img.width, 320);
    assert.equal(img.height, 180);
  }
});

test("filtered PNGs (Sub/Up/Average/Paeth) unfilter correctly", () => {
  // Hand-build a PNG whose five scanlines use filter types 0-4, then
  // check decode against an independently computed expectation.
  const width = 4;
  const height = 5;
  const stride = width * 4;
  // Target pixel bytes: value = (y * 7 + x * 13) & 0xff per channel
  // position, chosen so every filter produces nonzero deltas.
  const target = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < stride; x++) {
      target[y * stride + x] = (y * 7 + x * 13) & 0xff;
    }
  }
  const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  };
  // Forward-filter each line with its filter type.
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const filter = y; // 0..4
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const cur = target[y * stride + x]!;
      const a = x >= 4 ? target[y * stride + x - 4]! : 0;
      const b = y > 0 ? target[(y - 1) * stride + x]! : 0;
      const c = y > 0 && x >= 4 ? target[(y - 1) * stride + x - 4]! : 0;
      let v = cur;
      if (filter === 1) v = (cur - a) & 0xff;
      else if (filter === 2) v = (cur - b) & 0xff;
      else if (filter === 3) v = (cur - ((a + b) >> 1)) & 0xff;
      else if (filter === 4) v = (cur - paeth(a, b, c)) & 0xff;
      raw[y * (stride + 1) + 1 + x] = v;
    }
  }
  const png = buildPng(width, height, new Uint8Array(deflateSync(raw)));
  const decoded = decodePng(png);
  assert.deepEqual(Array.from(decoded.data), Array.from(target));
});

// Minimal PNG writer for the test above (RGBA8, custom IDAT payload).
function buildPng(width: number, height: number, idat: Uint8Array): Uint8Array {
  const crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  const crc32 = (...parts: Uint8Array[]): number => {
    let c = 0xffffffff;
    for (const part of parts) {
      for (const byte of part) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const typeBytes = new TextEncoder().encode(type);
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(typeBytes, 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(typeBytes, data));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const parts = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
