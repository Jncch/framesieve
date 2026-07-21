// Packs the published `framesieve` tarball, installs it into a throwaway
// project, and verifies that a real consumer can resolve it three ways:
//   - ESM   `import { frameFromImageData } from "framesieve"`
//   - CJS   `require("framesieve")`
//   - JSON  `require("framesieve/package.json")` (the exports subpath)
// Guards the .ts-source / dist-.js-import boundary and the dual build.
// Run with: npm run smoke:pack
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

console.log("[smoke] building...");
run("npm", ["run", "build"], root);

console.log("[smoke] packing framesieve...");
const packed = JSON.parse(run("npm", ["pack", "-w", "framesieve", "--json"], root));
const tarball = join(root, packed[0].filename);

// Fail loudly if the CJS build did not make it into the tarball.
const files = packed[0].files.map((f) => f.path);
for (const needed of ["dist/index.js", "dist/cjs/index.js", "dist/cjs/package.json"]) {
  if (!files.includes(needed)) {
    throw new Error(`[smoke] tarball is missing ${needed}`);
  }
}

const dir = mkdtempSync(join(tmpdir(), "framesieve-smoke-"));
try {
  writeFileSync(join(dir, "package.json"), '{ "name": "smoke", "private": true }\n');
  console.log("[smoke] installing tarball into a clean project...");
  run("npm", ["install", "--no-audit", "--no-fund", tarball], dir);

  writeFileSync(
    join(dir, "esm.mjs"),
    [
      'import { createFrameGate, frameFromImageData } from "framesieve";',
      "const gate = createFrameGate({ policy: { primeOnFirstFrame: true, debounceMs: 0 } });",
      "const f = frameFromImageData({ data: new Uint8ClampedArray(64), width: 4, height: 4 }, 0);",
      'if (gate.push(f).reason !== "prime") throw new Error("ESM: unexpected decision");',
      'console.log("[smoke] ESM ok");',
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "cjs.cjs"),
    [
      'const { createFrameGate, frameFromImageData } = require("framesieve");',
      'const pkg = require("framesieve/package.json");',
      "const gate = createFrameGate({ policy: { primeOnFirstFrame: true, debounceMs: 0 } });",
      "const f = frameFromImageData({ data: new Uint8ClampedArray(64), width: 4, height: 4 }, 0);",
      'if (gate.push(f).reason !== "prime") throw new Error("CJS: unexpected decision");',
      'console.log("[smoke] CJS ok (framesieve@" + pkg.version + ")");',
    ].join("\n"),
  );

  run("node", ["esm.mjs"], dir);
  run("node", ["cjs.cjs"], dir);
  console.log("[smoke] pass");
} finally {
  rmSync(dir, { recursive: true, force: true });
  for (const f of readdirSync(root)) {
    if (f.startsWith("framesieve-") && f.endsWith(".tgz")) {
      rmSync(join(root, f), { force: true });
    }
  }
}
