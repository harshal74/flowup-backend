/**
 * Inventory authorization (Step 5) — reuses the EXISTING auth building blocks.
 *
 * `adminOrStaff` mirrors the inline helper already used in billing.route.js and
 * waiterRequest.route.js: try the staff token first (tryStaffAuthMiddleware sets
 * req.staff + req.user = { restaurantId, _id }); if no valid staff, fall back to
 * the admin `protect` middleware (sets req.user from the Admin account). Either
 * way, req.user.restaurantId is the TRUSTED tenant id.
 *
 * `requireInventoryManager` is the mutation gate. It allows:
 *   • a Restaurant Admin account  (req.user present, NO req.staff), OR
 *   • a Staff with role ADMIN or ASSISTANT (req.staff.role).
 * It denies CHEF and WAITER (403). This does NOT introduce a new role system —
 * it composes the existing Staff role enum + admin account identity.
 *
 * SUPER_ADMIN note: platform behavior is unchanged. A SUPER_ADMIN authenticating
 * via the admin `protect` path is treated like the admin-account branch (no
 * req.staff) — inventory remains tenant-scoped by req.user.restaurantId, so no
 * platform-wide broadening occurs.
 */

const protect = require("./auth.middleware");
const { tryStaffAuthMiddleware } = require("./staffAuth");

// Combined authentication: staff token OR admin token. Never trusts the body.
function adminOrStaff(req, res, next) {
  tryStaffAuthMiddleware(req, res, () => {
    if (req.staff) {
      req.user = { restaurantId: req.staff.restaurantId, _id: req.staff._id };
      return next();
    }
    return protect(req, res, next);
  });
}

// Mutation gate: admin account OR staff ADMIN/ASSISTANT. Denies CHEF/WAITER.
const INVENTORY_MANAGER_STAFF_ROLES = ["ADMIN", "ASSISTANT"];

function requireInventoryManager(req, res, next) {
  // Must be authenticated by adminOrStaff first.
  if (!req.user) {
    return res.status(401).json({ success: false, message: "Unauthorized access" });
  }
  // Staff path: enforce role.
  if (req.staff) {
    if (!INVENTORY_MANAGER_STAFF_ROLES.includes(req.staff.role)) {
      return res.status(403).json({ success: false, message: "Access denied" });
    }
    return next();
  }
  // Admin-account path (no req.staff): the restaurant owner/admin — allowed.
  return next();
}

module.exports = { adminOrStaff, requireInventoryManager };
