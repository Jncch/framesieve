# Changelog

Notable changes to `@framesieve/cli`. Pre-1.0 the CLI surface may
change between minor versions.

## 0.1.0

- Initial release. `fsieve replay <dir>` replays a recording through
  the gate and prints the decision timeline; `--sweep param=start:end:step`
  reports emits per parameter value so you can pick a threshold. Built
  on the pure `replay` function from `@framesieve/adapters`.
