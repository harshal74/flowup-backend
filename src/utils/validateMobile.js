/**
 * FlowUp Mobile Number Validation Utility
 *
 * Business rule: Indian 10-digit mobile numbers.
 *   - Mandatory format: exactly 10 digits after stripping all non-digit characters.
 *   - Accepts optional country code prefix: +91, 91 (12-digit string).
 *   - First digit of the 10-digit number must be 6, 7, 8, or 9 (valid Indian mobile range).
 *   - Rejects landlines, toll-free, and obviously invalid numbers.
 *
 * This is intentionally strict because FlowUp is an India-first product.
 * All user-facing mobile fields (customer, staff, admin) use this rule.
 * WhatsApp / contact numbers in restaurant settings are informational and
 * use a looser "non-empty" check rather than this validator.
 *
 * Usage:
 *   const { isValidMobile, normalizeMobile } = require("../utils/validateMobile");
 *   if (!isValidMobile(mobile)) return res.status(400).json({ ... });
 *   const stored = normalizeMobile(mobile); // "9876543210"
 */

const INDIAN_MOBILE_RE = /^[6-9]\d{9}$/;

/**
 * Strip everything that isn't a digit from the input,
 * remove a leading +91 or 91 country code,
 * and return the raw 10-digit string.
 * Returns null if the value cannot be reduced to 10 digits.
 */
function stripMobile(value) {
  if (!value || typeof value !== "string") return null;
  let digits = value.trim().replace(/\D/g, "");

  // Strip +91 / 91 prefix if the result would be 12 digits
  if (digits.length === 12 && digits.startsWith("91")) {
    digits = digits.slice(2);
  }
  // Strip leading 0 (some users enter 0XXXXXXXXXX)
  if (digits.length === 11 && digits.startsWith("0")) {
    digits = digits.slice(1);
  }

  return digits.length === 10 ? digits : null;
}

/**
 * Validate a mobile number string.
 * Returns true if it is a valid Indian 10-digit mobile number.
 * Accepts common input formats:
 *   "9876543210", "+919876543210", "91 9876 543 210", "09876543210"
 */
function isValidMobile(value) {
  const digits = stripMobile(value);
  if (!digits) return false;
  return INDIAN_MOBILE_RE.test(digits);
}

/**
 * Return the canonical 10-digit form of a mobile number.
 * Throws if the value is invalid — always validate first with isValidMobile.
 */
function normalizeMobile(value) {
  const digits = stripMobile(value);
  if (!digits || !INDIAN_MOBILE_RE.test(digits)) {
    throw new Error(`Cannot normalize invalid mobile: ${value}`);
  }
  return digits;
}

/** Standard 400-response message */
const MOBILE_ERROR_MESSAGE =
  "Please enter a valid 10-digit Indian mobile number (e.g. 9876543210).";

module.exports = { isValidMobile, normalizeMobile, MOBILE_ERROR_MESSAGE };
