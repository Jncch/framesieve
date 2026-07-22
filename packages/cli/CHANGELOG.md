# Changelog

Notable changes to `@framesieve/cli`. Pre-1.0 the CLI surface may
change between minor versions.

## 0.2.0

- Requires `framesieve` `^0.4.0` and `@framesieve/adapters` `^0.3.0`
  (core adds the opt-in reference diff mode). `fsieve replay --sweep`
  can vary `diff.mode` like any other gate option; no new CLI flags.

## 0.1.1

- `--algorithm` now accepts `edge` (Sobel edge diff) in addition to
  `downsample` and `pixel`.

## 0.1.0

- Initial release. `fsieve replay <dir>` replays a recording through
  the gate and prints the decision timeline; `--sweep param=start:end:step`
  reports emits per parameter value so you can pick a threshold. Built
  on the pure `replay` function from `@framesieve/adapters`.
