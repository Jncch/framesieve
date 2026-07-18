import { test } from "node:test";
import assert from "node:assert/strict";

import { createFrameGate } from "framesieve";
import type { EmitEvent, EmitMeta, FrameInput, Region } from "framesieve";

import {
  createRedactor,
  luhnValid,
  myNumberValid,
  type OcrEngine,
  type OcrWord,
} from "../src/index.ts";

function frame(width = 32, height = 32, level = 128): FrameInput {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < data.length; p += 4) {
    data[p] = level;
    data[p + 1] = level;
    data[p + 2] = level;
    data[p + 3] = 255;
  }
  return { data, width, height, elapsedMs: 0 };
}

const META: EmitMeta = {
  seq: 1,
  elapsedMs: 0,
  reason: "threshold",
  score: 3,
  changedBlocks: [],
};

function fakeOcr(words: OcrWord[]): OcrEngine {
  return { recognize: () => words };
}

function isBlack(f: FrameInput, x: number, y: number): boolean {
  const p = (y * f.width + x) * 4;
  return f.data[p] === 0 && f.data[p + 1] === 0 && f.data[p + 2] === 0;
}

async function apply(
  transform: ReturnType<typeof createRedactor>,
  f: FrameInput,
): Promise<FrameInput | null> {
  return transform(f, META);
}

test("region masks blacken exactly the configured region", async () => {
  const region: Region = { x: 4, y: 4, width: 8, height: 8 };
  const out = await apply(createRedactor({ regions: [region] }), frame());
  assert.ok(out !== null);
  assert.ok(isBlack(out, 4, 4));
  assert.ok(isBlack(out, 11, 11));
  assert.ok(!isBlack(out, 3, 4));
  assert.ok(!isBlack(out, 12, 11));
});

test("the input frame is never mutated", async () => {
  const f = frame();
  await apply(
    createRedactor({ regions: [{ x: 0, y: 0, width: 32, height: 32 }] }),
    f,
  );
  assert.equal(f.data[0], 128);
});

test("patterns or dictionary without an OCR engine fail fast", () => {
  assert.throws(() => createRedactor({ patterns: ["email"] }), TypeError);
  assert.throws(() => createRedactor({ dictionary: ["x"] }), TypeError);
  assert.throws(
    () =>
      createRedactor({
        patterns: ["nope" as unknown as "email"],
        ocr: fakeOcr([]),
      }),
    RangeError,
  );
});

test("email pattern masks the word box with padding", async () => {
  const words: OcrWord[] = [
    { text: "mail:", region: { x: 2, y: 2, width: 6, height: 4 } },
    { text: "taro@example.co.jp", region: { x: 10, y: 10, width: 12, height: 6 } },
  ];
  const out = await apply(
    createRedactor({ patterns: ["email"], ocr: fakeOcr(words), maskPaddingPx: 2 }),
    frame(),
  );
  assert.ok(out !== null);
  assert.ok(isBlack(out, 10, 10)); // inside the email box
  assert.ok(isBlack(out, 8, 8)); // padding
  assert.ok(!isBlack(out, 2, 2)); // "mail:" untouched
  assert.ok(!isBlack(out, 30, 30));
});

test("phone-jp matches domestic and +81 forms but not short numbers", async () => {
  const cases: Array<[string, boolean]> = [
    ["03-1234-5678", true],
    ["090 1234 5678", true],
    ["+81-90-1234-5678", true],
    ["1234-5678", false], // no leading 0, not a JP phone number
    ["extension 204", false],
  ];
  for (const [text, expected] of cases) {
    const out = await apply(
      createRedactor({
        patterns: ["phone-jp"],
        ocr: fakeOcr([{ text, region: { x: 0, y: 0, width: 4, height: 4 } }]),
      }),
      frame(),
    );
    assert.ok(out !== null);
    assert.equal(isBlack(out, 0, 0), expected, text);
  }
});

test("credit-card requires a Luhn-valid number", async () => {
  assert.ok(luhnValid("4111111111111111"));
  assert.ok(!luhnValid("4111111111111112"));
  const cases: Array<[string, boolean]> = [
    ["4111 1111 1111 1111", true],
    ["4111-1111-1111-1112", false], // fails Luhn
    ["1234567890123", false],
  ];
  for (const [text, expected] of cases) {
    const out = await apply(
      createRedactor({
        patterns: ["credit-card"],
        ocr: fakeOcr([{ text, region: { x: 0, y: 0, width: 4, height: 4 } }]),
      }),
      frame(),
    );
    assert.ok(out !== null);
    assert.equal(isBlack(out, 0, 0), expected, text);
  }
});

test("my-number requires the official check digit", async () => {
  // Build a valid number: body 12345678901 + computed check digit.
  const body = "12345678901";
  let sum = 0;
  for (let n = 1; n <= 11; n++) {
    const p = body.charCodeAt(11 - n) - 48;
    const q = n <= 6 ? n + 1 : n - 5;
    sum += p * q;
  }
  const remainder = sum % 11;
  const check = remainder <= 1 ? 0 : 11 - remainder;
  const valid = body + String(check);
  const invalid = body + String((check + 1) % 10);
  assert.ok(myNumberValid(valid));
  assert.ok(!myNumberValid(invalid));

  for (const [text, expected] of [
    [valid, true],
    [`${valid.slice(0, 4)} ${valid.slice(4, 8)} ${valid.slice(8)}`, true],
    [invalid, false],
  ] as Array<[string, boolean]>) {
    const out = await apply(
      createRedactor({
        patterns: ["my-number"],
        ocr: fakeOcr([{ text, region: { x: 0, y: 0, width: 4, height: 4 } }]),
      }),
      frame(),
    );
    assert.ok(out !== null);
    assert.equal(isBlack(out, 0, 0), expected, text);
  }
});

test("address-jp masks postal codes and prefecture-city sequences", async () => {
  const cases: Array<[string, boolean]> = [
    ["\u3012123-4567", true], // postal mark + code
    ["100-0001", true], // bare postal code (over-masks by intent)
    ["\u6771\u4EAC\u90FD\u5343\u4EE3\u7530\u533A", true], // Tokyo-to Chiyoda-ku
    ["hello world", false],
  ];
  for (const [text, expected] of cases) {
    const out = await apply(
      createRedactor({
        patterns: ["address-jp"],
        ocr: fakeOcr([{ text, region: { x: 0, y: 0, width: 4, height: 4 } }]),
      }),
      frame(),
    );
    assert.ok(out !== null);
    assert.equal(isBlack(out, 0, 0), expected, text);
  }
});

test("dictionary matching is case-insensitive and NFKC-normalized", async () => {
  const cases: Array<[string, boolean]> = [
    ["Tanaka Taro", true],
    ["TANAKA TARO", true],
    ["\uFF34\uFF41\uFF4E\uFF41\uFF4B\uFF41 \uFF34\uFF41\uFF52\uFF4F", true], // full-width
    ["Suzuki", false],
  ];
  for (const [text, expected] of cases) {
    const out = await apply(
      createRedactor({
        dictionary: ["tanaka taro"],
        ocr: fakeOcr([{ text, region: { x: 0, y: 0, width: 4, height: 4 } }]),
      }),
      frame(),
    );
    assert.ok(out !== null);
    assert.equal(isBlack(out, 0, 0), expected, text);
  }
});

test("OCR failure: fail-open keeps region masks, fail-closed cancels", async () => {
  const broken: OcrEngine = {
    recognize: () => Promise.reject(new Error("ocr died")),
  };
  const region: Region = { x: 0, y: 0, width: 4, height: 4 };
  const open = await apply(
    createRedactor({ regions: [region], patterns: ["email"], ocr: broken }),
    frame(),
  );
  assert.ok(open !== null);
  assert.ok(isBlack(open, 0, 0)); // region mask still applied
  const closed = await apply(
    createRedactor({
      regions: [region],
      patterns: ["email"],
      ocr: broken,
      failClosed: true,
    }),
    frame(),
  );
  assert.equal(closed, null);
});

test("redactor plugs into a real gate as its transform", async () => {
  const gate = createFrameGate({
    diff: { downsampleFactor: 8 },
    blocks: { gridCols: 4, gridRows: 4, minChangedBlocks: 1 },
    policy: { debounceMs: 0, minIntervalMs: 0, maxSilenceMs: 0 },
    transform: createRedactor({
      regions: [{ x: 0, y: 0, width: 16, height: 16 }],
    }),
  });
  const events: EmitEvent[] = [];
  gate.on("emit", (e) => events.push(e));
  gate.push(frame(64, 64, 200));
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(events.length, 1);
  const out = events[0]!.frame;
  assert.ok(isBlack(out, 0, 0));
  assert.ok(isBlack(out, 15, 15));
  assert.ok(!isBlack(out, 16, 16));
});
