const Setting = require("../models/Setting");

/**
 * Middleware: Require the restaurant to have accountStatus === "ACTIVE".
 *
 * Used AFTER authentication middleware (protect / staffAuth / resolvePublicRestaurant)
 * has already set req.user.restaurantId or req.restaurantId.
 *
 * If the restaurant is SUSPENDED, returns 403.
 * SUPER_ADMIN requests are never blocked by this middleware.
 */
const requireActiveRestaurant = async (req, res, next) => {
  try {
    // Skip check for SUPER_ADMIN (platform operations)
    if (req.user?.role === "SUPER_ADMIN") return next();

    // Determine restaurantId from available sources
    const restaurantId = req.restaurantId || req.user?.restaurantId || req.staff?.restaurantId;

    if (!restaurantId) {
      return res.status(400).json({ success: false, message: "Restaurant context is required." });
    }

    const settings = await Setting.findOne({ restaurantId })
      .select("accountStatus expiresAt")
      .lean();

    if (!settings) {
      return res.status(404).json({ success: false, message: "Restaurant not found." });
    }

    if (settings.accountStatus === "SUSPENDED") {
      return res.status(403).json({
        success: false,
        message: "This restaurant has been suspended. Please contact FlowUp support.",
        suspended: true,
      });
    }

    // Expiry check: independent of accountStatus — treated as a separate condition
    if (settings.expiresAt && new Date() >= new Date(settings.expiresAt)) {
      return res.status(403).json({
        success: false,
        message: "This restaurant's subscription has expired. Please contact FlowUp support.",
        expired: true,
      });
    }

    next();
  } catch (error) {
    console.error("[requireActiveRestaurant] Error:", error.message);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

module.exports = requireActiveRestaurant;
