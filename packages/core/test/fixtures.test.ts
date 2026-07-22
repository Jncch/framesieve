import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createFrameGate } from "../src/gate.ts";
import { serializeDecision } from "../src/serialize.ts";
import type { Decision, FrameGateOptions, FrameInput } from "../src/types.ts";
// Dev-time helper from the adapters package; the core runtime itself
// stays free of I/O and dependencies.
import { decodePng } from "../../adapters/src/node/png.ts";

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "fixtures");
const FRAME_INTERVAL_MS = 500; // fixtures simulate 2 fps capture

/** Set FSIEVE_UPDATE_EXPECTED=1 to regenerate expected decision files. */
const UPDATE = process.env["FSIEVE_UPDATE_EXPECTED"] === "1";

function loadFrames(name: string): FrameInput[] {
  const dir = join(FIXTURES, name);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".png"))
    .sort()
    .map((f, i) => {
      const img = decodePng(readFileSync(join(dir, f)));
      return { ...img, elapsedMs: i * FRAME_INTERVAL_MS };
    });
}

function run(name: string, options: FrameGateOptions): Decision[] {
  const gate = createFrameGate(options);
  return loadFrames(name).map((f) => gate.push(f));
}

/**
 * Full-array comparison against the checked-in expected decision
 * sequence. Any behavioral change to scoring or policy must
 * regenerate these files and call the difference out in the PR.
 */
function checkExpected(fixture: string, tag: string, decisions: Decision[]): void {
  const file = join(FIXTURES, `${fixture}.${tag}.expected.jsonl`);
  const lines = decisions.map(serializeDecision).join("\n") + "\n";
  if (UPDATE) {
    writeFileSync(file, lines);
    return;
  }
  assert.equal(lines, readFileSync(file, "utf8"));
}

function pattern(decisions: Decision[]): string[] {
  return decisions.map((d) =>
    d.reason === undefined ? d.decision : `${d.decision}:${d.reason}`,
  );
}

test("slide-flip: baseline emit, then one emit for the settled flip", () => {
  const decisions = run("slide-flip", {});
  assert.deepEqual(pattern(decisions), [
    "debounced", // 0 ms: slide A vs black baseline opens a pending change
    "debounced", // 500 ms: stable for 500 < debounce 800
    "emit:threshold", // 1000 ms: settled baseline goes out
    "skip",
    "skip",
    "skip",
    "debounced", // 3000 ms: flip to slide B
    "debounced", // 3500 ms
    "emit:threshold", // 4000 ms: settled slide B (interval 3000 >= 2000)
    "skip",
    "skip",
    "skip",
  ]);
  checkExpected("slide-flip", "defaults", decisions);
});

test("cursor: a gliding cursor never reaches the block gate", () => {
  const decisions = run("cursor", {});
  assert.deepEqual(pattern(decisions), [
    "debounced", // baseline
    "debounced",
    "emit:threshold", // settled baseline
    "skip", // every cursor move stays under minChangedBlocks
    "skip",
    "skip",
    "skip",
    "skip",
    "skip",
    "skip",
  ]);
  // The cursor is visible to stage 1/2 but must stay under the gate.
  for (const d of decisions.slice(3)) {
    assert.ok(d.score < 3, `cursor frame scored ${d.score}`);
  }
  checkExpected("cursor", "defaults", decisions);
});

test("cursor with a short maxSilence: keepalive frames appear during quiet stretches", () => {
  const decisions = run("cursor", { policy: { maxSilenceMs: 2000 } });
  assert.deepEqual(pattern(decisions), [
    "debounced",
    "debounced",
    "emit:threshold", // 1000 ms
    "skip",
    "skip",
    "skip",
    "emit:keepalive", // 3000 ms: 2000 ms of silence since the emit
    "skip",
    "skip",
    "skip", // next keepalive would be at 5000 ms; sequence ends at 4500
  ]);
  // Decision.score is the frame's own raw score (the cursor moved);
  // the keepalive EmitMeta score of 0 is asserted in gate.test.ts.
  const keepalive = decisions[6]!;
  assert.ok(keepalive.score < 3);
  checkExpected("cursor", "keepalive", decisions);
});

test("video-noise: the busy strip is adaptively suppressed; a late slide change still emits", () => {
  const decisions = run("video-noise", {});
  const p = pattern(decisions);
  // Warmup: the noise strip crosses the gate on every frame while its
  // weight decays linearly, so the transition never settles.
  for (let i = 0; i < 20; i++) {
    assert.equal(p[i], "debounced", `frame ${i + 1} during warmup`);
  }
  assert.equal(p[20], "emit:threshold"); // 10000 ms: noise finally under gate
  assert.deepEqual(p.slice(21, 24), ["skip", "skip", "skip"]); // suppressed video
  assert.equal(p[24], "debounced"); // 12000 ms: fresh bars on the static side
  assert.equal(p[25], "debounced");
  assert.equal(p[26], "emit:threshold"); // 13000 ms: settled new content
  assert.deepEqual(p.slice(27), ["skip", "skip", "skip"]);
  // While suppressed, the noise strip still changes but scores ~0.
  for (const d of decisions.slice(21, 24)) {
    assert.ok(d.score < 3, `suppressed frame scored ${d.score}`);
  }
  checkExpected("video-noise", "defaults", decisions);
});

test("fixture decisions are identical across repeated runs", () => {
  const a = run("video-noise", {});
  const b = run("video-noise", {});
  assert.deepEqual(a, b);
});

// Default mode is "previous"; passing it explicitly must reproduce the
// checked-in goldens byte-for-byte on the same PNG sequences. Guards the
// "reference mode is fully backward compatible" claim for both the
// omitted-default and explicit-value code paths.
const PREV_CASES: Array<[string, FrameGateOptions]> = [
  ["slide-flip", {}],
  ["cursor", {}],
  ["cursor", { policy: { maxSilenceMs: 2000 } }],
  ["video-noise", {}],
];

test('explicit diff.mode "previous" reproduces the default decisions', () => {
  for (const [name, opts] of PREV_CASES) {
    const dflt = run(name, opts);
    const explicit = run(name, { ...opts, diff: { ...opts.diff, mode: "previous" } });
    assert.deepEqual(explicit, dflt, name);
  }
});

test("tooltip-blip: reference mode drops the transient overlay (no threshold emit)", () => {
  const decisions = run("tooltip-blip", {
    diff: { mode: "reference" },
    policy: { primeOnFirstFrame: true },
  });
  const p = pattern(decisions);
  assert.equal(p[0], "emit:prime"); // primeOnFirstFrame gives the baseline
  // The tooltip opens a pending divergence (frames 3-5) but reverts
  // before referencePersistMs, so it is never emitted as a threshold.
  assert.ok(
    p.slice(3, 6).includes("debounced"),
    `tooltip should open a pending change: ${p.join(",")}`,
  );
  assert.ok(
    !p.includes("emit:threshold"),
    `transient must not emit a threshold: ${p.join(",")}`,
  );
  checkExpected("tooltip-blip", "reference", decisions);
});

test("tooltip-blip: previous mode registers the transient the reference mode drops", () => {
  const p = pattern(run("tooltip-blip", { policy: { primeOnFirstFrame: true } }));
  assert.ok(
    p.includes("emit:threshold"),
    `previous mode should emit the transition: ${p.join(",")}`,
  );
});
