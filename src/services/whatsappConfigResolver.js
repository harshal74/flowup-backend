/**
 * FlowUp WhatsApp Config Resolver (Phase 7) — INACTIVE.
 *
 * Purpose:
 *   Given a TRUSTED restaurantId, load that restaurant's RestaurantWhatsApp
 *   connection, validate it is a usable Meta connection, decrypt its access
 *   token with the Phase 1 encryption utility, and return the exact config
 *   object that metaProvider.send() expects:
 *       { graphApiBaseUrl, graphApiVersion, phoneNumberId, accessToken }
 *
 * INACTIVE by design:
 *   • Nothing in the active send path calls this. getDefaultProvider() is still
 *     Twilio; _send() is unchanged. This module only PREPARES Meta config for a
 *     future activation phase.
 *   • No network calls. No provider selection. No OAuth/webhook/templates.
 *
 * Security / tenancy:
 *   • restaurantId MUST come from the trusted auth context (req.user.restaurantId).
 *     This module NEVER accepts wabaId / phoneNumberId / accessToken / a
 *     client-supplied restaurantId as the tenant authority.
 *   • The DB query is scoped EXCLUSIVELY by { restaurantId }.
 *   • The decrypted access token is returned to the (server-side) caller but is
 *     NEVER logged, and NEVER included in error objects/messages.
 *
 * Configuration:
 *   • accessToken   → decrypted from RestaurantWhatsApp.accessTokenEncrypted only.
 *   • phoneNumberId → from the tenant's RestaurantWhatsApp record only.
 *   • Encryption key → injected via env WHATSAPP_TOKEN_ENC_KEY (NOT added to
 *     .env in this phase; absent → normalized MISSING_CONFIG failure).
 *   • graphApiBaseUrl / graphApiVersion → non-secret global config from env
 *     (WHATSAPP_GRAPH_BASE_URL / WHATSAPP_GRAPH_VERSION) with safe defaults.
 *     These are NOT secrets and are NOT added to .env here; defaults are used
 *     if unset. See "REMAINS TO CONFIGURE" in the Phase 7 report.
 */

const RestaurantWhatsApp = require("../models/RestaurantWhatsApp");
const { decrypt } = require("../utils/encrypt");
const { ERROR_CODES, PROVIDERS } = require("./providers/types");

// Non-secret global Graph API config (safe defaults; overridable via env).
// Base URL + version are NOT secrets. They are intentionally NOT written to
// .env in this phase; if unset, these documented defaults apply.
const GRAPH_BASE_URL = process.env.WHATSAPP_GRAPH_BASE_URL || "https://graph.facebook.com";
const GRAPH_VERSION  = process.env.WHATSAPP_GRAPH_VERSION  || "v21.0";

/**
 * Build a normalized failure using the existing provider error taxonomy so
 * callers never depend on resolver-specific error shapes. Never contains the
 * token or encryption internals.
 */
function fail(code, message) {
  return { ok: false, error: { code, message } };
}

/**
 * Resolve the Meta send config for a trusted restaurantId.
 *
 * @param {string} restaurantId TRUSTED tenant id (from req.user.restaurantId).
 * @returns {Promise<
 *   | { ok: true, config: { graphApiBaseUrl, graphApiVersion, phoneNumberId, accessToken } }
 *   | { ok: false, error: { code: string, message: string } }
 * >}
 */
async function resolveMetaConfig(restaurantId) {
  // ── Tenant identity guard ─────────────────────────────────────
  if (!restaurantId || typeof restaurantId !== "string" || !restaurantId.trim()) {
    return fail(ERROR_CODES.PROVIDER_UNAVAILABLE, "restaurantId is required.");
  }

  // ── Encryption key (injected via env; not in .env this phase) ──
  const encKey = process.env.WHATSAPP_TOKEN_ENC_KEY;
  if (!encKey) {
    return fail(ERROR_CODES.PROVIDER_UNAVAILABLE, "WhatsApp token encryption key not configured.");
  }

  // ── Tenant-scoped lookup (ONLY by restaurantId) ───────────────
  let record;
  try {
    record = await RestaurantWhatsApp.findOne({ restaurantId: restaurantId.trim() }).lean();
  } catch (dbErr) {
    return fail(ERROR_CODES.PROVIDER_UNAVAILABLE, "Failed to load WhatsApp connection.");
  }

  if (!record) {
    return fail(ERROR_CODES.DISCONNECTED, "No WhatsApp connection for this restaurant.");
  }

  // ── Provider must be META ─────────────────────────────────────
  if (record.provider !== PROVIDERS.META) {
    return fail(ERROR_CODES.DISCONNECTED, "Restaurant is not configured to use Meta.");
  }

  // ── Must be CONNECTED (usable) ────────────────────────────────
  if (record.status !== "CONNECTED") {
    return fail(ERROR_CODES.DISCONNECTED, `WhatsApp connection is not usable (status: ${record.status}).`);
  }

  // ── Required identifiers present ──────────────────────────────
  if (!record.phoneNumberId) {
    return fail(ERROR_CODES.DISCONNECTED, "WhatsApp connection is missing phoneNumberId.");
  }
  if (!record.accessTokenEncrypted) {
    return fail(ERROR_CODES.AUTH_FAILED, "WhatsApp connection is missing an access token.");
  }

  // ── Decrypt token (never logged, never in errors) ─────────────
  let accessToken;
  try {
    accessToken = decrypt(record.accessTokenEncrypted, encKey);
  } catch (decErr) {
    // Do NOT surface decryption internals or any token material.
    return fail(ERROR_CODES.AUTH_FAILED, "Failed to decrypt WhatsApp access token.");
  }

  if (!accessToken) {
    return fail(ERROR_CODES.AUTH_FAILED, "Decrypted WhatsApp access token is empty.");
  }

  if (!GRAPH_BASE_URL || !GRAPH_VERSION) {
    return fail(ERROR_CODES.PROVIDER_UNAVAILABLE, "Graph API configuration is incomplete.");
  }

  // ── Exact metaProvider.send() config shape ────────────────────
  // Also exposes non-secret approval metadata (wabaId + templates) so the send
  // path can enforce the Phase 15A per-template approval gate WITHOUT a second
  // tenant lookup. NO secret (token/appSecret/key) beyond accessToken is added.
  return {
    ok: true,
    config: {
      graphApiBaseUrl: GRAPH_BASE_URL,
      graphApiVersion: GRAPH_VERSION,
      phoneNumberId: record.phoneNumberId,
      accessToken, // server-side only — caller must not log this
      // Non-secret approval metadata (Phase 15A):
      wabaId: record.wabaId || null,
      templates: Array.isArray(record.templates) ? record.templates : [],
    },
  };
}

module.exports = { resolveMetaConfig };
