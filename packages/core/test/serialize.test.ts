import { test } from "node:test";
import assert from "node:assert/strict";

import { parseDecisionLine, serializeDecision } from "../src/serialize.ts";
import type { Decision } from "../src/types.ts";

test("serialization uses sorted keys and 6-decimal scores", () => {
  const line = serializeDecision({
    seq: 2,
    elapsedMs: 500,
    score: 3,
    decision: "emit",
    reason: "threshold",
  });
  assert.equal(
    line,
    '{"decision":"emit","elapsedMs":500,"reason":"threshold","score":3.000000,"seq":2}',
  );
});

test("reason is omitted when absent", () => {
  const line = serializeDecision({
    seq: 1,
    elapsedMs: 0,
    score: 0.5,
    decision: "skip",
  });
  assert.equal(line, '{"decision":"skip","elapsedMs":0,"score":0.500000,"seq":1}');
});

test("timeline lines round-trip byte-identically", () => {
  const samples: Decision[] = [
    { seq: 1, elapsedMs: 0, score: 16, decision: "emit", reason: "threshold" },
    { seq: 2, elapsedMs: 500.25, score: 1 / 3, decision: "skip" },
    { seq: 3, elapsedMs: 1000, score: 0, decision: "debounced" },
    { seq: 4, elapsedMs: 1500, score: 2.05, decision: "throttled" },
    { seq: 5, elapsedMs: 60000, score: 0, decision: "emit", reason: "keepalive" },
  ];
  for (const d of samples) {
    const line = serializeDecision(d);
    const back = parseDecisionLine(line);
    assert.equal(serializeDecision(back), line);
  }
});

test("parse validates structure strictly", () => {
  assert.throws(() => parseDecisionLine("not json"), SyntaxError);
  assert.throws(() => parseDecisionLine("[1]"), SyntaxError);
  assert.throws(
    () => parseDecisionLine('{"decision":"emit","elapsedMs":0,"score":0,"seq":0}'),
    SyntaxError, // seq must be >= 1
  );
  assert.throws(
    () =>
      parseDecisionLine(
        '{"decision":"nope","elapsedMs":0,"score":0,"seq":1}',
      ),
    SyntaxError,
  );
  assert.throws(
    () =>
      parseDecisionLine(
        '{"decision":"emit","elapsedMs":0,"score":0,"seq":1,"extra":true}',
      ),
    SyntaxError,
  );
});

test("parse accepts scores in fixed 6-decimal format", () => {
  const d = parseDecisionLine(
    '{"decision":"skip","elapsedMs":250,"score":0.333333,"seq":9}',
  );
  assert.deepEqual(d, {
    seq: 9,
    elapsedMs: 250,
    score: 0.333333,
    decision: "skip",
  });
});
