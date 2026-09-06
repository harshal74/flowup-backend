/**
 * FlowUp WhatsApp — Meta Embedded Signup onboarding controller (Phase 11).
 *
 * INACTIVE for sending. These endpoints only persist restaurant-owned Meta
 * credentials (encrypted). They never send a WhatsApp message and never change
 * the default provider (Twilio remains active).
 *
 * Tenant identity:
 *   • initiate: from req.user.restaurantId (protect middleware — trusted DB Admin).
 *   • callback: from the validated single-use OAuth state, NOT from query params.
 */

const onboardingService = require("../services/metaOnboardingService");
const templateSyncService = require("../services/metaTemplateSyncService");
const RestaurantWhatsApp = require("../models/RestaurantWhatsApp");
const WhatsAppMessageLog = require("../models/WhatsAppMessageLog");
const metrics = require("../services/whatsappMetrics");
const { verifyIdempotencyIndex } = require("../services/whatsappMessageLog.service");

// POST /api/whatsapp/meta/connect  (protected)
// Returns frontend-safe Embedded Signup config + a single-use state.
const connect = async (req, res) => {
  try {
    const restaurantId = req.user?.restaurantId;
    if (!restaurantId) {
      return res.status(400).json({ success: false, message: "Restaurant context is required." });
    }
    const result = await onboardingService.initiate(restaurantId);
    if (!result.ok) {
      return res.status(400).json({ success: false, message: result.error.message, code: result.error.code });
    }
    return res.status(200).json({ success: true, data: result.data });
  } catch (error) {
    console.error("Meta connect error:", error.message || error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// POST /api/whatsapp/meta/callback  (protected)
// Body: { code, state }. Tenant identity comes from the validated state only.
const callback = async (req, res) => {
  try {
    const { code, state } = req.body || {};
    const result = await onboardingService.handleCallback({ code, state });
    if (!result.ok) {
      return res.status(400).json({ success: false, message: result.error.message, code: result.error.code });
    }
    return res.status(200).json({ success: true, message: "WhatsApp connected", data: result.data });
  } catch (error) {
    console.error("Meta callback error:", error.message || error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// POST /api/whatsapp/meta/templates/sync  (protected)
// Server-trusted: restaurantId from req.user, wabaId from DB, status from Meta.
// Optional body.event scopes the sync to one canonical FlowUp template.
// The client CANNOT supply restaurantId / wabaId / status / approved / approvedAt.
const syncTemplates = async (req, res) => {
  try {
    const restaurantId = req.user?.restaurantId;
    if (!restaurantId) {
      return res.status(400).json({ success: false, message: "Restaurant context is required." });
    }
    const event = typeof req.body?.event === "string" ? req.body.event : undefined;
    const result = await templateSyncService.syncTemplates(restaurantId, { event });
    if (!result.ok) {
      return res.status(400).json({ success: false, message: result.error.message, code: result.error.code });
    }
    return res.status(200).json({ success: true, message: "Template statuses synced", data: result.data });
  } catch (error) {
    console.error("Meta template sync error:", error.message || error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// GET /api/whatsapp/meta/status  (protected)
// Read-only, NON-SECRET view of the restaurant's Meta WhatsApp connection +
// template approval status, for the admin UI (Phase 16). NEVER returns the
// access token (encrypted or not), App Secret, or any credential. Tenant is
// req.user.restaurantId only. Performs NO Meta API call and NO send.
const status = async (req, res) => {
  try {
    const restaurantId = req.user?.restaurantId;
    if (!restaurantId) {
      return res.status(400).json({ success: false, message: "Restaurant context is required." });
    }

    // Exclude the encrypted token explicitly — defense in depth.
    const record = await RestaurantWhatsApp.findOne({ restaurantId })
      .select("-accessTokenEncrypted")
      .lean();

    if (!record) {
      // No Meta connection yet — the restaurant is on the default (Twilio) path.
      return res.status(200).json({
        success: true,
        data: { connected: false, provider: null, status: null, metaOutboundEnabled: false, templates: [] },
      });
    }

    const templates = Array.isArray(record.templates)
      ? record.templates.map((t) => ({
          name: t.name,
          languageCode: t.languageCode,
          status: t.status,
          wabaId: t.wabaId,
          approvedAt: t.approvedAt || null,
        }))
      : [];

    return res.status(200).json({
      success: true,
      data: {
        connected: record.status === "CONNECTED",
        provider: record.provider || null,
        status: record.status || null,
        metaOutboundEnabled: record.metaOutboundEnabled === true,
        statusReason: record.statusReason || null,
        wabaId: record.wabaId || null,
        phoneNumberId: record.phoneNumberId || null,
        displayPhoneNumber: record.displayPhoneNumber || null,
        countryCode: record.countryCode || null,
        connectedAt: record.connectedAt || null,
        lastVerifiedAt: record.lastVerifiedAt || null,
        templates,
      },
    });
  } catch (error) {
    console.error("Meta status error:", error.message || error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// PATCH /api/whatsapp/meta/outbound  (protected)
// Toggle THIS restaurant's per-restaurant Meta outbound gate (Phase 20).
// Tenant is req.user.restaurantId ONLY. The client may supply only a boolean
// `enabled`; restaurantId/wabaId/provider/status/approval from the body are
// IGNORED. This flag alone does NOT activate Meta — the global gate,
// connection status, and template approval still apply at send time.
const setOutbound = async (req, res) => {
  try {
    const restaurantId = req.user?.restaurantId;
    if (!restaurantId) {
      return res.status(400).json({ success: false, message: "Restaurant context is required." });
    }
    if (typeof req.body?.enabled !== "boolean") {
      return res.status(400).json({ success: false, message: "`enabled` must be a boolean." });
    }
    const enabled = req.body.enabled;

    // Update ONLY this restaurant's record, and ONLY the flag. Never upsert
    // (a restaurant must complete Meta onboarding before this is meaningful).
    const updated = await RestaurantWhatsApp.findOneAndUpdate(
      { restaurantId },
      { $set: { metaOutboundEnabled: enabled } },
      { new: true }
    ).select("-accessTokenEncrypted").lean();

    if (!updated) {
      return res.status(404).json({ success: false, message: "No WhatsApp connection for this restaurant." });
    }

    return res.status(200).json({
      success: true,
      message: enabled ? "Meta outbound enabled for this restaurant" : "Meta outbound disabled for this restaurant",
      data: { metaOutboundEnabled: updated.metaOutboundEnabled === true },
    });
  } catch (error) {
    console.error("Meta outbound toggle error:", error.message || error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// GET /api/whatsapp/meta/diagnostics  (protected)
// Tenant-scoped operational visibility (Phase 24). Returns process-local metric
// counters, live idempotency-index readiness, and THIS restaurant's stuck
// QUEUED Meta messages (older than a threshold, missing providerMessageId).
// NO secrets. Read-only. Never triggers a send. Never exposes another tenant.
const STUCK_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes

const diagnostics = async (req, res) => {
  try {
    const restaurantId = req.user?.restaurantId;
    if (!restaurantId) {
      return res.status(400).json({ success: false, message: "Restaurant context is required." });
    }

    const indexReady = await verifyIdempotencyIndex();

    // Stuck = QUEUED + META + no wamid + older than threshold, scoped to tenant.
    const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS);
    let stuck = [];
    try {
      stuck = await WhatsAppMessageLog.find({
        restaurantId,                 // tenant boundary (server-derived)
        provider: "META",
        status: "QUEUED",
        providerMessageId: null,
        createdAt: { $lt: cutoff },
      })
        .select("_id event orderId createdAt failureReason")
        .sort({ createdAt: 1 })
        .limit(100)
        .lean();
    } catch (e) {
      stuck = [];
    }

    return res.status(200).json({
      success: true,
      data: {
        idempotencyIndexReady: indexReady,
        counters: metrics.snapshot(),
        stuckQueued: stuck.map((s) => ({
          logId: String(s._id),
          event: s.event,
          orderId: s.orderId ? String(s.orderId) : null,
          createdAt: s.createdAt,
          note: s.failureReason || null,
        })),
        stuckThresholdMinutes: STUCK_THRESHOLD_MS / 60000,
      },
    });
  } catch (error) {
    console.error("Meta diagnostics error:", error.message || error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

module.exports = { connect, callback, syncTemplates, status, setOutbound, diagnostics };
