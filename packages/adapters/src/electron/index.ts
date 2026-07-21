/**
 * Electron capture helpers. Electron renderers are Chromium, so the
 * actual frame source is the browser one; what Electron adds is the
 * desktopCapturer handshake for picking a screen or window. This
 * module never imports "electron" - the caller enumerates sources in
 * the main process (desktopCapturer.getSources) and hands an id to
 * the renderer. Only structural types cross the boundary here.
 */

import { frameFromImageData, type FrameInput } from "framesieve";

export {
  createDisplayMediaSource as createElectronSource,
  type BrowserSourceOptions,
  type FrameSource,
} from "../browser/index.ts";

/** The slice of Electron's DesktopCapturerSource this package needs. */
export interface DesktopCapturerSourceLike {
  id: string;
  name: string;
}

export interface DesktopConstraintsOptions {
  maxWidth?: number;
  maxHeight?: number;
  /** Capture frame rate cap. Capped low on purpose: the gate runs at ~2 fps. */
  maxFrameRate?: number;
}

/**
 * Build getUserMedia constraints for a desktopCapturer source id.
 * Chromium's chromeMediaSource constraints are non-standard, hence
 * the structural typing; pass the result to
 * navigator.mediaDevices.getUserMedia in the renderer and wrap the
 * stream with createElectronSource.
 */
export function desktopSourceConstraints(
  sourceId: string,
  options: DesktopConstraintsOptions = {},
): MediaStreamConstraints {
  const video = {
    mandatory: {
      chromeMediaSource: "desktop",
      chromeMediaSourceId: sourceId,
      maxWidth: options.maxWidth ?? 1920,
      maxHeight: options.maxHeight ?? 1080,
      maxFrameRate: options.maxFrameRate ?? 5,
    },
  };
  return { audio: false, video: video as unknown as MediaTrackConstraints };
}

/** The slice of Electron's NativeImage this package needs. */
export interface NativeImageLike {
  getSize(): { width: number; height: number };
  /** Raw bitmap pixels in BGRA order, as Electron's toBitmap() returns. */
  toBitmap(options?: { scaleFactor?: number }): Uint8Array;
}

/**
 * Wrap an Electron nativeImage (e.g. a desktopCapturer thumbnail, or
 * nativeImage from any main-process source) as a FrameInput.
 * toBitmap() returns pixels in BGRA order; this swaps them to the RGBA
 * the gate expects. Runs in the main process, where desktopCapturer
 * and nativeImage live - no DOM required. For the toPNG() path, decode
 * with frameFromPngBuffer from "@framesieve/adapters/node" instead.
 */
export function frameFromNativeImage(
  image: NativeImageLike,
  elapsedMs: number,
): FrameInput {
  const { width, height } = image.getSize();
  const bgra = image.toBitmap();
  const rgba = new Uint8ClampedArray(bgra.length);
  for (let i = 0; i + 3 < bgra.length; i += 4) {
    rgba[i] = bgra[i + 2]!; // R <- B
    rgba[i + 1] = bgra[i + 1]!; // G
    rgba[i + 2] = bgra[i]!; // B <- R
    rgba[i + 3] = bgra[i + 3]!; // A
  }
  return frameFromImageData({ data: rgba, width, height }, elapsedMs);
}
