const Setting = require("../models/Setting");

// Reserved slugs that conflict with routes or common paths
const RESERVED_SLUGS = new Set([
  "admin", "staff", "platform", "api", "login", "signup", "dashboard",
  "settings", "restaurant", "restaurants", "menu", "order", "orders",
  "payment", "payments", "billing", "support", "help", "about", "contact",
  "favicon", "robots", "sitemap", "static", "assets", "health", "status",
  "table", "tables", "qr", "checkout", "cart", "profile", "register",
]);

// Slug format: ^[a-z0-9]+(?:-[a-z0-9]+)*$
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Normalize a string into a URL-safe slug.
 * "ABC Cafe & Restaurant" → "abc-cafe-restaurant"
 */
function slugify(text) {
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/&/g, "and")              // & → "and"
    .replace(/[^a-z0-9\s-]/g, "")     // remove non-alphanumeric
    .replace(/\s+/g, "-")             // spaces → hyphens
    .replace(/-+/g, "-")              // collapse multiple hyphens
    .replace(/^-|-$/g, "");           // trim leading/trailing hyphens
}

/**
 * Validate a slug format.
 * Returns { valid: boolean, message?: string }
 */
function validateSlug(slug) {
  if (!slug || typeof slug !== "string") {
    return { valid: false, message: "Slug is required." };
  }
  const normalized = slug.trim().toLowerCase();
  if (normalized.length < 2) {
    return { valid: false, message: "Slug must be at least 2 characters." };
  }
  if (normalized.length > 80) {
    return { valid: false, message: "Slug must be 80 characters or fewer." };
  }
  if (!SLUG_RE.test(normalized)) {
    return { valid: false, message: "Slug must contain only lowercase letters, numbers, and hyphens (e.g., abc-cafe)." };
  }
  if (RESERVED_SLUGS.has(normalized)) {
    return { valid: false, message: `"${normalized}" is a reserved name and cannot be used as a slug.` };
  }
  return { valid: true };
}

/**
 * Generate a unique slug for a restaurant.
 *
 * If customSlug is provided and valid, check uniqueness and return it.
 * If customSlug conflicts, throw an error (don't auto-suffix for manual slugs).
 *
 * If no customSlug, auto-generate from restaurantName with suffix on collision.
 *
 * @param {string} restaurantName
 * @param {string} [customSlug] - Optional manually provided slug
 * @param {string} [excludeRestaurantId] - Exclude this restaurant from uniqueness check (for updates)
 * @returns {Promise<string>}
 */
async function generateRestaurantSlug(restaurantName, customSlug, excludeRestaurantId) {
  // ── Manual slug ─────────────────────────────────────────────
  if (customSlug && customSlug.trim()) {
    const normalized = customSlug.trim().toLowerCase();
    const validation = validateSlug(normalized);
    if (!validation.valid) {
      throw new Error(validation.message);
    }

    // Check uniqueness
    const query = { restaurantSlug: normalized };
    if (excludeRestaurantId) query.restaurantId = { $ne: excludeRestaurantId };
    const existing = await Setting.findOne(query).select("restaurantId").lean();
    if (existing) {
      throw new Error("This public URL slug is already in use.");
    }

    return normalized;
  }

  // ── Auto-generate from restaurant name ──────────────────────
  let base = slugify(restaurantName);

  // If name produces empty slug, use a fallback
  if (!base || base.length < 2) {
    base = "restaurant";
  }

  // Truncate base to reasonable length for suffixing
  if (base.length > 60) base = base.slice(0, 60).replace(/-$/, "");

  // Check if reserved
  if (RESERVED_SLUGS.has(base)) {
    base = `${base}-restaurant`;
  }

  // Try base first, then suffixed versions
  for (let i = 0; i < 100; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const existing = await Setting.findOne({ restaurantSlug: candidate }).select("restaurantId").lean();
    if (!existing) return candidate;
  }

  // Fallback: use timestamp
  return `${base}-${Date.now().toString(36).slice(-6)}`;
}

module.exports = { generateRestaurantSlug, validateSlug, slugify, RESERVED_SLUGS };
