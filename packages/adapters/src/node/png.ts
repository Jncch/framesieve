import { deflateSync, inflateSync } from "node:zlib";

/**
 * Minimal PNG codec with zero npm dependencies (zlib is a node
 * builtin). Supports what framesieve produces and consumes:
 * 8-bit depth, color types 0 (gray), 2 (RGB) and 6 (RGBA),
 * non-interlaced. The encoder always writes color type 6 with filter
 * type None; recordings and fixtures are small, simplicity wins over
 * compression ratio.
 */

export interface RawImage {
  /** RGBA, row-major, width * height * 4. */
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

const SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(...parts: Uint8Array[]): number {
  let c = 0xffffffff;
  for (const part of parts) {
    for (let i = 0; i < part.length; i++) {
      c = CRC_TABLE[(c ^ part[i]!) & 0xff]! ^ (c >>> 8);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(typeBytes, data));
  return out;
}

export function encodePng(image: RawImage): Uint8Array {
  const { data, width, height } = image;
  if (data.length !== width * height * 4) {
    throw new RangeError("image data length does not match dimensions");
  }
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace

  // Filter type None (0) prepended to each scanline.
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(
      data.subarray(y * stride, (y + 1) * stride),
      y * (stride + 1) + 1,
    );
  }
  const idat = new Uint8Array(deflateSync(raw, { level: 9 }));

  const parts = [
    SIGNATURE,
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

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePng(bytes: Uint8Array): RawImage {
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new SyntaxError("not a PNG file");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idatParts: Uint8Array[] = [];
  const decoder = new TextDecoder("latin1");
  while (off < bytes.length) {
    const length = view.getUint32(off);
    const type = decoder.decode(bytes.subarray(off + 4, off + 8));
    const data = bytes.subarray(off + 8, off + 8 + length);
    const expected = view.getUint32(off + 8 + length);
    if (crc32(bytes.subarray(off + 4, off + 8), data) !== expected) {
      throw new SyntaxError(`PNG chunk ${type} failed CRC check`);
    }
    if (type === "IHDR") {
      const ihdr = new DataView(bytes.buffer, bytes.byteOffset + off + 8, 13);
      width = ihdr.getUint32(0);
      height = ihdr.getUint32(4);
      const bitDepth = ihdr.getUint8(8);
      colorType = ihdr.getUint8(9);
      const interlace = ihdr.getUint8(12);
      if (bitDepth !== 8) {
        throw new SyntaxError(`unsupported PNG bit depth ${bitDepth}`);
      }
      if (colorType !== 0 && colorType !== 2 && colorType !== 6) {
        throw new SyntaxError(`unsupported PNG color type ${colorType}`);
      }
      if (interlace !== 0) {
        throw new SyntaxError("interlaced PNG is not supported");
      }
    } else if (type === "IDAT") {
      idatParts.push(data);
    } else if (type === "IEND") {
      break;
    }
    off += 12 + length;
  }
  if (width === 0 || height === 0 || idatParts.length === 0) {
    throw new SyntaxError("PNG is missing IHDR or IDAT");
  }

  const compressed = new Uint8Array(
    idatParts.reduce((n, p) => n + p.length, 0),
  );
  let coff = 0;
  for (const p of idatParts) {
    compressed.set(p, coff);
    coff += p.length;
  }
  const raw = new Uint8Array(inflateSync(compressed));

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const stride = width * channels;
  if (raw.length !== (stride + 1) * height) {
    throw new SyntaxError("PNG pixel data has unexpected length");
  }

  // Unfilter in place into a channel buffer.
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[x - channels]! : 0;
      const b = prev !== null ? prev[x]! : 0;
      const c = prev !== null && x >= channels ? prev[x - channels]! : 0;
      let v = line[x]!;
      switch (filter) {
        case 0:
          break;
        case 1:
          v = (v + a) & 0xff;
          break;
        case 2:
          v = (v + b) & 0xff;
          break;
        case 3:
          v = (v + ((a + b) >> 1)) & 0xff;
          break;
        case 4:
          v = (v + paeth(a, b, c)) & 0xff;
          break;
        default:
          throw new SyntaxError(`unsupported PNG filter type ${filter}`);
      }
      out[x] = v;
    }
  }

  const data = new Uint8ClampedArray(width * height * 4);
  if (channels === 4) {
    data.set(pixels);
  } else if (channels === 3) {
    for (let i = 0, p = 0; i < width * height; i++, p += 3) {
      data[i * 4] = pixels[p]!;
      data[i * 4 + 1] = pixels[p + 1]!;
      data[i * 4 + 2] = pixels[p + 2]!;
      data[i * 4 + 3] = 255;
    }
  } else {
    for (let i = 0; i < width * height; i++) {
      const g = pixels[i]!;
      data[i * 4] = g;
      data[i * 4 + 1] = g;
      data[i * 4 + 2] = g;
      data[i * 4 + 3] = 255;
    }
  }
  return { data, width, height };
}
