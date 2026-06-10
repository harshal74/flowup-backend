const express = require("express");

const {
  login,
  getProfile,
  changePassword,
  logout,
} = require("../controllers/auth.controller");

const protect = require("../middleware/auth.middleware");

const router = express.Router();

router.post("/login", login);

router.get("/profile", protect, getProfile);

router.patch(
  "/change-password",
  protect,
  changePassword
);

router.post("/logout", protect, logout);

module.exports = router;