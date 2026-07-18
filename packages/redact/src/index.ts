import type {
  EmitMeta,
  EmitTransform,
  FrameInput,
  Region,
} from "framesieve";

/**
 * @framesieve/redact - local PII masking transform.
 *
 * Two very different guarantees live here; do not conflate them:
 * - Region masks are pure pixel math. They are deterministic and
 *   cannot miss. Use them for anything that must never leave the
 *   machine.
 * - Pattern and dictionary masks depend on an OCR engine reading the
 *   text first. Frontier VLMs read text better than any local OCR
 *   engine, so a detection miss is possible by construction. Treat
 *   text-based masking as best-effort defense in depth, never as a
 *   guarantee.
 */

/** One recognized word and where it sits, in source pixels. */
export interface OcrWord {
  text: string;
  region: Region;
}

/**
 * Pluggable OCR engine. Engines are adapters, never hard
 * dependencies: @framesieve/redact/tesseract wraps tesseract.js if
 * you install it, or bring your own (platform vision APIs, etc.).
 */
export interface OcrEngine {
  recognize(frame: FrameInput): Promise<OcrWord[]> | OcrWord[];
}

export type BuiltinPattern =
  | "email"
  | "phone-jp"
  | "credit-card"
  | "my-number"
  | "address-jp";

export interface RedactorOptions {
  /** Always-on masks in source pixels. Deterministic; cannot miss. */
  regions?: Region[];
  /** Built-in text patterns to mask (requires ocr). */
  patterns?: BuiltinPattern[];
  /**
   * Literal strings to mask wherever OCR reads them (requires ocr).
   * Matching is case-insensitive after Unicode NFKC normalization, so
   * full-width forms match their ASCII equivalents.
   */
  dictionary?: string[];
  ocr?: OcrEngine;
  /**
   * When true and OCR fails while patterns or dictionary are
   * configured, cancel the emit entirely (the transform returns
   * null). Default: false - region masks still apply and the frame
   * goes out without text masking.
   */
  failClosed?: boolean;
  /** Padding in pixels around each masked word box. Default: 2. */
  maskPaddingPx?: number;
}

// ---------------------------------------------------------------------------
// Pattern detectors (best-effort by design)
// ---------------------------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

// Domestic 0X... numbers with optional separators, or +81 form.
const PHONE_JP_RE =
  /(?:\+81[-\s]?\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}|0\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4})/;

// Postal code (with or without the JIS postal mark) or
// prefecture + municipality kanji sequences. Escapes keep the source
// ASCII-only.
const ADDRESS_JP_RE = new RegExp(
  [
    "\\u3012\\s?\\d{3}-?\\d{4}", // postal mark + code
    "(?<!\\d)\\d{3}-\\d{4}(?!\\d)", // bare postal code (over-masks by intent)
    // prefecture (to/dou/fu/ken) followed by municipality (shi/ku/gun/chou/son)
    "[\\u3040-\\u30FF\\u4E00-\\u9FAF]{1,6}[\\u90FD\\u9053\\u5E9C\\u770C]" +
      "[\\u3040-\\u30FF\\u4E00-\\u9FAF]{1,8}[\\u5E02\\u533A\\u90E1\\u753A\\u6751]",
  ].join("|"),
);

function digitsOf(text: string): string {
  return text.replace(/\D/g, "");
}

/** Luhn checksum; keeps credit-card matching from firing on any long number. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Check-digit validation for the 12-digit Japanese My Number. */
export function myNumberValid(digits: string): boolean {
  if (!/^\d{12}$/.test(digits)) return false;
  const body = digits.slice(0, 11);
  const check = digits.charCodeAt(11) - 48;
  let sum = 0;
  for (let n = 1; n <= 11; n++) {
    const p = body.charCodeAt(11 - n) - 48;
    const q = n <= 6 ? n + 1 : n - 5;
    sum += p * q;
  }
  const remainder = sum % 11;
  const expected = remainder <= 1 ? 0 : 11 - remainder;
  return check === expected;
}

function looksLikeCreditCard(text: string): boolean {
  if (!/^[\d\s-]+$/.test(text)) return false;
  const digits = digitsOf(text);
  return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
}

function looksLikeMyNumber(text: string): boolean {
  if (!/^[\d\s-]+$/.test(text)) return false;
  return myNumberValid(digitsOf(text));
}

function matchesPattern(pattern: BuiltinPattern, text: string): boolean {
  switch (pattern) {
    case "email":
      return EMAIL_RE.test(text);
    case "phone-jp":
      return PHONE_JP_RE.test(text) && digitsOf(text).length >= 10;
    case "credit-card":
      return looksLikeCreditCard(text);
    case "my-number":
      return looksLikeMyNumber(text);
    case "address-jp":
      return ADDRESS_JP_RE.test(text);
  }
}

const BUILTIN_PATTERNS: readonly BuiltinPattern[] = [
  "email",
  "phone-jp",
  "credit-card",
  "my-number",
  "address-jp",
];

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

function fillRegion(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  region: Region,
  pad: number,
): void {
  const x0 = Math.max(0, region.x - pad);
  const y0 = Math.max(0, region.y - pad);
  const x1 = Math.min(width, region.x + region.width + pad);
  const y1 = Math.min(height, region.y + region.height + pad);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * width + x) * 4;
      data[p] = 0;
      data[p + 1] = 0;
      data[p + 2] = 0;
      data[p + 3] = 255;
    }
  }
}

function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/**
 * Build the masking transform. Plug the result into
 * createFrameGate({ transform }).
 */
export function createRedactor(options: RedactorOptions = {}): EmitTransform {
  const regions = options.regions ?? [];
  const patterns = options.patterns ?? [];
  const dictionary = (options.dictionary ?? []).map(normalize);
  const ocr = options.ocr ?? null;
  const failClosed = options.failClosed ?? false;
  const pad = options.maskPaddingPx ?? 2;

  for (const p of patterns) {
    if (!BUILTIN_PATTERNS.includes(p)) {
      throw new RangeError(`unknown pattern: ${String(p)}`);
    }
  }
  const needsOcr = patterns.length > 0 || dictionary.length > 0;
  if (needsOcr && ocr === null) {
    throw new TypeError(
      "patterns/dictionary need an OCR engine; pass RedactorOptions.ocr",
    );
  }

  return (frame: FrameInput, _meta: EmitMeta) => {
    const data = new Uint8ClampedArray(frame.data);
    for (const region of regions) {
      fillRegion(data, frame.width, frame.height, region, 0);
    }
    const masked: FrameInput = { ...frame, data };
    if (!needsOcr || ocr === null) return masked;

    // OCR runs on the region-masked frame: text under a region mask
    // is already gone and cannot re-trigger detection.
    return (async () => {
      let words: OcrWord[];
      try {
        words = await ocr.recognize(masked);
      } catch {
        return failClosed ? null : masked;
      }
      for (const word of words) {
        const hit =
          patterns.some((p) => matchesPattern(p, word.text)) ||
          dictionary.some((entry) => normalize(word.text).includes(entry));
        if (hit) {
          fillRegion(data, frame.width, frame.height, word.region, pad);
        }
      }
      return masked;
    })();
  };
}
