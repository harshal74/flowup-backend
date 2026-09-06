/**
 * FlowUp WhatsApp — Meta template approval status sync (Phase 15B).
 *
 * Server-trusted synchronization of a restaurant's Meta template statuses into
 * RestaurantWhatsApp.templates[]. The status ALWAYS originates from Meta's
 * Business Management API — never from a client request. A client may trigger a
 * sync (and optionally scope it to one canonical FlowUp event), but can NEVER
 * supply restaurantId, wabaId, status, approved, or approvedAt.
 *
 * Meta endpoint (Graph API):
 *   GET {base}/{version}/{WABA_ID}/message_templates
 *   Authorization: Bearer <delegated token>
 *   → { data: [ { name, language, status, category, ... } ], paging }
 * Meta status values include APPROVED | PENDING | REJECTED | PAUSED and others
 * (DISABLED, IN_APPEAL, PENDING_DELETION, ...). Only the four FlowUp enum values
 * are persisted as-is; anything else is normalized to a SAFE non-sendable state
 * ("PAUSED") — never APPROVED. Fail-closed: on any error, existing approval
 * state is left untouched (never widened).
 *
 * Reuses the Phase 7 credential/config boundary (resolveMetaConfig) — this
 * service NEVER decrypts tokens itself. HTTP is dependency-injected for tests.
 * Meta outbound sending is NOT touched: no metaProvider.send, no gate change.
 */

const RestaurantWhatsApp = require("../models/RestaurantWhatsApp");
const { resolveMetaConfig } = require("./whatsappConfigResolver");
const { TEMPLATE_REGISTRY, SUPPORTED_LANGUAGES } = require("./providers/templateRegistry");
const { ERROR_CODES } = require("./providers/types");
const metrics = require("./whatsappMetrics");

const LOCAL_STATUSES = ["APPROVED", "PENDING", "REJECTED", "PAUSED"];

// FlowUp canonical template names (Phase 9) — only these are synced into our
// approval records. Unrelated templates in the WABA are ignored.
const FLOWUP_TEMPLATE_NAMES = new Set(
  Object.values(TEMPLATE_REGISTRY).map((d) => d.templateName)
);

function fail(code, message) {
  metrics.inc("meta_template_sync_failure");
  return { ok: false, error: { code, message } };
}

/**
 * Normalize a Meta status string to the local enum. Unknown/new statuses map to
 * "PAUSED" (safe, non-sendable) — NEVER APPROVED.
 */
function normalizeMetaStatus(metaStatus) {
  const s = typeof metaStatus === "string" ? metaStatus.toUpperCase() : "";
  if (LOCAL_STATUSES.includes(s)) return s;
  return "PAUSED"; // fail-safe: never treat unknown as sendable
}

function createTemplateSyncService(httpClient) {
  const doHttp =
    httpClient ||
    (typeof fetch === "function" ? (url, opts) => fetch(url, opts) : null);

  /**
   * Sync Meta template statuses for a trusted restaurantId.
   * @param {string} restaurantId  from req.user.restaurantId (trusted)
   * @param {Object} [opts] { event }  optional canonical FlowUp event to scope to
   * @returns {Promise<{ ok:true, data:{ wabaId, synced:number, templates:Array } } | { ok:false, error }>}
   *          Returned templates contain NO secrets (name/languageCode/status/wabaId/approvedAt only).
   */
  async function syncTemplates(restaurantId, opts = {}) {
    if (!restaurantId || typeof restaurantId !== "string" || !restaurantId.trim()) {
      return fail(ERROR_CODES.PROVIDER_UNAVAILABLE, "restaurantId is required.");
    }
    const id = restaurantId.trim();

    // Resolve credentials + current wabaId via the Phase 7 boundary (requires
    // provider=META, status=CONNECTED, decryptable token). No direct decrypt here.
    const resolved = await resolveMetaConfig(id);
    if (!resolved.ok) {
      return { ok: false, error: resolved.error };
    }
    const { graphApiBaseUrl, graphApiVersion, accessToken, wabaId } = resolved.config;
    if (!wabaId) {
      return fail(ERROR_CODES.DISCONNECTED, "Meta connection is missing a WABA id.");
    }
    if (!doHttp) {
      return fail(ERROR_CODES.PROVIDER_UNAVAILABLE, "No HTTP client available.");
    }

    // Optional scoping to a single canonical event's template name.
    let scopedName = null;
    if (opts.event) {
      const def = TEMPLATE_REGISTRY[opts.event];
      if (!def) return fail(ERROR_CODES.TEMPLATE_REJECTED, "Unknown template event.");
      scopedName = def.templateName;
    }

    // Fetch template statuses from Meta, following pagination (Phase 21).
    // ALL pages must load successfully before the authoritative persist below.
    // If ANY page fails, the whole sync fails and existing templates[] are left
    // untouched (fail-closed). Loop guards prevent infinite pagination.
    let metaTemplates;
    try {
      const base = String(graphApiBaseUrl).replace(/\/+$/, "");
      const firstUrl = `${base}/${graphApiVersion}/${wabaId}/message_templates?limit=200`;

      const MAX_PAGES = 20;               // pathological-pagination guard
      const aggregated = [];
      const seenUrls = new Set();         // repeated-next-URL guard
      let nextUrl = firstUrl;
      let pages = 0;

      while (nextUrl) {
        if (pages >= MAX_PAGES) {
          return fail(ERROR_CODES.PROVIDER_UNAVAILABLE, "Meta template pagination exceeded page limit.");
        }
        if (seenUrls.has(nextUrl)) {
          return fail(ERROR_CODES.PROVIDER_UNAVAILABLE, "Meta template pagination loop detected.");
        }
        seenUrls.add(nextUrl);
        pages += 1;

        // Only the first page needs the Authorization header we build; Meta's
        // paging.next is a fully-formed URL that already carries its own access
        // token, but we still send our Bearer header defensively. The next URL
        // is server-derived from Meta's response — never client-supplied.
        const resp = await doHttp(nextUrl, {
          method: "GET",
          headers: { Authorization: `Bearer ${accessToken}` }, // never logged
        });
        const status = resp?.status;
        const data = typeof resp?.json === "function" ? await resp.json() : null;

        if (status === 401) return fail(ERROR_CODES.AUTH_FAILED, "Meta authentication failed.");
        if (status === 403) return fail(ERROR_CODES.PERMISSION_DENIED, "Meta permission denied.");
        if (!(status >= 200 && status < 300)) {
          return fail(ERROR_CODES.PROVIDER_UNAVAILABLE, "Meta template request failed.");
        }
        if (!data || !Array.isArray(data.data)) {
          return fail(ERROR_CODES.PROVIDER_UNAVAILABLE, "Malformed Meta template response.");
        }

        for (const t of data.data) aggregated.push(t);

        // Follow Meta cursor pagination. Only accept an https string next URL.
        const candidate = data?.paging?.next;
        nextUrl = (typeof candidate === "string" && candidate.startsWith("https://")) ? candidate : null;
      }

      metaTemplates = aggregated;
    } catch {
      // Fail closed: never modify existing approval state on error.
      return fail(ERROR_CODES.PROVIDER_UNAVAILABLE, "Meta template request error.");
    }

    // Build the authoritative approval set for FlowUp templates on THIS wabaId.
    // Only FlowUp canonical names + supported languages are considered.
    const now = new Date();
    const records = [];
    const seen = new Set(); // dedupe by name|lang
    for (const t of metaTemplates) {
      const name = t?.name;
      const language = t?.language;
      if (!name || !language) continue;
      if (!FLOWUP_TEMPLATE_NAMES.has(name)) continue;          // ignore unrelated WABA templates
      if (scopedName && name !== scopedName) continue;         // optional single-event scope
      if (!SUPPORTED_LANGUAGES.includes(language)) continue;   // only supported languages
      const key = `${name}|${language}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const status = normalizeMetaStatus(t?.status);
      records.push({
        name,
        languageCode: language,
        status,
        wabaId,
        approvedAt: status === "APPROVED" ? now : null,
      });
    }

    // Persist. When NOT scoped, the Meta response is authoritative for the full
    // FlowUp set on this WABA → replace all FlowUp entries for this wabaId
    // (so a template no longer APPROVED at Meta stops being sendable). Entries
    // for a DIFFERENT wabaId are left as-is (stale, already unusable via 15A).
    // When scoped to one event, only that name's entries (this wabaId) are
    // replaced, preserving other entries.
    try {
      const record = await RestaurantWhatsApp.findOne({ restaurantId: id }).lean();
      const existing = Array.isArray(record?.templates) ? record.templates : [];

      const kept = existing.filter((e) => {
        // Drop the entries this sync is authoritative for; keep everything else.
        if (e.wabaId !== wabaId) return true;                  // other WABA: keep (already unusable)
        if (scopedName) return e.name !== scopedName;          // scoped: only replace that name
        if (!FLOWUP_TEMPLATE_NAMES.has(e.name)) return true;   // non-FlowUp: keep
        return false;                                          // full sync: drop all FlowUp/this-WABA
      });

      const next = [...kept, ...records];

      await RestaurantWhatsApp.updateOne(
        { restaurantId: id, wabaId }, // guard: only if wabaId still matches (concurrency-safe)
        { $set: { templates: next } }
      );

      // Return non-secret view only.
      return {
        ok: true,
        data: {
          wabaId,
          synced: records.length,
          templates: next.map((e) => ({
            name: e.name, languageCode: e.languageCode, status: e.status,
            wabaId: e.wabaId, approvedAt: e.approvedAt || null,
          })),
        },
      };
    } catch {
      return fail(ERROR_CODES.PROVIDER_UNAVAILABLE, "Failed to persist template statuses.");
    }
  }

  return { syncTemplates, normalizeMetaStatus };
}

const templateSyncService = createTemplateSyncService();

module.exports = templateSyncService;
module.exports.createTemplateSyncService = createTemplateSyncService;
module.exports.normalizeMetaStatus = normalizeMetaStatus;
