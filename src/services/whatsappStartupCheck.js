/**
 * FlowUp WhatsApp — Meta idempotency-index STARTUP DIAGNOSTIC (Phase 26).
 *
 * READ-ONLY operational readiness check. On boot (after the DB connects) this
 * inspects the LIVE {orderId,event} unique partial index on whatsappmessagelogs
 * and logs one clear line:
 *
 *   ✅ META WHATSAPP IDEMPOTENCY INDEX: READY
 *   ⛔ CRITICAL: META WHATSAPP IDEMPOTENCY INDEX NOT READY — META OUTBOUND BLOCKED
 *
 * STRICT NON-BEHAVIOURAL GUARANTEES:
 *   • Never creates or modifies any index (no createIndex, no syncIndexes).
 *   • Never crashes the process — the app + Twilio path continue regardless.
 *   • Never enables Meta. The send path's own runtime gate
 *     (verifyIdempotencyIndex in _sendViaMeta) remains the authoritative check;
 *     this is purely an early operator-visible signal.
 *   • Never exposes DB internals to any client (log-only, server-side).
 *
 * It intentionally does NOT block, retry aggressively, or throw: a missing
 * index means Meta stays fail-closed (already enforced at send time), while
 * Twilio and the rest of the application keep working normally.
 */

const { verifyIdempotencyIndex } = require("./whatsappMessageLog.service");

/**
 * Run the startup readiness diagnostic. Best-effort; never throws.
 * @returns {Promise<boolean>} true if the idempotency index is READY.
 */
async function runWhatsAppStartupCheck() {
  try {
    const ready = await verifyIdempotencyIndex(true); // force a fresh live check
    if (ready) {
      console.log("✅ META WHATSAPP IDEMPOTENCY INDEX: READY");
      return true;
    }
    // verifyIdempotencyIndex already logged the specific reason (missing/incorrect).
    console.error(
      "⛔ CRITICAL: META WHATSAPP IDEMPOTENCY INDEX NOT READY — META OUTBOUND BLOCKED " +
      "(Twilio unaffected; the app continues running)."
    );
    return false;
  } catch (err) {
    // Absolute belt-and-braces: the check must never disturb startup.
    console.error(
      "⛔ CRITICAL: META WHATSAPP IDEMPOTENCY INDEX CHECK FAILED — META OUTBOUND BLOCKED " +
      "(Twilio unaffected; the app continues running)."
    );
    return false;
  }
}

module.exports = { runWhatsAppStartupCheck };
