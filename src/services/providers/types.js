/**
 * FlowUp WhatsApp Provider Contract — shared constants & JSDoc typedefs.
 *
 * Phase 2A (provider boundary only): defines the provider-neutral vocabulary
 * used by the WhatsApp service and every provider adapter. NO Meta code, NO
 * network calls here — pure constants + documentation.
 *
 * Architecture:
 *   FlowUp business logic
 *     → WhatsApp Service (whatsapp.service.js)   ← decides WHEN/WHAT/WHO
 *       → WhatsApp Provider (Twilio | Meta)      ← provider-specific transport
 *
 * Business logic owns: when to send, which event, which customer, which restaurant.
 * Provider owns: authentication, provider API calls, provider message id,
 *                response/error mapping.
 */

// ── Provider identifiers ─────────────────────────────────────────────
const PROVIDERS = Object.freeze({
  TWILIO: "TWILIO",
  META: "META",
});

// ── Normalized delivery status (mirrors WhatsAppMessageLog.status) ───
// The provider's send() returns one of QUEUED | SENT | FAILED synchronously.
// DELIVERED / READ arrive later via provider callbacks/webhooks (future phase).
const SEND_STATUS = Object.freeze({
  QUEUED: "QUEUED",
  SENT: "SENT",
  FAILED: "FAILED",
});

// ── Normalized error taxonomy ────────────────────────────────────────
// Small, provider-neutral set. Adapters map their provider-specific codes
// into one of these so business logic never depends on Twilio/Meta codes.
const ERROR_CODES = Object.freeze({
  INVALID_RECIPIENT: "INVALID_RECIPIENT",   // bad/missing phone number
  AUTH_FAILED: "AUTH_FAILED",               // credentials rejected
  RATE_LIMITED: "RATE_LIMITED",             // provider throttling
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE", // network/5xx/not configured
  TEMPLATE_REJECTED: "TEMPLATE_REJECTED",   // template missing/not approved (Meta)
  PERMISSION_DENIED: "PERMISSION_DENIED",   // insufficient permission
  DISCONNECTED: "DISCONNECTED",             // restaurant WhatsApp not connected/revoked
  UNKNOWN: "UNKNOWN",                        // unmapped provider error
});

/**
 * @typedef {Object} SendMessageInput
 * Provider-neutral send request. The service builds this; the provider consumes it.
 * @property {string}  to            Recipient in E.164 (e.g. "+919876543210").
 * @property {string}  [body]        Rendered text body (Twilio / free-text era).
 * @property {Object}  [template]    Structured template payload (Meta era, future).
 * @property {string}  [template.name]      e.g. "flowup_order_placed"
 * @property {string}  [template.language]  e.g. "en"
 * @property {string}  [template.category]  e.g. "UTILITY"
 * @property {Array}   [template.variables] ordered/keyed template variables
 * @property {string}  [event]       Business event label, for logging only.
 * @property {Object}  [config]      Provider-specific config (e.g. per-restaurant
 *                                   Meta credentials) injected by the service.
 *
 * Note: a provider that only supports text (Twilio adapter here) uses `body`.
 * A future Meta adapter will prefer `template`. The service supplies whichever
 * the active provider needs; this keeps ONE send operation (see decision in
 * the Phase 2A report) instead of separate sendText/sendTemplate methods.
 */

/**
 * @typedef {Object} SendMessageResult
 * Provider-neutral result. Shaped so the caller can persist a WhatsAppMessageLog
 * without knowing the provider.
 * @property {boolean} success
 * @property {string}  provider           one of PROVIDERS
 * @property {string|null} providerMessageId  Twilio SID or Meta wamid
 * @property {string}  status             one of SEND_STATUS
 * @property {string|null} recipient      E.164 recipient echoed back
 * @property {NormalizedError|null} error present when success === false
 */

/**
 * @typedef {Object} NormalizedError
 * @property {string} code     one of ERROR_CODES
 * @property {string} message  human-readable (no secrets)
 * @property {boolean} retriable  whether a later retry may succeed
 */

module.exports = {
  PROVIDERS,
  SEND_STATUS,
  ERROR_CODES,
};
