import type { Decision } from "framesieve";

/**
 * A portable recording captured on the client (browser / Electron
 * renderer) for replay on Node. Frames are PNG-encoded so the bundle
 * stays small enough to move across the boundary (IndexedDB, a
 * download, postMessage to the main process). Node's writeRecordingBundle
 * turns it into a standard recording directory that `replay` consumes.
 */
export interface RecordingBundleFrame {
  seq: number;
  elapsedMs: number;
  /** PNG bytes for this frame (8-bit RGBA, what canvas.convertToBlob emits). */
  png: Uint8Array;
}

export interface RecordingBundle {
  format: "framesieve-recording-bundle";
  version: 1;
  frames: RecordingBundleFrame[];
  /** Decisions as they were made at capture time, in push order. */
  timeline: Decision[];
}
