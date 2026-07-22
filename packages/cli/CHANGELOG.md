# Changelog

Notable changes to `@framesieve/cli`. Pre-1.0 the CLI surface may
change between minor versions.

## 0.2.1

- `--mode <previous|reference>` selects the diff comparison baseline
  (core 0.4.0's reference mode), and `--persist <ms>` sets
  `policy.referencePersistMs`. `--sweep referencePersistMs=a:b:step`
  calibrates the reference-mode persistence window against a recording,
  so `fsieve replay <dir> --mode reference --sweep referencePersistMs=0:4000:1000`
  shows the emit knee. No behavior change to existing flags.

## 0.2.0

- Requires `framesieve` `^0.4.0` and `@framesieve/adapters` `^0.3.0`
  (core adds the opt-in reference diff mode). No CLI surface change in
  this version.

## 0.1.1

- `--algorithm` now accepts `edge` (Sobel edge diff) in addition to
  `downsample` and `pixel`.

## 0.1.0

- Initial release. `fsieve replay <dir>` replays a recording through
  the gate and prints the decision timeline; `--sweep param=start:end:step`
  reports emits per parameter value so you can pick a threshold. Built
  on the pure `replay` function from `@framesieve/adapters`.
