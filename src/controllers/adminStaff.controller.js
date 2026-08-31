/**
 * Admin Staff Management Controller
 * All routes are protected by the admin `protect` middleware.
 * Every query is scoped to req.user.restaurantId (restaurant isolation).
 */

const bcrypt        = require("bcryptjs");
const mongoose      = require("mongoose");
const Staff         = require("../models/Staff");
const StaffActivity = require("../models/StaffActivity");
const { logActivity }  = require("../services/staffActivityService");

const EMAIL_RE  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const { isValidMobile, normalizeMobile, MOBILE_ERROR_MESSAGE } = require("../utils/validateMobile");
const MANAGEABLE_ROLES = ["CHEF", "WAITER", "ASSISTANT"];

// ── Helper ────────────────────────────────────────────────────────
function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

/**
 * Escape a user-supplied string for safe use inside a MongoDB $regex.
 * Without escaping, a search for "(" produces a regex parse error (500),
 * and patterns like "(a+)+" are treated as executable regex (ReDoS risk).
 */
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── GET /api/admin/staff ──────────────────────────────────────────
// List all staff for this restaurant (excluding other ADMINs).
exports.getStaff = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const { search, role, status, page = 1, limit = 50 } = req.query;

    // Use $and to combine conditions safely — avoids $or collisions
    const conditions = [
      { restaurantId },
      { role: { $in: MANAGEABLE_ROLES } },
    ];

    // Status filter — default shows active/blocked + legacy accounts
    if (status === "active") {
      // "Active" means: explicitly ACTIVE, or a legacy account (no/null status)
      // that has not been deactivated. Kept in sync with the `active` summary count
      // (legacyActiveFilter) so the list and the count always agree.
      conditions.push({ isActive: { $ne: false } });
      conditions.push({
        $or: [
          { status: "ACTIVE" },
          { status: { $exists: false } },
          { status: null },
        ],
      });
    } else if (status === "blocked") {
      conditions.push({ status: "BLOCKED" });
    } else {
      // Default: show active + blocked + legacy (exclude PENDING & REJECTED)
      conditions.push({
        $or: [
          { status: { $in: ["ACTIVE", "BLOCKED"] } },
          { status: { $exists: false } },
          { status: null },
        ],
      });
    }

    if (role && MANAGEABLE_ROLES.includes(role)) {
      conditions.push({ role });
    }

    if (search && search.trim()) {
      // FIX: escape user input to prevent regex parse errors (e.g. "(") and ReDoS
      const q = escapeRegex(search.trim());
      conditions.push({
        $or: [
          { name:   { $regex: q, $options: "i" } },
          { email:  { $regex: q, $options: "i" } },
          { mobile: { $regex: q, $options: "i" } },
        ],
      });
    }

    const filter = { $and: conditions };

    const skip  = (Number(page) - 1) * Number(limit);
    const total = await Staff.countDocuments(filter);

    const staffList = await Staff
      .find(filter)
      .select("-password")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit));

    // Summary counts (includes legacy accounts without status field)
    const legacyActiveFilter = { restaurantId, role: { $in: MANAGEABLE_ROLES }, $or: [{ status: "ACTIVE" }, { status: { $exists: false } }, { status: null }], isActive: { $ne: false } };
    const [totalCount, activeCount, blockedCount, pendingCount] = await Promise.all([
      Staff.countDocuments({ restaurantId, role: { $in: MANAGEABLE_ROLES }, $or: [{ status: { $in: ["ACTIVE", "BLOCKED"] } }, { status: { $exists: false } }, { status: null }] }),
      Staff.countDocuments(legacyActiveFilter),
      Staff.countDocuments({ restaurantId, role: { $in: MANAGEABLE_ROLES }, status: "BLOCKED" }),
      Staff.countDocuments({ restaurantId, role: { $in: MANAGEABLE_ROLES }, status: "PENDING" }),
    ]);

    return res.status(200).json({
      success: true,
      data:    staffList,
      total,
      page:    Number(page),
      limit:   Number(limit),
      summary: { total: totalCount, active: activeCount, blocked: blockedCount, pending: pendingCount },
    });
  } catch (err) {
    console.error("AdminStaff getStaff:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── GET /api/admin/staff/pending ──────────────────────────────────
// List pending registration requests for this restaurant.
exports.getPendingRequests = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const { page = 1, limit = 50 } = req.query;

    const filter = {
      restaurantId,
      role: { $in: MANAGEABLE_ROLES },
      status: "PENDING",
    };

    const skip  = (Number(page) - 1) * Number(limit);
    const total = await Staff.countDocuments(filter);

    const requests = await Staff
      .find(filter)
      .select("name email mobile role status createdAt restaurantId")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit));

    return res.status(200).json({
      success: true,
      data:    requests,
      total,
      page:    Number(page),
      limit:   Number(limit),
    });
  } catch (err) {
    console.error("AdminStaff getPendingRequests:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── GET /api/admin/staff/rejected ─────────────────────────────────
// List rejected registration requests for this restaurant.
exports.getRejectedRequests = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const { page = 1, limit = 50 } = req.query;

    const filter = {
      restaurantId,
      role: { $in: MANAGEABLE_ROLES },
      status: "REJECTED",
    };

    const skip  = (Number(page) - 1) * Number(limit);
    const total = await Staff.countDocuments(filter);

    const requests = await Staff
      .find(filter)
      .select("name email mobile role status createdAt rejectionReason reviewedAt restaurantId")
      .sort({ reviewedAt: -1, createdAt: -1 })
      .skip(skip)
      .limit(Number(limit));

    return res.status(200).json({
      success: true,
      data:    requests,
      total,
      page:    Number(page),
      limit:   Number(limit),
    });
  } catch (err) {
    console.error("AdminStaff getRejectedRequests:", err);
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
      .select("-password");

    if (!staff) return res.status(404).json({ success: false, message: "Staff not found" });

    return res.status(200).json({ success: true, data: staff });
  } catch (err) {
    console.error("AdminStaff getStaffById:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── POST /api/admin/staff ─────────────────────────────────────────
// Admin creates a staff account directly → status = ACTIVE immediately.
exports.createStaff = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const { name, email, mobile, role, password } = req.body;

    const missing = ["name", "email", "mobile", "role", "password"]
      .filter(f => !req.body[f] || !String(req.body[f]).trim());
    if (missing.length) {
      return res.status(400).json({ success: false, message: `Missing: ${missing.join(", ")}` });
    }
    if (!EMAIL_RE.test(email.trim())) {
      return res.status(400).json({ success: false, message: "Invalid email format" });
    }
    if (!isValidMobile(mobile)) {
      return res.status(400).json({ success: false, message: MOBILE_ERROR_MESSAGE });
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
      if (existing.status === "PENDING") {
        return res.status(409).json({ success: false, message: "A pending request with this email already exists. Approve it instead." });
      }
      return res.status(409).json({ success: false, message: "Email already registered" });
    }

    // Create active account directly (admin-created staff are immediately active)
    const hashed = await bcrypt.hash(password, 10);

    const staff = await Staff.create({
      restaurantId,
      name:            name.trim(),
      email:           normEmail,
      mobile:          normalizeMobile(mobile),
      password:        hashed,
      role,
      status:          "ACTIVE",
      isActive:        true,
      isEmailVerified: true,
      createdBy:       req.user._id,
    });

    logActivity({
      staff: { _id: req.user._id, restaurantId, name: req.user.name, role: "ADMIN" },
      action:     "STAFF_CREATED",
      entityType: "Staff",
      entityId:   staff._id,
      newValue:   `${staff.name} (${staff.role}) — active`,
      req,
    });

    const safe = await Staff.findById(staff._id).select("-password");
    return res.status(201).json({
      success: true,
      message: "Staff account created and activated.",
      data:    safe,
    });
  } catch (err) {
    console.error("AdminStaff createStaff:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── PATCH /api/admin/staff/:id/approve ────────────────────────────
// Admin approves a PENDING registration request.
exports.approveStaff = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid staff ID" });
    }
    const restaurantId = req.user.restaurantId;

    const staff = await Staff.findOne({
      _id: req.params.id,
      restaurantId,
      role: { $in: MANAGEABLE_ROLES },
    });

    if (!staff) {
      return res.status(404).json({ success: false, message: "Staff not found" });
    }

    if (staff.status !== "PENDING") {
      return res.status(409).json({
        success: false,
        message: `Cannot approve — staff status is already "${staff.status}".`,
      });
    }

    // Atomic update to prevent double-approval race condition
    const updated = await Staff.findOneAndUpdate(
      { _id: staff._id, status: "PENDING" },
      {
        $set: {
          status:          "ACTIVE",
          isActive:        true,
          isEmailVerified: true,
          reviewedBy:      req.user._id,
          reviewedAt:      new Date(),
        },
      },
      { new: true }
    ).select("-password");

    if (!updated) {
      return res.status(409).json({
        success: false,
        message: "Staff request has already been reviewed.",
      });
    }

    logActivity({
      staff: { _id: req.user._id, restaurantId, name: req.user.name, role: "ADMIN" },
      action:     "STAFF_APPROVED",
      entityType: "Staff",
      entityId:   staff._id,
      oldValue:   "PENDING",
      newValue:   `ACTIVE — ${staff.name} (${staff.role})`,
      req,
    });

    return res.status(200).json({
      success: true,
      message: `${staff.name} has been approved and can now log in.`,
      data:    updated,
    });
  } catch (err) {
    console.error("AdminStaff approveStaff:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── PATCH /api/admin/staff/:id/reject ─────────────────────────────
// Admin rejects a PENDING registration request.
exports.rejectStaff = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid staff ID" });
    }
    const restaurantId = req.user.restaurantId;
    const { reason } = req.body;

    const staff = await Staff.findOne({
      _id: req.params.id,
      restaurantId,
      role: { $in: MANAGEABLE_ROLES },
    });

    if (!staff) {
      return res.status(404).json({ success: false, message: "Staff not found" });
    }

    if (staff.status !== "PENDING") {
      return res.status(409).json({
        success: false,
        message: `Cannot reject — staff status is already "${staff.status}".`,
      });
    }

    // Atomic update to prevent double-rejection race condition
    const updated = await Staff.findOneAndUpdate(
      { _id: staff._id, status: "PENDING" },
      {
        $set: {
          status:          "REJECTED",
          isActive:        false,
          reviewedBy:      req.user._id,
          reviewedAt:      new Date(),
          rejectionReason: reason ? String(reason).trim().slice(0, 500) : null,
        },
      },
      { new: true }
    ).select("-password");

    if (!updated) {
      return res.status(409).json({
        success: false,
        message: "Staff request has already been reviewed.",
      });
    }

    logActivity({
      staff: { _id: req.user._id, restaurantId, name: req.user.name, role: "ADMIN" },
      action:     "STAFF_REJECTED",
      entityType: "Staff",
      entityId:   staff._id,
      oldValue:   "PENDING",
      newValue:   `REJECTED — ${staff.name} (${staff.role})${reason ? `: ${reason}` : ""}`,
      req,
    });

    return res.status(200).json({
      success: true,
      message: `${staff.name}'s registration request has been rejected.`,
      data:    updated,
    });
  } catch (err) {
    console.error("AdminStaff rejectStaff:", err);
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
    const update = { updatedBy: null };

    if (name   !== undefined && name.trim())   update.name   = name.trim();
    if (mobile !== undefined && mobile.trim()) {
      if (!isValidMobile(mobile)) {
        return res.status(400).json({ success: false, message: MOBILE_ERROR_MESSAGE });
      }
      update.mobile = normalizeMobile(mobile);
    }
    if (role !== undefined) {
      if (!MANAGEABLE_ROLES.includes(role)) {
        return res.status(400).json({ success: false, message: `Role must be one of: ${MANAGEABLE_ROLES.join(", ")}` });
      }
      update.role = role;
    }

    const updated = await Staff.findByIdAndUpdate(req.params.id, update, { returnDocument: 'after', runValidators: true })
      .select("-password");

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
    if (staff.status === "BLOCKED" || !staff.isActive) {
      return res.status(400).json({ success: false, message: "Staff is already blocked" });
    }

    staff.status   = "BLOCKED";
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

    const safe = await Staff.findById(staff._id).select("-password");
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
    if (staff.status === "ACTIVE" && staff.isActive) {
      return res.status(400).json({ success: false, message: "Staff is already active" });
    }

    staff.status   = "ACTIVE";
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

    const safe = await Staff.findById(staff._id).select("-password");
    return res.status(200).json({ success: true, message: `${staff.name} has been unblocked`, data: safe });
  } catch (err) {
    console.error("AdminStaff unblockStaff:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── PATCH /api/admin/staff/:id/reset-password ─────────────────────
// Restaurant ADMIN resets a staff member's password.
// Only targets CHEF, WAITER, ASSISTANT in the same restaurant.
// Never reads or returns any existing password or hash.
exports.resetStaffPassword = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid staff ID." });
    }
    const restaurantId = req.user.restaurantId;
    const { newPassword } = req.body;

    // ── Validate newPassword ───────────────────────────────────
    if (!newPassword || typeof newPassword !== "string" || !newPassword.trim()) {
      return res.status(400).json({ success: false, message: "New password is required." });
    }
    const trimmedPassword = newPassword.trim();
    if (trimmedPassword.length < 8) {
      return res.status(400).json({ success: false, message: "Password must be at least 8 characters." });
    }
    if (trimmedPassword.length > 128) {
      return res.status(400).json({ success: false, message: "Password must be 128 characters or fewer." });
    }

    // ── Find staff — restaurant-scoped, manageable roles only ──
    // This prevents resetting ADMIN or SUPER_ADMIN passwords,
    // and prevents cross-restaurant access.
    const staff = await Staff.findOne({
      _id:          req.params.id,
      restaurantId,
      role:         { $in: MANAGEABLE_ROLES },
    });

    if (!staff) {
      // Return 404 regardless of reason — do not reveal cross-restaurant existence
      return res.status(404).json({ success: false, message: "Staff not found." });
    }

    // ── Hash and save — never store plaintext ──────────────────
    const hashedPassword = await bcrypt.hash(trimmedPassword, 10);
    staff.password = hashedPassword;
    await staff.save();

    // ── Audit log — fire-and-forget, NO password in log ───────
    logActivity({
      staff: { _id: req.user._id, restaurantId, name: req.user.name, role: "ADMIN" },
      action:     "STAFF_PASSWORD_RESET",
      entityType: "Staff",
      entityId:   staff._id,
      oldValue:   "",
      newValue:   `Password reset for ${staff.name} (${staff.role})`,
      req,
    });

    return res.status(200).json({
      success: true,
      message: "Staff password has been reset successfully.",
    });
  } catch (err) {
    console.error("AdminStaff resetStaffPassword:", err);
    return res.status(500).json({ success: false, message: "Failed to reset staff password." });
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
