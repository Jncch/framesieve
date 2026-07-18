# framesieve - Claude Code instructions

Deterministic frame gating library for vision AI. Decides which
captured frames are worth sending to a VLM and redacts PII locally.
See README.md for product scope; this file covers rules for working
in this repo.

## Repository layout

- packages/core      Frame gate. Zero runtime dependencies.
- packages/redact    PII masking transform. OCR engines are pluggable
                     adapters, never hard dependencies.
- packages/adapters  Capture sources (electron, browser, node).
- packages/cli       fsieve command (replay, sweep).
- examples/          Sample recordings used by README and tests.

## Hard invariants (never violate)

1. Determinism in core: same frame sequence in, same decision
   sequence out. In packages/core never use Date.now(), setTimeout,
   setInterval, Math.random, or any wall-clock source. All temporal
   logic uses FrameInput.elapsedMs.
2. packages/core has zero runtime dependencies and performs no I/O.
   File access lives in recorder/replay and cli only.
3. Nothing in this repo calls an LLM/VLM API or imports a provider
   SDK. Sending frames is the caller's job. Reject feature work that
   adds provider-specific code paths.
4. Serialization is deterministic: sorted keys, fixed number
   formatting (6 decimal places for scores). timeline.jsonl lines
   must round-trip byte-identically.
5. transform hook semantics: returning null cancels the emit. Do not
   add other cancellation channels.
6. Redaction honesty: text-based masking is best-effort by design.
   Never write docs or messages implying pattern/dictionary masking
   is guaranteed. Region masks are the only guaranteed mechanism.

## Testing rules

- Core behavior is tested as decision sequences against fixture frame
  series (PNG sequences in fixtures/). Assert full Decision arrays,
  not just counts.
- Any change to scoring or policy logic must update or add a fixture
  test demonstrating the behavioral difference. If replaying
  examples/ produces different decisions, that is a breaking change:
  call it out explicitly in the PR description.
- No snapshot tests against timestamps or machine-dependent values.
- Do not mock the core in cli/adapters tests; run the real thing.

## Code style

- TypeScript strict mode. No `any`; use `unknown` and narrow.
- No emoji or platform-dependent characters anywhere in code, docs,
  or commit messages.
- Public API changes require updating types.ts docs comments and
  README in the same PR.
- Comments in English. Keep them sparse; explain why, not what.

## Commands

- npm install           workspace install
- npm run build         build all packages
- npm test              run all tests
- npm run test:core     core only (fastest loop)
- npm run lint          hard-invariant + ASCII checks (CI-enforced)
- fsieve replay examples/meeting   sanity-check the gate end to end

## Out of scope (decline and point to README)

Provider-specific image optimization, GUIs/dashboards, NER-based name
detection, audio/multimodal input, calling models from anywhere in
the library.
