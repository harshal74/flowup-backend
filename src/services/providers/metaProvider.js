/**
 * FlowUp WhatsApp Provider — Meta Cloud API adapter (Phase 4).
 *
 * TRANSPORT ONLY. INACTIVE. This adapter conforms to the Phase 2A provider
 * contract (provider.send(input) → Promise<SendMessageResult>, provider.id
 * === "META") but is NOT selected by getDefaultProvider(). Twilio remains the
 * active provider. No real Meta request is made unless a caller explicitly
 * supplies a real config + real HTTP client in a future phase.
 *
 * Strict boundaries (per Phase 4 scope):
 *   • Does NOT resolve restaurantId, query RestaurantWhatsApp, read env vars,
 *     decrypt tokens, touch JWT/request, select providers, or write the DB.
 *   • Receives EVERYTHING via input: recipient, body/template, and `config`
 *     ({ graphApiBaseUrl, graphApiVersion, phoneNumberId, accessToken }).
 *   • HTTP is dependency-injected (createMetaProvider(httpClient)) so tests run
 *     with a fake client and NO network access. No new npm dependency added.
 *   • Never logs / returns / throws the access token or Authorization header.
 *
 * Graph API contract (from Phase 3 audit):
 *   POST {base}/{version}/{phoneNumberId}/messages
 *   Authorization: Bearer <accessToken>
 *   Content-Type: application/json
 *   Success: { messages: [ { id: "wamid..." } ] } → providerMessageId
 *   Error:   { error: { message, type, code, error_subcode, fbtrace_id } }
 */

const { PROVIDERS, SEND_STATUS, ERROR_CODES } = require("./types");

// ── Recipient handling ────────────────────────────────────────────
// The Phase 2B boundary already yields bare E.164 ("+14155551234").
// Meta's `to` field wants digits only (no "+"), and NEVER the Twilio
// "whatsapp:" prefix. We do NOT infer a country or add +91.
function toMetaRecipient(e164) {
  if (typeof e164 !== "string") return null;
  const trimmed = e164.trim();
  if (!/^\+[1-9]\d{7,14}$/.test(trimmed)) return null; // structural E.164
  return trimmed.slice(1); // strip leading "+"
}

// ── Error normalization ───────────────────────────────────────────
// Map Meta error codes / HTTP status into the existing Phase 2A taxonomy.
// Preserves the Meta numeric code in the message in a SAFE form (no secrets).
function mapMetaError({ httpStatus, metaError } = {}) {
  const code = metaError?.code;
  const subcode = metaError?.error_subcode;

  // HTTP-status-driven classification first (deterministic).
  if (httpStatus === 401) {
    return { code: ERROR_CODES.AUTH_FAILED, message: "Meta authentication failed.", retriable: false };
  }
  if (httpStatus === 403) {
    return { code: ERROR_CODES.PERMISSION_DENIED, message: "Meta permission denied.", retriable: false };
  }
  if (httpStatus === 429) {
    return { code: ERROR_CODES.RATE_LIMITED, message: "Meta rate limited.", retriable: true };
  }
  if (typeof httpStatus === "number" && httpStatus >= 500) {
    return { code: ERROR_CODES.PROVIDER_UNAVAILABLE, message: "Meta temporarily unavailable.", retriable: true };
  }

  // Meta application error codes (subset — safe, well-known mappings).
  // 190 = invalid/expired access token; 200/10/803 = permission issues.
  if (code === 190) {
    return { code: ERROR_CODES.AUTH_FAILED, message: "Meta access token invalid or expired.", retriable: false };
  }
  if (code === 200 || code === 10 || code === 803) {
    return { code: ERROR_CODES.PERMISSION_DENIED, message: `Meta permission error (code ${code}).`, retriable: false };
  }
  if (code === 4 || code === 80007 || code === 130429) {
    return { code: ERROR_CODES.RATE_LIMITED, message: `Meta rate limit (code ${code}).`, retriable: true };
  }
  // 131026 = message undeliverable / not a WhatsApp user / bad recipient.
  if (code === 131026 || code === 131051 || code === 131047) {
    return { code: ERROR_CODES.INVALID_RECIPIENT, message: `Meta could not deliver to recipient (code ${code}).`, retriable: false };
  }
  // 132xxx = template errors (missing / not approved / param mismatch).
  if ((typeof code === "number" && code >= 132000 && code < 133000) || subcode === 2494010) {
    return { code: ERROR_CODES.TEMPLATE_REJECTED, message: `Meta template error (code ${code}).`, retriable: false };
  }
  if (code === 131000 || code === 131056) {
    return { code: ERROR_CODES.PROVIDER_UNAVAILABLE, message: `Meta transient error (code ${code}).`, retriable: true };
  }

  return {
    code: ERROR_CODES.UNKNOWN,
    message: code ? `Meta error (code ${code}).` : "Unknown Meta error.",
    retriable: false,
  };
}

// ── Payload builders ──────────────────────────────────────────────
function buildTextPayload(to, body) {
  return { messaging_product: "whatsapp", to, type: "text", text: { body } };
}

function buildTemplatePayload(to, template) {
  const languageCode =
    (template.language && (template.language.code || template.language)) || "en";
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: template.name,
      language: { code: languageCode },
      components: Array.isArray(template.components) ? template.components : [],
    },
  };
  return payload;
}

// ── Factory: allows HTTP injection for tests (no real network) ─────
// httpClient(url, { method, headers, body }) → Promise<{ status, json() }>
// Defaults to global fetch if present; if absent, send() fails safely with a
// normalized PROVIDER_UNAVAILABLE error (never throws).
function createMetaProvider(httpClient) {
  const doHttp =
    httpClient ||
    (typeof fetch === "function"
      ? (url, opts) => fetch(url, opts)
      : null);

  /**
   * @param {import("./types").SendMessageInput} input
   * @returns {Promise<import("./types").SendMessageResult>}
   */
  async function send(input) {
    const { to, body, template, event = "notification", config } = input || {};

    const fail = (error, recipient = to || null) => ({
      success: false,
      provider: PROVIDERS.META,
      providerMessageId: null,
      status: SEND_STATUS.FAILED,
      recipient,
      error,
    });

    // ── Config validation (no env access; injected only) ──────────
    if (!config || !config.graphApiBaseUrl || !config.graphApiVersion ||
        !config.phoneNumberId || !config.accessToken) {
      return fail({
        code: ERROR_CODES.PROVIDER_UNAVAILABLE,
        message: "Meta provider not configured.",
        retriable: false,
      });
    }

    // ── Recipient normalization ───────────────────────────────────
    const metaTo = toMetaRecipient(to);
    if (!metaTo) {
      return fail({
        code: ERROR_CODES.INVALID_RECIPIENT,
        message: "Invalid or missing recipient.",
        retriable: false,
      });
    }

    // ── Message type selection (never silently convert) ───────────
    let payload;
    if (template) {
      if (!template.name) {
        return fail({
          code: ERROR_CODES.TEMPLATE_REJECTED,
          message: "Template name is required.",
          retriable: false,
        }, to);
      }
      payload = buildTemplatePayload(metaTo, template);
    } else if (typeof body === "string" && body.length > 0) {
      payload = buildTextPayload(metaTo, body);
    } else {
      // Neither template nor body — closest existing non-retriable code.
      return fail({
        code: ERROR_CODES.UNKNOWN,
        message: "No message body or template supplied.",
        retriable: false,
      }, to);
    }

    if (!doHttp) {
      return fail({
        code: ERROR_CODES.PROVIDER_UNAVAILABLE,
        message: "No HTTP client available.",
        retriable: true,
      });
    }

    const base = String(config.graphApiBaseUrl).replace(/\/+$/, "");
    const url = `${base}/${config.graphApiVersion}/${config.phoneNumberId}/messages`;

    let response;
    try {
      response = await doHttp(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.accessToken}`, // never logged/returned
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (networkErr) {
      // Network/DNS/timeout — safe, no secret leak.
      console.error(`[WhatsApp][META] ✗ [${event}] network error`);
      return fail({
        code: ERROR_CODES.PROVIDER_UNAVAILABLE,
        message: "Meta request failed (network).",
        retriable: true,
      });
    }

    const httpStatus = response?.status;
    let data = null;
    try {
      data = typeof response?.json === "function" ? await response.json() : null;
    } catch {
      data = null;
    }

    // ── Success: 2xx AND a valid wamid present ────────────────────
    if (typeof httpStatus === "number" && httpStatus >= 200 && httpStatus < 300) {
      const wamid = data?.messages?.[0]?.id || null;
      if (wamid) {
        console.log(`[WhatsApp][META] ✓ [${event}] wamid=${wamid} → +${metaTo}`);
        return {
          success: true,
          provider: PROVIDERS.META,
          providerMessageId: wamid,
          status: SEND_STATUS.SENT,
          recipient: to,
          error: null,
        };
      }
      // 2xx without a message id — treat as provider anomaly.
      return fail({
        code: ERROR_CODES.PROVIDER_UNAVAILABLE,
        message: "Meta returned success without a message id.",
        retriable: true,
      });
    }

    // ── Error normalization ───────────────────────────────────────
    const normalized = mapMetaError({ httpStatus, metaError: data?.error });
    console.error(`[WhatsApp][META] ✗ [${event}] → +${metaTo} | ${normalized.code}`);
    return fail(normalized);
  }

  return {
    id: PROVIDERS.META,
    send,
    // exported for unit checks (no secrets involved)
    toMetaRecipient,
    mapMetaError,
    buildTextPayload,
    buildTemplatePayload,
  };
}

// Default instance uses global fetch (if present) as its HTTP client. It is
// registered in the provider registry but is NEVER selected by
// getDefaultProvider(), so it stays unreachable from the active send path.
const metaProvider = createMetaProvider();

module.exports = metaProvider;
module.exports.createMetaProvider = createMetaProvider;
