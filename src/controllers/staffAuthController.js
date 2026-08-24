const bcrypt = require("bcryptjs");
const jwt    = require("jsonwebtoken");
const Staff  = require("../models/Staff");
const Setting = require("../models/Setting");
const { logActivity } = require("../services/staffActivityService");

const EMAIL_RE  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MOBILE_RE = /^\+?\d{7,15}$/;
const VALID_ROLES = ["CHEF", "WAITER", "ASSISTANT"]; // ADMIN cannot self-register

// ─────────────────────────────────────────────────────────────────
// POST /api/staff/signup
// Submit a registration request → status = PENDING
// ─────────────────────────────────────────────────────────────────
exports.signup = async (req, res) => {
  try {
    const { restaurantId, name, email, mobile, password, role } = req.body;

    // ── Required field check ──────────────────────────────────
    const missing = ["restaurantId", "name", "email", "mobile", "password", "role"]
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

    // ── Validate restaurant exists ────────────────────────────
    const trimmedRestaurantId = restaurantId.trim();
    const restaurant = await Setting.findOne({ restaurantId: trimmedRestaurantId });
    if (!restaurant) {
      return res.status(404).json({ success: false, message: "Restaurant not found. Please use a valid signup link." });
    }

    const normEmail = email.toLowerCase().trim();

    // ── Duplicate check ───────────────────────────────────────
    const existing = await Staff.findOne({ email: normEmail });

    if (existing) {
      if (existing.status === "PENDING") {
        return res.status(409).json({
          success: false,
          message: "A registration request with this email is already pending approval.",
        });
      }
      if (existing.status === "ACTIVE") {
        return res.status(409).json({ success: false, message: "An account with this email already exists." });
      }
      if (existing.status === "BLOCKED") {
        return res.status(409).json({ success: false, message: "An account with this email already exists and is blocked." });
      }
      if (existing.status === "REJECTED") {
        // Allow re-registration after rejection — but ONLY for the same restaurant.
        // A rejected Staff record must never be moved to a different restaurant.
        if (existing.restaurantId !== restaurantId.trim()) {
          return res.status(409).json({ success: false, message: "An account with this email already exists." });
        }

        const hashed = await bcrypt.hash(password, 10);
        existing.name = name.trim();
        existing.mobile = mobile.trim().replace(/\s/g, "");
        existing.password = hashed;
        existing.role = role;
        // restaurantId intentionally NOT changed — remains the original restaurant
        existing.status = "PENDING";
        existing.isActive = false;
        existing.isEmailVerified = false;
        existing.rejectionReason = null;
        existing.reviewedBy = null;
        existing.reviewedAt = null;
        await existing.save();

        return res.status(200).json({
          success: true,
          message: "Registration request submitted successfully. Your request is waiting for administrator approval.",
          status: "PENDING",
        });
      }
      // Fallback for legacy accounts without status field
      return res.status(409).json({ success: false, message: "Email already registered" });
    }

    // ── Create PENDING staff registration request ─────────────
    const hashed = await bcrypt.hash(password, 10);

    await Staff.create({
      restaurantId:    restaurantId.trim(),
      name:            name.trim(),
      email:           normEmail,
      mobile:          mobile.trim().replace(/\s/g, ""),
      password:        hashed,
      role,
      status:          "PENDING",
      isActive:        false,
      isEmailVerified: false,
    });

    return res.status(201).json({
      success: true,
      message: "Registration request submitted successfully. Your request is waiting for administrator approval.",
      status: "PENDING",
    });
  } catch (error) {
    console.error("Staff Signup Error:", error);
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
      .select("+password");

    // Always return same error for missing user or wrong password (prevent enumeration)
    if (!staff) {
      return res.status(401).json({ success: false, message: "Invalid email or password" });
    }

    // ── Check status before password verification ─────────────
    // Legacy accounts created before the approval system may not have a status field.
    // Treat undefined/null status as ACTIVE if isActive is true.
    const effectiveStatus = staff.status || (staff.isActive !== false ? "ACTIVE" : "BLOCKED");

    if (effectiveStatus === "PENDING") {
      return res.status(403).json({
        success: false,
        message: "Your registration request is awaiting administrator approval.",
        status: "PENDING",
      });
    }

    if (effectiveStatus === "REJECTED") {
      return res.status(403).json({
        success: false,
        message: "Your registration request was rejected.",
        status: "REJECTED",
      });
    }

    if (effectiveStatus === "BLOCKED" || !staff.isActive) {
      return res.status(403).json({
        success: false,
        message: "Your account has been blocked by the administrator.",
        status: "BLOCKED",
      });
    }

    const isMatch = await bcrypt.compare(password, staff.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: "Invalid email or password" });
    }

    // ── Check restaurant suspension ───────────────────────────
    const restaurantSettings = await Setting.findOne({ restaurantId: staff.restaurantId })
      .select("accountStatus")
      .lean();

    if (restaurantSettings?.accountStatus === "SUSPENDED") {
      return res.status(403).json({
        success: false,
        message: "This restaurant is currently suspended.",
        suspended: true,
      });
    }

    const token = jwt.sign(
      { staffId: staff._id, restaurantId: staff.restaurantId, role: staff.role },
      process.env.JWT_SECRET,
      { expiresIn: "24h" }
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
        _id:          staff._id,
        name:         staff.name,
        email:        staff.email,
        mobile:       staff.mobile,
        role:         staff.role,
        restaurantId: staff.restaurantId,
        isActive:     staff.isActive,
        status:       staff.status,
        lastLogin:    staff.lastLogin,
        profileImage: staff.profileImage,
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
