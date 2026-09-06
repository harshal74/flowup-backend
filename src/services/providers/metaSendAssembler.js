/**
 * FlowUp WhatsApp — Meta Send Assembler (Phase 10). INACTIVE.
 *
 * Purpose:
 *   Pure orchestration that connects the existing, independent Meta pieces into
 *   ONE prepared Meta send operation — WITHOUT sending and WITHOUT touching the
 *   active send path:
 *
 *     restaurantId
 *        → resolveProviderForRestaurant()   (Phase 8: provider + config; META only)
 *        → buildMetaTemplate()              (Phase 9: canonical UTILITY template)
 *        → normalizeE164()                  (Phase 2B: E.164 recipient)
 *        → { provider, input } ready for provider.send(input)
 *
 * INACTIVE by design:
 *   • This does NOT call provider.send(). It returns a PREPARED operation so a
 *     test can execute it explicitly with a fake HTTP client. Constructing the
 *     result never sends anything.
 *   • Nothing in the active application path imports or calls this. Twilio stays
 *     the default provider; getDefaultProvider() and _send() are unchanged.
 *   • Zero direct DB queries (only indirectly via resolveProviderForRestaurant
 *     → resolveMetaConfig). Zero HTTP. No token decryption here. No secret logs.
 *
 * Security:
 *   • The prepared input.config.accessToken exists transiently because
 *     metaProvider.send() requires it, but this module NEVER logs it and NEVER
 *     serializes the full input into an error message.
 */

const { resolveProviderForRestaurant } = require("./resolveProvider");
const { buildMetaTemplate } = require("./templateRegistry");
const { normalizeE164 } = require("../../utils/phoneE164");
const { PROVIDERS, ERROR_CODES } = require("./types");

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

/**
 * Assemble (but do NOT send) a Meta WhatsApp operation.
 *
 * @param {Object} args
 * @param {string} args.restaurantId   TRUSTED tenant id (from req.user.restaurantId).
 * @param {string} args.event          template event key (e.g. "ORDER_PLACED").
 * @param {string} args.recipient      customer phone (E.164, or national + countryContext).
 * @param {Object} args.templateInput  values for buildMetaTemplate parameters.
 * @param {string} [args.languageCode] optional Meta language code.
 * @param {string} [args.countryContext] optional ISO alpha-2 for national numbers.
 * @returns {
 *   | { ok:true, providerId:"META", provider:object, input:{ to, template, config, event } }
 *   | { ok:false, error:{ code, message } }
 * }
 */
async function assembleMetaSend(args = {}) {
  const {
    restaurantId,
    event,
    recipient,
    templateInput,
    languageCode,
    countryContext,
  } = args;

  // ── Basic input validation ────────────────────────────────────
  if (!restaurantId || typeof restaurantId !== "string" || !restaurantId.trim()) {
    return fail(ERROR_CODES.PROVIDER_UNAVAILABLE, "restaurantId is required.");
  }
  if (!event || typeof event !== "string") {
    return fail(ERROR_CODES.UNKNOWN, "event is required.");
  }
  if (!recipient || typeof recipient !== "string") {
    return fail(ERROR_CODES.INVALID_RECIPIENT, "recipient is required.");
  }

  // ── Provider resolution (Phase 8 — single authority) ──────────
  const resolved = await resolveProviderForRestaurant(restaurantId.trim());
  if (!resolved.ok) {
    // Propagate the normalized error (never contains credentials).
    return { ok: false, error: resolved.error };
  }
  if (resolved.providerId !== PROVIDERS.META) {
    // Do NOT silently convert Twilio → Meta.
    return fail(ERROR_CODES.DISCONNECTED, "Resolved provider is not Meta for this restaurant.");
  }

  // ── Recipient normalization (Phase 2B — no +91 inference) ─────
  const to = normalizeE164(recipient, countryContext);
  if (!to) {
    return fail(ERROR_CODES.INVALID_RECIPIENT, "Recipient could not be normalized to E.164.");
  }

  // ── Template build (Phase 9 — single source of truth) ─────────
  const built = buildMetaTemplate(event, templateInput, languageCode ? { languageCode } : undefined);
  if (!built.ok) {
    return { ok: false, error: built.error };
  }

  // ── Prepared operation (NOT sent) ─────────────────────────────
  return {
    ok: true,
    providerId: PROVIDERS.META,
    provider: resolved.provider,
    input: {
      to,
      template: built.template,
      config: resolved.config, // contains transient accessToken (server-side only)
      event,
    },
  };
}

module.exports = { assembleMetaSend };
