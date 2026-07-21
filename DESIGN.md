# framesieve design notes

Records the reasoning behind the diff pipeline so future changes are
argued against decisions, not re-litigated from scratch. README
describes what the gate does; this file describes why.

## Decision 1: simple pixel math, no learned models

We deliberately use downsampled grayscale difference instead of SSIM,
perceptual hashing as the primary signal, CLIP embeddings, or any
learned saliency model.

Rationale:
- Research on agent observation interfaces compared pixel-difference
  sampling against CLIP-based and uniform sampling for screen
  observation and found downstream accuracy converges. Added
  sophistication does not buy accuracy here. (Link the paper in this
  section when publishing.)
- Zero dependencies and full determinism are product invariants
  (see CLAUDE.md). SSIM libraries and models break both.
- Cost: the gate runs at 2 fps on user machines alongside a meeting
  app. Budget is "a few percent of one core", which downsampled
  diff meets with two orders of magnitude to spare.

Consequence: PRs adding heavier similarity metrics to core are
rejected by default. A plugin point may be considered post-1.0 if a
concrete accuracy failure is demonstrated with a recording.

## Decision 2: three-stage pipeline, in this order

Stage 1 (downsample + grayscale + luminance floor) exists to make
Stages 2-3 cheap and to kill sub-block noise: anti-aliasing flicker,
subpixel font rendering, compression artifacts, subtle color shifts.
Defaults: factor 8, luminance delta floor 10/255. The floor is applied
per-pixel before any counting; without it, block ratios measure codec
noise, not content change.

Stage 2 (block grid judgment) distinguishes point changes from area
changes. Summing pixel deltas over the whole frame cannot tell a
cursor move from a slide flip. Counting blocks where >= 20% of pixels
changed, and requiring >= 3 such blocks, encodes "a meaningful area
changed" directly. Block coordinates double as crop regions, so this
stage is also the source of crop output.

Stage 3 (adaptive frequency mask) handles regions that are always
changing: embedded video, camera tiles, animated ads. Static ignore
regions cannot cover these because their position is not known in
advance. Per-block weight:

    weight(b) = 1 - changeFrequency(b, last N frames)   # N = 20
    score     = sum over changed blocks of weight(b)

Properties this buys:
- A region that changes every frame converges to weight ~0 and stops
  contributing.
- Content next to it still scores at full weight.
- A busy region that goes quiet recovers weight, so a video that
  stops and then shows a new scene is detected again.

Stage 3 makes the gate stateful: decisions depend on the preceding
frames, not just the current pair. Determinism is preserved at the
sequence level (same frame sequence -> same decision sequence), which
is the level our tests and replay operate on. "Same two frames ->
same score" does NOT hold by design; do not write tests that assume
it.

## Decision 3: policy layer is separate from scoring

Debounce, min interval, keepalive, and ignore regions sit above the
score, not inside it. Two reasons:
- Debounce semantics: we emit the settled post-transition frame, not
  the first frame that crossed the threshold. Mid-animation frames
  waste tokens and confuse VLMs. This is a policy choice, not a
  scoring concern.
- Replay sweeps vary scoring and policy parameters independently;
  mixing the layers would make sweep results uninterpretable.

primeOnFirstFrame lives in this layer too: it forces the first frame
out (reason "prime") regardless of score, for observers that want the
current state immediately rather than the settled one. It is off by
default so the decision sequence of existing recordings is unchanged.

## Decision 4: push model, caller-owned time

The gate never samples, schedules, or reads a clock. The caller
pushes frames with elapsedMs. This single decision is what makes
recordings replayable bit-for-bit and tests trivially deterministic.
Any feature that needs "time" must take it from elapsedMs.

elapsedMs must be monotonic; a decreasing value throws by default.
onNonMonotonic: "clamp" pins a backwards step to the last seen time
instead, so a non-monotonic wall clock (an NTP correction) cannot
crash a long capture. Clamp is a pure function of the prior elapsedMs,
so determinism at the sequence level is preserved. frameFromImageData
is the caller-side helper for building a frame from decoded pixels; it
too takes no clock, keeping the "caller owns time" boundary intact.

## Decision 5: stats count delivered frames, not decisions

The decision stream and the delivery stream are deliberately kept
apart. Decisions (emit / skip / debounced / throttled) are pure
functions of the frame sequence and options; the transform hook can
never influence them, and timeline.jsonl records them. GateStats
answers a different question - "what actually left the machine":
framesEmitted, emitRatio and lastEmitElapsedMs count only frames
that survived the transform. An emit cancelled by the transform
(null return, or a throw, both fail closed) appears as decision
"emit" in the timeline but is excluded from the stats. This keeps
emitRatio usable as the honest "captured frames actually sent"
number even under fail-closed redaction, where cancellations are
routine. Because transforms may be async, stats trail push();
flush() resolves when all pending deliveries have settled.

## Default values and their status

| Parameter          | Default | Status                                    |
|--------------------|---------|-------------------------------------------|
| downsampleFactor   | 8       | provisional, calibrate against production |
| luminanceThreshold | 10      | provisional                               |
| grid               | 16x9    | matches 16:9 sources; provisional         |
| blockChangeRatio   | 0.2     | provisional                               |
| minChangedBlocks   | 3       | provisional                               |
| adaptive window    | 20      | provisional (10 s at 2 fps)               |
| debounceMs         | 800     | provisional                               |
| minIntervalMs      | 2000    | provisional                               |
| maxSilenceMs       | 60000   | provisional                               |
| primeOnFirstFrame  | false   | opt-in; forces the first frame out        |
| onNonMonotonic     | throw   | clamp available for non-monotonic clocks  |

All defaults are provisional until calibrated against recordings from
the production meeting-room deployment. When calibration happens,
replace "provisional" with the recording ID that justified the value.

## Known limitations (accepted)

- Gradual global changes (e.g. slow full-screen fade) can stay under
  per-frame thresholds indefinitely; maxSilenceMs keepalive is the
  backstop.
- The adaptive mask can suppress a legitimately important region that
  happens to change constantly (e.g. a live dashboard the user cares
  about). Mitigation: adaptiveMask.enabled = false or region-scoped
  configuration (post-1.0 candidate).
- Block grid is aligned to the frame, not to window boundaries; a
  change spanning a block edge counts in both blocks. Acceptable at
  16x9 granularity.
