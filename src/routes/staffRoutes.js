const express      = require("express");
const router       = express.Router();
const staffAuth    = require("../middleware/staffAuth");
const requireRole  = require("../middleware/requireRole");
const authCtrl     = require("../controllers/staffAuthController");
const orderCtrl    = require("../controllers/staffOrderController");
const { testSmtpConnection } = require("../services/emailService");

// ── Auth (public) ─────────────────────────────────────────────────
router.post("/signup",      authCtrl.signup);
router.post("/verify-otp",  authCtrl.verifyOtp);
router.post("/resend-otp",  authCtrl.resendOtp);
router.post("/login",       authCtrl.login);

// ── SMTP diagnostic (public — only for debugging, shows no secrets) ──
router.get("/test-email", async (req, res) => {
  const result = await testSmtpConnection();
  if (result.ok) {
    return res.json({ success: true, message: `SMTP connected ✓  (${result.user})` });
  }
  return res.status(500).json({
    success: false,
    message: "SMTP connection failed",
    reason:  result.reason,
    code:    result.code || null,
    fix: getFix(result),
  });
});

function getFix(result) {
  const r = (result.reason || "").toLowerCase();
  if (r.includes("535") || r.includes("username and password") || r.includes("invalid credentials")) {
    return "Wrong App Password. Go to myaccount.google.com/apppasswords and generate a new one. Make sure 2FA is ON.";
  }
  if (r.includes("534") || r.includes("less secure") || r.includes("please log in via your web browser")) {
    return "Gmail is blocking the login. Enable 2FA and use an App Password instead of your real password.";
  }
  if (r.includes("econnrefused") || r.includes("etimedout") || r.includes("connect")) {
    return "Cannot reach smtp.gmail.com:587. Check your internet/firewall.";
  }
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    return "EMAIL_USER or EMAIL_PASS not set in backend/.env";
  }
  return "Check backend terminal for full error details.";
}

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
