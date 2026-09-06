/**
 * FlowUp WhatsApp — Meta template approval check (Phase 15A). PURE.
 *
 * Determines whether a specific Meta template is approved for sending, based on
 * the per-restaurant approval records stored on RestaurantWhatsApp.templates.
 *
 * A send is approved ONLY when an entry matches ALL of:
 *   record.wabaId       === current wabaId
 *   record.name         === templateName   (Phase 9 canonical name)
 *   record.languageCode === languageCode   (Meta template language)
 *   record.status       === "APPROVED"
 *
 * Fail-closed: any missing/mismatched field → false. Approval is NEVER inferred
 * from CONNECTED status, registry membership, name/language/WABA alone,
 * approvedAt, or any environment variable.
 *
 * Deterministic and side-effect-free: no DB, no network, no logging.
 */

/**
 * @param {Object} p
 * @param {Array}  p.templates      approval records (RestaurantWhatsApp.templates)
 * @param {string} p.wabaId         current connection WABA id
 * @param {string} p.templateName   canonical template name being sent
 * @param {string} p.languageCode   language code being sent
 * @returns {boolean}
 */
function isMetaTemplateApproved({ templates, wabaId, templateName, languageCode } = {}) {
  if (!Array.isArray(templates) || templates.length === 0) return false;
  if (!wabaId || !templateName || !languageCode) return false;

  return templates.some(
    (r) =>
      r &&
      r.status === "APPROVED" &&
      r.wabaId === wabaId &&
      r.name === templateName &&
      r.languageCode === languageCode
  );
}

module.exports = { isMetaTemplateApproved };
