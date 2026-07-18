# framesieve

Deterministic frame gating for vision AI. Feed it a stream of screen
captures; it tells you which frames are actually worth sending to a
VLM - and masks personal information before they leave the machine.

## Why

Letting an AI "watch your screen" is simple to build and expensive to
run. Capturing at 2 fps produces 7,200 frames per hour. Sending all of
them to a vision model is a fast way to burn money on frames where
nothing happened.

framesieve sits between your capture source and your model:

```
capture (2 fps) --> framesieve --> 20-60 meaningful frames/hour --> VLM
                        |
                        +-- PII redaction (optional, local)
```

Research on agent observation interfaces has shown that simple
pixel-difference sampling matches CLIP-based and learned approaches in
downstream accuracy. framesieve leans into that result: no models, no
GPU, no network - just fast, deterministic pixel math.

## What it is / is not

- A zero-dependency TypeScript library. Same frame sequence in, same
  decisions out. Every emit carries a machine-readable reason.
- It never calls an LLM/VLM. You own the sending, the provider, and
  the prompt.
- It is not a screen recorder, not an observability platform, and not
  an agent framework.

## Install

```bash
npm install framesieve            # the gate itself (zero dependencies)
```

`framesieve` (the core gate) is the only package on npm today. The
companion packages ship on their own schedule and are not published
yet:

- `@framesieve/adapters` (capture sources, recorder, replay) and
  `@framesieve/cli` (the `fsieve` command) land with the v0.1 line.
- `@framesieve/redact` (local PII masking) is planned for v0.2, after
  it has been battle-tested in production.

Examples below that import `@framesieve/*` describe those APIs; until
the packages are on npm, run them from a clone of this repository.

## Quick start

```ts
import { createFrameGate } from "framesieve";

const gate = createFrameGate({
  policy: { debounceMs: 800, minIntervalMs: 2000, maxSilenceMs: 60000 },
});

gate.on("emit", ({ frame, reason, score, changedBlocks }) => {
  // reason: "threshold" | "keepalive"
  sendToYourVLM(frame, { reason, changedBlocks });
});

// You control the cadence. Capture however you like (Electron
// desktopCapturer, getDisplayMedia, node) and push frames:
setInterval(async () => {
  gate.push(await captureFrame()); // { data, width, height, elapsedMs }
}, 500);
```

## How it decides

Three stages, all deterministic:

1. Downsample + grayscale + luminance floor. A 1080p frame shrinks to
   ~240x135 before comparison. Rendering noise, anti-aliasing flicker
   and subtle color shifts disappear here, and so does 99% of the
   compute cost.
2. Block-level judgment. The frame is split into a 16x9 grid; only
   blocks where a meaningful fraction of pixels changed count. A moving
   cursor or a ticking clock cannot trigger an emit; a redrawn slide
   can. Changed-block positions are reported in the emit event.
3. Adaptive masking. Blocks that change on nearly every frame (an
   embedded video, someone's camera tile) are automatically
   down-weighted, without any configuration. The slide next to the
   video still triggers normally - and if a formerly busy region goes
   quiet and then changes, it counts again at full weight.

On top of the score, gate policies shape the output stream: debounce
(wait for transitions to settle), minimum interval, keepalive frames
during long silence, and static ignore regions.

## Tuning without guesswork: record and replay

The hard part of any change-detection setup is picking thresholds.
framesieve ships a recorder and a replay CLI so you tune against your
real screen, offline.

> The recorder and replay live in `@framesieve/adapters`, and the
> `fsieve` command in `@framesieve/cli`. Both land with the v0.1 line
> and are not on npm yet; run these from a clone of the repository for
> now.

```bash
# capture a few minutes of your actual usage: wrap your gate with
# createRecorder from "@framesieve/adapters/node" and push as usual

fsieve replay ./recording                      # decisions with current defaults
fsieve replay examples/meeting                 # bundled sample recording
fsieve replay ./recording --min-blocks 5       # what would change?
fsieve replay ./recording --sweep blockChangeRatio=0.1:0.4:0.05
# emits per setting, so you can pick the knee of the curve
```

Replays are pure functions of (recording, options): run them a
thousand times, get the same answer a thousand times. Recordings are
capped (5 min / 1 GiB by default) - this is a tuning tool, not
surveillance storage. Note that recordings contain raw, unredacted
screen content; treat the directory accordingly.

## PII redaction (@framesieve/redact)

> Planned for v0.2, not on npm yet. This package is being battle-tested
> inside a production meeting-room system before it is extracted and
> published; `npm install @framesieve/redact` will not resolve until
> then. The API below is what will ship.

An optional transform that masks personal information before a frame
leaves the machine. Runs fully locally.

```ts
import { createRedactor } from "@framesieve/redact";
import { tesseractAdapter } from "@framesieve/redact/tesseract";

const redact = createRedactor({
  regions: [{ x: 0, y: 0, width: 320, height: 1080 }], // always-on masks
  patterns: ["email", "phone-jp", "credit-card", "my-number", "address-jp"],
  dictionary: ["Tanaka Taro", "ACME Corp"], // names you must protect
  ocr: tesseractAdapter(), // pluggable; or bring your own OcrEngine
});

const gate = createFrameGate({ transform: redact });
```

The tesseract.js adapter loads tesseract.js lazily and declares it as
an optional peer dependency; install it only if you use this adapter.
Any object with a `recognize(frame)` method works as an engine.

- Region masks are deterministic and cannot miss. Use them for
  anything that must never leak.
- Pattern and dictionary masks depend on OCR reading the text first.
  Frontier VLMs read text better than any local OCR engine, so a
  detection miss is possible by construction. Treat text-based
  redaction as best-effort defense in depth, not as a guarantee, and
  combine it with region masks for sensitive layouts.
- Returning null from the transform cancels the emit entirely, so you
  can build fail-closed policies on top. A cancelled emit still shows
  up in the decision timeline (decisions are deterministic and never
  depend on the transform), but it is excluded from
  gate.stats().framesEmitted - stats count frames that actually left
  the machine. Use gate.flush() to await in-flight deliveries.

Name detection uses your dictionary, not an NER model: in practice the
names you need to protect (attendees, customers) already exist as
structured data in your system. No models, no false confidence.

## Use cases

- Computer-use agents that need to notice state changes without
  streaming every frame
- AI meeting assistants that describe shared screens
- Long-running monitoring tasks with a token budget
- Any pipeline where "the screen changed in a way that matters" is the
  real event

## Status

v0.1. Extracted from a production AI meeting-room system, where it
gates the screen-capture channel. API may change before 1.0.

Roadmap: budget caps (max emits/hour), scene-change tagging,
near-duplicate suppression (A -> B -> A tab switches), face masking in
redact. Out of scope: provider-specific image optimization, GUIs,
anything that calls a model from the core.

## License

Apache-2.0
