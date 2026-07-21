import { digitsOf, type PatternDef } from "../index.ts";

/**
 * Japan-specific PII patterns for @framesieve/redact. Opt in by
 * spreading jpPatterns (or picking individual detectors) into
 * createRedactor's `patterns`. These live here, not in the core
 * module, so redact itself stays locale-neutral and does not bake in
 * one country's formats.
 *
 * Like all pattern/dictionary masking these are best-effort and depend
 * on OCR reading the text first; region masks remain the only
 * guaranteed mechanism.
 */

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

export const phoneJp: PatternDef = {
  name: "phone-jp",
  test: (text) => PHONE_JP_RE.test(text) && digitsOf(text).length >= 10,
};

export const myNumber: PatternDef = {
  name: "my-number",
  test: (text) => /^[\d\s-]+$/.test(text) && myNumberValid(digitsOf(text)),
};

export const addressJp: PatternDef = {
  name: "address-jp",
  test: (text) => ADDRESS_JP_RE.test(text),
};

/** All JP presets, ready to spread into createRedactor({ patterns }). */
export const jpPatterns: PatternDef[] = [phoneJp, myNumber, addressJp];
