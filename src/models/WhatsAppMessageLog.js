const mongoose = require("mongoose");

/**
 * WhatsAppMessageLog — per-message audit + usage record for WhatsApp sends.
 *
 * Phase 1 (additive foundation): CREATED but NOT wired into any controller or
 * send path. No code writes to this collection yet. It exists so future phases
 * can track transactional (and later marketing) messages, delivery/read status,
 * failures, and usage — for BOTH the current Twilio provider and the future
 * Meta provider.
 *
 * Two orthogonal concepts are deliberately kept SEPARATE:
 *   • event  — WHY the message was sent (business intent), e.g. ORDER_PLACED.
 *   • status — the DELIVERY lifecycle state, e.g. QUEUED → SENT → DELIVERED.
 * Confusing the two is a common modeling mistake; they are distinct fields.
 *
 * Provider-agnostic:
 *   provider is an enum (TWILIO | META) — NOT hard-coded to Meta — so the log
 *   is valid during the Twilio era and after the Meta migration.
 *
 * Conventions follow existing FlowUp models (String restaurantId, ObjectId
 * refs for customer/order, uppercase enums, timestamps).
 */

const whatsAppMessageLogSchema = new mongoose.Schema(
  {
    // ── Tenant + relationships ─────────────────────────────────────
    restaurantId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    // Optional: which customer received it. Marketing/bulk may resolve
    // recipients differently, so not strictly required.
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      default: null,
    },

    // Optional: transactional messages relate to an order; marketing does NOT.
    // Therefore orderId must be nullable (see idempotency index note below).
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
    },

    // ── Provider ───────────────────────────────────────────────────
    provider: {
      type: String,
      enum: ["TWILIO", "META"],
      required: true,
      index: true,
    },

    // Provider message identifier:
    //   • Meta  → wamid
    //   • Twilio → message SID
    // Nullable because a QUEUED/FAILED-before-send message may have no id yet.
    providerMessageId: {
      type: String,
      default: null,
      trim: true,
    },

    // ── Event (business intent) ────────────────────────────────────
    // Kept aligned with FlowUp's existing notification scope, plus MARKETING
    // for the future. Distinct from `status`.
    event: {
      type: String,
      enum: [
        "ORDER_PLACED",
        "ORDER_ACCEPTED",
        "ORDER_REJECTED",
        "OUT_FOR_DELIVERY",
        "DELIVERED",
        "PAYMENT_SUCCESS",
        "BILL",
        "MARKETING",
      ],
      required: true,
      index: true,
    },

    // ── Meta template metadata (null for Twilio free-text era) ─────
    templateName: {
      type: String,
      default: null,
      trim: true,
    },

    // Meta message category — drives billing/pricing. UTILITY for all current
    // transactional notifications; MARKETING for future campaigns.
    category: {
      type: String,
      enum: ["UTILITY", "MARKETING", "AUTHENTICATION", "SERVICE"],
      default: null,
    },

    // ── Recipient ──────────────────────────────────────────────────
    // Stored in canonical E.164 for operational/audit/debug and usage grouping.
    // This is the SAME class of PII already stored on Customer.mobile, so it is
    // not a new privacy exposure; it is stored directly (not masked) to keep
    // the log useful for debugging failed sends where the customer row may be
    // absent (e.g. future marketing to imported lists). May be null if resolved
    // solely via customerId.
    recipientPhone: {
      type: String,
      default: null,
      trim: true,
    },

    // ── Delivery status (lifecycle) ────────────────────────────────
    // QUEUED   : accepted by FlowUp, not yet handed to provider
    // SENT     : provider accepted (Meta "accepted"/"sent", Twilio "queued/sent")
    // DELIVERED: delivered to the recipient device
    // READ     : read by the recipient (Meta read receipt)
    // FAILED   : provider or delivery failure
    status: {
      type: String,
      enum: ["QUEUED", "SENT", "DELIVERED", "READ", "FAILED"],
      default: "QUEUED",
      index: true,
    },

    failureReason: {
      type: String,
      default: null,
      trim: true,
      maxlength: 500,
    },

    // ── Status transition timestamps ───────────────────────────────
    sentAt:      { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    readAt:      { type: Date, default: null },
    failedAt:    { type: Date, default: null },

    // ── Global-readiness metadata (analytics/pricing, non-INR) ─────
    // Country of the recipient/number and currency for cost reporting. Nullable
    // and NOT defaulted to India, keeping reporting country/currency-agnostic.
    countryCode: {
      type: String,
      default: null,
      trim: true,
      uppercase: true,
      minlength: 2,
      maxlength: 2,
    },

    currency: {
      type: String,
      default: null,
      trim: true,
    },
  },
  {
    timestamps: true, // createdAt / updatedAt
  }
);

// ── Indexes ────────────────────────────────────────────────────────
// (1) List messages for a restaurant, newest first (dashboard/usage).
whatsAppMessageLogSchema.index({ restaurantId: 1, createdAt: -1 });

// (2) All messages for an order (transactional history for one order).
whatsAppMessageLogSchema.index({ orderId: 1 });

// (3) Idempotent webhook processing: look up a message by its provider id.
//     Unique + sparse — a providerMessageId is globally unique when present,
//     but is null before send / for pre-send failures, so sparse avoids
//     collisions on null.
whatsAppMessageLogSchema.index(
  { providerMessageId: 1 },
  { unique: true, sparse: true }
);

// (4) Idempotent transactional sends: at most one message per (order, event).
//     This prevents duplicate "order placed" sends on retries WITHOUT blocking
//     legitimately different events for the same order (ORDER_PLACED vs BILL).
//     partialFilterExpression restricts uniqueness to rows that actually have
//     an orderId, so MARKETING messages (orderId = null) are never constrained
//     and multiple marketing messages remain allowed.
whatsAppMessageLogSchema.index(
  { orderId: 1, event: 1 },
  { unique: true, partialFilterExpression: { orderId: { $type: "objectId" } } }
);

// (5) Usage/analytics by country over time (global reporting).
whatsAppMessageLogSchema.index({ restaurantId: 1, countryCode: 1, createdAt: -1 });

// (6) Quickly find failed messages for a restaurant (ops/debugging).
whatsAppMessageLogSchema.index({ restaurantId: 1, status: 1 });

module.exports =
  mongoose.models.WhatsAppMessageLog ||
  mongoose.model("WhatsAppMessageLog", whatsAppMessageLogSchema);
