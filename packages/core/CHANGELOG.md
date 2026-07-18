# Changelog

Notable changes to `framesieve`. Pre-1.0 the API may change between
minor versions; breaking changes are called out here.

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
