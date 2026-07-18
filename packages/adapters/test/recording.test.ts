import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFrameGate, serializeDecision } from "framesieve";
import type { Decision, FrameGateOptions, FrameInput } from "framesieve";

import {
  createRecorder,
  readRecording,
  replay,
  pngSequenceSource,
} from "../src/node/recording.ts";

const OPTS: FrameGateOptions = {
  diff: { downsampleFactor: 8 },
  blocks: { gridCols: 4, gridRows: 4, minChangedBlocks: 2 },
  adaptiveMask: { enabled: false },
  policy: { debounceMs: 800, minIntervalMs: 2000, maxSilenceMs: 0 },
};

function solid(level: number, elapsedMs: number): FrameInput {
  const data = new Uint8ClampedArray(64 * 64 * 4);
  for (let p = 0; p < data.length; p += 4) {
    data[p] = level;
    data[p + 1] = level;
    data[p + 2] = level;
    data[p + 3] = 255;
  }
  return { data, width: 64, height: 64, elapsedMs };
}

/** A/B/A content at 500 ms cadence; exercises all decision kinds. */
function sampleFrames(): FrameInput[] {
  return [
    solid(60, 0),
    solid(60, 500),
    solid(60, 1000),
    solid(200, 1500),
    solid(200, 2000),
    solid(200, 2500),
    solid(200, 3000),
    solid(60, 3500),
    solid(60, 4000),
    solid(60, 4500),
    solid(60, 5000),
  ];
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "fsieve-test-"));
}

async function recordSample(dir: string): Promise<Decision[]> {
  const gate = createFrameGate(OPTS);
  const recorder = createRecorder({ dir });
  recorder.attach(gate);
  const decisions = sampleFrames().map((f) => gate.push(f));
  await recorder.stop();
  return decisions;
}

test("record then replay with the same options reproduces the decision sequence", async () => {
  const dir = tempDir();
  try {
    const recorded = await recordSample(dir);
    const result = await replay(dir, OPTS);
    assert.deepEqual(result.decisions, recorded);
    assert.equal(result.stats.framesSeen, recorded.length);
    // The recorded timeline matches too.
    const recording = readRecording(dir);
    assert.deepEqual(recording.timeline, recorded);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("timeline.jsonl round-trips byte-identically through parse + serialize", async () => {
  const dir = tempDir();
  try {
    await recordSample(dir);
    const raw = readFileSync(join(dir, "timeline.jsonl"), "utf8");
    const reserialized =
      readRecording(dir)
        .timeline.map(serializeDecision)
        .join("\n") + "\n";
    assert.equal(reserialized, raw);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replay with different options yields different decisions", async () => {
  const dir = tempDir();
  try {
    const recorded = await recordSample(dir);
    const strict = await replay(dir, {
      ...OPTS,
      blocks: { ...OPTS.blocks, minChangedBlocks: 999 },
    });
    assert.notDeepEqual(strict.decisions, recorded);
    assert.equal(strict.stats.framesEmitted, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replay is repeatable: same recording + options, same decisions", async () => {
  const dir = tempDir();
  try {
    await recordSample(dir);
    const a = await replay(dir, OPTS);
    const b = await replay(dir, OPTS);
    assert.deepEqual(a.decisions, b.decisions);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recorder does not alter gate decisions", async () => {
  const bare = createFrameGate(OPTS);
  const bareDecisions = sampleFrames().map((f) => bare.push(f));
  const dir = tempDir();
  try {
    const recorded = await recordSample(dir);
    assert.deepEqual(recorded, bareDecisions);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("maxDurationMs stops recording but the gate keeps deciding", async () => {
  const dir = tempDir();
  try {
    const gate = createFrameGate(OPTS);
    const recorder = createRecorder({ dir, maxDurationMs: 2000 });
    recorder.attach(gate);
    const decisions = sampleFrames().map((f) => gate.push(f));
    await recorder.stop();
    assert.equal(decisions.length, 11);
    const recording = readRecording(dir);
    // Frames with elapsedMs - first > 2000 are dropped.
    assert.deepEqual(
      recording.frames.map((f) => f.elapsedMs),
      [0, 500, 1000, 1500, 2000],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("maxBytes stops recording once the budget is exhausted", async () => {
  const dir = tempDir();
  try {
    const gate = createFrameGate(OPTS);
    const recorder = createRecorder({ dir, maxBytes: 600 });
    recorder.attach(gate);
    sampleFrames().map((f) => gate.push(f));
    await recorder.stop();
    const recording = readRecording(dir);
    assert.ok(recording.frames.length >= 1, "at least one frame fits");
    assert.ok(recording.frames.length < 11, "budget cut the recording short");
    const written = readdirSync(join(dir, "frames")).length;
    assert.equal(written, recording.frames.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stop() restores the original push and finalizes meta.json", async () => {
  const dir = tempDir();
  try {
    const gate = createFrameGate(OPTS);
    const recorder = createRecorder({ dir });
    recorder.attach(gate);
    gate.push(solid(60, 0));
    await recorder.stop();
    gate.push(solid(200, 500)); // after stop: not recorded
    const recording = readRecording(dir);
    assert.equal(recording.frames.length, 1);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as {
      frameCount: number;
    };
    assert.equal(meta.frameCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readRecording rejects a directory that is not a recording", () => {
  const dir = tempDir();
  try {
    assert.throws(() => readRecording(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pngSequenceSource yields fixture frames at the given cadence", () => {
  const fixtures = join(import.meta.dirname, "..", "..", "..", "fixtures");
  const frames = [...pngSequenceSource(join(fixtures, "cursor"), 500)];
  assert.equal(frames.length, 10);
  assert.equal(frames[0]!.elapsedMs, 0);
  assert.equal(frames[9]!.elapsedMs, 4500);
  assert.equal(frames[0]!.width, 320);
});

test("replaying examples/meeting reproduces its recorded timeline", async () => {
  // Tripwire required by the repo testing rules: if replaying
  // examples/ produces different decisions, that is a breaking
  // change and must be called out explicitly in the PR description.
  const dir = join(import.meta.dirname, "..", "..", "..", "examples", "meeting");
  const recording = readRecording(dir);
  const result = await replay(dir);
  const canonical = result.decisions.map((d) =>
    JSON.parse(serializeDecision(d)) as unknown,
  );
  const recorded = recording.timeline.map((d) =>
    JSON.parse(serializeDecision(d)) as unknown,
  );
  assert.deepEqual(canonical, recorded);
  assert.equal(recording.frames.length, 60);
});
