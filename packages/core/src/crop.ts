import type { BlockChange, Crop, FrameInput } from "./types.ts";

/**
 * Crops are bounding boxes of 4-connected components of changed
 * blocks, mapped back to source pixels and padded. Component order is
 * deterministic: first-seen block in row-major order.
 */
export function computeCrops(
  frame: FrameInput,
  changedBlocks: BlockChange[],
  cols: number,
  rows: number,
  paddingPx: number,
): Crop[] {
  if (changedBlocks.length === 0) return [];
  const occupied = new Set<number>();
  for (const b of changedBlocks) occupied.add(b.row * cols + b.col);
  const visited = new Set<number>();
  const crops: Crop[] = [];
  for (const b of changedBlocks) {
    const start = b.row * cols + b.col;
    if (visited.has(start)) continue;
    // BFS over the 4-neighborhood.
    let minCol = b.col;
    let maxCol = b.col;
    let minRow = b.row;
    let maxRow = b.row;
    const queue = [start];
    visited.add(start);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const col = cur % cols;
      const row = (cur - col) / cols;
      if (col < minCol) minCol = col;
      if (col > maxCol) maxCol = col;
      if (row < minRow) minRow = row;
      if (row > maxRow) maxRow = row;
      const neighbors = [
        col > 0 ? cur - 1 : -1,
        col < cols - 1 ? cur + 1 : -1,
        row > 0 ? cur - cols : -1,
        row < rows - 1 ? cur + cols : -1,
      ];
      for (const n of neighbors) {
        if (n >= 0 && occupied.has(n) && !visited.has(n)) {
          visited.add(n);
          queue.push(n);
        }
      }
    }
    const x0 = Math.max(0, Math.floor((minCol * frame.width) / cols) - paddingPx);
    const x1 = Math.min(
      frame.width,
      Math.floor(((maxCol + 1) * frame.width) / cols) + paddingPx,
    );
    const y0 = Math.max(0, Math.floor((minRow * frame.height) / rows) - paddingPx);
    const y1 = Math.min(
      frame.height,
      Math.floor(((maxRow + 1) * frame.height) / rows) + paddingPx,
    );
    const w = x1 - x0;
    const h = y1 - y0;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      const src = ((y0 + y) * frame.width + x0) * 4;
      data.set(frame.data.subarray(src, src + w * 4), y * w * 4);
    }
    crops.push({ region: { x: x0, y: y0, width: w, height: h }, data, width: w, height: h });
  }
  return crops;
}
