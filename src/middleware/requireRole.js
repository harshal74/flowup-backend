/**
 * Role-based authorization middleware.
 * Usage: requireRole("CHEF", "ADMIN")
 * Always used AFTER staffAuth middleware.
 */
const requireRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.staff) {
      return res.status(401).json({ success: false, message: "Unauthorized access" });
    }

    if (!allowedRoles.includes(req.staff.role)) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }

    next();
  };
};

module.exports = requireRole;
