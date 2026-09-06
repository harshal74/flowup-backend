/**
 * FlowUp WhatsApp — Meta webhook processing (Phase 12). INBOUND ONLY.
 *
 * Pure, testable helpers + a status-ingestion function for WhatsApp Cloud API
 * webhooks: signature verification, statuses[] extraction, status mapping, and
 * idempotent / regression-safe WhatsAppMessageLog updates.
 *
 * INACTIVE for outbound: nothing here sends a message or calls metaProvider /
 * whatsapp.service / resolveProviderForRestaurant. Twilio remains default.
 *
 * Security:
 *   • Signature verified with HMAC-SHA256(appSecret, rawBody), timing-safe.
 *   • App Secret / verify token read from server config only — never logged,
 *     returned, or persisted. Never logs full payloads or tokens.
 *   • Tenant identity is server-derived from Meta's phone_number_id/waba_id,
 *     never from a client-supplied restaurantId.
 */

const crypto = require("crypto");
const RestaurantWhatsApp = require("../models/RestaurantWhatsApp");
const WhatsAppMessageLog = require("../models/WhatsAppMessageLog");

// Status ordering for regression protection. Higher = more advanced.
// FAILED is terminal and handled explicitly (it must not be overwritten by a
// late sent/delivered, and must not overwrite a read).
const STATUS_RANK = Object.freeze({ QUEUED: 0, SENT: 1, DELIVERED: 2, READ: 3, FAILED: 3 });

/**
 * Map a Meta status string to the existing WhatsAppMessageLog status enum.
 * @param {string} metaStatus
 * @returns {string|null}
 */
function mapMetaStatus(metaStatus) {
  switch (metaStatus) {
    case "sent":      return "SENT";
    case "delivered": return "DELIVERED";
    case "read":      return "READ";
    case "failed":    return "FAILED";
    default:          return null; // unknown/future — ignored safely
  }
}

/**
 * Verify the X-Hub-Signature-256 header against the raw request body.
 * @param {string} rawBody   exact received bytes (string)
 * @param {string} signatureHeader  e.g. "sha256=<hex>"
 * @param {string} appSecret server-side Meta App Secret
 * @returns {boolean}
 */
function verifyMetaSignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret || typeof rawBody !== "string" || !signatureHeader || typeof signatureHeader !== "string") {
    return false;
  }
  if (!signatureHeader.startsWith("sha256=")) return false;
  const provided = signatureHeader.slice("sha256=".length);
  if (!/^[0-9a-f]+$/i.test(provided)) return false;

  const expected = crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");

  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(provided, "hex");
  if (a.length !== b.length) return false;              // timingSafeEqual requires equal length
  return crypto.timingSafeEqual(a, b);
}

/**
 * Extract a flat list of status events from a Meta webhook payload.
 * Forward-compatible: tolerates missing entry/changes/value/statuses.
 * @param {object} body parsed webhook JSON
 * @returns {Array<{ phoneNumberId:string|null, wamid:string|null, status:string|null, timestamp:string|null, errors:Array|null }>}
 */
function extractStatuses(body) {
  const out = [];
  const entries = Array.isArray(body?.entry) ? body.entry : [];
  for (const entry of entries) {
    const changes = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value;
      if (!value) continue;
      const phoneNumberId = value?.metadata?.phone_number_id || null;
      const statuses = Array.isArray(value?.statuses) ? value.statuses : [];
      for (const st of statuses) {
        if (!st || typeof st !== "object") continue;
        out.push({
          phoneNumberId,
          wamid: st.id || null,
          status: st.status || null,
          timestamp: st.timestamp || null,
          errors: Array.isArray(st.errors) ? st.errors : null,
        });
      }
    }
  }
  return out;
}

/**
 * Process one extracted status event idempotently.
 * Updates an EXISTING WhatsAppMessageLog matched by providerMessageId (wamid),
 * scoped additionally by the tenant resolved from phoneNumberId. Never creates
 * a log for an unmatched wamid. Never regresses a more-advanced status.
 *
 * @returns {Promise<"updated"|"noop"|"unmatched"|"ignored">}
 */
async function processStatusEvent(evt) {
  const target = mapMetaStatus(evt.status);
  if (!target || !evt.wamid) return "ignored";

  // Resolve tenant from Meta identifier (server-derived, never client input).
  let restaurantId = null;
  if (evt.phoneNumberId) {
    const conn = await RestaurantWhatsApp.findOne({ phoneNumberId: evt.phoneNumberId })
      .select("restaurantId")
      .lean();
    restaurantId = conn?.restaurantId || null;
  }

  // Find the existing outbound message log for this wamid (+ tenant if known).
  const query = restaurantId
    ? { providerMessageId: evt.wamid, restaurantId }
    : { providerMessageId: evt.wamid };
  const log = await WhatsAppMessageLog.findOne(query).select("status").lean();

  if (!log) return "unmatched";

  const currentRank = STATUS_RANK[log.status] ?? -1;
  const nextRank = STATUS_RANK[target] ?? -1;

  // Regression protection: never move to a lower-ranked status. Same rank
  // (e.g. delivered→delivered) is a harmless no-op.
  if (nextRank < currentRank) return "noop";
  if (nextRank === currentRank && log.status === target) return "noop";
  // Do not let FAILED overwrite READ (both rank 3) or vice-versa ambiguously:
  if (nextRank === currentRank && log.status !== target) return "noop";

  // Build the atomic update.
  const tsMs = evt.timestamp ? Number(evt.timestamp) * 1000 : Date.now();
  const when = Number.isFinite(tsMs) ? new Date(tsMs) : new Date();
  const set = { status: target };
  if (target === "SENT")      set.sentAt = when;
  if (target === "DELIVERED") set.deliveredAt = when;
  if (target === "READ")      set.readAt = when;
  if (target === "FAILED") {
    set.failedAt = when;
    const firstErr = evt.errors && evt.errors[0];
    if (firstErr) {
      const code = firstErr.code != null ? `code ${firstErr.code}` : "";
      const title = firstErr.title || firstErr.message || "";
      set.failureReason = `${code} ${title}`.trim().slice(0, 500) || null;
    }
  }

  // Atomic, regression-safe update: only apply if the stored status is still
  // one we're allowed to advance from (guards against concurrent duplicates).
  await WhatsAppMessageLog.updateOne(
    { _id: log._id, status: log.status },
    { $set: set }
  );
  return "updated";
}

/**
 * Process a full authenticated webhook body. Returns a safe summary.
 * Never throws for normal/unknown payloads (forward-compatible).
 */
async function processWebhook(body) {
  const events = extractStatuses(body);
  const summary = { received: events.length, updated: 0, unmatched: 0, ignored: 0, noop: 0 };
  for (const evt of events) {
    try {
      const r = await processStatusEvent(evt);
      summary[r] = (summary[r] || 0) + 1;
    } catch {
      // A single bad event must not fail the whole webhook.
      summary.ignored += 1;
    }
  }
  return summary;
}

module.exports = {
  mapMetaStatus,
  verifyMetaSignature,
  extractStatuses,
  processStatusEvent,
  processWebhook,
  STATUS_RANK,
};
