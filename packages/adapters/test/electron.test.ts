import { test } from "node:test";
import assert from "node:assert/strict";

import { desktopSourceConstraints } from "../src/electron/index.ts";

test("desktopSourceConstraints wires the source id into chromeMediaSource", () => {
  const constraints = desktopSourceConstraints("screen:1:0", {
    maxWidth: 1280,
    maxHeight: 720,
  });
  assert.equal(constraints.audio, false);
  const video = constraints.video as unknown as {
    mandatory: Record<string, unknown>;
  };
  assert.deepEqual(video.mandatory, {
    chromeMediaSource: "desktop",
    chromeMediaSourceId: "screen:1:0",
    maxWidth: 1280,
    maxHeight: 720,
    maxFrameRate: 5,
  });
});
