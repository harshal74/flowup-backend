const { verifyToken } = require("../utils/jwt");
const Admin = require("../models/Admin");

/**
 * Platform-level authentication middleware.
 * Requires: valid Admin JWT + role === "SUPER_ADMIN" + isActive === true.
 *
 * Must be used AFTER the standard protect middleware or independently.
 * Sets req.user to the authenticated SUPER_ADMIN.
 */
const platformAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, message: "Unauthorized — authentication required" });
    }

    const token = authHeader.split(" ")[1];
    let decoded;
    try {
      decoded = verifyToken(token);
    } catch {
      return res.status(401).json({ success: false, message: "Invalid or expired token" });
    }

    const admin = await Admin.findById(decoded.id);
    if (!admin) {
      return res.status(401).json({ success: false, message: "Admin not found" });
    }

    if (!admin.isActive) {
      return res.status(403).json({ success: false, message: "Account is disabled" });
    }

    if (admin.role !== "SUPER_ADMIN") {
      return res.status(403).json({ success: false, message: "Platform access denied — SUPER_ADMIN role required" });
    }

    req.user = admin;
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: "Authentication failed" });
  }
};

module.exports = platformAuth;
