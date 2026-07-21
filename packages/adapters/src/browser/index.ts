import {
  frameFromImageData,
  type Decision,
  type FrameGate,
  type FrameInput,
} from "framesieve";
import type {
  RecordingBundle,
  RecordingBundleFrame,
} from "../recording-bundle.ts";

/**
 * Browser capture source. The gate never samples on its own (caller-
 * owned time is a core invariant), so this adapter only turns "the
 * screen right now" into a FrameInput; you decide when to call grab()
 * and push the result.
 *
 * elapsedMs is measured with performance.now() anchored at source
 * creation. That clock lives here in the adapter, on the capture side
 * of the boundary - the gate itself stays deterministic.
 */

export interface FrameSource {
  /** Capture the current frame. Call at your own cadence. */
  grab(): Promise<FrameInput>;
  /** Release the underlying video element and tracks. */
  stop(): void;
}

export interface BrowserSourceOptions {
  /**
   * Clock returning milliseconds; elapsedMs is now() minus its value
   * at source creation. Default: performance.now.
   */
  now?: () => number;
}

/** Wrap an existing screen-share MediaStream (e.g. getDisplayMedia). */
export function createDisplayMediaSource(
  stream: MediaStream,
  options: BrowserSourceOptions = {},
): FrameSource {
  const now = options.now ?? (() => performance.now());
  const startMs = now();
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  const ready = video.play().then(
    () =>
      new Promise<void>((resolve) => {
        if (video.readyState >= 2 && video.videoWidth > 0) resolve();
        else video.addEventListener("loadeddata", () => resolve(), { once: true });
      }),
  );
  let canvas: OffscreenCanvas | null = null;
  let stopped = false;

  return {
    async grab(): Promise<FrameInput> {
      if (stopped) throw new Error("source is stopped");
      await ready;
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (width === 0 || height === 0) {
        throw new Error("video stream has no frames yet");
      }
      if (canvas === null || canvas.width !== width || canvas.height !== height) {
        canvas = new OffscreenCanvas(width, height);
      }
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (ctx === null) throw new Error("could not get a 2d canvas context");
      ctx.drawImage(video, 0, 0, width, height);
      const image = ctx.getImageData(0, 0, width, height);
      return {
        data: image.data,
        width,
        height,
        elapsedMs: now() - startMs,
      };
    },
    stop(): void {
      stopped = true;
      video.srcObject = null;
      for (const track of stream.getTracks()) track.stop();
    },
  };
}

/** Prompt for a screen share and wrap it in one call. */
export async function captureDisplay(
  constraints?: DisplayMediaStreamOptions,
  options?: BrowserSourceOptions,
): Promise<FrameSource> {
  const stream = await navigator.mediaDevices.getDisplayMedia(
    constraints ?? { video: true, audio: false },
  );
  return createDisplayMediaSource(stream, options);
}

/**
 * Wrap an ImageBitmap (createImageBitmap output, a decoded <img>, a
 * VideoFrame) as a FrameInput by reading its pixels off an
 * OffscreenCanvas. For the still-image case where you already hold a
 * bitmap rather than a live stream.
 */
export function frameFromBitmap(
  bitmap: ImageBitmap,
  elapsedMs: number,
): FrameInput {
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (ctx === null) throw new Error("could not get a 2d canvas context");
  ctx.drawImage(bitmap, 0, 0);
  return frameFromImageData(ctx.getImageData(0, 0, width, height), elapsedMs);
}

/**
 * Decode an image URL (a data: URL, a blob: URL, or any fetchable
 * image) into a FrameInput. Convenience over
 * createImageBitmap + frameFromBitmap.
 */
export async function frameFromDataUrl(
  url: string,
  elapsedMs: number,
): Promise<FrameInput> {
  const blob = await (await fetch(url)).blob();
  const bitmap = await createImageBitmap(blob);
  try {
    return frameFromBitmap(bitmap, elapsedMs);
  } finally {
    bitmap.close();
  }
}

export interface BrowserRecorderOptions {
  /** Stop accepting frames after this much frame-time. Default 300000. */
  maxDurationMs?: number;
  /** Stop accepting after this many frames. Default 2000. */
  maxFrames?: number;
}

export interface BrowserRecorder {
  /**
   * Detach, finish encoding, and return the portable bundle. Move it to
   * Node (download, IndexedDB, postMessage) and feed it to
   * writeRecordingBundle from "@framesieve/adapters/node" to replay.
   */
  stop(): Promise<RecordingBundle>;
}

/**
 * Record frames + decisions on the client for offline replay on Node.
 * Observes the gate via gate.tap (decisions untouched) and PNG-encodes
 * each frame off the hot path with an OffscreenCanvas. The gate itself
 * never touches the filesystem; this is how a browser or Electron
 * renderer captures real frames to tune against later.
 */
export function createBrowserRecorder(
  gate: FrameGate,
  options: BrowserRecorderOptions = {},
): BrowserRecorder {
  const maxDurationMs = options.maxDurationMs ?? 300000;
  const maxFrames = options.maxFrames ?? 2000;
  const frames: RecordingBundleFrame[] = [];
  const timeline: Decision[] = [];
  let firstElapsedMs: number | null = null;
  let accepted = 0;
  let stopped = false;
  let chain: Promise<void> = Promise.resolve();
  let canvas: OffscreenCanvas | null = null;

  async function encode(
    data: Uint8ClampedArray<ArrayBuffer>,
    width: number,
    height: number,
  ): Promise<Uint8Array> {
    if (canvas === null || canvas.width !== width || canvas.height !== height) {
      canvas = new OffscreenCanvas(width, height);
    }
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("could not get a 2d canvas context");
    ctx.putImageData(new ImageData(data, width, height), 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return new Uint8Array(await blob.arrayBuffer());
  }

  const unsubscribe = gate.tap((frame, decision) => {
    if (stopped) return;
    if (firstElapsedMs === null) firstElapsedMs = frame.elapsedMs;
    if (frame.elapsedMs - firstElapsedMs > maxDurationMs || accepted >= maxFrames) {
      stopped = true;
      return;
    }
    accepted += 1;
    const seq = accepted;
    const { width, height, elapsedMs } = frame;
    const snapshot = new Uint8ClampedArray(frame.data);
    timeline.push(decision);
    chain = chain.then(async () => {
      const png = await encode(snapshot, width, height);
      frames.push({ seq, elapsedMs, png });
    });
  });

  return {
    async stop(): Promise<RecordingBundle> {
      stopped = true;
      unsubscribe();
      await chain;
      return { format: "framesieve-recording-bundle", version: 1, frames, timeline };
    },
  };
}
