const bcrypt = require("bcryptjs");
const jwt    = require("jsonwebtoken");
const Staff  = require("../models/Staff");
const Setting = require("../models/Setting");
const { logActivity } = require("../services/staffActivityService");
const {
  recordStaffLogin,
  recordStaffLoginFailed,
} = require("../services/loginActivityService");
const { emitToRestaurant } = require("../socket");

const EMAIL_RE  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const { isValidMobile, normalizeMobile, MOBILE_ERROR_MESSAGE } = require("../utils/validateMobile");
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

    if (!isValidMobile(mobile)) {
      return res.status(400).json({ success: false, message: MOBILE_ERROR_MESSAGE });
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
        existing.mobile = normalizeMobile(mobile);
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

        // Notify admins of this restaurant about the re-registration request
        emitToRestaurant(restaurantId.trim(), "staff_registration_request", {
          staffId:   existing._id,
          name:      existing.name,
          email:     existing.email,
          role:      existing.role,
          createdAt: existing.updatedAt || new Date().toISOString(),
        });

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

    const staff = await Staff.create({
      restaurantId:    restaurantId.trim(),
      name:            name.trim(),
      email:           normEmail,
      mobile:          normalizeMobile(mobile),
      password:        hashed,
      role,
      status:          "PENDING",
      isActive:        false,
      isEmailVerified: false,
    });

    // Notify admins of this restaurant about the new registration request.
    // The restaurantId is the backend-validated value from the Setting lookup
    // above — never the raw client input. This ensures the event is emitted
    // only to the correct restaurant room.
    emitToRestaurant(restaurantId.trim(), "staff_registration_request", {
      staffId:   staff._id,
      name:      staff.name,
      email:     staff.email,
      role:      staff.role,
      createdAt: staff.createdAt,
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
      recordStaffLoginFailed(email, "Invalid credentials", null, null, null, req);
      return res.status(401).json({ success: false, message: "Invalid email or password" });
    }

    // ── Check status before password verification ─────────────
    // Legacy accounts created before the approval system may not have a status field.
    // Treat undefined/null status as ACTIVE if isActive is true.
    const effectiveStatus = staff.status || (staff.isActive !== false ? "ACTIVE" : "BLOCKED");

    if (effectiveStatus === "PENDING") {
      recordStaffLoginFailed(email, "Account pending approval", staff.role, staff.restaurantId, null, req);
      return res.status(403).json({
        success: false,
        message: "Your registration request is awaiting administrator approval.",
        status: "PENDING",
      });
    }

    if (effectiveStatus === "REJECTED") {
      recordStaffLoginFailed(email, "Account rejected", staff.role, staff.restaurantId, null, req);
      return res.status(403).json({
        success: false,
        message: "Your registration request was rejected.",
        status: "REJECTED",
      });
    }

    if (effectiveStatus === "BLOCKED" || !staff.isActive) {
      recordStaffLoginFailed(email, "Account blocked", staff.role, staff.restaurantId, null, req);
      return res.status(403).json({
        success: false,
        message: "Your account has been blocked by the administrator.",
        status: "BLOCKED",
      });
    }

    const isMatch = await bcrypt.compare(password, staff.password);
    if (!isMatch) {
      recordStaffLoginFailed(email, "Invalid credentials", staff.role, staff.restaurantId, null, req);
      return res.status(401).json({ success: false, message: "Invalid email or password" });
    }

    // ── Check restaurant suspension and expiry ────────────────
    const restaurantSettings = await Setting.findOne({ restaurantId: staff.restaurantId })
      .select("accountStatus expiresAt restaurantName")
      .lean();

    if (restaurantSettings?.accountStatus === "SUSPENDED") {
      recordStaffLoginFailed(email, "Restaurant suspended", staff.role, staff.restaurantId, restaurantSettings?.restaurantName || null, req);
      return res.status(403).json({
        success: false,
        message: "This restaurant is currently suspended.",
        suspended: true,
      });
    }

    if (restaurantSettings?.expiresAt && new Date() >= new Date(restaurantSettings.expiresAt)) {
      recordStaffLoginFailed(email, "Restaurant expired", staff.role, staff.restaurantId, restaurantSettings?.restaurantName || null, req);
      return res.status(403).json({
        success: false,
        message: "This restaurant's subscription has expired. Please contact FlowUp support.",
        expired: true,
      });
    }

    const token = jwt.sign(
      { staffId: staff._id, restaurantId: staff.restaurantId, role: staff.role },
      process.env.JWT_SECRET,
      { expiresIn: "24h" }
    );

    staff.lastLogin = new Date();
    await staff.save();

    // Log to staff activity (existing feature — unchanged)
    logActivity({
      staff: { _id: staff._id, restaurantId: staff.restaurantId, name: staff.name, role: staff.role },
      action: "LOGIN",
      entityType: "Staff",
      entityId: staff._id,
      newValue: "Logged in",
      req,
    });

    // Record platform login audit — fire-and-forget
    recordStaffLogin(staff, req, restaurantSettings?.restaurantName || null);

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

    if (mobile !== undefined && mobile && !isValidMobile(mobile)) {
      return res.status(400).json({ success: false, message: MOBILE_ERROR_MESSAGE });
    }

    const update = { updatedBy: req.staff._id };
    if (name)                        update.name         = name.trim();
    if (mobile)                      update.mobile       = normalizeMobile(mobile);
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
