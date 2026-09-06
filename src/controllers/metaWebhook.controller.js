/**
 * FlowUp WhatsApp — Meta webhook controller (Phase 12). INBOUND ONLY.
 *
 * GET  → Meta subscription verification (hub.challenge).
 * POST → signature-verified delivery-status ingestion.
 *
 * Public routes (no `protect`): Meta calls these server-to-server. Authenticity
 * is established by the verify token (GET) and X-Hub-Signature-256 (POST), NOT
 * by a user session. No outbound message is ever sent from here.
 */

const { verifyMetaSignature, processWebhook } = require("../services/metaWebhookService");
const metrics = require("../services/whatsappMetrics");

// GET /api/whatsapp/meta/webhook
const verify = (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  const expected = process.env.META_WEBHOOK_VERIFY_TOKEN;

  if (mode === "subscribe" && expected && token === expected && typeof challenge === "string") {
    // Echo the challenge back verbatim on success.
    return res.status(200).send(challenge);
  }
  // Do not reveal whether the token or the mode was the problem.
  return res.sendStatus(403);
};

// POST /api/whatsapp/meta/webhook
const receive = async (req, res) => {
  try {
    const appSecret = process.env.META_APP_SECRET;
    const signature = req.headers["x-hub-signature-256"];
    const rawBody = req.rawBody; // captured by express.json verify hook

    // Verify BEFORE treating the payload as trusted data.
    if (!appSecret || typeof rawBody !== "string" || !verifyMetaSignature(rawBody, signature, appSecret)) {
      metrics.inc("meta_webhook_signature_failure");
      return res.sendStatus(401);
    }

    // Authenticated. Process idempotently; never throw for unknown payloads.
    const summary = await processWebhook(req.body || {});
    if (summary && summary.unmatched > 0) metrics.inc("meta_webhook_unmatched", summary.unmatched);

    // Acknowledge so Meta does not retry (even for unmatched/unknown events).
    return res.sendStatus(200);
  } catch (error) {
    // Log a safe message only — never the payload or any secret.
    console.error("Meta webhook error:", error.message || "unknown");
    // Still 200 to avoid infinite Meta retries on a permanently-unprocessable event.
    return res.sendStatus(200);
  }
};

module.exports = { verify, receive };
