import { frameFromImageData, type FrameInput } from "framesieve";
import { decodePng } from "./png.ts";

/**
 * Decode a PNG buffer into a FrameInput. Covers the common node paths:
 * a file read, a screenshot library's PNG output, or an Electron
 * nativeImage.toPNG() from the main process. A node Buffer is a
 * Uint8Array, so either works.
 */
export function frameFromPngBuffer(
  png: Uint8Array,
  elapsedMs: number,
): FrameInput {
  const { data, width, height } = decodePng(png);
  return frameFromImageData({ data, width, height }, elapsedMs);
}
