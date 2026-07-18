import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createFrameGate,
  parseDecisionLine,
  serializeDecision,
  type Decision,
  type FrameGate,
  type FrameGateOptions,
  type FrameInput,
  type GateStats,
} from "framesieve";

import { decodePng, encodePng } from "./png.ts";

/**
 * Recording directory layout (all serialization deterministic):
 *
 *   meta.json       {"format":"framesieve-recording","frameCount":N,
 *                    "version":1}
 *   frames.jsonl    one {"elapsedMs":E,"file":"000001.png","seq":S}
 *                   per pushed frame, in push order
 *   frames/*.png    the frames themselves
 *   timeline.jsonl  the Decision line for each frame as it was made
 *                   at record time (round-trips byte-identically)
 *
 * Recordings contain raw, unredacted screen content by design; they
 * are a local tuning artifact, never something to ship.
 */

export interface RecorderOptions {
  /** Output directory. Created if missing. */
  dir: string;
  /** Hard limits; recording stops when either is reached. */
  maxDurationMs?: number; // default 300000 (5 min)
  maxBytes?: number; // default 1 GiB
}

export interface Recorder {
  /** Wraps a gate: records every pushed frame + its decision. */
  attach(gate: FrameGate): void;
  stop(): Promise<void>;
}

const DEFAULT_MAX_DURATION_MS = 300000;
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;

interface FrameIndexEntry {
  seq: number;
  elapsedMs: number;
  file: string;
}

function serializeFrameEntry(e: FrameIndexEntry): string {
  return `{"elapsedMs":${String(e.elapsedMs)},"file":${JSON.stringify(e.file)},"seq":${String(e.seq)}}`;
}

function serializeMeta(frameCount: number): string {
  return `{"format":"framesieve-recording","frameCount":${String(frameCount)},"version":1}\n`;
}

class RecorderImpl implements Recorder {
  private readonly dir: string;
  private readonly maxDurationMs: number;
  private readonly maxBytes: number;
  private gate: FrameGate | null = null;
  private originalPush: ((frame: FrameInput) => Decision) | null = null;
  private frameCount = 0;
  private bytesWritten = 0;
  private firstElapsedMs: number | null = null;
  private stopped = false;

  constructor(options: RecorderOptions) {
    this.dir = options.dir;
    this.maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  attach(gate: FrameGate): void {
    if (this.gate !== null) throw new Error("recorder is already attached");
    if (this.stopped) throw new Error("recorder is stopped");
    mkdirSync(join(this.dir, "frames"), { recursive: true });
    writeFileSync(join(this.dir, "frames.jsonl"), "");
    writeFileSync(join(this.dir, "timeline.jsonl"), "");
    writeFileSync(join(this.dir, "meta.json"), serializeMeta(0));
    this.gate = gate;
    const original = gate.push.bind(gate);
    this.originalPush = original;
    gate.push = (frame: FrameInput): Decision => {
      const decision = original(frame);
      this.record(frame, decision);
      return decision;
    };
  }

  private record(frame: FrameInput, decision: Decision): void {
    if (this.stopped) return;
    if (this.firstElapsedMs === null) this.firstElapsedMs = frame.elapsedMs;
    if (frame.elapsedMs - this.firstElapsedMs > this.maxDurationMs) {
      this.stopped = true;
      return;
    }
    const png = encodePng({
      data: frame.data,
      width: frame.width,
      height: frame.height,
    });
    if (this.bytesWritten + png.length > this.maxBytes) {
      this.stopped = true;
      return;
    }
    this.frameCount += 1;
    this.bytesWritten += png.length;
    const file = `${String(this.frameCount).padStart(6, "0")}.png`;
    writeFileSync(join(this.dir, "frames", file), png);
    appendLine(
      join(this.dir, "frames.jsonl"),
      serializeFrameEntry({
        seq: this.frameCount,
        elapsedMs: frame.elapsedMs,
        file,
      }),
    );
    appendLine(join(this.dir, "timeline.jsonl"), serializeDecision(decision));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.gate !== null && this.originalPush !== null) {
      this.gate.push = this.originalPush;
      this.gate = null;
      this.originalPush = null;
    }
    writeFileSync(join(this.dir, "meta.json"), serializeMeta(this.frameCount));
  }
}

function appendLine(file: string, line: string): void {
  writeFileSync(file, line + "\n", { flag: "a" });
}

export function createRecorder(options: RecorderOptions): Recorder {
  return new RecorderImpl(options);
}

// ---------------------------------------------------------------------------
// Reading and replaying
// ---------------------------------------------------------------------------

export interface RecordedFrame {
  seq: number;
  elapsedMs: number;
  /** Path relative to the recording's frames/ directory. */
  file: string;
}

export interface Recording {
  dir: string;
  frames: RecordedFrame[];
  /** Decisions recorded at capture time, if present. */
  timeline: Decision[];
}

export function readRecording(dir: string): Recording {
  const metaRaw: unknown = JSON.parse(
    readFileSync(join(dir, "meta.json"), "utf8"),
  );
  if (
    typeof metaRaw !== "object" ||
    metaRaw === null ||
    (metaRaw as Record<string, unknown>)["format"] !== "framesieve-recording"
  ) {
    throw new SyntaxError(`${dir} is not a framesieve recording`);
  }
  const frames: RecordedFrame[] = [];
  const framesIndex = readFileSync(join(dir, "frames.jsonl"), "utf8");
  for (const line of framesIndex.split("\n")) {
    if (line === "") continue;
    const raw: unknown = JSON.parse(line);
    if (typeof raw !== "object" || raw === null) {
      throw new SyntaxError("invalid frames.jsonl line");
    }
    const { seq, elapsedMs, file } = raw as Record<string, unknown>;
    if (
      typeof seq !== "number" ||
      typeof elapsedMs !== "number" ||
      typeof file !== "string"
    ) {
      throw new SyntaxError("invalid frames.jsonl line");
    }
    frames.push({ seq, elapsedMs, file });
  }
  const timeline: Decision[] = [];
  for (const line of readFileSync(join(dir, "timeline.jsonl"), "utf8").split(
    "\n",
  )) {
    if (line !== "") timeline.push(parseDecisionLine(line));
  }
  return { dir, frames, timeline };
}

/** Load one recorded frame as a gate-ready FrameInput. */
export function loadRecordedFrame(
  recording: Recording,
  frame: RecordedFrame,
): FrameInput {
  const img = decodePng(
    readFileSync(join(recording.dir, "frames", frame.file)),
  );
  return { ...img, elapsedMs: frame.elapsedMs };
}

/**
 * Replay a recording with (possibly different) options and return the
 * decision sequence. Pure function of (recording, options) - this is
 * what `fsieve replay` and `fsieve replay --sweep` are built on.
 */
export async function replay(
  recordingDir: string,
  options?: FrameGateOptions,
): Promise<{ decisions: Decision[]; stats: GateStats }> {
  const recording = readRecording(recordingDir);
  const gate = createFrameGate(options);
  const decisions = recording.frames.map((f) =>
    gate.push(loadRecordedFrame(recording, f)),
  );
  // Stats count delivered frames; settle in-flight deliveries first.
  await gate.flush();
  return { decisions, stats: gate.stats() };
}

/**
 * Read a plain directory of PNG files (sorted by filename) as a frame
 * sequence, assigning elapsedMs at a fixed interval. This is the node
 * capture source for testing and for turning image sequences into
 * recordings.
 */
export function* pngSequenceSource(
  dir: string,
  intervalMs: number,
): Generator<FrameInput> {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".png"))
    .sort();
  let i = 0;
  for (const file of files) {
    const img = decodePng(readFileSync(join(dir, file)));
    yield { ...img, elapsedMs: i * intervalMs };
    i += 1;
  }
}
