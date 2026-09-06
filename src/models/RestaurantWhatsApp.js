const mongoose = require("mongoose");

/**
 * RestaurantWhatsApp — one restaurant's Meta WhatsApp Cloud API connection.
 *
 * Phase 1 (additive foundation): this model is CREATED but NOT wired into any
 * controller, route, or send path. Twilio remains the active provider. Nothing
 * writes to this collection yet.
 *
 * Future architecture it supports:
 *   Restaurant → WABA → Phone Number → Meta Cloud API → Customer
 *
 * Ownership model (confirmed in Phase 0):
 *   The restaurant OWNS its Meta Business Portfolio, WABA, and phone number.
 *   FlowUp stores the delegated, per-restaurant access token (encrypted) plus
 *   the Meta identifiers needed to send on the restaurant's behalf.
 *
 * Security:
 *   • The Meta access token is stored ONLY in encrypted form
 *     (accessTokenEncrypted), produced by utils/encrypt.js (AES-256-GCM).
 *     The plaintext token is NEVER stored, and the field name makes the
 *     encrypted nature explicit.
 *   • The Meta App Secret is a FlowUp-global secret and is NOT stored here.
 *   • No restaurant passwords are stored here.
 *
 * Conventions follow existing FlowUp models:
 *   • restaurantId is a String (matches Setting/Order/Customer), required.
 *   • Enum states are uppercase strings.
 *   • timestamps: true supplies createdAt/updatedAt.
 */

const restaurantWhatsAppSchema = new mongoose.Schema(
  {
    // Tenant key — matches the String restaurantId used across FlowUp.
    restaurantId: {
      type: String,
      required: true,
      trim: true,
    },

    // ── Meta identifiers ───────────────────────────────────────────
    // Present once the restaurant completes Embedded Signup. Nullable so a
    // PENDING row can exist before the connection is finalized (future flow).
    wabaId: {
      type: String,
      default: null,
      trim: true,
    },

    phoneNumberId: {
      type: String,
      default: null,
      trim: true,
    },

    // Human-readable display number (E.164), for admin UI/receipts. This is
    // display metadata — routing uses phoneNumberId/wabaId, never this string.
    displayPhoneNumber: {
      type: String,
      default: null,
      trim: true,
    },

    // ISO-3166 alpha-2 country of the WhatsApp number (e.g. "IN", "US", "GB").
    // Stored to keep the architecture globally extensible (pricing/locale/
    // reporting) — NOT defaulted to India.
    countryCode: {
      type: String,
      default: null,
      trim: true,
      uppercase: true,
      minlength: 2,
      maxlength: 2,
    },

    // ── Credentials (encrypted at rest) ────────────────────────────
    // Ciphertext produced by utils/encrypt.js. NEVER plaintext.
    accessTokenEncrypted: {
      type: String,
      default: null,
    },

    // ── Connection lifecycle ───────────────────────────────────────
    // Minimum correct lifecycle (distinguishes the states that require
    // different handling). A separate RECONNECTING state is intentionally
    // NOT added: reconnect reuses CONNECTING, and connectedAt presence
    // distinguishes a first connect from a reconnect.
    //
    // PENDING      : row exists, restaurant has NEVER connected (initial)
    // CONNECTING   : onboarding/reconnect in progress (Embedded Signup running)
    // CONNECTED    : usable connection with valid credentials
    // DISCONNECTED : restaurant intentionally disconnected (temporary)
    // REVOKED      : Meta revoked access / token invalidated
    // ERROR        : last operation failed; needs attention/reconnect
    status: {
      type: String,
      enum: ["PENDING", "CONNECTING", "CONNECTED", "DISCONNECTED", "REVOKED", "ERROR"],
      default: "PENDING",
      index: true,
    },

    // ── Per-restaurant Meta outbound activation gate (Phase 20) ────
    // Second, per-tenant gate on top of the global WHATSAPP_META_OUTBOUND_ENABLED
    // env flag. Meta outbound is permitted for a restaurant ONLY when this is
    // explicitly true AND the global gate is on AND provider=META + CONNECTED +
    // approved template. Default false and fail-closed: legacy documents without
    // this field (undefined) are treated as NOT enabled, so no restaurant becomes
    // Meta-sendable merely because the global flag is turned on.
    metaOutboundEnabled: {
      type: Boolean,
      default: false,
    },

    // ── Provider selection (Phase 2B) ──────────────────────────────
    // Determines which transport adapter sends this restaurant's messages,
    // enabling a mixed migration window (Restaurant A→TWILIO, B→META, …).
    // Defaults to TWILIO so existing/unconnected restaurants keep using the
    // current active provider until Meta is connected. The future resolver
    // will flip this to META only when status === CONNECTED with valid Meta
    // credentials. NOT wired to any send path in this phase.
    provider: {
      type: String,
      enum: ["TWILIO", "META"],
      default: "TWILIO",
    },

    // Free-text detail for the last ERROR/REVOKED transition (no secrets).
    statusReason: {
      type: String,
      default: null,
      trim: true,
      maxlength: 500,
    },

    // ── Meta template approval records (Phase 15A) ─────────────────
    // Per-WABA, per-template, per-language approval state. A Meta send is
    // permitted ONLY when an entry exists with a matching current wabaId +
    // template name + languageCode AND status === "APPROVED" (enforced in
    // whatsapp.service _sendViaMeta). Missing/empty = nothing approved =
    // fail closed. This phase does NOT populate APPROVED records; a future
    // server-trusted sync/admin flow will set them. `name` is the Phase 9
    // canonical template name; `languageCode` matches the Meta template
    // language; `wabaId` binds approval to the WABA it was approved against so
    // a WABA-changing reconnect invalidates stale approvals automatically.
    templates: {
      type: [
        new mongoose.Schema(
          {
            name:         { type: String, required: true, trim: true },
            languageCode: { type: String, required: true, trim: true },
            status: {
              type: String,
              required: true,
              enum: ["APPROVED", "PENDING", "REJECTED", "PAUSED"],
            },
            wabaId:       { type: String, required: true, trim: true },
            approvedAt:   { type: Date, default: null },
          },
          { _id: false }
        ),
      ],
      default: [],
    },

    // ── Timestamps for observability ───────────────────────────────
    connectedAt: {
      type: Date,
      default: null,
    },

    disconnectedAt: {
      type: Date,
      default: null,
    },

    // Last time FlowUp successfully verified/synced this connection with Meta.
    lastVerifiedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true, // createdAt / updatedAt
  }
);

// ── Indexes ────────────────────────────────────────────────────────
// (1) One WhatsApp connection per restaurant (launch assumption). Unique on
//     restaurantId. Using a plain unique index (not partial) because every
//     row is inherently tied to a restaurant. If multi-connection is ever
//     needed, this can be relaxed to a compound unique without a destructive
//     field rename (additive change), so no lock-in.
restaurantWhatsAppSchema.index({ restaurantId: 1 }, { unique: true });

// (2) Reverse lookup used by the future webhook: map an inbound event's
//     phone_number_id → restaurant. Unique + sparse because a phoneNumberId
//     belongs to exactly one restaurant, but is null until connected.
restaurantWhatsAppSchema.index(
  { phoneNumberId: 1 },
  { unique: true, sparse: true }
);

// (3) Reverse lookup by WABA id (webhook entry.id). Unique + sparse for the
//     same reason as phoneNumberId (a WABA maps to one restaurant here, null
//     until connected).
restaurantWhatsAppSchema.index(
  { wabaId: 1 },
  { unique: true, sparse: true }
);

module.exports =
  mongoose.models.RestaurantWhatsApp ||
  mongoose.model("RestaurantWhatsApp", restaurantWhatsAppSchema);
