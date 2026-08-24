const Setting = require("../models/Setting");

/**
 * Public Restaurant Resolver Middleware
 *
 * Extracts restaurantId from:
 * 1. req.query.restaurantId (customer frontend)
 * 2. req.body.restaurantId (POST requests)
 * 3. Authorization header JWT (admin/staff frontend — decoded inline)
 *
 * Validates it exists in Settings, then attaches to req.restaurantId.
 *
 * If none of these sources provide a restaurantId, returns 400.
 */
const resolvePublicRestaurant = async (req, res, next) => {
  try {
    // Source 1: explicit query/body param (restaurantId or restaurantSlug)
    let rawId = req.query.restaurantId || req.body?.restaurantId;
    let rawSlug = req.query.restaurantSlug || req.body?.restaurantSlug;

    // Source 2: JWT (admin/staff frontend sends token but no query param)
    if (!rawId && !rawSlug) {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.startsWith("Bearer ")) {
        try {
          const jwt = require("jsonwebtoken");
          const decoded = jwt.verify(authHeader.split(" ")[1], process.env.JWT_SECRET);
          rawId = decoded.restaurantId;
        } catch { /* token invalid — ignore, will fail below */ }
      }
    }

    let restaurant = null;

    // Resolve by restaurantId (primary)
    if (rawId && typeof rawId === "string" && rawId.trim()) {
      const restaurantId = rawId.trim();
      restaurant = await Setting.findOne({ restaurantId }).select("restaurantId accountStatus").lean();
    }

    // Resolve by restaurantSlug (secondary — public URL)
    if (!restaurant && rawSlug && typeof rawSlug === "string" && rawSlug.trim()) {
      const slug = rawSlug.trim().toLowerCase();
      restaurant = await Setting.findOne({ restaurantSlug: slug }).select("restaurantId accountStatus").lean();
    }

    if (!restaurant) {
      return res.status(404).json({
        success: false,
        message: "Restaurant not found.",
      });
    }

    if (restaurant.accountStatus === "SUSPENDED") {
      return res.status(403).json({
        success: false,
        message: "This restaurant is currently unavailable.",
        suspended: true,
      });
    }

    // Attach trusted restaurantId to request (always the internal ID, never the slug)
    req.restaurantId = restaurant.restaurantId;
    next();
  } catch (error) {
    console.error("[resolvePublicRestaurant] Error:", error.message);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

module.exports = resolvePublicRestaurant;
