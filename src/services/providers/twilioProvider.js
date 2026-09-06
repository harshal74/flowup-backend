/**
 * FlowUp WhatsApp Provider — Twilio adapter.
 *
 * Phase 2A: wraps the EXISTING Twilio transport that previously lived inline in
 * whatsapp.service.js. Behavior is preserved exactly:
 *   • Respects the ENABLE_WHATSAPP master flag (DEV_MODE when off).
 *   • Uses the same env vars (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN /
 *     TWILIO_WHATSAPP_FROM) — NO new env vars added.
 *   • Never throws — returns a normalized result so the caller stays
 *     fire-and-forget safe.
 *
 * This adapter only knows Twilio transport. It does NOT decide when/what/who —
 * that stays in the service/business layer.
 */

const twilio = require("twilio");
const { PROVIDERS, SEND_STATUS, ERROR_CODES } = require("./types");

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken  = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_WHATSAPP_FROM || "whatsapp:+14155238886";

const ENABLE_WHATSAPP =
  process.env.ENABLE_WHATSAPP === "true" || process.env.ENABLE_WHATSAPP === true;

// Lazily created Twilio client (only when enabled AND credentials exist).
const client =
  ENABLE_WHATSAPP && accountSid && authToken
    ? twilio(accountSid, authToken)
    : null;

/**
 * Convert an E.164 number to Twilio's "whatsapp:+E164" channel form.
 * Input MUST already be E.164 (the service normalizes before calling).
 * Returns null if not E.164 (defensive; caller treats null as invalid recipient).
 */
function toTwilioWhatsAppAddress(e164) {
  if (typeof e164 !== "string") return null;
  if (!/^\+[1-9]\d{7,14}$/.test(e164)) return null;
  return `whatsapp:${e164}`;
}

/**
 * Map a Twilio error into the normalized taxonomy. No secrets in the message.
 * @param {any} err
 * @returns {{code:string, message:string, retriable:boolean}}
 */
function mapTwilioError(err) {
  const code = err?.code; // Twilio numeric error code, if present
  // A small, deliberate mapping — not exhaustive by design.
  if (code === 21211 || code === 21614 || code === 21408) {
    return { code: ERROR_CODES.INVALID_RECIPIENT, message: "Invalid recipient number.", retriable: false };
  }
  if (code === 20003) {
    return { code: ERROR_CODES.AUTH_FAILED, message: "Provider authentication failed.", retriable: false };
  }
  if (code === 20429 || err?.status === 429) {
    return { code: ERROR_CODES.RATE_LIMITED, message: "Provider rate limited.", retriable: true };
  }
  if (err?.status >= 500) {
    return { code: ERROR_CODES.PROVIDER_UNAVAILABLE, message: "Provider temporarily unavailable.", retriable: true };
  }
  return { code: ERROR_CODES.UNKNOWN, message: err?.message || "Unknown provider error.", retriable: false };
}

/**
 * Send a WhatsApp message via Twilio (text body only — Twilio free-text era).
 * @param {import("./types").SendMessageInput} input
 * @returns {Promise<import("./types").SendMessageResult>}
 */
async function send(input) {
  const { to, body, event = "notification" } = input || {};

  // DEV MODE — flag off: log-only, mimic prior behavior exactly.
  if (!ENABLE_WHATSAPP) {
    console.log(`[WhatsApp][TWILIO] DEV MODE [${event}] → ${to} | ${String(body || "").slice(0, 80).replace(/\n/g, " ")}…`);
    return {
      success: true,
      provider: PROVIDERS.TWILIO,
      providerMessageId: "DEV_MODE",
      status: SEND_STATUS.QUEUED,
      recipient: to || null,
      error: null,
    };
  }

  if (!client) {
    console.error("[WhatsApp][TWILIO] ENABLE_WHATSAPP is true but credentials are missing — not sent.");
    return {
      success: false,
      provider: PROVIDERS.TWILIO,
      providerMessageId: null,
      status: SEND_STATUS.FAILED,
      recipient: to || null,
      error: { code: ERROR_CODES.PROVIDER_UNAVAILABLE, message: "Twilio not configured.", retriable: false },
    };
  }

  const twilioTo = toTwilioWhatsAppAddress(to);
  if (!twilioTo) {
    return {
      success: false,
      provider: PROVIDERS.TWILIO,
      providerMessageId: null,
      status: SEND_STATUS.FAILED,
      recipient: to || null,
      error: { code: ERROR_CODES.INVALID_RECIPIENT, message: "Invalid or missing recipient.", retriable: false },
    };
  }

  try {
    const message = await client.messages.create({ from: fromNumber, to: twilioTo, body });
    console.log(`[WhatsApp][TWILIO] ✓ [${event}] sid=${message.sid} → ${twilioTo}`);
    return {
      success: true,
      provider: PROVIDERS.TWILIO,
      providerMessageId: message.sid,
      status: SEND_STATUS.SENT,
      recipient: to,
      error: null,
    };
  } catch (err) {
    const normalized = mapTwilioError(err);
    console.error(`[WhatsApp][TWILIO] ✗ [${event}] → ${twilioTo} | ${normalized.code}`);
    return {
      success: false,
      provider: PROVIDERS.TWILIO,
      providerMessageId: null,
      status: SEND_STATUS.FAILED,
      recipient: to,
      error: normalized,
    };
  }
}

module.exports = {
  id: PROVIDERS.TWILIO,
  send,
  // exported for unit checks
  toTwilioWhatsAppAddress,
  mapTwilioError,
};
