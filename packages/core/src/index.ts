export { createFrameGate } from "./gate.ts";
export { frameFromImageData } from "./frame.ts";
export type { ImageDataLike } from "./frame.ts";
export { serializeDecision, parseDecisionLine } from "./serialize.ts";
export type {
  FrameInput,
  DiffAlgorithm,
  DiffMode,
  Region,
  DiffOptions,
  BlockOptions,
  AdaptiveMaskOptions,
  PolicyOptions,
  CropOptions,
  EmitTransform,
  FrameGateOptions,
  EmitReason,
  BlockChange,
  EmitMeta,
  Crop,
  EmitEvent,
  EmitErrorEvent,
  Decision,
  GateStats,
  FrameGate,
} from "./types.ts";
