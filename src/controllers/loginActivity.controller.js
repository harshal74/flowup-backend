/**
 * Login Activity Controller — Platform-only audit API.
 *
 * All endpoints require SUPER_ADMIN authentication (enforced by platformAuth
 * middleware on the router — this controller does not need to re-check).
 *
 * SECURITY:
 *   - No password, token, OTP, or credential is ever returned.
 *   - Filter parameters are validated against a whitelist before use.
 *   - Search is limited to safe fields using regex (anchored, capped length).
 *   - Arbitrary MongoDB filter objects from the client are rejected.
 */

const LoginActivity = require("../models/LoginActivity");

// Allowed role values for filter validation
const ALLOWED_ROLES = ["SUPER_ADMIN", "ADMIN", "CHEF", "WAITER", "ASSISTANT"];
const ALLOWED_STATUSES = ["SUCCESS", "FAILED"];

// ── GET /api/platform/login-activity ────────────────────────────
exports.getLoginActivity = async (req, res) => {
  try {
    const {
      page       = 1,
      limit      = 30,
      status,
      role,
      restaurantId,
      search,
      dateFrom,
      dateTo,
    } = req.query;

    const effectiveLimit = Math.min(Math.max(Number(limit) || 30, 1), 100);
    const effectivePage  = Math.max(Number(page) || 1, 1);
    const skip = (effectivePage - 1) * effectiveLimit;

    // Build filter — only validated values accepted (no arbitrary client filters)
    const filter = {};

    if (status && ALLOWED_STATUSES.includes(status)) {
      filter.status = status;
    }

    if (role && ALLOWED_ROLES.includes(role)) {
      filter.role = role;
    }

    if (restaurantId && typeof restaurantId === "string" && restaurantId.trim()) {
      filter.restaurantId = restaurantId.trim().slice(0, 60);
    }

    // Date range filter
    if (dateFrom || dateTo) {
      filter.loginAt = {};
      if (dateFrom) {
        const from = new Date(dateFrom);
        if (!isNaN(from.getTime())) filter.loginAt.$gte = from;
      }
      if (dateTo) {
        const to = new Date(dateTo);
        if (!isNaN(to.getTime())) {
          // Include the full end date by adding 1 day
          to.setDate(to.getDate() + 1);
          filter.loginAt.$lte = to;
        }
      }
    }

    // Server-side search — safe regex anchored on identifier, restaurantName, ipAddress
    // Caps search string at 100 chars; escapes regex special chars.
    if (search && typeof search === "string" && search.trim()) {
      const safe = search.trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = { $regex: safe, $options: "i" };
      filter.$or = [
        { identifier:     re },
        { restaurantName: re },
        { ipAddress:      re },
      ];
    }

    const [total, records] = await Promise.all([
      LoginActivity.countDocuments(filter),
      LoginActivity.find(filter)
        .select("-__v")        // exclude mongoose internals
        .sort({ loginAt: -1 }) // newest first
        .skip(skip)
        .limit(effectiveLimit)
        .lean(),
    ]);

    return res.status(200).json({
      success: true,
      data: records,
      pagination: {
        page:       effectivePage,
        limit:      effectiveLimit,
        total,
        totalPages: Math.ceil(total / effectiveLimit),
      },
    });
  } catch (error) {
    console.error("[LoginActivity] getLoginActivity error:", error.message);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ── GET /api/platform/login-activity/summary ────────────────────
// Summary counts for the dashboard cards on the Login Activity page.
exports.getLoginActivitySummary = async (req, res) => {
  try {
    const [total, successful, failed, today] = await Promise.all([
      LoginActivity.countDocuments({}),
      LoginActivity.countDocuments({ status: "SUCCESS" }),
      LoginActivity.countDocuments({ status: "FAILED" }),
      LoginActivity.countDocuments({
        loginAt: { $gte: (() => { const d = new Date(); d.setHours(0,0,0,0); return d; })() },
      }),
    ]);

    return res.status(200).json({
      success: true,
      data: { total, successful, failed, today },
    });
  } catch (error) {
    console.error("[LoginActivity] getLoginActivitySummary error:", error.message);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};
