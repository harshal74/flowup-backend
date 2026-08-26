const Setting = require("../models/Setting");

/**
 * GET /api/restaurants/public
 *
 * Public discovery endpoint — returns only the minimum information
 * a customer needs to pick a restaurant.
 *
 * Security:
 *  - No authentication required (intentionally public, like a menu board)
 *  - Only ACTIVE restaurants with a configured slug are returned
 *  - Only name, slug, and logo are exposed — no credentials, revenue,
 *    private settings, owner info, or internal IDs
 *  - restaurantId (internal key) is intentionally NOT returned
 *
 * Query params:
 *  search   string  (optional) case-insensitive match on name or slug
 *  limit    number  (optional, default 50, max 100)
 */
exports.listPublicRestaurants = async (req, res) => {
  try {
    const { search, limit = 50 } = req.query;

    const effectiveLimit = Math.min(Number(limit) || 50, 100);

    // Only ACTIVE restaurants that have a slug configured
    const filter = {
      accountStatus: { $ne: "SUSPENDED" },
      restaurantSlug: { $exists: true, $ne: null, $ne: "" },
    };

    if (search && search.trim()) {
      const q = search.trim();
      filter.$or = [
        { restaurantName: { $regex: q, $options: "i" } },
        { restaurantSlug:  { $regex: q, $options: "i" } },
      ];
    }

    const restaurants = await Setting.find(filter)
      .select("restaurantName restaurantSlug restaurantLogo")
      .sort({ restaurantName: 1 })
      .limit(effectiveLimit)
      .lean();

    // Return only the three public fields — nothing else
    const data = restaurants.map((r) => ({
      name: r.restaurantName,
      slug: r.restaurantSlug,
      logo: r.restaurantLogo || null,
    }));

    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error("[PublicRestaurants] listPublicRestaurants:", err.message);
    return res.status(500).json({ success: false, message: "Unable to load restaurants." });
  }
};
