import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFrameGate, parseDecisionLine, serializeDecision } from "framesieve";
import type { Decision, FrameInput } from "framesieve";
import { createRecorder, replay } from "@framesieve/adapters/node";

/** Scores in JSON lines are fixed at 6 decimals; canonicalize before
 * comparing in-memory decisions against CLI output. */
function canonical(decisions: Decision[]): Decision[] {
  return decisions.map((d) => parseDecisionLine(serializeDecision(d)));
}

// These tests run the real built CLI against a real recording; the
// core is never mocked.
const BIN = join(import.meta.dirname, "..", "dist", "main.js");

let recordingDir: string;

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

before(async () => {
  recordingDir = mkdtempSync(join(tmpdir(), "fsieve-cli-test-"));
  const gate = createFrameGate();
  const recorder = createRecorder({ dir: recordingDir });
  recorder.attach(gate);
  // Quiet, flip, quiet: enough to exercise emit/debounced/skip.
  const frames = [
    solid(50, 0),
    solid(50, 500),
    solid(50, 1000),
    solid(50, 1500),
    solid(220, 2000),
    solid(220, 2500),
    solid(220, 3000),
    solid(220, 3500),
  ];
  for (const f of frames) gate.push(f);
  await recorder.stop();
});

after(() => {
  rmSync(recordingDir, { recursive: true, force: true });
});

function fsieve(...args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: "utf8",
    });
    return { stdout, status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; status?: number };
    return { stdout: err.stdout ?? "", status: err.status ?? 1 };
  }
}

test("fsieve replay prints a deterministic summary", () => {
  const a = fsieve("replay", recordingDir);
  const b = fsieve("replay", recordingDir);
  assert.equal(a.status, 0);
  assert.equal(a.stdout, b.stdout);
  assert.match(a.stdout, /frames: {4}8/);
  assert.match(a.stdout, /emits: {5}2/);
  assert.match(a.stdout, /threshold/);
});

test("fsieve replay --json emits parseable Decision lines matching the library", async () => {
  const { stdout, status } = fsieve("replay", recordingDir, "--json");
  assert.equal(status, 0);
  const lines = stdout.trim().split("\n");
  assert.equal(lines.length, 8);
  const fromCli = lines.map(parseDecisionLine);
  const fromLib = await replay(recordingDir);
  assert.deepEqual(fromCli, canonical(fromLib.decisions));
});

test("option overrides change decisions the same way the library does", async () => {
  const { stdout, status } = fsieve(
    "replay",
    recordingDir,
    "--json",
    "--min-blocks",
    "999",
  );
  assert.equal(status, 0);
  const fromCli = stdout.trim().split("\n").map(parseDecisionLine);
  const fromLib = await replay(recordingDir, {
    blocks: { minChangedBlocks: 999 },
  });
  assert.deepEqual(fromCli, canonical(fromLib.decisions));
  assert.ok(fromCli.every((d) => d.decision !== "emit"));
});

test("fsieve replay --sweep prints one row per parameter value", () => {
  const { stdout, status } = fsieve(
    "replay",
    recordingDir,
    "--sweep",
    "minChangedBlocks=1:5:2",
  );
  assert.equal(status, 0);
  const rows = stdout
    .trim()
    .split("\n")
    .filter((l) => /^ {2}\d/.test(l));
  assert.equal(rows.length, 3); // values 1, 3, 5
  assert.match(rows[0]!, /^ {2}1\b/);
  assert.match(rows[2]!, /^ {2}5\b/);
});

test("sweeping blockChangeRatio handles fractional steps without float drift", () => {
  const { stdout, status } = fsieve(
    "replay",
    recordingDir,
    "--sweep",
    "blockChangeRatio=0.1:0.4:0.05",
  );
  assert.equal(status, 0);
  const values = stdout
    .trim()
    .split("\n")
    .filter((l) => /^ {2}0\./.test(l))
    .map((l) => l.trim().split(/\s+/)[0]);
  assert.deepEqual(values, ["0.1", "0.15", "0.2", "0.25", "0.3", "0.35", "0.4"]);
});

test("--mode reference matches the library's reference-mode decisions", async () => {
  const { stdout, status } = fsieve("replay", recordingDir, "--json", "--mode", "reference");
  assert.equal(status, 0);
  const fromCli = stdout.trim().split("\n").map(parseDecisionLine);
  const fromLib = await replay(recordingDir, { diff: { mode: "reference" } });
  assert.deepEqual(fromCli, canonical(fromLib.decisions));
});

test("--persist sets referencePersistMs, matching the library", async () => {
  const { stdout, status } = fsieve(
    "replay",
    recordingDir,
    "--json",
    "--mode",
    "reference",
    "--persist",
    "1000",
  );
  assert.equal(status, 0);
  const fromCli = stdout.trim().split("\n").map(parseDecisionLine);
  const fromLib = await replay(recordingDir, {
    diff: { mode: "reference" },
    policy: { referencePersistMs: 1000 },
  });
  assert.deepEqual(fromCli, canonical(fromLib.decisions));
});

test("--sweep referencePersistMs prints one row per value", () => {
  const { stdout, status } = fsieve(
    "replay",
    recordingDir,
    "--mode",
    "reference",
    "--sweep",
    "referencePersistMs=0:2000:1000",
  );
  assert.equal(status, 0);
  const rows = stdout
    .trim()
    .split("\n")
    .filter((l) => /^ {2}\d/.test(l));
  assert.equal(rows.length, 3); // 0, 1000, 2000
  assert.match(rows[0]!, /^ {2}0\b/);
  assert.match(rows[2]!, /^ {2}2000\b/);
});

test("usage errors exit nonzero", () => {
  assert.equal(fsieve().status, 1);
  assert.equal(fsieve("replay").status, 1);
  assert.equal(fsieve("replay", recordingDir, "--sweep", "bogus=1:2:1").status, 1);
  assert.equal(fsieve("replay", recordingDir, "--mode", "sideways").status, 1);
  assert.equal(fsieve("replay", join(tmpdir(), "does-not-exist-xyz")).status, 1);
});

test("fsieve replay examples/meeting works end to end", () => {
  const dir = join(import.meta.dirname, "..", "..", "..", "examples", "meeting");
  const { stdout, status } = fsieve("replay", dir);
  assert.equal(status, 0);
  assert.match(stdout, /frames: {4}60/);
  const emits = Number(/emits: {5}(\d+)/.exec(stdout)?.[1]);
  assert.ok(emits >= 1, "the example recording produces emits");
  assert.ok(emits <= 10, "the gate keeps the emit count meaningful");
});
