/**
 * FlowUp Encryption Utility — AES-256-GCM authenticated encryption.
 *
 * Purpose (Phase 1 additive foundation):
 *   Provide reusable authenticated encryption for sensitive values that will
 *   later be persisted — specifically the per-restaurant Meta WhatsApp access
 *   token stored on the RestaurantWhatsApp model. NOTHING in this phase wires
 *   this utility into a controller or persists a token; it is a pure, tested
 *   building block for a future phase.
 *
 * Design rules (per Phase 1 scope):
 *   • AES-256-GCM (authenticated encryption — confidentiality + integrity).
 *   • A fresh random 12-byte IV/nonce is generated for EVERY encryption.
 *   • The 16-byte GCM auth tag is stored alongside the ciphertext and verified
 *     on decrypt; tampering causes decrypt() to throw.
 *   • The key is INJECTED by the caller (never read from process.env here, never
 *     hard-coded). This keeps key management in the future application layer.
 *   • The key must be exactly 32 bytes (AES-256). Accepts a Buffer, a 64-char
 *     hex string, or a 44-char base64 string — all resolving to 32 raw bytes.
 *     We do NOT silently hash an arbitrary secret into a key.
 *   • Serialized output is a single self-describing string:
 *         v1:<iv_b64>:<tag_b64>:<ciphertext_b64>
 *     The version prefix allows future algorithm changes without ambiguity.
 *   • No secrets, plaintext, or ciphertext are ever logged by this module.
 *
 * Usage (future application layer):
 *   const { encrypt, decrypt, resolveKey } = require("../utils/encrypt");
 *   const key = resolveKey(someInjectedSecret);      // 32-byte Buffer
 *   const stored = encrypt(token, key);              // safe to persist
 *   const token  = decrypt(stored, key);             // throws if tampered/wrong key
 */

const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32; // AES-256
const IV_BYTES  = 12; // GCM standard nonce length
const TAG_BYTES = 16; // GCM auth tag length
const VERSION   = "v1";

/**
 * Resolve an injected key into a validated 32-byte Buffer.
 * Accepts:
 *   • Buffer of length 32
 *   • hex string of length 64  (32 bytes)
 *   • base64 string decoding to exactly 32 bytes
 * Throws a clear error otherwise. Never hashes/derives silently.
 *
 * @param {Buffer|string} key
 * @returns {Buffer} 32-byte key
 */
function resolveKey(key) {
  if (Buffer.isBuffer(key)) {
    if (key.length !== KEY_BYTES) {
      throw new Error(`Encryption key must be ${KEY_BYTES} bytes; received Buffer of ${key.length} bytes.`);
    }
    return key;
  }

  if (typeof key === "string") {
    // Try hex first (64 hex chars = 32 bytes)
    if (/^[0-9a-fA-F]{64}$/.test(key)) {
      return Buffer.from(key, "hex");
    }
    // Then base64 that decodes to exactly 32 bytes
    try {
      const buf = Buffer.from(key, "base64");
      if (buf.length === KEY_BYTES) return buf;
    } catch {
      /* fall through to error */
    }
    throw new Error(
      `Encryption key string must be 64 hex chars or base64 decoding to ${KEY_BYTES} bytes.`
    );
  }

  throw new Error("Encryption key must be a 32-byte Buffer or an equivalent hex/base64 string.");
}

/**
 * Encrypt plaintext with AES-256-GCM.
 *
 * @param {string} plaintext  UTF-8 plaintext (e.g. a Meta access token)
 * @param {Buffer|string} key 32-byte key (see resolveKey)
 * @returns {string} serialized "v1:<iv_b64>:<tag_b64>:<ciphertext_b64>"
 */
function encrypt(plaintext, key) {
  if (typeof plaintext !== "string") {
    throw new Error("encrypt() requires a string plaintext.");
  }
  const k = resolveKey(key);
  const iv = crypto.randomBytes(IV_BYTES);

  const cipher = crypto.createCipheriv(ALGORITHM, k, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/**
 * Decrypt a value produced by encrypt(). Verifies the GCM auth tag;
 * throws if the payload was tampered with or the wrong key is used.
 *
 * @param {string} serialized "v1:<iv_b64>:<tag_b64>:<ciphertext_b64>"
 * @param {Buffer|string} key 32-byte key (see resolveKey)
 * @returns {string} UTF-8 plaintext
 */
function decrypt(serialized, key) {
  if (typeof serialized !== "string") {
    throw new Error("decrypt() requires a serialized string.");
  }
  const parts = serialized.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Malformed or unsupported ciphertext format.");
  }

  const k = resolveKey(key);
  const iv = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const ciphertext = Buffer.from(parts[3], "base64");

  if (iv.length !== IV_BYTES) throw new Error("Invalid IV length.");
  if (tag.length !== TAG_BYTES) throw new Error("Invalid auth tag length.");

  const decipher = crypto.createDecipheriv(ALGORITHM, k, iv);
  decipher.setAuthTag(tag);

  // .final() throws if the auth tag does not verify (tampering / wrong key).
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

/**
 * Generate a fresh random 32-byte key as a hex string.
 * Provided as a convenience for the future application/ops layer to mint a
 * key; NOT used automatically and NOT written to any env file in this phase.
 *
 * @returns {string} 64-char hex string (32 bytes)
 */
function generateKeyHex() {
  return crypto.randomBytes(KEY_BYTES).toString("hex");
}

module.exports = {
  encrypt,
  decrypt,
  resolveKey,
  generateKeyHex,
  // Exported constants for tests / future callers
  ALGORITHM,
  KEY_BYTES,
  IV_BYTES,
  TAG_BYTES,
  VERSION,
};
