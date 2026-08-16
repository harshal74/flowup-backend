const bcrypt = require("bcryptjs");
const jwt    = require("jsonwebtoken");
const Staff  = require("../models/Staff");
const { generateOtp, sendOtpEmail } = require("../services/emailService");
const { logActivity } = require("../services/staffActivityService");

const EMAIL_RE  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MOBILE_RE = /^\+?\d{7,15}$/;
const VALID_ROLES = ["ADMIN", "CHEF", "WAITER", "ASSISTANT"];
const OTP_EXPIRY_MS = (Number(process.env.OTP_EXPIRY_MINUTES) || 10) * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;

// ─────────────────────────────────────────────────────────────────
// POST /api/staff/signup
// Step 1: validate → create unverified account → send OTP
// ─────────────────────────────────────────────────────────────────
exports.signup = async (req, res) => {
  try {
    const { restaurantId, name, email, mobile, password, role } = req.body;

    // ── Required field check ──────────────────────────────────
    const missing = ["restaurantId","name","email","mobile","password","role"]
      .filter(f => !req.body[f] || !String(req.body[f]).trim());
    if (missing.length) {
      return res.status(400).json({
        success: false,
        message: `Missing required fields: ${missing.join(", ")}`,
      });
    }

    // ── Format validation ─────────────────────────────────────
    if (!EMAIL_RE.test(email.trim())) {
      return res.status(400).json({ success: false, message: "Invalid email format" });
    }

    if (!MOBILE_RE.test(mobile.trim().replace(/\s/g, ""))) {
      return res.status(400).json({ success: false, message: "Invalid mobile number (7–15 digits, optional leading +)" });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
    }

    if (name.trim().length > 100) {
      return res.status(400).json({ success: false, message: "Name must be 100 characters or fewer" });
    }

    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({
        success: false,
        message: `Role must be one of: ${VALID_ROLES.join(", ")}`,
      });
    }

    const normEmail = email.toLowerCase().trim();

    // ── Duplicate check ───────────────────────────────────────
    const existing = await Staff.findOne({ email: normEmail })
      .select("+emailOtp +emailOtpExpiry +isEmailVerified");

    if (existing) {
      // If account exists but is not verified, allow re-sending OTP
      if (!existing.isEmailVerified) {
        const otp    = generateOtp();
        const expiry = new Date(Date.now() + OTP_EXPIRY_MS);
        existing.emailOtp         = otp;
        existing.emailOtpExpiry   = expiry;
        existing.emailOtpAttempts = 0;
        await existing.save();
        // Fire-and-forget — return immediately, email sends in background
        sendOtpEmail({ to: normEmail, name: existing.name, otp }).catch(() => {});
        return res.status(200).json({
          success: true,
          message: "A new OTP has been sent to your email. Please verify to activate your account.",
          requiresOtp: true,
          email: normEmail,
        });
      }
      return res.status(409).json({ success: false, message: "Email already registered" });
    }

    // ── Create unverified staff account ───────────────────────
    const hashed = await bcrypt.hash(password, 10);
    const otp    = generateOtp();
    const expiry = new Date(Date.now() + OTP_EXPIRY_MS);

    await Staff.create({
      restaurantId:     restaurantId.trim(),
      name:             name.trim(),
      email:            normEmail,
      mobile:           mobile.trim().replace(/\s/g, ""),
      password:         hashed,
      role,
      isEmailVerified:  false,
      isActive:         false,  // activated after email verification
      emailOtp:         otp,
      emailOtpExpiry:   expiry,
      emailOtpAttempts: 0,
    });

    // ── Send OTP email — fire-and-forget so response returns immediately ──
    // OTP is saved in DB. Email delivers in background. Max 3s grace period.
    sendOtpEmail({ to: normEmail, name: name.trim(), otp }).catch(() => {});

    return res.status(201).json({
      success: true,
      message: "Account created. Please check your email for the OTP to verify your address.",
      requiresOtp: true,
      email: normEmail,
    });
  } catch (error) {
    console.error("Staff Signup Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ─────────────────────────────────────────────────────────────────
// POST /api/staff/verify-otp
// Step 2: validate OTP → mark email verified + activate account
// ─────────────────────────────────────────────────────────────────
exports.verifyOtp = async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ success: false, message: "Email and OTP are required" });
    }

    const normEmail = email.toLowerCase().trim();

    const staff = await Staff.findOne({ email: normEmail })
      .select("+emailOtp +emailOtpExpiry +emailOtpAttempts +isEmailVerified");

    if (!staff) {
      return res.status(404).json({ success: false, message: "No account found for this email" });
    }

    if (staff.isEmailVerified) {
      return res.status(400).json({ success: false, message: "Email is already verified" });
    }

    // ── Rate-limit: max attempts ──────────────────────────────
    if (staff.emailOtpAttempts >= MAX_OTP_ATTEMPTS) {
      return res.status(429).json({
        success: false,
        message: `Too many incorrect attempts. Please request a new OTP.`,
      });
    }

    // ── Expiry check ──────────────────────────────────────────
    if (!staff.emailOtpExpiry || new Date() > staff.emailOtpExpiry) {
      return res.status(400).json({ success: false, message: "OTP has expired. Please request a new one." });
    }

    // ── Code match ────────────────────────────────────────────
    if (staff.emailOtp !== String(otp).trim()) {
      staff.emailOtpAttempts += 1;
      await staff.save();
      const remaining = MAX_OTP_ATTEMPTS - staff.emailOtpAttempts;
      return res.status(400).json({
        success: false,
        message: `Invalid OTP. ${remaining > 0 ? `${remaining} attempt${remaining !== 1 ? "s" : ""} remaining.` : "No attempts remaining — request a new OTP."}`,
      });
    }

    // ── Verify ────────────────────────────────────────────────
    staff.isEmailVerified  = true;
    staff.isActive         = true;
    staff.emailOtp         = null;
    staff.emailOtpExpiry   = null;
    staff.emailOtpAttempts = 0;
    await staff.save();

    return res.status(200).json({
      success: true,
      message: "Email verified successfully. You can now log in.",
    });
  } catch (error) {
    console.error("Staff VerifyOtp Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ─────────────────────────────────────────────────────────────────
// POST /api/staff/resend-otp
// Resend a fresh OTP to an unverified email
// ─────────────────────────────────────────────────────────────────
exports.resendOtp = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: "Email is required" });

    const normEmail = email.toLowerCase().trim();
    const staff = await Staff.findOne({ email: normEmail })
      .select("+emailOtp +emailOtpExpiry +emailOtpAttempts +isEmailVerified");

    if (!staff) {
      return res.status(404).json({ success: false, message: "No account found for this email" });
    }

    if (staff.isEmailVerified) {
      return res.status(400).json({ success: false, message: "Email is already verified" });
    }

    const otp    = generateOtp();
    const expiry = new Date(Date.now() + OTP_EXPIRY_MS);

    staff.emailOtp         = otp;
    staff.emailOtpExpiry   = expiry;
    staff.emailOtpAttempts = 0;
    await staff.save();

    // Fire-and-forget — return immediately, email sends in background
    sendOtpEmail({ to: normEmail, name: staff.name, otp }).catch(() => {});

    return res.status(200).json({
      success: true,
      message: "A new OTP has been sent to your email.",
    });
  } catch (error) {
    console.error("Staff ResendOtp Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ─────────────────────────────────────────────────────────────────
// POST /api/staff/login
// ─────────────────────────────────────────────────────────────────
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: "Email and password are required" });
    }

    if (!EMAIL_RE.test(email.trim())) {
      return res.status(400).json({ success: false, message: "Invalid email format" });
    }

    const staff = await Staff.findOne({ email: email.toLowerCase().trim() })
      .select("+password +isEmailVerified");

    // Always return same error for missing user or wrong password (prevent enumeration)
    if (!staff) {
      return res.status(401).json({ success: false, message: "Invalid email or password" });
    }

    // Check email verified before checking password
    // Legacy accounts (created before OTP system) have isEmailVerified=undefined — treat as verified
    const emailVerified = staff.isEmailVerified !== false; // undefined or true → OK, only false blocks
    if (!emailVerified) {
      return res.status(403).json({
        success: false,
        message: "Email not verified. Please verify your email before logging in.",
        requiresOtp: true,
        email: email.toLowerCase().trim(),
      });
    }

    if (!staff.isActive) {
      return res.status(403).json({ success: false, message: "Account is disabled. Contact your administrator." });
    }

    const isMatch = await bcrypt.compare(password, staff.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: "Invalid email or password" });
    }

    const token = jwt.sign(
      { staffId: staff._id, restaurantId: staff.restaurantId, role: staff.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    staff.lastLogin = new Date();
    await staff.save();

    // Log login activity (fire-and-forget)
    logActivity({
      staff: { _id: staff._id, restaurantId: staff.restaurantId, name: staff.name, role: staff.role },
      action: "LOGIN",
      entityType: "Staff",
      entityId: staff._id,
      newValue: "Logged in",
      req,
    });

    return res.status(200).json({
      success: true,
      message: "Login successful",
      token,
      staff: {
        _id:             staff._id,
        name:            staff.name,
        email:           staff.email,
        mobile:          staff.mobile,
        role:            staff.role,
        restaurantId:    staff.restaurantId,
        isActive:        staff.isActive,
        isEmailVerified: staff.isEmailVerified,
        lastLogin:       staff.lastLogin,
        profileImage:    staff.profileImage,
      },
    });
  } catch (error) {
    console.error("Staff Login Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ─────────────────────────────────────────────────────────────────
// POST /api/staff/logout
// ─────────────────────────────────────────────────────────────────
exports.logout = async (_req, res) => {
  return res.status(200).json({ success: true, message: "Logged out successfully" });
};

// ─────────────────────────────────────────────────────────────────
// GET /api/staff/profile
// ─────────────────────────────────────────────────────────────────
exports.getProfile = async (req, res) => {
  try {
    const staff = await Staff.findById(req.staff._id);
    if (!staff) return res.status(404).json({ success: false, message: "Staff not found" });
    return res.status(200).json({ success: true, data: staff });
  } catch (error) {
    console.error("Staff GetProfile Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ─────────────────────────────────────────────────────────────────
// PUT /api/staff/profile
// ─────────────────────────────────────────────────────────────────
exports.updateProfile = async (req, res) => {
  try {
    const { name, mobile, profileImage } = req.body;

    if (!name && !mobile && profileImage === undefined) {
      return res.status(400).json({
        success: false,
        message: "Provide at least one field to update: name, mobile, or profileImage",
      });
    }

    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ success: false, message: "Name cannot be empty" });
      }
      if (name.trim().length > 50) {
        return res.status(400).json({ success: false, message: "Name must be 50 characters or fewer" });
      }
    }

    if (mobile !== undefined && mobile && !MOBILE_RE.test(mobile.trim())) {
      return res.status(400).json({ success: false, message: "Invalid mobile number format" });
    }

    const update = { updatedBy: req.staff._id };
    if (name)                        update.name         = name.trim();
    if (mobile)                      update.mobile       = mobile.trim();
    if (profileImage !== undefined)  update.profileImage = profileImage;

    const updated = await Staff.findByIdAndUpdate(
      req.staff._id, update, { returnDocument: 'after', runValidators: true }
    );

    if (!updated) {
      return res.status(404).json({ success: false, message: "Staff not found" });
    }

    return res.status(200).json({ success: true, message: "Profile updated", data: updated });
  } catch (error) {
    console.error("Staff UpdateProfile Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};
