# @framesieve/adapters

Capture sources (browser, electron, node) plus the recorder and the
pure replay function for [framesieve](https://github.com/Jncch/framesieve).
The gate itself never touches a clock or the filesystem; everything
environment-specific lives here.

```bash
npm install framesieve @framesieve/adapters
```

Three entry points, one per environment. Each ships ESM and CommonJS.

## Feeding still images

If you already hold decoded pixels, wrap them as a `FrameInput` and
push. The core `frameFromImageData` covers a raw `ImageData`; these
adapters add the source-specific decoders.

```ts
// browser: an ImageBitmap or an image URL (data:, blob:, http)
import { frameFromBitmap, frameFromDataUrl } from "@framesieve/adapters/browser";
gate.push(frameFromBitmap(bitmap, elapsedMs));
gate.push(await frameFromDataUrl(pngDataUrl, elapsedMs));

// node: a PNG buffer (file read, screenshot lib, nativeImage.toPNG())
import { frameFromPngBuffer } from "@framesieve/adapters/node";
gate.push(frameFromPngBuffer(pngBuffer, elapsedMs));

// electron main: a desktopCapturer thumbnail / nativeImage (BGRA -> RGBA)
import { frameFromNativeImage } from "@framesieve/adapters/electron";
const [src] = await desktopCapturer.getSources({
  types: ["screen"],
  thumbnailSize: { width: 1920, height: 1080 },
});
gate.push(frameFromNativeImage(src.thumbnail, elapsedMs));
```

`frameFromNativeImage` and the electron entry pull no node builtins, so
the entry is safe to load in a renderer too; the node entry (recorder,
PNG codec) is main-process/node only.

## Streaming capture

```ts
import { captureDisplay } from "@framesieve/adapters/browser";
const source = await captureDisplay(); // prompts for a screen share
setInterval(async () => gate.push(await source.grab()), 500);
```

For Electron, `desktopSourceConstraints(sourceId)` builds the
getUserMedia constraints for a chosen desktopCapturer source; wrap the
resulting stream with `createElectronSource`.

## Record and replay

The recorder taps a gate and writes frames plus the decision timeline
to a directory; `replay` re-runs a recording through a fresh gate as a
pure function of (recording, options). This is what `fsieve replay`
and `--sweep` are built on.

```ts
import { createRecorder, replay } from "@framesieve/adapters/node";
```

See the main repository README for the tuning workflow.
