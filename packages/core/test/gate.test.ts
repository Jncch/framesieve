import { test } from "node:test";
import assert from "node:assert/strict";

import { createFrameGate } from "../src/gate.ts";
import type { Decision, EmitEvent, FrameGateOptions, FrameInput } from "../src/types.ts";
import { solidFrame, paintRect, at } from "./helpers.ts";

// 64x64 source, factor 8 -> 8x8 working, 4x4 grid -> 2x2 px blocks.
// One 16x16 source rect = one grid block.
// Adaptive masking is exercised in blocks.test.ts; policy tests turn
// it off so expected scores are whole block counts.
const GRID: FrameGateOptions = {
  diff: { downsampleFactor: 8 },
  blocks: { gridCols: 4, gridRows: 4, minChangedBlocks: 2 },
  adaptiveMask: { enabled: false },
};

const base = solidFrame(64, 64, 40, 0);

/** Paint n distinct 16x16 block-aligned rects. */
function blocksChanged(from: FrameInput, n: number, level: number, elapsedMs: number): FrameInput {
  let f = at(from, elapsedMs);
  for (let i = 0; i < n; i++) {
    f = paintRect(f, (i % 4) * 16, Math.floor(i / 4) * 16, 16, 16, level);
  }
  return f;
}

function decisions(gate: ReturnType<typeof createFrameGate>, frames: FrameInput[]): Decision[] {
  return frames.map((f) => gate.push(f));
}

async function settled(): Promise<void> {
  // Emit delivery is queued on a promise chain; two microtask hops
  // are enough for synchronous transforms.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("change above threshold emits immediately with debounce and interval off", () => {
  const gate = createFrameGate({
    ...GRID,
    policy: { debounceMs: 0, minIntervalMs: 0, maxSilenceMs: 0 },
  });
  const d = decisions(gate, [
    at(base, 0), // first frame: whole screen changes vs black baseline
    blocksChanged(base, 3, 220, 500),
  ]);
  assert.deepEqual(
    d.map((x) => [x.decision, x.reason ?? null]),
    [
      ["emit", "threshold"],
      ["emit", "threshold"],
    ],
  );
  assert.equal(d[0]!.score, 16); // all 16 blocks, full weight
  assert.equal(d[1]!.score, 3);
});

test("score below minChangedBlocks skips", () => {
  const gate = createFrameGate({
    ...GRID,
    policy: { debounceMs: 0, minIntervalMs: 0, maxSilenceMs: 0 },
  });
  gate.push(at(base, 0));
  const d = gate.push(blocksChanged(base, 1, 220, 500));
  assert.equal(d.decision, "skip");
  assert.equal(d.score, 1);
});

test("debounce holds the emit until the screen settles, then emits the settled frame", async () => {
  const gate = createFrameGate({
    ...GRID,
    policy: { debounceMs: 800, minIntervalMs: 0, maxSilenceMs: 0 },
  });
  const events: EmitEvent[] = [];
  gate.on("emit", (e) => events.push(e));

  const changed = blocksChanged(base, 3, 220, 1000);
  const d = decisions(gate, [
    at(base, 0), // transition frame 1 (vs black); starts pending
    at(base, 500), // stable 500 < 800
    at(base, 900), // stable 900 >= 800 -> emit settled frame
    at(base, 1000), // quiet
  ]);
  assert.deepEqual(
    d.map((x) => x.decision),
    ["debounced", "debounced", "emit", "skip"],
  );
  await settled();
  assert.equal(events.length, 1);
  // Emitted frame is the settled one (seq 3), meta carries the
  // crossing frame's score.
  assert.equal(events[0]!.seq, 3);
  assert.equal(events[0]!.score, 16);
  assert.equal(events[0]!.elapsedMs, 900);
  void changed;
});

test("continuing changes keep refreshing the debounce window", () => {
  const gate = createFrameGate({
    ...GRID,
    policy: { debounceMs: 800, minIntervalMs: 0, maxSilenceMs: 0 },
  });
  const d = decisions(gate, [
    at(base, 0), // change (vs baseline)
    blocksChanged(base, 4, 220, 500), // change again: pending refreshed
    at(blocksChanged(base, 4, 220, 0), 1200), // stable only 700
    at(blocksChanged(base, 4, 220, 0), 1400), // stable 900 -> emit
  ]);
  assert.deepEqual(
    d.map((x) => x.decision),
    ["debounced", "debounced", "debounced", "emit"],
  );
});

test("minIntervalMs throttles a second change until the interval passes", () => {
  const gate = createFrameGate({
    ...GRID,
    policy: { debounceMs: 0, minIntervalMs: 2000, maxSilenceMs: 0 },
  });
  const second = blocksChanged(base, 3, 220, 0);
  const d = decisions(gate, [
    at(base, 0), // emit 1
    at(second, 1000), // change, but 1000 < 2000 -> throttled
    at(second, 1500), // still inside interval
    at(second, 2300), // interval passed -> emit settled frame
  ]);
  assert.deepEqual(
    d.map((x) => x.decision),
    ["emit", "throttled", "throttled", "emit"],
  );
});

test("keepalive fires after maxSilenceMs without emits and then re-arms", () => {
  const gate = createFrameGate({
    ...GRID,
    policy: { debounceMs: 0, minIntervalMs: 0, maxSilenceMs: 2000 },
  });
  const quiet = solidFrame(64, 64, 0, 0); // black: no change vs baseline
  const d = decisions(gate, [
    at(quiet, 0),
    at(quiet, 1000),
    at(quiet, 2000), // 2000 - 0 >= 2000 -> keepalive
    at(quiet, 3000),
    at(quiet, 4000), // 4000 - 2000 >= 2000 -> keepalive
  ]);
  assert.deepEqual(
    d.map((x) => [x.decision, x.reason ?? null]),
    [
      ["skip", null],
      ["skip", null],
      ["emit", "keepalive"],
      ["skip", null],
      ["emit", "keepalive"],
    ],
  );
  assert.equal(d[2]!.score, 0);
});

test("maxSilenceMs 0 disables keepalive", () => {
  const gate = createFrameGate({
    ...GRID,
    policy: { debounceMs: 0, minIntervalMs: 0, maxSilenceMs: 0 },
  });
  const quiet = solidFrame(64, 64, 0, 0);
  const d = decisions(gate, [at(quiet, 0), at(quiet, 100000)]);
  assert.deepEqual(
    d.map((x) => x.decision),
    ["skip", "skip"],
  );
});

test("keepalive is the backstop while an endless animation stays debounced", () => {
  const gate = createFrameGate({
    ...GRID,
    adaptiveMask: { enabled: false },
    policy: { debounceMs: 800, minIntervalMs: 0, maxSilenceMs: 3000 },
  });
  // Alternating full-screen flips every 500 ms: never stable.
  const a = solidFrame(64, 64, 40, 0);
  const b = solidFrame(64, 64, 220, 0);
  const frames = Array.from({ length: 8 }, (_, i) =>
    at(i % 2 === 0 ? a : b, i * 500),
  );
  const d = decisions(gate, frames);
  assert.deepEqual(
    d.map((x) => [x.decision, x.reason ?? null]),
    [
      ["debounced", null],
      ["debounced", null],
      ["debounced", null],
      ["debounced", null],
      ["debounced", null],
      ["debounced", null],
      ["emit", "keepalive"], // t=3000: silence limit reached
      ["debounced", null],
    ],
  );
});

test("threshold emit wins over keepalive on the same frame", () => {
  const gate = createFrameGate({
    ...GRID,
    policy: { debounceMs: 0, minIntervalMs: 0, maxSilenceMs: 1000 },
  });
  const quiet = solidFrame(64, 64, 0, 0);
  gate.push(at(quiet, 0));
  const d = gate.push(at(base, 1000)); // change exactly at silence limit
  assert.deepEqual([d.decision, d.reason], ["emit", "threshold"]);
});

test("transform replaces the outgoing frame and applies to crops", async () => {
  const gate = createFrameGate({
    ...GRID,
    policy: { debounceMs: 0, minIntervalMs: 0, maxSilenceMs: 0 },
    crop: { enabled: true, paddingPx: 0 },
    transform: (frame) => {
      const data = new Uint8ClampedArray(frame.data);
      data.fill(7); // pretend-redact everything
      return { ...frame, data };
    },
  });
  const events: EmitEvent[] = [];
  gate.on("emit", (e) => events.push(e));
  gate.push(at(base, 0));
  await settled();
  assert.equal(events.length, 1);
  assert.equal(events[0]!.frame.data[0], 7);
  assert.ok(events[0]!.crops!.length > 0);
  assert.equal(events[0]!.crops![0]!.data[0], 7);
});

test("transform returning null cancels delivery but the decision stays emit", async () => {
  const gate = createFrameGate({
    ...GRID,
    policy: { debounceMs: 0, minIntervalMs: 0, maxSilenceMs: 0 },
    transform: () => null,
  });
  const events: EmitEvent[] = [];
  gate.on("emit", (e) => events.push(e));
  const d = gate.push(at(base, 0));
  assert.equal(d.decision, "emit");
  await gate.flush();
  assert.equal(events.length, 0);
  // Cancelled emits are not "frames sent": stats exclude them.
  assert.equal(gate.stats().framesEmitted, 0);
  assert.equal(gate.stats().lastEmitElapsedMs, null);
});

test("cancelled emits are excluded from framesEmitted and emitRatio", async () => {
  let calls = 0;
  const gate = createFrameGate({
    ...GRID,
    policy: { debounceMs: 0, minIntervalMs: 0, maxSilenceMs: 0 },
    transform: (frame) => {
      calls += 1;
      return calls === 1 ? null : frame; // cancel only the first emit
    },
  });
  const events: EmitEvent[] = [];
  gate.on("emit", (e) => events.push(e));
  const d1 = gate.push(at(base, 0)); // emit decision, cancelled
  const d2 = gate.push(blocksChanged(base, 3, 220, 500)); // delivered
  gate.push(at(blocksChanged(base, 3, 220, 0), 1000)); // quiet skip
  await gate.flush();
  // The decision timeline still shows both emits (deterministic)...
  assert.equal(d1.decision, "emit");
  assert.equal(d2.decision, "emit");
  // ...but stats count only the delivered frame.
  const s = gate.stats();
  assert.equal(s.framesEmitted, 1);
  assert.equal(s.framesSeen, 3);
  assert.equal(s.emitRatio, 1 / 3);
  assert.equal(s.lastEmitElapsedMs, 500);
  assert.deepEqual(events.map((e) => e.seq), [2]);
});

test("a throwing transform fails closed and is excluded from stats", async () => {
  const gate = createFrameGate({
    ...GRID,
    policy: { debounceMs: 0, minIntervalMs: 0, maxSilenceMs: 0 },
    transform: () => {
      throw new Error("ocr exploded");
    },
  });
  const events: EmitEvent[] = [];
  gate.on("emit", (e) => events.push(e));
  gate.push(at(base, 0));
  await gate.flush();
  assert.equal(events.length, 0);
  assert.equal(gate.stats().framesEmitted, 0);
});

test("async transforms deliver events in push order", async () => {
  let delay = 30;
  const gate = createFrameGate({
    ...GRID,
    policy: { debounceMs: 0, minIntervalMs: 0, maxSilenceMs: 0 },
    transform: async (frame) => {
      const d = delay;
      delay = 0; // first emit resolves slower than the second
      await new Promise((r) => setTimeout(r, d));
      return frame;
    },
  });
  const seqs: number[] = [];
  gate.on("emit", (e) => seqs.push(e.seq));
  gate.push(at(base, 0));
  gate.push(blocksChanged(base, 3, 220, 500));
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(seqs, [1, 2]);
});

test("crop regions cover the changed blocks with padding and clamping", async () => {
  const gate = createFrameGate({
    ...GRID,
    policy: { debounceMs: 0, minIntervalMs: 0, maxSilenceMs: 0 },
    blocks: { ...GRID.blocks, minChangedBlocks: 1 },
    crop: { enabled: true, paddingPx: 4 },
  });
  const events: EmitEvent[] = [];
  gate.on("emit", (e) => events.push(e));
  const black = solidFrame(64, 64, 0, 0);
  gate.push(black);
  // Change exactly block (col 1, row 1): source rect x,y in [16,32).
  gate.push(paintRect(at(black, 500), 16, 16, 16, 16, 255));
  await settled();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.crops!.map((c) => c.region), [
    { x: 12, y: 12, width: 24, height: 24 },
  ]);
});

test("adjacent changed blocks merge into one crop; distant ones stay separate", async () => {
  const gate = createFrameGate({
    ...GRID,
    policy: { debounceMs: 0, minIntervalMs: 0, maxSilenceMs: 0 },
    blocks: { ...GRID.blocks, minChangedBlocks: 1 },
    crop: { enabled: true, paddingPx: 0 },
  });
  const events: EmitEvent[] = [];
  gate.on("emit", (e) => events.push(e));
  const black = solidFrame(64, 64, 0, 0);
  gate.push(black);
  // Blocks (0,0)+(1,0) adjacent; block (3,3) separate.
  let f = paintRect(at(black, 500), 0, 0, 32, 16, 255);
  f = paintRect(f, 48, 48, 16, 16, 255);
  gate.push(f);
  await settled();
  assert.deepEqual(events[0]!.crops!.map((c) => c.region), [
    { x: 0, y: 0, width: 32, height: 16 },
    { x: 48, y: 48, width: 16, height: 16 },
  ]);
});

test("stats track counts and last emit time", async () => {
  const gate = createFrameGate({
    ...GRID,
    policy: { debounceMs: 0, minIntervalMs: 0, maxSilenceMs: 0 },
  });
  assert.deepEqual(gate.stats(), {
    framesSeen: 0,
    framesEmitted: 0,
    emitRatio: 0,
    lastEmitElapsedMs: null,
  });
  gate.push(at(base, 0));
  gate.push(at(base, 500));
  await gate.flush(); // stats count delivered frames
  const s = gate.stats();
  assert.equal(s.framesSeen, 2);
  assert.equal(s.framesEmitted, 1);
  assert.equal(s.emitRatio, 0.5);
  assert.equal(s.lastEmitElapsedMs, 0);
});

test("reset restores the initial state completely", () => {
  const gate = createFrameGate({
    ...GRID,
    policy: { debounceMs: 0, minIntervalMs: 0, maxSilenceMs: 0 },
  });
  const first = gate.push(at(base, 0));
  gate.reset();
  const again = gate.push(at(base, 0));
  assert.deepEqual(first, again);
  assert.equal(gate.stats().framesSeen, 1);
});

test("elapsedMs must not decrease", () => {
  const gate = createFrameGate(GRID);
  gate.push(at(base, 500));
  assert.throws(() => gate.push(at(base, 400)), RangeError);
  gate.push(at(base, 500)); // equal is allowed
});

test("same frame sequence produces the identical decision sequence", () => {
  const frames = [
    at(base, 0),
    blocksChanged(base, 3, 220, 500),
    at(blocksChanged(base, 3, 220, 0), 1400),
    at(blocksChanged(base, 3, 220, 0), 2500),
    blocksChanged(blocksChanged(base, 3, 220, 0), 2, 90, 3600),
    at(blocksChanged(blocksChanged(base, 3, 220, 0), 2, 90, 0), 4600),
  ];
  const opts: FrameGateOptions = {
    ...GRID,
    policy: { debounceMs: 800, minIntervalMs: 2000, maxSilenceMs: 60000 },
  };
  const a = decisions(createFrameGate(opts), frames);
  const b = decisions(createFrameGate(opts), frames);
  assert.deepEqual(a, b);
});
