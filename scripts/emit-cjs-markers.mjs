// Writes a `{ "type": "commonjs" }` marker into each package's
// dist/cjs so Node treats the .js files there as CommonJS even though
// the package root is `"type": "module"`. Run after the CJS tsc pass.
// Idempotent; safe to run whenever dist exists.
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Packages that ship a dual (ESM + CJS) build.
const CJS_DIRS = ["packages/core/dist/cjs", "packages/adapters/dist/cjs"];

for (const rel of CJS_DIRS) {
  const dir = join(root, rel);
  if (!existsSync(dir)) continue; // package may not build CJS yet
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), '{\n  "type": "commonjs"\n}\n');
}
