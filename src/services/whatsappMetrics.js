/**
 * FlowUp WhatsApp — lightweight operational metrics/counters (Phase 24).
 *
 * No external monitoring dependency (FlowUp has none). This is an in-process
 * structured counter + safe diagnostic logger. Counters are process-local
 * (best-effort visibility, resets on restart) and are exposed read-only to an
 * authenticated admin diagnostic endpoint. NEVER logs secrets, tokens,
 * Authorization headers, or raw provider/webhook payloads.
 *
 * Meta outbound remains inactive; this module only observes.
 */

const COUNTER_KEYS = Object.freeze([
  "meta_send_success",
  "meta_send_definitive_failure",
  "meta_send_ambiguous",
  "meta_duplicate_suppressed",
  "meta_idempotency_index_missing",
  "meta_mark_sent_retry",
  "meta_mark_sent_failure",
  "meta_template_sync_failure",
  "meta_webhook_signature_failure",
  "meta_webhook_unmatched",
]);

const counters = Object.create(null);
for (const k of COUNTER_KEYS) counters[k] = 0;

/**
 * Increment a known counter. Unknown keys are ignored (defensive).
 * @param {string} key one of COUNTER_KEYS
 * @param {number} [n=1]
 */
function inc(key, n = 1) {
  if (Object.prototype.hasOwnProperty.call(counters, key)) {
    counters[key] += n;
  }
}

/**
 * Emit a safe, structured operational diagnostic. `ctx` may include ONLY safe
 * identifiers (restaurantId, logId, orderId, event, provider, code, count).
 * Any accidental sensitive-looking keys are dropped defensively.
 * @param {string} level "info" | "warn" | "critical"
 * @param {string} message
 * @param {object} [ctx]
 */
const UNSAFE_KEYS = /token|secret|authorization|bearer|password|key|payload|body/i;
function diag(level, message, ctx = {}) {
  const safe = {};
  for (const [k, v] of Object.entries(ctx || {})) {
    if (UNSAFE_KEYS.test(k)) continue;                 // never log sensitive keys
    if (v === undefined || v === null) continue;
    if (typeof v === "object") continue;               // avoid dumping objects
    safe[k] = v;
  }
  const line = `[WhatsApp][${level.toUpperCase()}] ${message} ${JSON.stringify(safe)}`;
  if (level === "critical" || level === "warn") console.error(line);
  else console.log(line);
}

/** Read-only snapshot of counters (safe for an admin diagnostic response). */
function snapshot() {
  return { ...counters };
}

/** Test helper: reset counters. */
function _reset() {
  for (const k of COUNTER_KEYS) counters[k] = 0;
}

module.exports = { inc, diag, snapshot, _reset, COUNTER_KEYS };
