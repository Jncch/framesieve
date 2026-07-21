# Changelog

Notable changes to `framesieve`. Pre-1.0 the API may change between
minor versions; breaking changes are called out here.

## 0.3.0

- New `gate.tap(observer)`: a synchronous observer of (frame, decision)
  for every push - the safe hook for recording/metrics without wrapping
  push(). Returns an unsubscribe function and cannot change decisions.
- `on()` now returns an unsubscribe function, and a new `on("error",
  ...)` channel reports a throwing transform (the emit still fails
  closed and is not counted).
- New `copyFrameOnEmit` option (default true): opt out of the per-emit
  frame-buffer copy when you never mutate a pushed buffer.
- New opt-in diff algorithm `"edge"`: compares Sobel edge maps, so a
  uniform brightness or theme color shift is ignored while text and
  contour changes still register. The default stays `"downsample"`;
  existing recordings decide identically.

## 0.2.0

- New `frameFromImageData(image, elapsedMs)` helper: the one-line entry
  point for feeding a still image (a browser `ImageData`, a decoded
  PNG, a canvas readback) instead of hand-building a `FrameInput`.
- New `gate.pushForEmit(frame)`: push and await the frame an "emit"
  listener would receive (or null), for single-consumer loops that do
  not want to register a listener and correlate by seq.
- New `policy.primeOnFirstFrame` (default false): emit the first frame
  immediately with reason "prime", for observers that need the current
  state right away. Adds "prime" to the emit reason set.
- New `policy.onNonMonotonic` ("throw" | "clamp", default "throw"):
  clamp a backwards elapsedMs to the last seen time instead of throwing,
  for callers that cannot guarantee a monotonic clock.
- The package now ships a CommonJS build alongside ESM, so
  `require("framesieve")` works (e.g. from an Electron main/preload).
  No behavior change; decisions for existing recordings are unchanged.

## 0.1.3

- Expose `./package.json` in the package `exports` map so tools that
  read `framesieve/package.json` (some bundlers and resolvers) no
  longer hit ERR_PACKAGE_PATH_NOT_EXPORTED. No API or runtime changes.

## 0.1.2

- Releases now publish via OIDC trusted publishing from GitHub Actions,
  so every published tarball carries a provenance attestation. No
  functional or API changes.

## 0.1.1

- Docs: mark the companion packages that are not on npm yet
  (`@framesieve/adapters` and `@framesieve/cli` land with the v0.1
  line, `@framesieve/redact` with v0.2) so the README no longer implies
  `npm install @framesieve/*` will resolve today.

## 0.1.0

- Initial release. Deterministic frame gate: downsample + grayscale +
  luminance floor, block-grid judgment, and an adaptive frequency mask
  that down-weights constantly-changing regions. Policy layer with
  debounce, minimum interval, keepalive, and ignore regions. Optional
  crops, a transform hook for redaction, and deterministic timeline
  serialization. Zero runtime dependencies; no clock, no I/O.
