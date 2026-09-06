/**
 * FlowUp WhatsApp — Per-restaurant provider resolver (Phase 8). INACTIVE.
 *
 * Purpose:
 *   Given a TRUSTED restaurantId, decide which provider adapter + config a
 *   restaurant should use:
 *       restaurantId → RestaurantWhatsApp → provider + status
 *         • META + CONNECTED (+ resolvable config) → getProvider("META") + config
 *         • otherwise                              → Twilio (default)
 *
 * INACTIVE by design:
 *   • Nothing in the active send path calls this. getDefaultProvider() is still
 *     Twilio and _send() is unchanged. This module is orchestration preparation
 *     that is safe to unit-test in isolation.
 *   • No network calls. No OAuth/webhook/templates. No provider activation.
 *   • No environment activation switch is introduced — there is NO way for an
 *     env var to flip the active send path to Meta.
 *
 * Credential single-source-of-truth:
 *   Meta credentials come ONLY from resolveMetaConfig() (Phase 7), which is the
 *   sole place that decrypts the token. This module never decrypts anything.
 *
 * Tenancy:
 *   restaurantId must come from the trusted caller (req.user.restaurantId). The
 *   DB lookup is scoped EXCLUSIVELY by { restaurantId }. wabaId/phoneNumberId
 *   are NEVER used as tenant authority.
 *
 * No automatic Meta→Twilio fallback: a restaurant explicitly configured for
 * META whose connection is unusable returns a normalized FAILURE (it does NOT
 * silently send through Twilio, which could use the wrong identity). Twilio is
 * only chosen when the restaurant is not (yet) a usable Meta tenant.
 */

const RestaurantWhatsApp = require("../../models/RestaurantWhatsApp");
const { getProvider, getDefaultProvider } = require("./index");
const { PROVIDERS, ERROR_CODES } = require("./types");
const { resolveMetaConfig } = require("../whatsappConfigResolver");

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

/**
 * Resolve the provider + config for a trusted restaurantId.
 *
 * @param {string} restaurantId TRUSTED tenant id (from req.user.restaurantId).
 * @returns {Promise<
 *   | { ok: true, providerId: string, provider: object, config: object|null }
 *   | { ok: false, error: { code: string, message: string } }
 * >}
 *   For TWILIO, config is null (Twilio uses server-side env configuration).
 *   For META, config is the object from resolveMetaConfig().
 */
async function resolveProviderForRestaurant(restaurantId) {
  if (!restaurantId || typeof restaurantId !== "string" || !restaurantId.trim()) {
    return fail(ERROR_CODES.PROVIDER_UNAVAILABLE, "restaurantId is required.");
  }
  const id = restaurantId.trim();

  // ── Tenant-scoped lookup (ONLY by restaurantId) ───────────────
  let record;
  try {
    record = await RestaurantWhatsApp.findOne({ restaurantId: id }).lean();
  } catch (dbErr) {
    return fail(ERROR_CODES.PROVIDER_UNAVAILABLE, "Failed to load WhatsApp connection.");
  }

  // ── No record, or not explicitly Meta → default Twilio ────────
  // This preserves existing behavior: restaurants without a usable Meta
  // connection keep using the current active provider (Twilio).
  //
  // Phase 20: a Meta-designated restaurant whose per-restaurant gate
  // (metaOutboundEnabled) is not explicitly true is treated exactly like a
  // NON-Meta restaurant → Twilio. This is DELIBERATE: a disabled restaurant is
  // "not activated for Meta", NOT "an unhealthy Meta connection", so it must
  // NOT fail closed — it uses the existing default provider. Fail-closed
  // (deny) is reserved for restaurants that ARE Meta-activated but unhealthy.
  // The check is strict `!== true` so undefined/null/false/missing all → Twilio.
  if (!record || record.provider !== PROVIDERS.META || record.metaOutboundEnabled !== true) {
    return {
      ok: true,
      providerId: PROVIDERS.TWILIO,
      provider: getDefaultProvider(), // Twilio
      config: null,                   // Twilio uses env-based config
    };
  }

  // ── Meta path: require CONNECTED, then resolve config ─────────
  // No automatic fallback to Twilio for a Meta-designated restaurant whose
  // connection is unusable — that would risk sending via the wrong identity.
  if (record.status !== "CONNECTED") {
    return fail(ERROR_CODES.DISCONNECTED, `Meta connection is not usable (status: ${record.status}).`);
  }

  const metaConfig = await resolveMetaConfig(id); // single source of truth
  if (!metaConfig.ok) {
    // Propagate the normalized error from the credential resolver (no secrets).
    return { ok: false, error: metaConfig.error };
  }

  const metaProvider = getProvider(PROVIDERS.META);
  if (!metaProvider) {
    return fail(ERROR_CODES.PROVIDER_UNAVAILABLE, "Meta provider is not registered.");
  }

  return {
    ok: true,
    providerId: PROVIDERS.META,
    provider: metaProvider,
    config: metaConfig.config,
  };
}

module.exports = { resolveProviderForRestaurant };
