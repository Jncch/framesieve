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

/**
 * A locale-neutral built-in pattern name. Locale-specific detectors
 * (Japanese phone/My Number/address, etc.) are not baked in here; they
 * ship as opt-in presets, e.g. jpPatterns from
 * "@framesieve/redact/presets/jp", which you spread into `patterns`.
 */
export type BuiltinPatternName = "email" | "credit-card";

/** A caller-supplied pattern: a name plus a test over one OCR word. */
export interface PatternDef {
  name: string;
  test: (text: string) => boolean;
}

/** A built-in name or a custom detector. */
export type PatternInput = BuiltinPatternName | PatternDef;

export interface RedactorOptions {
  /** Always-on masks in source pixels. Deterministic; cannot miss. */
  regions?: Region[];
  /**
   * Text patterns to mask (requires ocr). Mix built-in names, opt-in
   * presets (spread jpPatterns), and your own { name, test } detectors.
   */
  patterns?: PatternInput[];
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

/** Strip non-digits; shared by digit-based detectors (also used by presets). */
export function digitsOf(text: string): string {
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

function looksLikeCreditCard(text: string): boolean {
  if (!/^[\d\s-]+$/.test(text)) return false;
  const digits = digitsOf(text);
  return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
}

/** Locale-neutral built-in detectors, resolved by name. */
const BUILTINS: Record<string, (text: string) => boolean> = {
  email: (text) => EMAIL_RE.test(text),
  "credit-card": looksLikeCreditCard,
};

function resolvePattern(p: PatternInput): PatternDef {
  if (typeof p === "string") {
    const test = BUILTINS[p];
    if (test === undefined) throw new RangeError(`unknown pattern: ${String(p)}`);
    return { name: p, test };
  }
  if (typeof p?.name !== "string" || typeof p?.test !== "function") {
    throw new TypeError(
      "a custom pattern must be { name: string, test: (text) => boolean }",
    );
  }
  return p;
}

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
  const patterns = (options.patterns ?? []).map(resolvePattern);
  const dictionary = (options.dictionary ?? []).map(normalize);
  const ocr = options.ocr ?? null;
  const failClosed = options.failClosed ?? false;
  const pad = options.maskPaddingPx ?? 2;

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
          patterns.some((p) => p.test(word.text)) ||
          dictionary.some((entry) => normalize(word.text).includes(entry));
        if (hit) {
          fillRegion(data, frame.width, frame.height, word.region, pad);
        }
      }
      return masked;
    })();
  };
}
