/**
 * Deterministic fixture generator. Never uses Math.random or the
 * clock: all variation comes from a seeded LCG, so re-running this
 * script reproduces the checked-in PNG sequences byte for byte
 * (modulo the zlib version used for compression; the decoded pixels
 * are what tests depend on).
 *
 * Usage: node scripts/generate-fixtures.ts
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { encodePng } from "../packages/adapters/src/node/png.ts";

const WIDTH = 320;
const HEIGHT = 180;
const OUT = join(import.meta.dirname, "..", "fixtures");

class Lcg {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    // Numerical Recipes LCG; plenty for noise tiles.
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state;
  }
  level(): number {
    return this.next() & 0xff;
  }
}

type Canvas = Uint8ClampedArray;

function canvas(level: number): Canvas {
  const c = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  fillRect(c, 0, 0, WIDTH, HEIGHT, level);
  return c;
}

function fillRect(
  c: Canvas,
  x0: number,
  y0: number,
  w: number,
  h: number,
  level: number,
): void {
  for (let y = y0; y < Math.min(HEIGHT, y0 + h); y++) {
    for (let x = x0; x < Math.min(WIDTH, x0 + w); x++) {
      const p = (y * WIDTH + x) * 4;
      c[p] = level;
      c[p + 1] = level;
      c[p + 2] = level;
      c[p + 3] = 255;
    }
  }
}

/** A slide: title bar plus content bars whose layout depends on variant. */
function slide(variant: number): Canvas {
  const c = canvas(235);
  fillRect(c, 0, 0, WIDTH, 24, 60); // title bar
  const rng = new Lcg(0x5eed + variant * 977);
  for (let i = 0; i < 6; i++) {
    const y = 40 + i * 22;
    const w = 80 + (rng.next() % 200);
    fillRect(c, 16, y, w, 12, 120 + (rng.next() % 80));
  }
  return c;
}

function writeSequence(name: string, frames: Canvas[]): void {
  const dir = join(OUT, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  frames.forEach((data, i) => {
    const file = join(dir, `${String(i + 1).padStart(6, "0")}.png`);
    writeFileSync(file, encodePng({ data, width: WIDTH, height: HEIGHT }));
  });
  console.log(`${name}: ${frames.length} frames`);
}

// slide-flip: static slide A, then a flip to slide B.
{
  const a = slide(1);
  const b = slide(2);
  const frames = [
    ...Array.from({ length: 6 }, () => new Uint8ClampedArray(a)),
    ...Array.from({ length: 6 }, () => new Uint8ClampedArray(b)),
  ];
  writeSequence("slide-flip", frames);
}

// cursor: a small cursor square gliding over a static slide.
{
  const a = slide(1);
  const frames = Array.from({ length: 10 }, (_, i) => {
    const c = new Uint8ClampedArray(a);
    fillRect(c, 40 + i * 3, 90, 8, 8, 10);
    return c;
  });
  writeSequence("cursor", frames);
}

// video-noise: left strip is per-frame noise (an embedded video); the
// right side is static until a late slide change.
{
  const bg = slide(3);
  const rng = new Lcg(0xbeef);
  const frames: Canvas[] = [];
  for (let i = 0; i < 30; i++) {
    const c = new Uint8ClampedArray(bg);
    if (i >= 24) {
      // Late change in the static area: three fresh content bars.
      fillRect(c, 176, 60, 120, 14, 30);
      fillRect(c, 176, 84, 100, 14, 200);
      fillRect(c, 176, 108, 130, 14, 80);
    }
    // Noise tiles aligned to the 8px downsample grid so every working
    // pixel in the strip moves each frame.
    for (let y = 0; y < HEIGHT; y += 8) {
      for (let x = 0; x < 80; x += 8) {
        fillRect(c, x, y, 8, 8, rng.level());
      }
    }
    frames.push(c);
  }
  writeSequence("video-noise", frames);
}

// tooltip-blip: a static slide with a tooltip overlay that appears for a
// few frames, then reverts completely to the slide. Exercises reference
// mode (the transient is dropped) vs previous mode (it registers on
// appear and again on disappear).
{
  const bg = slide(4);
  const withTip = new Uint8ClampedArray(bg);
  fillRect(withTip, 192, 56, 72, 48, 20); // opaque tooltip box
  const seq = [bg, bg, bg, withTip, withTip, withTip, bg, bg, bg, bg];
  writeSequence(
    "tooltip-blip",
    seq.map((c) => new Uint8ClampedArray(c)),
  );
}
