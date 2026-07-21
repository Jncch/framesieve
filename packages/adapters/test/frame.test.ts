import { test } from "node:test";
import assert from "node:assert/strict";

import { encodePng, frameFromPngBuffer } from "../src/node/index.ts";

test("frameFromPngBuffer decodes an encoded PNG into a FrameInput", () => {
  const width = 3;
  const height = 2;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = (i * 37) % 256;
    data[i * 4 + 1] = (255 - i * 20) % 256;
    data[i * 4 + 2] = i * 8;
    data[i * 4 + 3] = 255;
  }
  const png = encodePng({ data, width, height });
  const frame = frameFromPngBuffer(png, 1234);
  assert.equal(frame.width, width);
  assert.equal(frame.height, height);
  assert.equal(frame.elapsedMs, 1234);
  assert.ok(frame.data instanceof Uint8ClampedArray);
  assert.deepEqual(Array.from(frame.data), Array.from(data));
});
