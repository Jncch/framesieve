/**
 * Electron capture helpers. Electron renderers are Chromium, so the
 * actual frame source is the browser one; what Electron adds is the
 * desktopCapturer handshake for picking a screen or window. This
 * module never imports "electron" - the caller enumerates sources in
 * the main process (desktopCapturer.getSources) and hands an id to
 * the renderer. Only structural types cross the boundary here.
 */

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
