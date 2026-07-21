import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFrameGate, serializeDecision } from "framesieve";
import type { Decision, FrameGateOptions, FrameInput } from "framesieve";

import {
  encodePng,
  readRecording,
  replay,
  writeRecordingBundle,
  type RecordingBundle,
} from "../src/node/index.ts";

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

function canonical(decisions: Decision[]): unknown[] {
  return decisions.map((d) => JSON.parse(serializeDecision(d)) as unknown);
}

/** Simulate a client recorder: push frames, keep decisions, PNG-encode. */
function makeBundle(frames: FrameInput[]): {
  bundle: RecordingBundle;
  decisions: Decision[];
} {
  const gate = createFrameGate(OPTS);
  const decisions: Decision[] = [];
  const bundleFrames = frames.map((f, i) => {
    decisions.push(gate.push(f));
    return { seq: i + 1, elapsedMs: f.elapsedMs, png: encodePng(f) };
  });
  return {
    bundle: {
      format: "framesieve-recording-bundle",
      version: 1,
      frames: bundleFrames,
      timeline: decisions,
    },
    decisions,
  };
}

test("writeRecordingBundle produces a recording that replays to the captured decisions", async () => {
  const frames = [
    solid(60, 0),
    solid(60, 500),
    solid(200, 1000),
    solid(200, 1500),
    solid(200, 2000),
  ];
  const { bundle, decisions } = makeBundle(frames);
  const dir = mkdtempSync(join(tmpdir(), "fsieve-bundle-"));
  try {
    writeRecordingBundle(bundle, dir);
    const recording = readRecording(dir);
    assert.equal(recording.frames.length, frames.length);
    assert.deepEqual(canonical(recording.timeline), canonical(decisions));
    const result = await replay(dir, OPTS);
    assert.deepEqual(canonical(result.decisions), canonical(decisions));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeRecordingBundle rejects a bundle with the wrong format", () => {
  const dir = mkdtempSync(join(tmpdir(), "fsieve-bundle-"));
  try {
    assert.throws(() =>
      writeRecordingBundle(
        { format: "nope" } as unknown as RecordingBundle,
        dir,
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
