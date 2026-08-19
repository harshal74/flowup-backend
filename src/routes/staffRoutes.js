const express      = require("express");
const router       = express.Router();
const staffAuth    = require("../middleware/staffAuth");
const requireRole  = require("../middleware/requireRole");
const { rateLimit } = require("../middleware/rateLimit");
const authCtrl     = require("../controllers/staffAuthController");
const orderCtrl    = require("../controllers/staffOrderController");

// Rate limiters for public auth endpoints
// Composite key: IP + email — so multiple staff on same Wi-Fi aren't blocked by each other
const loginLimiter  = rateLimit({
  windowMs: 60000,
  max: 5,
  message: "Too many login attempts. Please wait a minute.",
  keyGenerator: (req) => {
    const ip = req.ip || "unknown";
    const email = req.body?.email;
    if (email && typeof email === "string" && email.trim()) {
      return `login:${ip}:${email.trim().toLowerCase()}`;
    }
    return `login:ip:${ip}`;
  },
});
const signupLimiter = rateLimit({ windowMs: 300000, max: 5, message: "Too many registration attempts. Please wait 5 minutes." });

// ── Auth (public) ─────────────────────────────────────────────────
router.post("/signup",      signupLimiter, authCtrl.signup);
router.post("/login",       loginLimiter,  authCtrl.login);

// ── Auth (protected) ─────────────────────────────────────────────
router.post("/logout",           staffAuth, authCtrl.logout);
router.get("/profile",           staffAuth, authCtrl.getProfile);
router.put("/profile",           staffAuth, authCtrl.updateProfile);

// ── Orders (all authenticated staff can read) ─────────────────────
router.get("/orders", staffAuth, orderCtrl.getOrders);

// ── Order transitions (Chef + Admin) ─────────────────────────────
router.patch("/orders/:id/accept",    staffAuth, requireRole("CHEF", "ADMIN"),   orderCtrl.acceptOrder);
router.patch("/orders/:id/preparing", staffAuth, requireRole("CHEF", "ADMIN"),   orderCtrl.preparingOrder);
router.patch("/orders/:id/ready",     staffAuth, requireRole("CHEF", "ADMIN"),   orderCtrl.readyOrder);

// ── Order delivery (Waiter + Admin) ──────────────────────────────
router.patch("/orders/:id/dispatch",  staffAuth, requireRole("WAITER", "ADMIN"), orderCtrl.dispatchOrder);
router.patch("/orders/:id/deliver",   staffAuth, requireRole("WAITER", "ADMIN"), orderCtrl.deliverOrder);

module.exports = router;
