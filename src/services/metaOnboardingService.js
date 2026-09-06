/**
 * FlowUp WhatsApp — Meta Embedded Signup onboarding service (Phase 11).
 *
 * Responsibilities (backend only):
 *   • Generate a secure, single-use, expiring OAuth `state` bound to the
 *     authenticated restaurant, and build the Meta authorization config.
 *   • On callback: validate state → exchange code (server-side) → resolve
 *     WABA + phone metadata → encrypt token → upsert RestaurantWhatsApp
 *     (provider=META, status=CONNECTED), all scoped to the TRUSTED restaurantId
 *     recovered from the validated state (never from client input).
 *
 * INACTIVE for sending: nothing here calls metaProvider.send / whatsapp.service.
 * Persisting META+CONNECTED does NOT trigger any message. Twilio stays default.
 *
 * Security:
 *   • HTTP is dependency-injected (createOnboardingService(httpClient)) so tests
 *     never contact Meta. No new package.
 *   • App Secret, access token, authorization code, and encryption key are
 *     NEVER logged, NEVER returned to the frontend, NEVER placed in errors.
 */

const crypto = require("crypto");
const RestaurantWhatsApp = require("../models/RestaurantWhatsApp");
const MetaOAuthState = require("../models/MetaOAuthState");
const { encrypt } = require("../utils/encrypt");
const { ERROR_CODES } = require("./providers/types");

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

// Non-secret Graph config (safe defaults; overridable via env; NOT added to .env).
function graphConfig() {
  return {
    baseUrl: process.env.WHATSAPP_GRAPH_BASE_URL || "https://graph.facebook.com",
    version: process.env.WHATSAPP_GRAPH_VERSION || "v21.0",
  };
}

// Meta app configuration — read from runtime env only; never hardcoded.
function metaAppConfig() {
  return {
    appId: process.env.META_APP_ID,
    appSecret: process.env.META_APP_SECRET,
    configId: process.env.META_EMBEDDED_SIGNUP_CONFIG_ID,
    redirectUri: process.env.META_REDIRECT_URI,
  };
}

function createOnboardingService(httpClient) {
  const doHttp =
    httpClient ||
    (typeof fetch === "function" ? (url, opts) => fetch(url, opts) : null);

  /**
   * Initiate onboarding for a TRUSTED restaurantId.
   * Creates a single-use state and returns FRONTEND-SAFE authorization config.
   * Returns NO secrets (no appSecret, no token).
   */
  async function initiate(restaurantId) {
    if (!restaurantId || typeof restaurantId !== "string" || !restaurantId.trim()) {
      return fail(ERROR_CODES.PROVIDER_UNAVAILABLE, "restaurantId is required.");
    }
    const app = metaAppConfig();
    if (!app.appId || !app.configId || !app.redirectUri) {
      return fail(ERROR_CODES.PROVIDER_UNAVAILABLE, "Meta app is not configured.");
    }

    const state = crypto.randomBytes(32).toString("hex");
    try {
      await MetaOAuthState.create({
        state,
        restaurantId: restaurantId.trim(),
        used: false,
        expiresAt: new Date(Date.now() + STATE_TTL_MS),
      });
    } catch {
      return fail(ERROR_CODES.PROVIDER_UNAVAILABLE, "Could not initialize onboarding.");
    }

    // Frontend-safe payload only — the JS SDK uses appId + configId; the
    // callback uses redirectUri. NO secret is included.
    return {
      ok: true,
      data: {
        appId: app.appId,
        configId: app.configId,
        redirectUri: app.redirectUri,
        state,
      },
    };
  }

  /**
   * Validate + consume state exactly once. Returns the trusted restaurantId.
   */
  async function _consumeState(state) {
    if (!state || typeof state !== "string") {
      return fail(ERROR_CODES.AUTH_FAILED, "Missing OAuth state.");
    }
    // Atomically mark used only if currently unused AND not expired.
    const now = new Date();
    const doc = await MetaOAuthState.findOneAndUpdate(
      { state, used: false, expiresAt: { $gt: now } },
      { $set: { used: true, usedAt: now } },
      { new: true }
    );
    if (!doc) {
      // Missing, mismatched, expired, or already used — all indistinguishable to caller.
      return fail(ERROR_CODES.AUTH_FAILED, "Invalid, expired, or already-used OAuth state.");
    }
    return { ok: true, restaurantId: doc.restaurantId };
  }

  /**
   * Handle the OAuth callback.
   * @param {Object} params { code, state }  — from Meta redirect query.
   * @returns normalized result. On success: { ok:true, data:{ status, phoneNumberId, wabaId, displayPhoneNumber, countryCode } } (NO token).
   */
  async function handleCallback({ code, state } = {}) {
    // 1) Validate + consume state FIRST. Do NOT exchange code if invalid.
    const consumed = await _consumeState(state);
    if (!consumed.ok) return consumed;
    const restaurantId = consumed.restaurantId; // TRUSTED tenant

    if (!code || typeof code !== "string") {
      return fail(ERROR_CODES.AUTH_FAILED, "Missing authorization code.");
    }

    // 2) Config prerequisites.
    const app = metaAppConfig();
    const encKey = process.env.WHATSAPP_TOKEN_ENC_KEY;
    if (!app.appId || !app.appSecret || !app.redirectUri) {
      return fail(ERROR_CODES.PROVIDER_UNAVAILABLE, "Meta app is not configured.");
    }
    if (!encKey) {
      return fail(ERROR_CODES.PROVIDER_UNAVAILABLE, "Token encryption key not configured.");
    }
    if (!doHttp) {
      return fail(ERROR_CODES.PROVIDER_UNAVAILABLE, "No HTTP client available.");
    }

    const { baseUrl, version } = graphConfig();

    // 3) Exchange code → access token (server-side).
    let accessToken;
    try {
      const url = `${baseUrl}/${version}/oauth/access_token`;
      const body = {
        client_id: app.appId,
        client_secret: app.appSecret, // server-side only, never logged/returned
        redirect_uri: app.redirectUri,
        code,
      };
      const resp = await doHttp(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = typeof resp?.json === "function" ? await resp.json() : null;
      if (!(resp?.status >= 200 && resp?.status < 300) || !data?.access_token) {
        return fail(ERROR_CODES.AUTH_FAILED, "Failed to exchange authorization code.");
      }
      accessToken = data.access_token;
    } catch {
      return fail(ERROR_CODES.PROVIDER_UNAVAILABLE, "Token exchange request failed.");
    }

    // 4) Resolve WABA + phone metadata (server-verified, never client-supplied).
    let wabaId = null, phoneNumberId = null, displayPhoneNumber = null, countryCode = null;
    try {
      // Shared WABAs for this Business Integration System User token.
      const wabaUrl = `${baseUrl}/${version}/me/whatsapp_business_accounts`;
      const wabaResp = await doHttp(wabaUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` }, // never logged
      });
      const wabaData = typeof wabaResp?.json === "function" ? await wabaResp.json() : null;
      wabaId = wabaData?.data?.[0]?.id || null;
      if (!wabaId) {
        return fail(ERROR_CODES.PERMISSION_DENIED, "No WhatsApp Business Account available.");
      }

      const phoneUrl = `${baseUrl}/${version}/${wabaId}/phone_numbers`;
      const phoneResp = await doHttp(phoneUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const phoneData = typeof phoneResp?.json === "function" ? await phoneResp.json() : null;
      const first = phoneData?.data?.[0] || null;
      phoneNumberId = first?.id || null;
      displayPhoneNumber = first?.display_phone_number || null;
      // Meta may expose the number's country; keep null if absent (no inference).
      countryCode = (first?.country_code || first?.countryCode || null);
      if (typeof countryCode === "string") countryCode = countryCode.toUpperCase().slice(0, 2) || null;

      if (!phoneNumberId) {
        return fail(ERROR_CODES.DISCONNECTED, "No usable WhatsApp phone number found.");
      }
    } catch {
      return fail(ERROR_CODES.PROVIDER_UNAVAILABLE, "Failed to resolve WhatsApp assets.");
    }

    // 5) Encrypt token (never persist/return plaintext).
    let accessTokenEncrypted;
    try {
      accessTokenEncrypted = encrypt(accessToken, encKey);
    } catch {
      return fail(ERROR_CODES.PROVIDER_UNAVAILABLE, "Failed to secure the access token.");
    } finally {
      accessToken = null; // drop plaintext from scope ASAP
    }

    // 6) Tenant-scoped upsert — ONLY for the trusted restaurantId.
    try {
      const now = new Date();
      await RestaurantWhatsApp.findOneAndUpdate(
        { restaurantId },
        {
          $set: {
            restaurantId,
            provider: "META",
            status: "CONNECTED",
            statusReason: null,
            wabaId,
            phoneNumberId,
            displayPhoneNumber,
            ...(countryCode ? { countryCode } : {}),
            accessTokenEncrypted,
            connectedAt: now,
            lastVerifiedAt: now,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
    } catch {
      return fail(ERROR_CODES.PROVIDER_UNAVAILABLE, "Failed to persist WhatsApp connection.");
    }

    // Frontend-safe result — NO token, NO secret.
    return {
      ok: true,
      data: {
        status: "CONNECTED",
        provider: "META",
        wabaId,
        phoneNumberId,
        displayPhoneNumber,
        countryCode: countryCode || null,
      },
    };
  }

  return { initiate, handleCallback, _consumeState };
}

const onboardingService = createOnboardingService();

module.exports = onboardingService;
module.exports.createOnboardingService = createOnboardingService;
