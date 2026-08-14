/**
 * Admin Staff Management Controller
 * All routes are protected by the admin `protect` middleware.
 * Every query is scoped to req.user.restaurantId (restaurant isolation).
 */

const bcrypt       = require("bcryptjs");
const mongoose     = require("mongoose");
const Staff        = require("../models/Staff");
const StaffActivity = require("../models/StaffActivity");
const { logActivity } = require("../services/staffActivityService");

const EMAIL_RE  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MOBILE_RE = /^\+?\d{7,15}$/;
const MANAGEABLE_ROLES = ["CHEF", "WAITER", "ASSISTANT"];  // Admin cannot manage other ADMINs via this UI

// ── Helper ────────────────────────────────────────────────────────
function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

// ── GET /api/admin/staff ──────────────────────────────────────────
// List all staff for this restaurant (excluding other ADMINs).
exports.getStaff = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const { search, role, status, page = 1, limit = 50 } = req.query;

    const filter = {
      restaurantId,
      role: { $in: MANAGEABLE_ROLES },
    };

    if (role && MANAGEABLE_ROLES.includes(role)) {
      filter.role = role;
    }

    if (status === "active")  filter.isActive = true;
    if (status === "blocked") filter.isActive = false;

    if (search && search.trim()) {
      const q = search.trim();
      filter.$or = [
        { name:   { $regex: q, $options: "i" } },
        { email:  { $regex: q, $options: "i" } },
        { mobile: { $regex: q, $options: "i" } },
      ];
    }

    const skip  = (Number(page) - 1) * Number(limit);
    const total = await Staff.countDocuments(filter);

    const staffList = await Staff
      .find(filter)
      .select("-emailOtp -emailOtpExpiry -emailOtpAttempts -password")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit));

    // Summary counts (unfiltered)
    const [totalCount, activeCount, blockedCount] = await Promise.all([
      Staff.countDocuments({ restaurantId, role: { $in: MANAGEABLE_ROLES } }),
      Staff.countDocuments({ restaurantId, role: { $in: MANAGEABLE_ROLES }, isActive: true }),
      Staff.countDocuments({ restaurantId, role: { $in: MANAGEABLE_ROLES }, isActive: false }),
    ]);

    return res.status(200).json({
      success: true,
      data:    staffList,
      total,
      page:    Number(page),
      limit:   Number(limit),
      summary: { total: totalCount, active: activeCount, blocked: blockedCount },
    });
  } catch (err) {
    console.error("AdminStaff getStaff:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── GET /api/admin/staff/:id ──────────────────────────────────────
exports.getStaffById = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid staff ID" });
    }
    const restaurantId = req.user.restaurantId;
    const staff = await Staff
      .findOne({ _id: req.params.id, restaurantId, role: { $in: MANAGEABLE_ROLES } })
      .select("-emailOtp -emailOtpExpiry -emailOtpAttempts -password");

    if (!staff) return res.status(404).json({ success: false, message: "Staff not found" });

    return res.status(200).json({ success: true, data: staff });
  } catch (err) {
    console.error("AdminStaff getStaffById:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── POST /api/admin/staff ─────────────────────────────────────────
// Admin creates a staff account directly — pre-verified, no OTP needed.
exports.createStaff = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const { name, email, mobile, role, password } = req.body;

    // Validate required fields
    const missing = ["name", "email", "mobile", "role", "password"]
      .filter(f => !req.body[f] || !String(req.body[f]).trim());
    if (missing.length) {
      return res.status(400).json({ success: false, message: `Missing: ${missing.join(", ")}` });
    }

    if (!EMAIL_RE.test(email.trim())) {
      return res.status(400).json({ success: false, message: "Invalid email format" });
    }
    if (!MOBILE_RE.test(mobile.trim().replace(/\s/g, ""))) {
      return res.status(400).json({ success: false, message: "Invalid mobile number" });
    }
    if (password.length < 6) {
      return res.status(400).json({ success: false, message: "Password must be at least 6 characters" });
    }
    if (!MANAGEABLE_ROLES.includes(role)) {
      return res.status(400).json({ success: false, message: `Role must be one of: ${MANAGEABLE_ROLES.join(", ")}` });
    }

    const normEmail = email.toLowerCase().trim();
    const existing  = await Staff.findOne({ email: normEmail });
    if (existing) {
      return res.status(409).json({ success: false, message: "Email already registered" });
    }

    const hashed = await bcrypt.hash(password, 10);
    const staff  = await Staff.create({
      restaurantId,
      name:            name.trim(),
      email:           normEmail,
      mobile:          mobile.trim().replace(/\s/g, ""),
      password:        hashed,
      role,
      isEmailVerified: true,   // Admin-created accounts are pre-verified
      isActive:        true,
      createdBy:       null,   // created by Admin (different model)
    });

    // Log admin action (using a synthetic staff-like object for the logger)
    logActivity({
      staff: { _id: req.user._id, restaurantId, name: req.user.name, role: "ADMIN" },
      action: "STAFF_CREATED",
      entityType: "Staff",
      entityId: staff._id,
      newValue: `${staff.name} (${staff.role})`,
      req,
    });

    const safe = await Staff
      .findById(staff._id)
      .select("-emailOtp -emailOtpExpiry -emailOtpAttempts -password");

    return res.status(201).json({ success: true, message: "Staff created successfully", data: safe });
  } catch (err) {
    console.error("AdminStaff createStaff:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── PATCH /api/admin/staff/:id ────────────────────────────────────
// Update name, mobile, role.
exports.updateStaff = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid staff ID" });
    }
    const restaurantId = req.user.restaurantId;
    const staff = await Staff.findOne({
      _id: req.params.id, restaurantId, role: { $in: MANAGEABLE_ROLES },
    });
    if (!staff) return res.status(404).json({ success: false, message: "Staff not found" });

    const { name, mobile, role } = req.body;
    const update = { updatedBy: null };  // updated by Admin, different model

    if (name   !== undefined && name.trim())   update.name   = name.trim();
    if (mobile !== undefined && mobile.trim()) {
      if (!MOBILE_RE.test(mobile.trim().replace(/\s/g, ""))) {
        return res.status(400).json({ success: false, message: "Invalid mobile number" });
      }
      update.mobile = mobile.trim().replace(/\s/g, "");
    }
    if (role !== undefined) {
      if (!MANAGEABLE_ROLES.includes(role)) {
        return res.status(400).json({ success: false, message: `Role must be one of: ${MANAGEABLE_ROLES.join(", ")}` });
      }
      update.role = role;
    }

    const updated = await Staff.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true })
      .select("-emailOtp -emailOtpExpiry -emailOtpAttempts -password");

    logActivity({
      staff: { _id: req.user._id, restaurantId, name: req.user.name, role: "ADMIN" },
      action: "STAFF_UPDATED",
      entityType: "Staff",
      entityId: staff._id,
      oldValue: `${staff.name} (${staff.role})`,
      newValue: `${updated.name} (${updated.role})`,
      req,
    });

    return res.status(200).json({ success: true, message: "Staff updated", data: updated });
  } catch (err) {
    console.error("AdminStaff updateStaff:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── PATCH /api/admin/staff/:id/block ─────────────────────────────
exports.blockStaff = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid staff ID" });
    }
    const restaurantId = req.user.restaurantId;
    const staff = await Staff.findOne({
      _id: req.params.id, restaurantId, role: { $in: MANAGEABLE_ROLES },
    });
    if (!staff) return res.status(404).json({ success: false, message: "Staff not found" });
    if (!staff.isActive) {
      return res.status(400).json({ success: false, message: "Staff is already blocked" });
    }

    staff.isActive = false;
    await staff.save();

    logActivity({
      staff: { _id: req.user._id, restaurantId, name: req.user.name, role: "ADMIN" },
      action: "STAFF_BLOCKED",
      entityType: "Staff",
      entityId: staff._id,
      oldValue: "ACTIVE",
      newValue: "BLOCKED",
      req,
    });

    const safe = await Staff.findById(staff._id).select("-emailOtp -emailOtpExpiry -emailOtpAttempts -password");
    return res.status(200).json({ success: true, message: `${staff.name} has been blocked`, data: safe });
  } catch (err) {
    console.error("AdminStaff blockStaff:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── PATCH /api/admin/staff/:id/unblock ───────────────────────────
exports.unblockStaff = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid staff ID" });
    }
    const restaurantId = req.user.restaurantId;
    const staff = await Staff.findOne({
      _id: req.params.id, restaurantId, role: { $in: MANAGEABLE_ROLES },
    });
    if (!staff) return res.status(404).json({ success: false, message: "Staff not found" });
    if (staff.isActive) {
      return res.status(400).json({ success: false, message: "Staff is already active" });
    }

    staff.isActive = true;
    await staff.save();

    logActivity({
      staff: { _id: req.user._id, restaurantId, name: req.user.name, role: "ADMIN" },
      action: "STAFF_UNBLOCKED",
      entityType: "Staff",
      entityId: staff._id,
      oldValue: "BLOCKED",
      newValue: "ACTIVE",
      req,
    });

    const safe = await Staff.findById(staff._id).select("-emailOtp -emailOtpExpiry -emailOtpAttempts -password");
    return res.status(200).json({ success: true, message: `${staff.name} has been unblocked`, data: safe });
  } catch (err) {
    console.error("AdminStaff unblockStaff:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── GET /api/admin/staff/:id/activity ────────────────────────────
exports.getStaffActivity = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid staff ID" });
    }
    const restaurantId = req.user.restaurantId;

    // Verify the staff belongs to this restaurant
    const staff = await Staff.findOne({
      _id: req.params.id, restaurantId,
    }).select("name role");
    if (!staff) return res.status(404).json({ success: false, message: "Staff not found" });

    const { page = 1, limit = 30, days } = req.query;
    const filter = { restaurantId, staffId: req.params.id };

    if (days) {
      const since = new Date();
      since.setDate(since.getDate() - Number(days));
      filter.timestamp = { $gte: since };
    }

    const skip  = (Number(page) - 1) * Number(limit);
    const total = await StaffActivity.countDocuments(filter);

    const activities = await StaffActivity
      .find(filter)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(Number(limit));

    return res.status(200).json({
      success:    true,
      staff:      { _id: staff._id, name: staff.name, role: staff.role },
      data:       activities,
      total,
      page:       Number(page),
      limit:      Number(limit),
    });
  } catch (err) {
    console.error("AdminStaff getStaffActivity:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};
