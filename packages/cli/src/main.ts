#!/usr/bin/env node
import { parseArgs } from "node:util";

import { serializeDecision } from "framesieve";
import type { Decision, FrameGateOptions, GateStats } from "framesieve";
import { replay } from "@framesieve/adapters/node";

/**
 * fsieve - replay recordings and sweep gate parameters offline.
 *
 * Replays are pure functions of (recording, options); every line this
 * tool prints is deterministic, so its output can be diffed across
 * runs and machines.
 */

const USAGE = `Usage: fsieve replay <recording-dir> [options]

Options:
  --json                     print one Decision JSON line per frame
  --sweep <param=a:b:step>   replay once per value of <param>;
                             params: downsampleFactor, luminanceThreshold,
                             blockChangeRatio, minChangedBlocks, windowSize,
                             debounceMs, minIntervalMs, maxSilenceMs
  --algorithm <name>         diff algorithm: downsample | pixel | edge
  --downsample <n>           diff.downsampleFactor
  --luminance <n>            diff.luminanceThreshold
  --grid <cols>x<rows>       blocks grid, e.g. 16x9
  --block-ratio <f>          blocks.blockChangeRatio (0-1)
  --min-blocks <n>           blocks.minChangedBlocks
  --no-adaptive              disable the adaptive frequency mask
  --adaptive-window <n>      adaptiveMask.windowSize
  --debounce <ms>            policy.debounceMs
  --min-interval <ms>        policy.minIntervalMs
  --max-silence <ms>         policy.maxSilenceMs
  -h, --help                 show this help
`;

type SweepParam =
  | "downsampleFactor"
  | "luminanceThreshold"
  | "blockChangeRatio"
  | "minChangedBlocks"
  | "windowSize"
  | "debounceMs"
  | "minIntervalMs"
  | "maxSilenceMs";

const SWEEP_PARAMS: readonly SweepParam[] = [
  "downsampleFactor",
  "luminanceThreshold",
  "blockChangeRatio",
  "minChangedBlocks",
  "windowSize",
  "debounceMs",
  "minIntervalMs",
  "maxSilenceMs",
];

class UsageError extends Error {}

function parseNumber(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new UsageError(`${name} expects a number, got "${value}"`);
  }
  return n;
}

function withParam(
  options: FrameGateOptions,
  param: SweepParam,
  value: number,
): FrameGateOptions {
  switch (param) {
    case "downsampleFactor":
    case "luminanceThreshold":
      return { ...options, diff: { ...options.diff, [param]: value } };
    case "blockChangeRatio":
    case "minChangedBlocks":
      return { ...options, blocks: { ...options.blocks, [param]: value } };
    case "windowSize":
      return {
        ...options,
        adaptiveMask: { ...options.adaptiveMask, windowSize: value },
      };
    case "debounceMs":
    case "minIntervalMs":
    case "maxSilenceMs":
      return { ...options, policy: { ...options.policy, [param]: value } };
  }
}

interface SweepSpec {
  param: SweepParam;
  values: number[];
}

function parseSweep(spec: string): SweepSpec {
  const eq = spec.indexOf("=");
  if (eq < 0) throw new UsageError(`--sweep expects param=start:end:step`);
  const param = spec.slice(0, eq);
  if (!(SWEEP_PARAMS as readonly string[]).includes(param)) {
    throw new UsageError(
      `unknown sweep param "${param}"; expected one of ${SWEEP_PARAMS.join(", ")}`,
    );
  }
  const parts = spec.slice(eq + 1).split(":");
  if (parts.length !== 3) {
    throw new UsageError(`--sweep expects param=start:end:step`);
  }
  const [start, end, step] = parts.map((p) => parseNumber("--sweep", p)) as [
    number,
    number,
    number,
  ];
  if (step <= 0 || end < start) {
    throw new UsageError(`--sweep needs step > 0 and end >= start`);
  }
  const values: number[] = [];
  const count = Math.floor((end - start) / step + 1e-9) + 1;
  for (let i = 0; i < count; i++) {
    values.push(Number((start + i * step).toFixed(9)));
  }
  return { param: param as SweepParam, values };
}

function formatValue(v: number): string {
  return String(Number(v.toFixed(6)));
}

function buildOptions(values: Record<string, unknown>): FrameGateOptions {
  let options: FrameGateOptions = {};
  const str = (k: string): string | undefined =>
    typeof values[k] === "string" ? (values[k] as string) : undefined;

  const algorithm = str("algorithm");
  if (algorithm !== undefined) {
    if (
      algorithm !== "downsample" &&
      algorithm !== "pixel" &&
      algorithm !== "edge"
    ) {
      throw new UsageError(`--algorithm expects downsample, pixel, or edge`);
    }
    options = { ...options, diff: { ...options.diff, algorithm } };
  }
  const num = (flag: string, param: SweepParam): void => {
    const v = str(flag);
    if (v !== undefined) options = withParam(options, param, parseNumber(`--${flag}`, v));
  };
  num("downsample", "downsampleFactor");
  num("luminance", "luminanceThreshold");
  num("block-ratio", "blockChangeRatio");
  num("min-blocks", "minChangedBlocks");
  num("adaptive-window", "windowSize");
  num("debounce", "debounceMs");
  num("min-interval", "minIntervalMs");
  num("max-silence", "maxSilenceMs");

  const grid = str("grid");
  if (grid !== undefined) {
    const m = /^(\d+)x(\d+)$/.exec(grid);
    if (m === null) throw new UsageError(`--grid expects <cols>x<rows>, e.g. 16x9`);
    options = {
      ...options,
      blocks: {
        ...options.blocks,
        gridCols: Number(m[1]),
        gridRows: Number(m[2]),
      },
    };
  }
  if (values["no-adaptive"] === true) {
    options = { ...options, adaptiveMask: { ...options.adaptiveMask, enabled: false } };
  }
  return options;
}

function printSummary(
  dir: string,
  decisions: Decision[],
  stats: GateStats,
): void {
  const counts = { emit: 0, skip: 0, debounced: 0, throttled: 0 };
  for (const d of decisions) counts[d.decision] += 1;
  console.log(`recording: ${dir}`);
  console.log(`frames:    ${stats.framesSeen}`);
  console.log(
    `emits:     ${stats.framesEmitted} (ratio ${stats.emitRatio.toFixed(6)})`,
  );
  console.log(
    `decisions: skip ${counts.skip}, debounced ${counts.debounced}, throttled ${counts.throttled}`,
  );
  if (stats.framesEmitted > 0) {
    console.log("");
    console.log("  seq  elapsedMs  reason     score");
    for (const d of decisions) {
      if (d.decision !== "emit") continue;
      const seq = String(d.seq).padStart(5);
      const elapsed = String(d.elapsedMs).padStart(9);
      const reason = (d.reason ?? "").padEnd(9);
      console.log(`${seq}  ${elapsed}  ${reason}  ${d.score.toFixed(6)}`);
    }
  }
}

export async function run(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        json: { type: "boolean" },
        sweep: { type: "string" },
        algorithm: { type: "string" },
        downsample: { type: "string" },
        luminance: { type: "string" },
        grid: { type: "string" },
        "block-ratio": { type: "string" },
        "min-blocks": { type: "string" },
        "no-adaptive": { type: "boolean" },
        "adaptive-window": { type: "string" },
        debounce: { type: "string" },
        "min-interval": { type: "string" },
        "max-silence": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    console.error((e as Error).message);
    console.error(USAGE);
    return 1;
  }
  const { values, positionals } = parsed;
  if (values["help"] === true) {
    console.log(USAGE);
    return 0;
  }
  const [command, dir] = positionals;
  if (command !== "replay" || dir === undefined) {
    console.error(USAGE);
    return 1;
  }
  try {
    const options = buildOptions(values);
    const sweepSpec = typeof values["sweep"] === "string"
      ? parseSweep(values["sweep"])
      : null;
    if (sweepSpec !== null) {
      console.log(`sweep ${sweepSpec.param} on ${dir}`);
      console.log("");
      console.log(`  ${sweepSpec.param.padEnd(20)} emits  ratio`);
      for (const value of sweepSpec.values) {
        const result = await replay(dir, withParam(options, sweepSpec.param, value));
        console.log(
          `  ${formatValue(value).padEnd(20)} ${String(result.stats.framesEmitted).padEnd(6)} ${result.stats.emitRatio.toFixed(6)}`,
        );
      }
      return 0;
    }
    const { decisions, stats } = await replay(dir, options);
    if (values["json"] === true) {
      for (const d of decisions) console.log(serializeDecision(d));
    } else {
      printSummary(dir, decisions, stats);
    }
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(e.message);
      console.error(USAGE);
    } else {
      console.error(`fsieve: ${(e as Error).message}`);
    }
    return 1;
  }
}

process.exitCode = await run(process.argv.slice(2));
