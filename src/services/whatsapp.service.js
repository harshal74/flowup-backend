/**
 * FlowUp WhatsApp Service — Twilio-based customer notifications.
 *
 * Architecture:
 *   Controllers → sendOrderStatusWhatsApp() / sendBillWhatsApp()
 *              → toWhatsAppNumber() (normalization)
 *              → Twilio client → WhatsApp delivery
 *
 * Key rules:
 *   • ENABLE_WHATSAPP must be true AND credentials must be present for real sends.
 *   • When disabled, all functions return { success: true, sid: "DEV_MODE" } and log only.
 *   • Invalid phone → { success: false, error: "Invalid Number" } — no crash.
 *   • All functions are async and must be called fire-and-forget (.catch()) by callers.
 *     WhatsApp failure must NEVER fail a core business operation.
 *   • Twilio credentials remain server-side only — never returned to any frontend.
 */

// ── Provider boundary (Phase 2A) ──────────────────────────────────
// Transport now goes through a provider adapter (Twilio today; Meta later).
// This service still owns WHEN/WHAT/WHO; the provider owns transport.
// The public functions below keep their exact previous signatures and
// return shape ({ success, sid?, error? }) so NO controller changes are
// required and existing behavior is preserved byte-for-byte.
const { getDefaultProvider, PROVIDERS } = require("./providers");
const messageLog = require("./whatsappMessageLog.service");
const { isMetaTemplateApproved } = require("./providers/templateApproval");
const metrics = require("./whatsappMetrics");

const { normalizeE164 } = require("../utils/phoneE164");

// ── Phase 14: Meta outbound feature gate (DEFAULT OFF) ────────────
// Meta is reachable from the outbound path ONLY when this server-side flag is
// explicitly "true". Missing/any-other-value → OFF → existing Twilio path.
// There is NO client/restaurant/frontend control over this flag, and it is NOT
// added to .env. When OFF, behavior is byte-for-byte identical to Phase 13.
function isMetaOutboundEnabled() {
  return process.env.WHATSAPP_META_OUTBOUND_ENABLED === "true";
}

// Lazily required to avoid load-order coupling; these are Phase 8/10 modules.
function _metaModules() {
  return {
    resolveProviderForRestaurant: require("./providers/resolveProvider").resolveProviderForRestaurant,
    assembleMetaSend: require("./providers/metaSendAssembler").assembleMetaSend,
  };
}

// Map the service's lowercase event labels → WhatsAppMessageLog event enum.
// Only mapped events are logged; unmapped labels skip logging (no invented events).
const EVENT_LOG_MAP = Object.freeze({
  order_placed:     "ORDER_PLACED",
  order_accepted:   "ORDER_ACCEPTED",
  order_rejected:   "ORDER_REJECTED",
  out_for_delivery: "OUT_FOR_DELIVERY",
  delivered:        "DELIVERED",
  payment_confirmed:"PAYMENT_SUCCESS",
  bill:             "BILL",
});

// ────────────────────────────────────────────────────────────────
// Phone number normalisation — GLOBAL E.164 boundary (Phase 2B)
//
// The WhatsApp layer no longer assumes India. This function returns a
// canonical E.164 number ("+<cc><national>") — WITHOUT the provider
// transport prefix. The provider adapter (e.g. Twilio) is responsible for
// adding "whatsapp:". There is NO hidden +91 fallback: a bare national
// number is only resolved when an explicit country context is supplied.
//
// Behaviour:
//   • Already-E.164 input ("+14155551234", "+919876543210") → normalized E.164.
//   • Bare national number + countryContext ("IN"/"US"/…)    → E.164.
//   • Bare national number WITHOUT countryContext            → null (controlled
//     failure; the country is never guessed).
//
// Returns null for any value that cannot be safely normalized. Callers must
// treat null as "skip silently" (fire-and-forget preserved).
//
// NOTE: This changed from returning "whatsapp:+E164" to returning bare
// "+E164". The provider adapter adds the "whatsapp:" prefix, and the
// service's _send() also tolerates a legacy "whatsapp:" prefix, so the end
// result to Twilio is unchanged ("whatsapp:+E164").
//
// @param {string} mobile           raw phone (E.164 or national digits)
// @param {string} [countryContext] ISO alpha-2 (e.g. "IN") for national input
// @returns {string|null} E.164 (no transport prefix) or null
// ────────────────────────────────────────────────────────────────
// Optional, explicit default country context for legacy national-number
// callers. This is NOT hardcoded to India: it is read from configuration and
// is undefined unless an operator explicitly sets WHATSAPP_DEFAULT_COUNTRY
// (e.g. "IN" for an India-only deployment). When unset, national numbers
// without an explicit countryContext resolve to null (no country guessing).
// This keeps the transport layer country-agnostic while allowing an
// India-first deployment to preserve current behavior via configuration.
const DEFAULT_COUNTRY_CONTEXT = process.env.WHATSAPP_DEFAULT_COUNTRY || undefined;

function toWhatsAppNumber(mobile, countryContext) {
  if (!mobile) return null;
  const ctx = countryContext || DEFAULT_COUNTRY_CONTEXT;
  return normalizeE164(String(mobile), ctx);
}

// ────────────────────────────────────────────────────────────────
// Core send helper — used by every public notification function.
// All sends are fire-and-forget at the controller level.
// Returns { success, sid? } — never throws.
//
// Phase 2A: delegates transport to the active provider adapter (Twilio)
// via the provider registry, then maps the provider-neutral result back
// to the legacy { success, sid?, error? } shape so callers are unchanged.
//
// The public functions pass `to` already in Twilio channel form
// ("whatsapp:+91…", produced by toWhatsAppNumber). The Twilio adapter
// expects a bare E.164 number and adds the "whatsapp:" prefix itself, so
// we strip that prefix here. This keeps the public API and message
// output byte-for-byte identical to the previous implementation.
// ────────────────────────────────────────────────────────────────
// ── Phase 14: Meta send branch ────────────────────────────────────
// Orchestrates the existing Phase 10 assembler + Phase 4 provider, with
// Phase 13 logging (provider = META, real wamid). Fail-closed and never
// throws; maps to the legacy { success, sid?, error? } shape. Requires an
// approved Meta template for the event (approval is an EXTERNAL prerequisite —
// unapproved templates are rejected by Meta at send time and normalized here).
async function _sendViaMeta({ e164, event, metaEvent, logContext, templateInput, languageCode }) {
  const { assembleMetaSend } = _metaModules();

  // 1) Assemble FIRST (resolves provider+config+template). No token/secret is
  //    logged. The config carries non-secret wabaId + templates (Phase 15A).
  let prepared;
  try {
    prepared = await assembleMetaSend({
      restaurantId: logContext.restaurantId,
      event: metaEvent,
      recipient: e164,
      templateInput: templateInput || {},
      languageCode,
      countryContext: logContext.countryCode,
    });
  } catch {
    prepared = { ok: false, error: { code: "PROVIDER_UNAVAILABLE", message: "assemble failed" } };
  }

  if (!prepared.ok) {
    // No QUEUED log created yet → nothing to mark; just fail closed.
    return { success: false, error: prepared.error ? prepared.error.message : "meta assemble failed" };
  }

  // 2) Phase 15A per-template approval gate — BEFORE any QUEUED log or Meta
  //    HTTP request. Fail closed if the exact template is not APPROVED for the
  //    current WABA + language. Never falls back to Twilio, never calls Meta.
  const cfg = prepared.input?.config || {};
  const tmpl = prepared.input?.template || {};
  const approved = isMetaTemplateApproved({
    templates: cfg.templates,
    wabaId: cfg.wabaId,
    templateName: tmpl.name,
    languageCode: tmpl.language?.code,
  });
  if (!approved) {
    return {
      success: false,
      error: "Meta template is not approved for this WABA and language",
    };
  }

  // 2b) Phase 23 — idempotency INDEX readiness gate. The atomic barrier below
  //     is only safe if the {orderId,event} unique partial index exists in the
  //     live DB. If it is missing/incorrect, DENY the Meta send (fail-closed) —
  //     do NOT fall back to Twilio (the restaurant is explicitly Meta-activated),
  //     and do NOT create a QUEUED row or call Meta.
  const indexReady = await messageLog.verifyIdempotencyIndex();
  if (!indexReady) {
    metrics.inc("meta_idempotency_index_missing");
    metrics.diag("critical", "Meta send denied: idempotency index not ready", {
      restaurantId: logContext.restaurantId, event: metaEvent, provider: PROVIDERS.META,
    });
    return { success: false, error: "Meta outbound unavailable: idempotency index not ready" };
  }

  // 3) Phase 21 — ATOMIC idempotency barrier BEFORE the Meta HTTP send.
  //    The first request to insert a QUEUED row for {orderId, event} owns the
  //    send; a concurrent/retried request hits the {orderId,event} unique index
  //    and is told "duplicate" → it MUST NOT send. This prevents duplicate
  //    customer notifications on retries/timeouts/double-clicks.
  //    Events without an orderId (rare) fall back to best-effort createQueued.
  const logMeta = {
    restaurantId: logContext.restaurantId,
    event: metaEvent,
    provider: PROVIDERS.META,
    recipientPhone: e164,
    customerId: logContext.customerId,
    orderId: logContext.orderId,
    countryCode: logContext.countryCode,
  };

  let logId = null;
  if (logContext.orderId) {
    const claim = await messageLog.createQueuedIdempotent(logMeta);
    if (claim.duplicate) {
      // Another attempt already owns this logical notification → do NOT resend.
      metrics.inc("meta_duplicate_suppressed");
      return { success: false, error: "Duplicate WhatsApp notification suppressed" };
    }
    if (!claim.created) {
      // Transient DB error acquiring the barrier → fail closed, do NOT send.
      return { success: false, error: "Could not acquire send lock" };
    }
    logId = claim.doc?._id || null;
  } else {
    try {
      const doc = await messageLog.createQueued(logMeta);
      logId = doc?._id || null;
    } catch { logId = null; }
  }

  // 4) Send via Meta.
  let result;
  try {
    result = await prepared.provider.send(prepared.input);
  } catch {
    // Thrown transport error is treated as AMBIGUOUS (the request may or may not
    // have reached Meta). Do NOT mark FAILED (could have delivered) and do NOT
    // auto-retry (could duplicate). Leave QUEUED with a reconciliation note.
    metrics.inc("meta_send_ambiguous");
    if (logId) { try { await messageLog.markAmbiguous(logId, "meta send threw (ambiguous)"); } catch { /* best-effort */ } }
    return { success: false, error: "meta send ambiguous" };
  }

  // 5) Persist outcome, distinguishing definitive failure from ambiguous.
  if (result.success) {
    // Successful Meta response → preserve the wamid for webhook correlation.
    metrics.inc("meta_send_success");
    if (logId) { try { await messageLog.markSent(logId, result.providerMessageId); } catch { /* best-effort */ } }
    return { success: true, sid: result.providerMessageId };
  }

  // Failure. metaProvider marks transport/5xx/network as retriable=true — these
  // are AMBIGUOUS (message may have been accepted): keep QUEUED, do NOT FAILED,
  // do NOT auto-retry. Definitive failures (retriable=false: auth, permission,
  // invalid recipient, template rejected) become FAILED.
  const err = result.error || {};
  if (err.retriable === true) {
    metrics.inc("meta_send_ambiguous");
    if (logId) { try { await messageLog.markAmbiguous(logId, `ambiguous: ${err.code || "provider"}`); } catch { /* best-effort */ } }
    return { success: false, error: err.message || "meta send ambiguous" };
  }
  metrics.inc("meta_send_definitive_failure");
  if (logId) { try { await messageLog.markFailed(logId, err.message || "meta send failed"); } catch { /* best-effort */ } }
  return { success: false, error: err.message || "meta send failed" };
}

async function _send({ to, body, event = "notification", logContext, templateInput, languageCode }) {
  const provider = getDefaultProvider();

  // Convert legacy "whatsapp:+E164" back to bare "+E164" for the adapter.
  const e164 =
    typeof to === "string" && to.startsWith("whatsapp:")
      ? to.slice("whatsapp:".length)
      : to;

  // ── Phase 14: gated per-restaurant Meta selection ─────────────
  // Only when the global gate is ON AND we have a trusted restaurantId AND the
  // event maps to a Meta template. If the restaurant resolves to META we send
  // via Meta (fail-closed: a Meta-designated but unhealthy restaurant returns a
  // controlled failure — never a silent Twilio fallback). If it resolves to
  // TWILIO (or no config), we fall through to the existing Twilio path.
  const metaEvent = EVENT_LOG_MAP[event];
  if (isMetaOutboundEnabled() && logContext?.restaurantId && metaEvent) {
    const { resolveProviderForRestaurant } = _metaModules();
    let resolved;
    try {
      resolved = await resolveProviderForRestaurant(logContext.restaurantId);
    } catch {
      resolved = { ok: false, error: { code: "PROVIDER_UNAVAILABLE", message: "resolve failed" } };
    }
    if (resolved.ok && resolved.providerId === PROVIDERS.META) {
      return _sendViaMeta({ e164, event, metaEvent, logContext, templateInput, languageCode });
    }
    if (!resolved.ok) {
      // Restaurant explicitly META but unhealthy → FAIL CLOSED (no Twilio).
      return { success: false, error: resolved.error ? resolved.error.message : "provider unavailable" };
    }
    // resolved TWILIO → fall through to existing Twilio path below.
  }

  // ── Best-effort outbound logging (Phase 13) ───────────────────
  // Only when a caller supplies logContext with a trusted restaurantId AND the
  // event maps to a known log enum. Logging NEVER affects the send result:
  // any logging error is swallowed. providerMessageId is stored so the Phase 12
  // webhook can later correlate delivery statuses.
  let logId = null;
  const mappedEvent = logContext?.restaurantId ? EVENT_LOG_MAP[event] : null;
  if (mappedEvent) {
    try {
      const doc = await messageLog.createQueued({
        restaurantId: logContext.restaurantId,
        event: mappedEvent,
        provider: provider.id, // "TWILIO" today
        recipientPhone: e164,
        customerId: logContext.customerId,
        orderId: logContext.orderId,
        countryCode: logContext.countryCode,
      });
      logId = doc?._id || null;
    } catch { logId = null; }
  }

  const result = await provider.send({ to: e164, body, event });

  // Update the log (best-effort) but NEVER change the returned shape/behavior.
  if (logId) {
    try {
      if (result.success) {
        // DEV_MODE returns providerMessageId "DEV_MODE"; store it verbatim so a
        // simulated send is distinguishable from a real provider id.
        await messageLog.markSent(logId, result.providerMessageId);
      } else {
        await messageLog.markFailed(logId, result.error ? result.error.message : "send failed");
      }
    } catch { /* logging is best-effort */ }
  }

  // Map provider-neutral result → legacy shape expected by existing callers.
  if (result.success) {
    return { success: true, sid: result.providerMessageId };
  }
  return { success: false, error: result.error ? result.error.message : "send failed" };
}

// ────────────────────────────────────────────────────────────────
// Message builders — plain text, concise, customer-friendly.
// Do NOT include internal IDs, DB IDs, staff info, or secrets.
// ────────────────────────────────────────────────────────────────

function buildOrderPlacedMessage({ orderNumber, restaurantName, totalAmount, orderType }) {
  const typeLabel =
    orderType === "DELIVERY"  ? "Delivery 🚴" :
    orderType === "DINE_IN"   ? "Dine-In 🍽️"  :
    orderType === "TAKE_AWAY" ? "Take Away 🛍️" : "";
  return (
    `✅ Order Received!\n\n` +
    `Restaurant : ${restaurantName}\n` +
    `Order No.  : ${orderNumber}\n` +
    `Type       : ${typeLabel}\n` +
    `Amount     : ₹${Number(totalAmount).toFixed(2)}\n\n` +
    `Your order has been received and is awaiting confirmation. Thank you! 🙏`
  );
}

function buildOrderAcceptedMessage({ orderNumber, restaurantName }) {
  return (
    `👨‍🍳 Order Confirmed!\n\n` +
    `Restaurant : ${restaurantName}\n` +
    `Order No.  : ${orderNumber}\n\n` +
    `Your order has been accepted and is being prepared. We'll update you when it's on the way! 🚀`
  );
}

function buildOrderRejectedMessage({ orderNumber, restaurantName, reason }) {
  const reasonLine = reason && reason.trim()
    ? `\nReason     : ${reason.trim()}`
    : "";
  return (
    `❌ Order Not Accepted\n\n` +
    `Restaurant : ${restaurantName}\n` +
    `Order No.  : ${orderNumber}${reasonLine}\n\n` +
    `We're sorry, your order could not be accepted at this time. Please try again or contact the restaurant directly.`
  );
}

function buildOutForDeliveryMessage({ orderNumber, restaurantName }) {
  return (
    `🚴 On the Way!\n\n` +
    `Restaurant : ${restaurantName}\n` +
    `Order No.  : ${orderNumber}\n\n` +
    `Your order is out for delivery. It will arrive shortly. Thank you for your patience! 📦`
  );
}

function buildDeliveredMessage({ orderNumber, restaurantName }) {
  return (
    `✅ Delivered!\n\n` +
    `Restaurant : ${restaurantName}\n` +
    `Order No.  : ${orderNumber}\n\n` +
    `Your order has been delivered. Enjoy your meal! 😊🙏\n` +
    `Thank you for ordering from ${restaurantName}.`
  );
}

function buildPaymentConfirmedMessage({ orderNumber, restaurantName, grandTotal }) {
  return (
    `💳 Payment Confirmed!\n\n` +
    `Restaurant : ${restaurantName}\n` +
    `Order No.  : ${orderNumber}\n` +
    `Amount Paid: ₹${Number(grandTotal).toFixed(2)}\n\n` +
    `Your payment has been received. Thank you! 🙏`
  );
}

function buildBillMessage({ bill, customerName, restaurantName }) {
  const date = new Date(bill.createdAt).toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const itemLines =
    bill.items?.length > 0
      ? bill.items
          .map(
            (item) =>
              `• ${item.quantity} x ${item.name} - ₹${Number(item.total).toFixed(2)}`
          )
          .join("\n")
      : "No Items";

  return (
    `🧾 BILL\n\n` +
    `Restaurant : ${restaurantName}\n` +
    `Invoice    : ${bill.invoiceNumber}\n` +
    `Date       : ${date}\n` +
    `Table      : ${bill.tableNumber || "-"}\n\n` +
    `Items\n-------------------------\n` +
    `${itemLines}\n\n` +
    `-------------------------\n` +
    `Subtotal : ₹${bill.subtotal.toFixed(2)}\n` +
    `GST      : ₹${bill.gst.toFixed(2)}\n` +
    `Discount : ₹${bill.discount.toFixed(2)}\n` +
    `Total    : ₹${bill.grandTotal.toFixed(2)}\n\n` +
    `Payment  : ${bill.paymentMethod}\n\n` +
    `Thank you ${customerName}! 🙏`
  );
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Generic order-status notification.
 * Controllers call this for: order_placed, accepted, rejected,
 * out_for_delivery, delivered, payment_confirmed.
 *
 * @param {object} params
 * @param {string} params.mobile          — customer phone (E.164, or national digits + countryContext)
 * @param {string} params.body            — pre-built message body
 * @param {string} params.event           — label for logging (e.g. "order_placed")
 * @param {string} [params.countryContext]— ISO alpha-2 for national-number input (optional)
 * @returns {Promise<{success, sid?, error?}>}
 */
async function sendOrderStatusWhatsApp({ mobile, body, event = "order_status", countryContext, logContext, templateInput, languageCode }) {
  const to = toWhatsAppNumber(mobile, countryContext);
  if (!to) {
    console.warn(`[WhatsApp] [${event}] Invalid or missing phone — skipping.`);
    return { success: false, error: "Invalid Number" };
  }
  return _send({ to, body, event, logContext, templateInput, languageCode });
}

/**
 * Bill notification — itemised receipt sent on bill generation.
 * Already used by billing.controller.js; preserved without changes.
 */
async function sendBillWhatsApp({ mobile, bill, customerName, restaurantName, countryContext, logContext, templateInput, languageCode }) {
  const to = toWhatsAppNumber(mobile, countryContext);
  if (!to) {
    console.warn("[WhatsApp] [bill] Invalid or missing phone — skipping.");
    return { success: false, error: "Invalid Number" };
  }
  const body = buildBillMessage({ bill, customerName, restaurantName });
  return _send({ to, body, event: "bill", logContext, templateInput, languageCode });
}

module.exports = {
  // Core helpers (exported for unit-testing convenience)
  toWhatsAppNumber,

  // Message builders (exported so controllers can compose messages
  // without coupling to the send implementation)
  buildOrderPlacedMessage,
  buildOrderAcceptedMessage,
  buildOrderRejectedMessage,
  buildOutForDeliveryMessage,
  buildDeliveredMessage,
  buildPaymentConfirmedMessage,
  buildBillMessage,

  // Send functions
  sendOrderStatusWhatsApp,
  sendBillWhatsApp,
};
