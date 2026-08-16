const express = require("express");
const { rateLimit } = require("../middleware/rateLimit");

const {
  login,
  getProfile,
  changePassword,
  logout,
} = require("../controllers/auth.controller");

const protect = require("../middleware/auth.middleware");

const router = express.Router();

// 5 login attempts per minute per IP+email combination
const loginLimiter = rateLimit({
  windowMs: 60000,
  max: 5,
  message: "Too many login attempts. Please wait a minute.",
  keyGenerator: (req) => {
    const ip = req.ip || "unknown";
    const email = req.body?.email;
    if (email && typeof email === "string" && email.trim()) {
      return `admin-login:${ip}:${email.trim().toLowerCase()}`;
    }
    return `admin-login:ip:${ip}`;
  },
});

router.post("/login", loginLimiter, login);

router.get("/profile", protect, getProfile);

router.patch(
  "/change-password",
  protect,
  changePassword
);

router.post("/logout", protect, logout);

module.exports = router;