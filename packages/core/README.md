# framesieve

Deterministic frame gating for vision AI. Feed it a stream of screen
captures; it tells you which frames are actually worth sending to a
VLM. An optional transform hook lets you black out sensitive regions
locally, before a frame ever leaves the machine.

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
npm install framesieve                       # the gate itself (zero dependencies)
npm install @framesieve/adapters             # capture sources, recorder, replay
npm install -g @framesieve/cli               # the fsieve command
```

`framesieve` (the core gate, zero dependencies) and its companion
packages `@framesieve/adapters` and `@framesieve/cli` are on npm. One
package is still held back:

- `@framesieve/redact` (local PII masking) is planned for v0.2, after
  it has been battle-tested in production; `npm install
  @framesieve/redact` does not resolve yet. Examples below that import
  it describe the API that will ship.

## Quick start

```ts
import { createFrameGate, frameFromImageData } from "framesieve";

const gate = createFrameGate({
  policy: { debounceMs: 800, minIntervalMs: 2000, maxSilenceMs: 60000 },
});

gate.on("emit", ({ frame, reason, score, changedBlocks }) => {
  // reason: "threshold" | "keepalive" | "prime"
  sendToYourVLM(frame, { reason, changedBlocks });
});

// You control the cadence. Capture however you like, wrap the pixels
// as a frame, and push. elapsedMs is your own monotonic clock.
const start = performance.now();
setInterval(() => {
  const image = captureImageData(); // any { data, width, height }
  gate.push(frameFromImageData(image, performance.now() - start));
}, 500);
```

## Feeding frames

A frame is just RGBA pixels plus a timestamp:
`{ data, width, height, elapsedMs }`. If you already hold a still image
- a browser `ImageData`, a decoded PNG, an Electron `nativeImage`, a
`<canvas>` readback - wrap it with `frameFromImageData` instead of
hand-building the object:

```ts
import { frameFromImageData } from "framesieve";

gate.push(frameFromImageData(imageData, elapsedMs)); // ImageData-shaped in
```

`elapsedMs` is a caller-supplied clock, and it must be monotonic:
`push` rejects a value lower than the previous frame's. Use a monotonic
source like `performance.now()`. A wall clock read with `Date.now()`
can jump backwards on an NTP correction and crash a long capture; if
you cannot guarantee monotonicity, set `policy.onNonMonotonic: "clamp"`
to pin backwards steps to the last time instead of throwing.

Source-specific decoding helpers (`ImageBitmap`, PNG buffers, Electron
`nativeImage`) live in `@framesieve/adapters` - see below.

### One frame in, one decision out

`push` returns the decision synchronously, but the emitted frame is
delivered asynchronously (a transform may be async). For a single
consumer that just wants "the frame to send, if any", `pushForEmit`
collapses both into one await:

```ts
const out = await gate.pushForEmit(frame);
if (out) sendToYourVLM(out); // null when this frame was not emitted
```

This is equivalent to registering an `"emit"` listener and correlating
by `seq`; use whichever fits your loop.

## Encoding what it emits

The emitted `frame` is raw RGBA at the resolution you pushed - the diff
runs on an internal downsample, but you get the full frame back, ready
to encode. framesieve never re-encodes for you (picking JPEG quality or
a provider's expected format is your call):

```ts
// browser: RGBA -> JPEG/PNG blob
const canvas = new OffscreenCanvas(frame.width, frame.height);
canvas
  .getContext("2d")
  .putImageData(new ImageData(frame.data, frame.width, frame.height), 0, 0);
const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });

// node: RGBA -> PNG (zero-dependency encoder in the adapters package)
import { encodePng } from "@framesieve/adapters/node";
const png = encodePng(frame);
```

Diff cheap, send sharp: you push one frame and get that same frame
back, so pushing at full resolution already gives you a high-quality
frame to send while the diff cost stays on the downsample. To diff a
small frame but send a larger one, keep your own high-resolution buffer
keyed by the emit's `seq` and look it up when the gate emits.

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
during long silence, and static ignore regions. Set
`policy.primeOnFirstFrame` to emit the very first frame immediately
(reason "prime") when an observer needs the current state right away
instead of waiting for the stream to settle.

By default the gate compares downsampled luma. Set `diff.algorithm:
"edge"` to compare Sobel edge maps instead: a theme or brightness color
shift (unchanged gradients) is ignored, while text and contour changes
still register. Compare it against your own recording with `fsieve
replay <dir> --algorithm edge`.

## Tuning without guesswork: record and replay

The hard part of any change-detection setup is picking thresholds.
framesieve ships a recorder and a replay CLI so you tune against your
real screen, offline.

> The recorder and replay live in `@framesieve/adapters`, and the
> `fsieve` command in `@framesieve/cli` (`npm install -g
> @framesieve/cli`).

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

Capturing in a browser or Electron renderer? `createBrowserRecorder`
(from `@framesieve/adapters/browser`) observes the gate via `gate.tap`
and collects frames + decisions into a portable `RecordingBundle`; hand
it to `writeRecordingBundle` (from `@framesieve/adapters/node`) to get a
recording directory you can `replay` and `--sweep` on Node. Record
where the real frames are, tune where the tooling is.

## Masking sensitive regions

The surest way to keep something off the wire is to never send it. If
you know where sensitive content sits - a sidebar, a name field, a
system tray - black it out with a transform. This is pure pixel math:
deterministic, zero-dependency, and it cannot miss.

```ts
import { createFrameGate, type FrameInput } from "framesieve";

type Rect = { x: number; y: number; width: number; height: number };

// Black out fixed rectangles (source pixels) before every emit.
function maskRegions(regions: Rect[]) {
  return (frame: FrameInput): FrameInput => {
    const data = new Uint8ClampedArray(frame.data);
    for (const { x, y, width, height } of regions) {
      for (let row = y; row < y + height; row++) {
        for (let col = x; col < x + width; col++) {
          const p = (row * frame.width + col) * 4;
          data[p] = data[p + 1] = data[p + 2] = 0;
          data[p + 3] = 255;
        }
      }
    }
    return { ...frame, data };
  };
}

const gate = createFrameGate({
  transform: maskRegions([{ x: 0, y: 0, width: 320, height: 1080 }]),
});
```

Return `null` from a transform to drop the frame entirely - a
fail-closed switch for "if in doubt, do not send". A dropped frame
still appears in the decision timeline but is excluded from
`gate.stats().framesEmitted`; `await gate.flush()` waits for in-flight
deliveries.

For layouts you cannot pin to fixed rectangles, the strongest move is
to capture a specific window instead of the whole screen. Reading
arbitrary on-screen text and masking it is a different, weaker problem
- that is what the optional redact package below is for.

## PII redaction (@framesieve/redact)

> Planned for v0.2, not on npm yet. This package is being battle-tested
> inside a production meeting-room system before it is extracted and
> published; `npm install @framesieve/redact` will not resolve until
> then. The API below is what will ship.

An optional, heavier layer for the harder case: masking personal
information that appears as on-screen text, read locally by OCR. It is
best-effort by design (see the caveats below) - a defense-in-depth
layer on top of region masks, never a replacement for them.

```ts
import { createRedactor } from "@framesieve/redact";
import { jpPatterns } from "@framesieve/redact/presets/jp";
import { tesseractAdapter } from "@framesieve/redact/tesseract";

const redact = createRedactor({
  regions: [{ x: 0, y: 0, width: 320, height: 1080 }], // always-on masks
  patterns: [
    "email",
    "credit-card", // locale-neutral built-ins
    ...jpPatterns, // opt-in JP preset: phone, My Number, address
    { name: "employee-id", test: (t) => /^EMP-\d{6}$/.test(t) }, // your own
  ],
  dictionary: ["Tanaka Taro", "ACME Corp"], // names you must protect
  ocr: tesseractAdapter(), // pluggable; or bring your own OcrEngine
});

const gate = createFrameGate({ transform: redact });
```

Built-in pattern names are locale-neutral (`email`, `credit-card`).
Country-specific formats are opt-in presets - Japanese phone, My
Number and address ship as `@framesieve/redact/presets/jp` - and any
`{ name, test }` object works as a custom detector, so redact itself
bakes in no locale.

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
