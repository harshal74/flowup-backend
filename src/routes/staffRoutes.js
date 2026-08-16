const express      = require("express");
const router       = express.Router();
const staffAuth    = require("../middleware/staffAuth");
const requireRole  = require("../middleware/requireRole");
const authCtrl     = require("../controllers/staffAuthController");
const orderCtrl    = require("../controllers/staffOrderController");

// ── Auth (public) ─────────────────────────────────────────────────
router.post("/signup",      authCtrl.signup);
router.post("/login",       authCtrl.login);

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
router.patch("/orders/:id/deliver",   staffAuth, requireRole("WAITER", "ADMIN"), orderCtrl.deliverOrder);

module.exports = router;
