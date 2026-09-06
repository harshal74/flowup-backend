/**
 * FlowUp WhatsApp Provider Registry / Selector.
 *
 * Phase 2A: provides provider lookup. The ACTIVE provider remains Twilio.
 *
 * Migration design (NOT implemented here, documented for the next phase):
 *   The future per-restaurant selection will be:
 *     resolveProviderForRestaurant(restaurantId):
 *       load RestaurantWhatsApp
 *       if status === CONNECTED (Meta ready) → META provider (+ its config)
 *       else                                  → TWILIO provider (default)
 *   This lets Restaurant A use Twilio while Restaurant B uses Meta during the
 *   migration window. That DB lookup is intentionally deferred — no DB access
 *   is added in this phase.
 */

const { PROVIDERS } = require("./types");
const twilioProvider = require("./twilioProvider");
const metaProvider = require("./metaProvider");

// Registry of available provider adapters.
// Phase 4: Meta is REGISTERED (resolvable via getProvider("META")) but is
// INACTIVE — getDefaultProvider() still returns Twilio, so the Meta adapter is
// unreachable from the active send path until a future per-restaurant resolver
// selects it. No credential loading or DB resolution is added here.
const registry = {
  [PROVIDERS.TWILIO]: twilioProvider,
  [PROVIDERS.META]: metaProvider,
};

/**
 * Return the default/active provider for the current launch state.
 * Twilio remains the sole active provider until Meta is enabled per-restaurant.
 * @returns {{id:string, send:Function}}
 */
function getDefaultProvider() {
  return registry[PROVIDERS.TWILIO];
}

/**
 * Look up a provider adapter by id.
 * @param {string} id one of PROVIDERS
 * @returns {{id:string, send:Function}|null}
 */
function getProvider(id) {
  return registry[id] || null;
}

module.exports = {
  getDefaultProvider,
  getProvider,
  PROVIDERS,
};
