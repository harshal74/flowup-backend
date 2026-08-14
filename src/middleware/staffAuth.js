const jwt   = require("jsonwebtoken");
const Staff = require("../models/Staff");

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

    return staff; // caller handles isEmailVerified / isActive checks
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

  if (staff.isEmailVerified === false) {
    return res.status(403).json({
      success: false,
      message: "Email not verified.",
      requiresOtp: true,
    });
  }

  if (!staff.isActive) {
    return res.status(403).json({
      success: false,
      message: "Account is disabled.",
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

  if (staff && staff.isEmailVerified !== false && staff.isActive) {
    req.staff = staff;
  }
  // Always call next() — let adminOrStaff check req.staff
  next();
};

module.exports = staffAuth;
module.exports.tryStaffAuthMiddleware = tryStaffAuthMiddleware;
