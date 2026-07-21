# Changelog

Notable changes to `@framesieve/adapters`. Pre-1.0 the API may change
between minor versions.

## 0.2.0

- The node recorder now observes the gate via `gate.tap` instead of
  monkeypatching `gate.push`, and moves PNG encoding and disk writes off
  the push hot path onto an async queue drained by `stop()`.
- New client-side recording: `createBrowserRecorder` (browser / Electron
  renderer) captures frames + decisions into a portable
  `RecordingBundle`; `writeRecordingBundle` (node) turns it into a
  standard recording directory for `replay`. Record on the renderer,
  tune on Node.

## 0.1.0

- Initial release. Capture sources for the browser (getDisplayMedia
  stream wrapper), Electron (the desktopCapturer constraints
  handshake), and node; a from-scratch zero-dependency PNG codec; the
  recorder and the pure `replay` function behind `fsieve replay`.
- Still-image entry helpers that build a `FrameInput` from decoded
  pixels: `frameFromBitmap` and `frameFromDataUrl` (browser),
  `frameFromPngBuffer` (node), and `frameFromNativeImage` (Electron
  main process, BGRA to RGBA).
- Ships both ESM and CommonJS builds, so the node and electron entries
  can be `require`d from an Electron main/preload or a CJS script.
