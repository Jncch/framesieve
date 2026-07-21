import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
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
import type { RecordingBundle } from "../recording-bundle.ts";

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
  /**
   * Observe a gate via gate.tap: records every pushed frame + its
   * decision. Does not alter the gate or its decisions. PNG encoding
   * and disk writes happen off the push hot path, on an async queue
   * drained by stop().
   */
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
  private unsubscribe: (() => void) | null = null;
  private frameCount = 0;
  private bytesWritten = 0;
  private firstElapsedMs: number | null = null;
  /** No more frames accepted (duration cap hit, or stop() called). */
  private stopped = false;
  /** Byte budget spent; writes drop the rest of the queue. */
  private bytesExhausted = false;
  /** Serializes async writes so files and lines land in push order. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: RecorderOptions) {
    this.dir = options.dir;
    this.maxDurationMs = options.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  attach(gate: FrameGate): void {
    if (this.unsubscribe !== null) throw new Error("recorder is already attached");
    if (this.stopped) throw new Error("recorder is stopped");
    mkdirSync(join(this.dir, "frames"), { recursive: true });
    writeFileSync(join(this.dir, "frames.jsonl"), "");
    writeFileSync(join(this.dir, "timeline.jsonl"), "");
    writeFileSync(join(this.dir, "meta.json"), serializeMeta(0));
    // Observe via tap: no monkeypatching, decisions untouched.
    this.unsubscribe = gate.tap((frame, decision) =>
      this.enqueue(frame, decision),
    );
  }

  private enqueue(frame: FrameInput, decision: Decision): void {
    if (this.stopped || this.bytesExhausted) return;
    if (this.firstElapsedMs === null) this.firstElapsedMs = frame.elapsedMs;
    if (frame.elapsedMs - this.firstElapsedMs > this.maxDurationMs) {
      this.stopped = true;
      return;
    }
    // Snapshot synchronously so a caller reusing its pixel buffer
    // cannot corrupt a frame still queued for encoding.
    const snapshot: FrameInput = {
      data: new Uint8ClampedArray(frame.data),
      width: frame.width,
      height: frame.height,
      elapsedMs: frame.elapsedMs,
    };
    this.writeChain = this.writeChain.then(() => this.write(snapshot, decision));
  }

  private async write(frame: FrameInput, decision: Decision): Promise<void> {
    if (this.bytesExhausted) return;
    const png = encodePng({
      data: frame.data,
      width: frame.width,
      height: frame.height,
    });
    if (this.bytesWritten + png.length > this.maxBytes) {
      this.bytesExhausted = true;
      return;
    }
    this.frameCount += 1;
    this.bytesWritten += png.length;
    const file = `${String(this.frameCount).padStart(6, "0")}.png`;
    await writeFile(join(this.dir, "frames", file), png);
    await appendFile(
      join(this.dir, "frames.jsonl"),
      serializeFrameEntry({
        seq: this.frameCount,
        elapsedMs: frame.elapsedMs,
        file,
      }) + "\n",
    );
    await appendFile(
      join(this.dir, "timeline.jsonl"),
      serializeDecision(decision) + "\n",
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.unsubscribe !== null) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    await this.writeChain; // drain queued writes
    writeFileSync(join(this.dir, "meta.json"), serializeMeta(this.frameCount));
  }
}

export function createRecorder(options: RecorderOptions): Recorder {
  return new RecorderImpl(options);
}

/**
 * Turn a RecordingBundle captured on the client (see
 * createBrowserRecorder) into a standard recording directory that
 * readRecording/replay consume. The bundle's PNGs are written as-is;
 * Node's decoder reads the 8-bit RGBA PNGs a browser canvas emits.
 */
export function writeRecordingBundle(bundle: RecordingBundle, dir: string): void {
  if (bundle.format !== "framesieve-recording-bundle") {
    throw new SyntaxError("not a framesieve recording bundle");
  }
  mkdirSync(join(dir, "frames"), { recursive: true });
  const frameLines: string[] = [];
  for (const f of bundle.frames) {
    const file = `${String(f.seq).padStart(6, "0")}.png`;
    writeFileSync(join(dir, "frames", file), f.png);
    frameLines.push(
      serializeFrameEntry({ seq: f.seq, elapsedMs: f.elapsedMs, file }),
    );
  }
  writeFileSync(
    join(dir, "frames.jsonl"),
    frameLines.length > 0 ? frameLines.join("\n") + "\n" : "",
  );
  writeFileSync(
    join(dir, "timeline.jsonl"),
    bundle.timeline.length > 0
      ? bundle.timeline.map(serializeDecision).join("\n") + "\n"
      : "",
  );
  writeFileSync(join(dir, "meta.json"), serializeMeta(bundle.frames.length));
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
