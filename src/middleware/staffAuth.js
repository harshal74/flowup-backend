const jwt     = require("jsonwebtoken");
const Staff   = require("../models/Staff");
const Setting = require("../models/Setting");

/**
 * Core: try to authenticate a staff JWT.
 * Returns the staff document on success, null on failure.
 * Used by both the direct middleware and the fallback helper.
 */
async function tryStaffAuth(req) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) return null;

    const token = authHeader.split(" ")[1];

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return null; // expired / malformed
    }

    const staffId = decoded.staffId || decoded.id;
    if (!staffId) return null;

    const staff = await Staff.findById(staffId);
    if (!staff) return null;

    return staff; // caller handles status checks
  } catch {
    return null;
  }
}

/**
 * staffAuth — used directly as route middleware on /api/staff/* routes.
 * Sends 401/403 response on failure so unauthenticated requests are rejected.
 */
const staffAuth = async (req, res, next) => {
  const staff = await tryStaffAuth(req);

  if (!staff) {
    return res.status(401).json({ success: false, message: "Unauthorized access" });
  }

  // Only ACTIVE staff can access protected routes
  // Legacy accounts without status field: treat as ACTIVE if isActive is true
  const effectiveStatus = staff.status || (staff.isActive !== false ? "ACTIVE" : "BLOCKED");

  if (effectiveStatus === "PENDING") {
    return res.status(403).json({
      success: false,
      message: "Your registration request is awaiting administrator approval.",
      status: "PENDING",
    });
  }

  if (effectiveStatus === "REJECTED") {
    return res.status(403).json({
      success: false,
      message: "Your registration request was rejected.",
      status: "REJECTED",
    });
  }

  if (effectiveStatus === "BLOCKED" || !staff.isActive) {
    return res.status(403).json({
      success: false,
      message: "Your account has been blocked by the administrator.",
      status: "BLOCKED",
    });
  }

  // Check restaurant suspension
  const restaurantSettings = await Setting.findOne({ restaurantId: staff.restaurantId })
    .select("accountStatus")
    .lean();

  if (restaurantSettings?.accountStatus === "SUSPENDED") {
    return res.status(403).json({
      success: false,
      message: "Your restaurant has been suspended. Please contact FlowUp support.",
      suspended: true,
    });
  }

  req.staff = staff;
  next();
};

/**
 * tryStaffAuthMiddleware — used inside adminOrStaff helpers.
 * Sets req.staff if the token is a valid staff token.
 * Calls next() unconditionally — caller checks req.staff afterwards.
 * Never sends a response, allowing the fallback to protect() to work.
 */
const tryStaffAuthMiddleware = async (req, res, next) => {
  const staff = await tryStaffAuth(req);

  if (staff) {
    const effectiveStatus = staff.status || (staff.isActive !== false ? "ACTIVE" : "BLOCKED");
    if (effectiveStatus === "ACTIVE" && staff.isActive !== false) {
      // Check restaurant suspension before granting staff access
      const restaurantSettings = await Setting.findOne({ restaurantId: staff.restaurantId })
        .select("accountStatus")
        .lean();

      if (restaurantSettings?.accountStatus !== "SUSPENDED") {
        req.staff = staff;
      }
    }
  }
  // Always call next() — let adminOrStaff check req.staff
  next();
};

module.exports = staffAuth;
module.exports.tryStaffAuthMiddleware = tryStaffAuthMiddleware;
