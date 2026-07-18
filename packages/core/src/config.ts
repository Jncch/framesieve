import type {
  AdaptiveMaskOptions,
  BlockOptions,
  CropOptions,
  DiffAlgorithm,
  DiffOptions,
  EmitTransform,
  FrameGateOptions,
  PolicyOptions,
  Region,
} from "./types.ts";

export interface ResolvedOptions {
  diff: Required<DiffOptions>;
  blocks: Required<BlockOptions>;
  adaptiveMask: Required<AdaptiveMaskOptions>;
  policy: Required<Omit<PolicyOptions, "ignoreRegions">> & {
    ignoreRegions: Region[];
  };
  crop: Required<CropOptions>;
  transform: EmitTransform | null;
}

const DIFF_ALGORITHMS: readonly DiffAlgorithm[] = ["downsample", "pixel"];

function checkInt(name: string, value: number, min: number): number {
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(`${name} must be an integer >= ${min}, got ${value}`);
  }
  return value;
}

function checkNumber(
  name: string,
  value: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(
      `${name} must be a finite number in [${min}, ${max}], got ${value}`,
    );
  }
  return value;
}

function checkRegion(name: string, r: Region): Region {
  checkInt(`${name}.x`, r.x, 0);
  checkInt(`${name}.y`, r.y, 0);
  checkInt(`${name}.width`, r.width, 1);
  checkInt(`${name}.height`, r.height, 1);
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

export function resolveOptions(options: FrameGateOptions = {}): ResolvedOptions {
  const algorithm = options.diff?.algorithm ?? "downsample";
  if (!DIFF_ALGORITHMS.includes(algorithm)) {
    throw new RangeError(`unknown diff algorithm: ${String(algorithm)}`);
  }
  return {
    diff: {
      algorithm,
      downsampleFactor: checkInt(
        "diff.downsampleFactor",
        options.diff?.downsampleFactor ?? 8,
        1,
      ),
      luminanceThreshold: checkNumber(
        "diff.luminanceThreshold",
        options.diff?.luminanceThreshold ?? 10,
        0,
        255,
      ),
    },
    blocks: {
      gridCols: checkInt("blocks.gridCols", options.blocks?.gridCols ?? 16, 1),
      gridRows: checkInt("blocks.gridRows", options.blocks?.gridRows ?? 9, 1),
      blockChangeRatio: checkNumber(
        "blocks.blockChangeRatio",
        options.blocks?.blockChangeRatio ?? 0.2,
        0,
        1,
      ),
      minChangedBlocks: checkNumber(
        "blocks.minChangedBlocks",
        options.blocks?.minChangedBlocks ?? 3,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
    },
    adaptiveMask: {
      enabled: options.adaptiveMask?.enabled ?? true,
      windowSize: checkInt(
        "adaptiveMask.windowSize",
        options.adaptiveMask?.windowSize ?? 20,
        1,
      ),
    },
    policy: {
      debounceMs: checkNumber(
        "policy.debounceMs",
        options.policy?.debounceMs ?? 800,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      minIntervalMs: checkNumber(
        "policy.minIntervalMs",
        options.policy?.minIntervalMs ?? 2000,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      maxSilenceMs: checkNumber(
        "policy.maxSilenceMs",
        options.policy?.maxSilenceMs ?? 60000,
        0,
        Number.MAX_SAFE_INTEGER,
      ),
      ignoreRegions: (options.policy?.ignoreRegions ?? []).map((r, i) =>
        checkRegion(`policy.ignoreRegions[${i}]`, r),
      ),
    },
    crop: {
      enabled: options.crop?.enabled ?? false,
      paddingPx: checkInt("crop.paddingPx", options.crop?.paddingPx ?? 16, 0),
    },
    transform: options.transform ?? null,
  };
}
