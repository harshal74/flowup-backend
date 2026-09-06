const express = require("express");
const protect = require("../middleware/auth.middleware");
const { connect, callback, syncTemplates, status, setOutbound, diagnostics } = require("../controllers/metaOnboarding.controller");
const { verify: webhookVerify, receive: webhookReceive } = require("../controllers/metaWebhook.controller");

const router = express.Router();

/**
 * Meta webhook (Phase 12) — PUBLIC (server-to-server; no user session).
 * GET verifies the subscription challenge; POST ingests delivery statuses with
 * X-Hub-Signature-256 verification. These must be registered WITHOUT `protect`.
 * Placed before the protected onboarding routes for clarity.
 */
router.get("/webhook", webhookVerify);
router.post("/webhook", webhookReceive);

/**
 * Meta WhatsApp Embedded Signup onboarding (Phase 11).
 *
 * Both routes require an authenticated restaurant admin (protect → req.user).
 * The callback additionally validates a single-use OAuth state that binds the
 * transaction to the initiating restaurant; the trusted tenant identity is
 * recovered from that state, never from client-supplied fields.
 *
 * These endpoints do NOT send WhatsApp messages and do NOT change the active
 * provider (Twilio remains default).
 */
router.post("/connect", protect, connect);
router.post("/callback", protect, callback);

// Phase 16 — read-only, non-secret connection + template status for the admin UI.
router.get("/status", protect, status);

// Phase 20 — per-restaurant Meta outbound enable/disable (protected, tenant-scoped).
router.patch("/outbound", protect, setOutbound);

// Phase 24 — tenant-scoped operational diagnostics (protected, read-only).
router.get("/diagnostics", protect, diagnostics);

// Phase 15B — server-trusted template approval status sync (protected).
router.post("/templates/sync", protect, syncTemplates);

module.exports = router;
