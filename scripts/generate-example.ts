/**
 * Generates examples/meeting: a deterministic 30-second, 2 fps
 * "screen share during a meeting" recording used by the README and
 * the tests. The scene: slides that flip twice, plus a camera tile
 * in the top-right corner whose pixels move every frame - the
 * textbook case for the adaptive frequency mask.
 *
 * The recording is produced by the real gate + recorder with default
 * options, so examples/meeting/timeline.jsonl is the ground-truth
 * decision sequence for the default configuration. Replaying the
 * example must reproduce it; a diff there is a breaking change.
 *
 * Usage: node scripts/generate-example.ts
 */
import { rmSync } from "node:fs";
import { join } from "node:path";

import { createFrameGate } from "../packages/core/src/index.ts";
import type { FrameInput } from "../packages/core/src/index.ts";
import { createRecorder } from "../packages/adapters/src/node/recording.ts";

const WIDTH = 320;
const HEIGHT = 180;
const FRAME_COUNT = 60; // 30 s at 2 fps
const INTERVAL_MS = 500;
const FLIP_1 = 30; // 0-based frame index of the first slide flip (t=15s)
const FLIP_2 = 48; // second flip (t=24s)

class Lcg {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state;
  }
  level(): number {
    return this.next() & 0xff;
  }
}

function fillRect(
  c: Uint8ClampedArray,
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

function slide(variant: number): Uint8ClampedArray {
  const c = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  fillRect(c, 0, 0, WIDTH, HEIGHT, 240);
  fillRect(c, 0, 0, WIDTH, 22, 50); // title bar
  const rng = new Lcg(0x6ee7 + variant * 7919);
  for (let i = 0; i < 5; i++) {
    const y = 40 + i * 26;
    fillRect(c, 20, y, 90 + (rng.next() % 170), 14, 100 + (rng.next() % 100));
  }
  return c;
}

const cameraRng = new Lcg(0xcafe);

/** Top-right camera tile: 96x54, noise tiles aligned to the 8px grid. */
function paintCamera(c: Uint8ClampedArray): void {
  for (let y = 0; y < 56; y += 8) {
    for (let x = WIDTH - 96; x < WIDTH; x += 8) {
      fillRect(c, x, y, 8, 8, cameraRng.level());
    }
  }
}

const dir = join(import.meta.dirname, "..", "examples", "meeting");
rmSync(dir, { recursive: true, force: true });

const slides = [slide(1), slide(2), slide(3)];
const gate = createFrameGate(); // defaults: the example documents them
const recorder = createRecorder({ dir });
recorder.attach(gate);

for (let i = 0; i < FRAME_COUNT; i++) {
  const base = i >= FLIP_2 ? slides[2]! : i >= FLIP_1 ? slides[1]! : slides[0]!;
  const data = new Uint8ClampedArray(base);
  paintCamera(data);
  const frame: FrameInput = {
    data,
    width: WIDTH,
    height: HEIGHT,
    elapsedMs: i * INTERVAL_MS,
  };
  gate.push(frame);
}
await recorder.stop();

const stats = gate.stats();
console.log(
  `examples/meeting: ${stats.framesSeen} frames, ${stats.framesEmitted} emits`,
);
