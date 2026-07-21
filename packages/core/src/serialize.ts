import type { Decision, EmitReason } from "./types.ts";

/**
 * Deterministic serialization for Decision records - one line of
 * timeline.jsonl. Invariants:
 * - Keys in fixed sorted order: decision, elapsedMs, reason (omitted
 *   when absent), score, seq.
 * - score is always formatted with exactly 6 decimal places.
 * - serializeDecision(parseDecisionLine(line)) === line, byte for
 *   byte, for any line this module produced.
 */

const DECISIONS = ["emit", "skip", "debounced", "throttled"] as const;
const REASONS: readonly EmitReason[] = ["threshold", "keepalive", "prime"];

export function serializeDecision(d: Decision): string {
  const reason =
    d.reason === undefined ? "" : `"reason":${JSON.stringify(d.reason)},`;
  return (
    `{"decision":${JSON.stringify(d.decision)},` +
    `"elapsedMs":${numberToJson(d.elapsedMs)},` +
    reason +
    `"score":${d.score.toFixed(6)},` +
    `"seq":${numberToJson(d.seq)}}`
  );
}

function numberToJson(n: number): string {
  if (!Number.isFinite(n)) {
    throw new RangeError(`cannot serialize non-finite number ${n}`);
  }
  return String(n);
}

function isDecisionKind(v: unknown): v is Decision["decision"] {
  return typeof v === "string" && (DECISIONS as readonly string[]).includes(v);
}

function isReason(v: unknown): v is EmitReason {
  return typeof v === "string" && (REASONS as readonly string[]).includes(v);
}

export function parseDecisionLine(line: string): Decision {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (e) {
    throw new SyntaxError(`invalid timeline line: ${(e as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SyntaxError("timeline line must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const allowed = ["decision", "elapsedMs", "reason", "score", "seq"];
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new SyntaxError(`unknown timeline field: ${key}`);
    }
  }
  const { decision, elapsedMs, reason, score, seq } = obj;
  if (!isDecisionKind(decision)) {
    throw new SyntaxError(`invalid decision: ${String(decision)}`);
  }
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) {
    throw new SyntaxError(`invalid seq: ${String(seq)}`);
  }
  if (typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs < 0) {
    throw new SyntaxError(`invalid elapsedMs: ${String(elapsedMs)}`);
  }
  if (typeof score !== "number" || !Number.isFinite(score)) {
    throw new SyntaxError(`invalid score: ${String(score)}`);
  }
  if (reason !== undefined && !isReason(reason)) {
    throw new SyntaxError(`invalid reason: ${String(reason)}`);
  }
  const d: Decision = { seq, elapsedMs, score, decision };
  if (reason !== undefined) d.reason = reason;
  return d;
}
