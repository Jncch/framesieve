import { frameFromImageData, type FrameInput } from "framesieve";

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
