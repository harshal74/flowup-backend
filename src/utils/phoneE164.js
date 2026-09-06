/**
 * FlowUp Phone Normalization — E.164 (international) canonical form.
 *
 * Purpose (Phase 1 additive foundation):
 *   Provide a reusable, GLOBALLY-EXTENSIBLE phone normalizer for the future
 *   Meta WhatsApp integration. Meta Cloud API expects recipient numbers in
 *   E.164 (e.g. "+919876543210", "+14155551234", "+447911123456").
 *
 *   This utility is intentionally NOT India-only. It does not assume 10 digits,
 *   does not assume a leading 6/7/8/9, and does not hard-code +91 as the only
 *   country. The existing India validator (utils/validateMobile.js) is left
 *   untouched and remains the India-specific INPUT rule for customer mobiles;
 *   this utility is the country-agnostic CANONICAL form for WhatsApp.
 *
 * Scope note:
 *   No phone library (libphonenumber) is installed and Phase 1 forbids adding
 *   dependencies. This implementation validates the E.164 STRUCTURE per the
 *   ITU standard (a '+' followed by up to 15 digits, first digit non-zero) and
 *   applies a country calling code only when given explicit country context.
 *   It can later be swapped for libphonenumber WITHOUT changing this interface.
 *
 * E.164 rules enforced:
 *   • Total digits after '+' : 1..15 (ITU maximum is 15).
 *   • The number must not start with 0 after the '+'.
 *   • Only digits (input separators/spaces/dashes/parentheses are stripped).
 *
 * Behavior summary:
 *   normalizeE164("+14155551234")            -> "+14155551234"   (already E.164)
 *   normalizeE164("+91 98765 43210")         -> "+919876543210"  (separators stripped)
 *   normalizeE164("9876543210", "IN")        -> "+919876543210"  (national + country ctx)
 *   normalizeE164("07911 123456", "GB")      -> "+447911123456"  (national trunk 0 dropped)
 *   normalizeE164("9876543210")              -> null             (ambiguous: no country ctx)
 *   normalizeE164("+1041...")                -> null             (invalid: leading 0)
 */

// Minimal ISO-3166 alpha-2 → country calling code map for launch + near-term
// expansion markets. This is a convenience for national-number input; any
// number already in '+<cc>...' form is accepted generically regardless of
// whether its country appears here. Extend as new markets are onboarded.
const COUNTRY_DIAL_CODES = Object.freeze({
  IN: "91",   // India
  US: "1",    // United States
  CA: "1",    // Canada
  GB: "44",   // United Kingdom
  AE: "971",  // United Arab Emirates
  AU: "61",   // Australia
  SG: "65",   // Singapore
  DE: "49",   // Germany
  FR: "33",   // France
  SA: "966",  // Saudi Arabia
});

const MAX_E164_DIGITS = 15; // ITU-T E.164 maximum
const MIN_E164_DIGITS = 8;  // practical minimum for a routable subscriber number

/**
 * Return only the digit characters of a string.
 * @param {string} value
 * @returns {string}
 */
function digitsOnly(value) {
  return value.replace(/\D/g, "");
}

/**
 * Validate that a string is a structurally valid E.164 number.
 * Does NOT guarantee the number is assigned/reachable — only ITU structure.
 *
 * @param {string} value e.g. "+919876543210"
 * @returns {boolean}
 */
function isValidE164(value) {
  if (typeof value !== "string") return false;
  // '+' then a non-zero leading digit then up to 14 more digits (total 1..15).
  if (!/^\+[1-9]\d{0,14}$/.test(value)) return false;
  const digits = value.slice(1);
  return digits.length >= MIN_E164_DIGITS && digits.length <= MAX_E164_DIGITS;
}

/**
 * Normalize an input phone number to canonical E.164.
 *
 * @param {string} input        raw phone (may contain spaces/dashes/parentheses,
 *                               may or may not have a leading '+')
 * @param {string} [countryCtx] optional ISO alpha-2 country (e.g. "IN", "US")
 *                               used ONLY when `input` is a national number
 *                               without a '+' country code.
 * @returns {string|null} "+<digits>" on success, or null if it cannot be
 *                        safely resolved to a valid E.164 number.
 */
function normalizeE164(input, countryCtx) {
  if (!input || typeof input !== "string") return null;

  const trimmed = input.trim();

  // ── Case 1: already in international '+' form ──────────────────
  if (trimmed.startsWith("+")) {
    const candidate = "+" + digitsOnly(trimmed);
    return isValidE164(candidate) ? candidate : null;
  }

  // ── Case 2: raw digits, possibly with a country context ────────
  let digits = digitsOnly(trimmed);
  if (!digits) return null;

  if (countryCtx) {
    const cc = COUNTRY_DIAL_CODES[String(countryCtx).toUpperCase()];
    if (!cc) return null; // unknown country context — refuse to guess

    // Drop a single national trunk prefix '0' if present (common in GB/AU/etc.)
    if (digits.startsWith("0")) {
      digits = digits.replace(/^0+/, "");
    }

    // If the number already begins with the country calling code AND the total
    // length looks international, treat it as already-prefixed to avoid double
    // prefixing (e.g. "919876543210" with ctx "IN").
    let candidateDigits;
    if (digits.startsWith(cc) && digits.length > cc.length) {
      candidateDigits = digits;
    } else {
      candidateDigits = cc + digits;
    }

    const candidate = "+" + candidateDigits;
    return isValidE164(candidate) ? candidate : null;
  }

  // ── Case 3: raw digits WITHOUT country context ─────────────────
  // Ambiguous — we refuse to assume a country (NOT India-only). Caller must
  // supply country context for national numbers.
  return null;
}

/**
 * Whether the given ISO alpha-2 country is supported for national-number
 * normalization (i.e. present in COUNTRY_DIAL_CODES). Structural ISO alpha-2
 * validation ("^[A-Z]{2}$") plus known-dial-code membership. Does NOT throw.
 *
 * @param {string} countryCode e.g. "IN"
 * @returns {boolean}
 */
function isSupportedCountry(countryCode) {
  if (!countryCode || typeof countryCode !== "string") return false;
  const cc = countryCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return false;
  return Object.prototype.hasOwnProperty.call(COUNTRY_DIAL_CODES, cc);
}

module.exports = {
  normalizeE164,
  isValidE164,
  isSupportedCountry,
  COUNTRY_DIAL_CODES,
  MAX_E164_DIGITS,
  MIN_E164_DIGITS,
};
