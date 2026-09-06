/**
 * FlowUp WhatsApp — Outbound message logging service (Phase 13).
 *
 * Small, reusable, tenant-scoped operations to persist outbound WhatsApp
 * messages into WhatsAppMessageLog so the Phase 12 webhook can correlate Meta
 * delivery statuses by providerMessageId later.
 *
 * Rules:
 *   • BEST-EFFORT: every operation is wrapped so a logging failure NEVER breaks
 *     an otherwise-successful send. Callers use fire-and-forget semantics.
 *   • No HTTP, no Meta credentials, no provider selection, no controller logic.
 *   • Tenant-scoped: writes/updates always carry restaurantId; updates match by
 *     providerMessageId and never regress a more-advanced status.
 *   • Secrets are never persisted; failureReason is truncated + sanitized.
 *
 * Status rank mirrors metaWebhookService for compatibility:
 *   QUEUED(0) < SENT(1) < DELIVERED(2) < READ(3); FAILED shares rank 3.
 */

const WhatsAppMessageLog = require("../models/WhatsAppMessageLog");
const metrics = require("./whatsappMetrics");

const STATUS_RANK = Object.freeze({ QUEUED: 0, SENT: 1, DELIVERED: 2, READ: 3, FAILED: 3 });
const MAX_REASON = 500;

// ── Phase 23: idempotency index integrity ─────────────────────────
// The Meta pre-send idempotency barrier (createQueuedIdempotent) relies on a
// UNIQUE partial index on { orderId, event } (partial: orderId is objectId).
// If that index is MISSING or INCORRECT in the live DB, concurrent duplicate
// sends could both reach Meta. This verifier inspects the ACTUAL collection
// index metadata (not the schema declaration) and caches the result. The send
// path consults it and DENIES Meta (fail-closed, no Twilio fallback) when the
// index is not verified. We do NOT auto-create the index: forcing a unique
// index when duplicate rows already exist could destabilize production.
let _indexReadyCache = null; // null = unknown, true/false once checked

function _matchesIdempotencyIndex(idx) {
  if (!idx || !idx.key) return false;
  const keys = Object.keys(idx.key);
  // key pattern exactly { orderId: 1, event: 1 } (order matters for the index)
  if (keys.length !== 2 || keys[0] !== "orderId" || keys[1] !== "event") return false;
  if (idx.key.orderId !== 1 || idx.key.event !== 1) return false;
  if (idx.unique !== true) return false;
  // partialFilterExpression must scope to objectId orderId
  const pfe = idx.partialFilterExpression;
  if (!pfe || !pfe.orderId) return false;
  const cond = pfe.orderId;
  // Accept { orderId: { $type: "objectId" } } (string or numeric BSON type 7)
  const t = cond && cond.$type;
  return t === "objectId" || t === 7;
}

/**
 * Verify (against LIVE collection metadata) that the idempotency index exists
 * and is correct. Result is cached. Never throws; returns boolean.
 * @param {boolean} [force] re-check ignoring cache
 * @returns {Promise<boolean>}
 */
async function verifyIdempotencyIndex(force = false) {
  // Cache ONLY the positive (ready) result: once the correct index is observed
  // it cannot silently disappear within a process without a restart. A negative
  // result is NEVER cached, so an index created AFTER startup is picked up on
  // the next check (avoids a stale `false` permanently denying Meta).
  if (!force && _indexReadyCache === true) return true;
  try {
    const indexes = await WhatsAppMessageLog.collection.indexes();
    const ok = Array.isArray(indexes) && indexes.some(_matchesIdempotencyIndex);
    if (ok) {
      _indexReadyCache = true;
      return true;
    }
    console.error(
      "[WhatsApp][CRITICAL] Idempotency index missing/incorrect on whatsappmessagelogs " +
      "({ orderId:1, event:1 } unique partial objectId). Meta outbound will be DENIED " +
      "until this index exists. No secrets involved."
    );
    return false; // not cached → re-checked next time
  } catch (err) {
    // Could not read index metadata (e.g. DB unavailable) → treat as NOT ready
    // (fail-closed for Meta). Not cached.
    console.error("[WhatsApp][CRITICAL] Could not verify idempotency index:", err.message);
    return false;
  }
}

/** Test/ops helper: reset the cached readiness (e.g. after creating the index). */
function _resetIndexCache() { _indexReadyCache = null; }

function safeReason(reason) {
  if (!reason) return null;
  const s = String(reason).replace(/\s+/g, " ").trim();
  return s ? s.slice(0, MAX_REASON) : null;
}

/**
 * Create a QUEUED outbound log. Returns the created doc (lean-ish) or null on
 * failure (best-effort). Never throws.
 *
 * @param {Object} p
 * @param {string} p.restaurantId  (required) trusted tenant id
 * @param {string} p.event         business event (e.g. "ORDER_PLACED")
 * @param {string} p.provider      "TWILIO" | "META"
 * @param {string} [p.recipientPhone] E.164
 * @param {string} [p.customerId]
 * @param {string} [p.orderId]
 * @param {string} [p.templateName]
 * @param {string} [p.category]
 * @param {string} [p.countryCode]
 * @param {string} [p.currency]
 * @returns {Promise<object|null>}
 */
async function createQueued(p = {}) {
  try {
    if (!p.restaurantId || !p.event || !p.provider) return null;
    const doc = await WhatsAppMessageLog.create({
      restaurantId: p.restaurantId,
      event: p.event,
      provider: p.provider,
      status: "QUEUED",
      recipientPhone: p.recipientPhone || null,
      customerId: p.customerId || null,
      orderId: p.orderId || null,
      templateName: p.templateName || null,
      category: p.category || null,
      countryCode: p.countryCode || null,
      currency: p.currency || null,
    });
    return doc;
  } catch {
    return null;
  }
}

/**
 * Mark a QUEUED log as SENT and attach the provider message id.
 * Regression-safe (only advances from a lower rank). Best-effort.
 *
 * @param {string} logId               the _id from createQueued
 * @param {string} providerMessageId   Twilio SID or Meta wamid (may be null)
 * @returns {Promise<boolean>} whether an update was applied
 */
async function markSent(logId, providerMessageId) {
  if (!logId) return false;

  // Phase 23: bounded local retry to strengthen the guarantee that a
  // successful Meta send persists its wamid (the webhook's correlation key).
  // This is a LOCAL DB operation only — it can NEVER trigger another Meta send.
  // Idempotent: re-running with the same wamid does not regress SENT and keeps
  // the correct providerMessageId (the QUEUED filter makes repeats no-ops).
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await WhatsAppMessageLog.updateOne(
        { _id: logId, status: "QUEUED" }, // only advance from QUEUED (no regression)
        {
          $set: {
            status: "SENT",
            sentAt: new Date(),
            ...(providerMessageId ? { providerMessageId } : {}),
          },
        }
      );
      // modifiedCount 0 means already advanced (e.g. webhook won the race) — done.
      return res.modifiedCount > 0;
    } catch (err) {
      // A duplicate providerMessageId (unique+sparse) means the wamid is already
      // stored somewhere — set status only, do not fight the unique index.
      if (err && err.code === 11000) {
        try {
          await WhatsAppMessageLog.updateOne(
            { _id: logId, status: "QUEUED" },
            { $set: { status: "SENT", sentAt: new Date() } }
          );
        } catch { /* best-effort */ }
        return false;
      }
      // Transient error — retry a couple of times before giving up.
      metrics.inc("meta_mark_sent_retry");
      if (attempt === MAX_ATTEMPTS) {
        // Leave a safe diagnostic; the record stays QUEUED for reconciliation.
        // NEVER resend Meta because of a local persistence failure.
        metrics.inc("meta_mark_sent_failure");
        metrics.diag("critical", "markSent failed after retries (wamid preserved for reconciliation)", {
          logId, attempts: MAX_ATTEMPTS,
        });
        return false;
      }
      // brief backoff
      await new Promise((r) => setTimeout(r, 50 * attempt));
    }
  }
  return false;
}

/**
 * Mark a log as FAILED with a safe, truncated reason. Best-effort.
 * @param {string} logId
 * @param {string} reason
 * @returns {Promise<boolean>}
 */
async function markFailed(logId, reason) {
  if (!logId) return false;
  try {
    const res = await WhatsAppMessageLog.updateOne(
      { _id: logId, status: { $in: ["QUEUED", "SENT"] } }, // don't clobber DELIVERED/READ
      { $set: { status: "FAILED", failedAt: new Date(), failureReason: safeReason(reason) } }
    );
    return res.modifiedCount > 0;
  } catch {
    return false;
  }
}

/**
 * Phase 21 — Atomic idempotent QUEUED create for Meta sends.
 *
 * Uses the existing partial-unique index on {orderId, event} (orderId is an
 * ObjectId) as the concurrency barrier: the FIRST request to insert a QUEUED
 * row for a given {orderId, event} OWNS the send; a concurrent/retried request
 * hits E11000 and is told a record already exists (so it must NOT send).
 *
 * Returns:
 *   { created:true, doc }                — caller owns the send
 *   { created:false, duplicate:true }    — another attempt already owns it → DO NOT send
 *   { created:false, error:true }        — transient DB error → DO NOT send (fail safe)
 *
 * Requires an orderId (the index only covers rows with an ObjectId orderId).
 * Events without an orderId cannot use this barrier and must be handled by the
 * caller (currently every Meta-wired event supplies an orderId).
 */
async function createQueuedIdempotent(p = {}) {
  if (!p.restaurantId || !p.event || !p.provider || !p.orderId) {
    return { created: false, error: true };
  }
  try {
    const doc = await WhatsAppMessageLog.create({
      restaurantId: p.restaurantId,
      event: p.event,
      provider: p.provider,
      status: "QUEUED",
      recipientPhone: p.recipientPhone || null,
      customerId: p.customerId || null,
      orderId: p.orderId,
      templateName: p.templateName || null,
      category: p.category || null,
      countryCode: p.countryCode || null,
      currency: p.currency || null,
    });
    return { created: true, doc };
  } catch (err) {
    // E11000 on the {orderId,event} partial-unique index → a QUEUED/SENT record
    // already exists for this logical notification. Treat as duplicate (no send).
    if (err && err.code === 11000) return { created: false, duplicate: true };
    return { created: false, error: true };
  }
}

/**
 * Phase 21 — Mark a send outcome as AMBIGUOUS (e.g. network timeout after the
 * request may have reached Meta). We do NOT know if Meta accepted it, so we:
 *   • leave status QUEUED (NOT SENT — no wamid; NOT FAILED — may have delivered)
 *   • record a safe, non-secret marker in failureReason for reconciliation
 * The record stays QUEUED so the idempotency barrier still blocks any resend for
 * the same {orderId,event}, and a later webhook status (with a wamid) can still
 * promote it. Best-effort; never throws.
 */
async function markAmbiguous(logId, note) {
  if (!logId) return false;
  try {
    const res = await WhatsAppMessageLog.updateOne(
      { _id: logId, status: "QUEUED" },
      { $set: { failureReason: safeReason(note || "ambiguous provider result (no wamid)") } }
    );
    return res.modifiedCount > 0;
  } catch {
    return false;
  }
}

module.exports = {
  createQueued,
  createQueuedIdempotent,
  markSent,
  markFailed,
  markAmbiguous,
  verifyIdempotencyIndex,
  _resetIndexCache,
  safeReason,
  STATUS_RANK,
};
