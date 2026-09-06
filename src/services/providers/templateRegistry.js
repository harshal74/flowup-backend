/**
 * FlowUp WhatsApp — Meta Template Registry + Builder (Phase 9). INACTIVE.
 *
 * Purpose:
 *   Canonical, application-side specification of the Meta UTILITY templates for
 *   FlowUp's seven transactional events, plus a PURE builder that turns event
 *   data into the `template` payload shape expected by metaProvider.send().
 *
 * INACTIVE by design:
 *   • Nothing here provisions templates on a WABA, calls the Graph API, or is
 *     wired into the active send path. Twilio remains the default provider and
 *     its free-text builders in whatsapp.service.js are unchanged.
 *   • This module is a pure, deterministic, network-free, DB-free building
 *     block for a future Meta activation phase.
 *
 * IMPORTANT — these template NAMES are FlowUp canonical identifiers ONLY. They
 * are NOT yet created or approved in Meta. Approval/provisioning is a future
 * phase (and an external Meta process).
 *
 * Category: every FlowUp transactional event is UTILITY (transactional/
 * informational about an existing order). Wording is strictly factual — no
 * promotional language, discounts, offers, upsell, or marketing CTAs — to stay
 * within Meta's UTILITY category.
 */

const { ERROR_CODES } = require("./types");

const DEFAULT_LANGUAGE = "en";

/**
 * Canonical template registry.
 *
 * parameterSchema is the ORDERED list of body {{n}} parameters. Each entry:
 *   { key, required }
 * where `key` is looked up from the builder `input` object. Order is the Meta
 * template body parameter order and is deterministic.
 *
 * `available` documents whether the mapped source data currently flows from an
 * existing FlowUp call site (informational for the future wiring phase; does
 * NOT affect building).
 */
const TEMPLATE_REGISTRY = Object.freeze({
  ORDER_PLACED: {
    event: "ORDER_PLACED",
    templateName: "flowup_order_placed",
    category: "UTILITY",
    language: { code: DEFAULT_LANGUAGE },
    parameterSchema: [
      { key: "restaurantName", required: true },
      { key: "orderNumber",    required: true },
      { key: "orderTotal",     required: true },
    ],
  },
  ORDER_ACCEPTED: {
    event: "ORDER_ACCEPTED",
    templateName: "flowup_order_accepted",
    category: "UTILITY",
    language: { code: DEFAULT_LANGUAGE },
    parameterSchema: [
      { key: "restaurantName", required: true },
      { key: "orderNumber",    required: true },
    ],
  },
  ORDER_REJECTED: {
    event: "ORDER_REJECTED",
    templateName: "flowup_order_rejected",
    category: "UTILITY",
    language: { code: DEFAULT_LANGUAGE },
    parameterSchema: [
      { key: "restaurantName", required: true },
      { key: "orderNumber",    required: true },
      // Reason is optional upstream (rejection reason may be empty).
      { key: "reason",         required: false },
    ],
  },
  OUT_FOR_DELIVERY: {
    event: "OUT_FOR_DELIVERY",
    templateName: "flowup_out_for_delivery",
    category: "UTILITY",
    language: { code: DEFAULT_LANGUAGE },
    parameterSchema: [
      { key: "restaurantName", required: true },
      { key: "orderNumber",    required: true },
    ],
  },
  DELIVERED: {
    event: "DELIVERED",
    templateName: "flowup_delivered",
    category: "UTILITY",
    language: { code: DEFAULT_LANGUAGE },
    parameterSchema: [
      { key: "restaurantName", required: true },
      { key: "orderNumber",    required: true },
    ],
  },
  PAYMENT_SUCCESS: {
    event: "PAYMENT_SUCCESS",
    templateName: "flowup_payment_success",
    category: "UTILITY",
    language: { code: DEFAULT_LANGUAGE },
    parameterSchema: [
      { key: "restaurantName", required: true },
      { key: "orderNumber",    required: true },
      { key: "amount",         required: true },
    ],
  },
  BILL: {
    event: "BILL",
    templateName: "flowup_bill",
    category: "UTILITY",
    language: { code: DEFAULT_LANGUAGE },
    parameterSchema: [
      { key: "restaurantName", required: true },
      { key: "invoiceNumber",  required: true },
      { key: "amount",         required: true },
    ],
  },
});

const SUPPORTED_LANGUAGES = Object.freeze(["en"]);

/**
 * Pure builder — turns an event + input into the Meta `template` payload.
 * No network, no DB, no credentials, no provider selection.
 *
 * @param {string} event  one of the registry keys (e.g. "ORDER_PLACED")
 * @param {Object} input  values keyed by parameterSchema keys
 * @param {Object} [opts] { languageCode }
 * @returns {{ ok: true, template: object } | { ok: false, error: {code,message} }}
 *   template shape (directly compatible with metaProvider.send input.template):
 *     { name, language:{code}, components:[{ type:"body", parameters:[{type:"text",text}] }] }
 */
function buildMetaTemplate(event, input, opts = {}) {
  const def = TEMPLATE_REGISTRY[event];
  if (!def) {
    return { ok: false, error: { code: ERROR_CODES.UNKNOWN, message: `Unknown template event: ${event}` } };
  }

  const languageCode = opts.languageCode || def.language.code || DEFAULT_LANGUAGE;
  if (!SUPPORTED_LANGUAGES.includes(languageCode)) {
    return { ok: false, error: { code: ERROR_CODES.TEMPLATE_REJECTED, message: `Unsupported language: ${languageCode}` } };
  }

  const src = input || {};
  const parameters = [];

  for (const { key, required } of def.parameterSchema) {
    const raw = src[key];
    const missing = raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "");

    if (missing) {
      if (required) {
        return { ok: false, error: { code: ERROR_CODES.TEMPLATE_REJECTED, message: `Missing required parameter: ${key}` } };
      }
      // Optional + missing → emit empty string to preserve positional ordering.
      parameters.push({ type: "text", text: "" });
      continue;
    }

    // Coerce to string; reject values that cannot be represented as text.
    if (typeof raw === "object") {
      return { ok: false, error: { code: ERROR_CODES.TEMPLATE_REJECTED, message: `Invalid parameter type for: ${key}` } };
    }
    parameters.push({ type: "text", text: String(raw) });
  }

  return {
    ok: true,
    template: {
      name: def.templateName,
      language: { code: languageCode },
      components: [{ type: "body", parameters }],
    },
  };
}

/**
 * Return the registry definition for an event (read-only helper).
 * @param {string} event
 * @returns {object|null}
 */
function getTemplateDefinition(event) {
  return TEMPLATE_REGISTRY[event] || null;
}

module.exports = {
  TEMPLATE_REGISTRY,
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
  buildMetaTemplate,
  getTemplateDefinition,
};
