/**
 * Enforces the CLAUDE.md hard invariants mechanically. Run via
 * `npm run lint`; CI fails on any violation. Plain node, no
 * dependencies, portable (no grep -P quirks).
 *
 * Checks:
 *   1. core-clock:    no wall clock / timers / randomness in core src
 *   2. core-deps:     packages/core has zero runtime dependencies
 *   3. core-io:       core src imports nothing (no node builtins,
 *                     no require, no network APIs)
 *   4. provider-sdks: no LLM/VLM provider SDK in any package manifest
 *   5. ascii:         no non-ASCII characters in code, docs, or data
 *                     text files, outside ASCII_ALLOWLIST
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");

/**
 * Path prefixes (relative, forward slashes) exempt from the ASCII
 * check. Decided 2026-07-18: a future Japanese README lives under
 * docs/ja/. Everything else ships ASCII-only; Japanese literals in
 * code use \uXXXX escapes (see packages/redact).
 */
const ASCII_ALLOWLIST = ["docs/ja/"];

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".claude"]);
const TEXT_EXT = /\.(ts|mts|cts|mjs|cjs|js|md|json|jsonl|yml|yaml|txt|sh)$/;

let violations = 0;
function report(check, file, line, detail) {
  violations += 1;
  console.error(`${check}: ${file}${line ? ":" + line : ""}  ${detail}`);
}

function* walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(name)) yield* walk(full);
    } else {
      yield full;
    }
  }
}

function lines(file) {
  return readFileSync(file, "utf8").split("\n");
}

function scanFile(file, regex, check, detail) {
  const rel = relative(ROOT, file);
  lines(file).forEach((text, i) => {
    const m = regex.exec(text);
    if (m !== null) report(check, rel, i + 1, `${detail}: ${m[0]}`);
  });
}

// 1. core-clock + 3. core-io ------------------------------------------------
const CLOCK_RE =
  /\b(Date\.now|setTimeout|setInterval|setImmediate|Math\.random|performance\.now|process\.hrtime)\b/;
const IO_RE =
  /(from\s+["'](node:|fs["'/]|path["'/]|os["'/]|child_process)|\brequire\s*\(|\bfetch\s*\(|XMLHttpRequest|WebSocket|import\s*\(\s*["']node:)/;
const coreSrc = join(ROOT, "packages", "core", "src");
for (const file of walk(coreSrc)) {
  if (!file.endsWith(".ts")) continue;
  scanFile(file, CLOCK_RE, "core-clock", "wall clock / timer / randomness");
  scanFile(file, IO_RE, "core-io", "I/O or import of a runtime module");
}

// 2. core-deps --------------------------------------------------------------
{
  const pkg = JSON.parse(
    readFileSync(join(ROOT, "packages", "core", "package.json"), "utf8"),
  );
  const deps = Object.keys(pkg.dependencies ?? {});
  if (deps.length > 0) {
    report("core-deps", "packages/core/package.json", 0, deps.join(", "));
  }
}

// 4. provider-sdks ----------------------------------------------------------
const PROVIDER_RE = /(openai|anthropic|@google\/|googleapis|gemini|mistralai|cohere-ai)/i;
for (const name of readdirSync(join(ROOT, "packages")).sort()) {
  const manifest = join(ROOT, "packages", name, "package.json");
  try {
    scanFile(manifest, PROVIDER_RE, "provider-sdks", "provider SDK reference");
  } catch {
    // package without a manifest: nothing to check
  }
}

// 5. ascii ------------------------------------------------------------------
const NON_ASCII_RE = /[^\x00-\x7F]/;
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file).replaceAll("\\", "/");
  if (!TEXT_EXT.test(rel)) continue;
  if (ASCII_ALLOWLIST.some((prefix) => rel.startsWith(prefix))) continue;
  lines(file).forEach((text, i) => {
    const m = NON_ASCII_RE.exec(text);
    if (m !== null) {
      const code = m[0].codePointAt(0).toString(16).toUpperCase();
      report("ascii", rel, i + 1, `non-ASCII character U+${code}`);
    }
  });
}

if (violations > 0) {
  console.error(`\n${violations} invariant violation(s)`);
  process.exit(1);
}
console.log("invariants OK");
