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
const { generateOtp, sendOtpEmail } = require("../services/emailService");

const EMAIL_RE  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MOBILE_RE = /^\+?\d{7,15}$/;
const MANAGEABLE_ROLES = ["CHEF", "WAITER", "ASSISTANT"];
const MAX_OTP_ATTEMPTS = 5;

// Evaluated at runtime so env vars loaded after module init are picked up
function getOtpExpiryMs() {
  return (Number(process.env.OTP_EXPIRY_MINUTES) || 10) * 60 * 1000;
}

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
// Admin creates a staff account → sends OTP email for verification.
// The account is unverified/inactive until OTP is confirmed.
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
    const existing  = await Staff.findOne({ email: normEmail })
      .select("+emailOtp +emailOtpExpiry +isEmailVerified");

    // If an unverified account already exists (e.g., re-adding), regenerate + resend OTP
    if (existing) {
      if (!existing.isEmailVerified) {
        const otp    = generateOtp();
        const expiry = new Date(Date.now() + getOtpExpiryMs());
        existing.emailOtp         = otp;
        existing.emailOtpExpiry   = expiry;
        existing.emailOtpAttempts = 0;
        await existing.save();

        try {
          await sendOtpEmail({ to: normEmail, name: existing.name, otp });
          return res.status(200).json({
            success:     true,
            requiresOtp: true,
            emailSent:   true,
            email:       normEmail,
            staffId:     existing._id,
            message:     "An unverified account already exists. A new OTP has been sent to their email.",
          });
        } catch (emailErr) {
          console.error("[createStaff] OTP resend failed for existing account:", {
            staffId: existing._id, message: emailErr.message, code: emailErr.code,
          });
          return res.status(200).json({
            success:     true,
            requiresOtp: true,
            emailSent:   false,
            email:       normEmail,
            staffId:     existing._id,
            message:     "An unverified account already exists, but the OTP email could not be sent. Please check the email configuration and use Resend OTP.",
          });
        }
      }
      return res.status(409).json({ success: false, message: "Email already registered" });
    }

    // Create unverified account
    const hashed = await bcrypt.hash(password, 10);
    const otp    = generateOtp();
    const expiry = new Date(Date.now() + getOtpExpiryMs());

    const staff = await Staff.create({
      restaurantId,
      name:             name.trim(),
      email:            normEmail,
      mobile:           mobile.trim().replace(/\s/g, ""),
      password:         hashed,
      role,
      isEmailVerified:  false,
      isActive:         false,
      emailOtp:         otp,
      emailOtpExpiry:   expiry,
      emailOtpAttempts: 0,
    });

    logActivity({
      staff: { _id: req.user._id, restaurantId, name: req.user.name, role: "ADMIN" },
      action:     "STAFF_CREATED",
      entityType: "Staff",
      entityId:   staff._id,
      newValue:   `${staff.name} (${staff.role}) — pending OTP verification`,
      req,
    });

    // Send OTP — await so we can report delivery status accurately
    try {
      await sendOtpEmail({ to: normEmail, name: name.trim(), otp });
      return res.status(201).json({
        success:     true,
        requiresOtp: true,
        emailSent:   true,
        email:       normEmail,
        staffId:     staff._id,
        message:     "Staff account created. An OTP has been sent to their email for verification.",
      });
    } catch (emailErr) {
      console.error("[createStaff] OTP email failed:", {
        staffId: staff._id, message: emailErr.message, code: emailErr.code,
      });
      // Account exists in DB with OTP saved — admin can use Resend OTP
      return res.status(201).json({
        success:     true,
        requiresOtp: true,
        emailSent:   false,
        email:       normEmail,
        staffId:     staff._id,
        message:     "Staff account was created, but the OTP email could not be sent. Please check the email configuration and use Resend OTP.",
      });
    }
  } catch (err) {
    console.error("AdminStaff createStaff:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── POST /api/admin/staff/:id/verify-otp ─────────────────────────
// Admin verifies the OTP for a newly created staff account.
exports.verifyStaffOtp = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid staff ID" });
    }
    const restaurantId = req.user.restaurantId;
    const { otp }      = req.body;

    if (!otp) {
      return res.status(400).json({ success: false, message: "OTP is required" });
    }

    const staff = await Staff.findOne({ _id: req.params.id, restaurantId })
      .select("+emailOtp +emailOtpExpiry +emailOtpAttempts +isEmailVerified");

    if (!staff) {
      return res.status(404).json({ success: false, message: "Staff not found" });
    }
    if (staff.isEmailVerified) {
      return res.status(400).json({ success: false, message: "Email already verified" });
    }
    if (staff.emailOtpAttempts >= MAX_OTP_ATTEMPTS) {
      return res.status(429).json({ success: false, message: "Too many incorrect attempts. Resend OTP." });
    }
    if (!staff.emailOtpExpiry || new Date() > staff.emailOtpExpiry) {
      return res.status(400).json({ success: false, message: "OTP has expired. Please resend." });
    }
    if (staff.emailOtp !== String(otp).trim()) {
      staff.emailOtpAttempts += 1;
      await staff.save();
      const remaining = MAX_OTP_ATTEMPTS - staff.emailOtpAttempts;
      return res.status(400).json({
        success: false,
        message: `Invalid OTP. ${remaining > 0 ? `${remaining} attempt(s) remaining.` : "No attempts left — resend OTP."}`,
      });
    }

    // Verify + activate
    staff.isEmailVerified  = true;
    staff.isActive         = true;
    staff.emailOtp         = null;
    staff.emailOtpExpiry   = null;
    staff.emailOtpAttempts = 0;
    await staff.save();

    logActivity({
      staff: { _id: req.user._id, restaurantId, name: req.user.name, role: "ADMIN" },
      action:     "STAFF_VERIFIED",
      entityType: "Staff",
      entityId:   staff._id,
      newValue:   `${staff.name} email verified`,
      req,
    });

    const safe = await Staff.findById(staff._id)
      .select("-emailOtp -emailOtpExpiry -emailOtpAttempts -password");

    return res.status(200).json({
      success: true,
      message: "Email verified. Staff account is now active.",
      data:    safe,
    });
  } catch (err) {
    console.error("AdminStaff verifyStaffOtp:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── POST /api/admin/staff/:id/resend-otp ─────────────────────────
exports.resendStaffOtp = async (req, res) => {
  try {
    if (!isValidId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid staff ID" });
    }
    const restaurantId = req.user.restaurantId;

    const staff = await Staff.findOne({ _id: req.params.id, restaurantId })
      .select("+emailOtp +emailOtpExpiry +emailOtpAttempts +isEmailVerified");

    if (!staff) return res.status(404).json({ success: false, message: "Staff not found" });
    if (staff.isEmailVerified) {
      return res.status(400).json({ success: false, message: "Email already verified" });
    }

    const otp    = generateOtp();
    const expiry = new Date(Date.now() + getOtpExpiryMs());
    staff.emailOtp         = otp;
    staff.emailOtpExpiry   = expiry;
    staff.emailOtpAttempts = 0;
    await staff.save();

    try {
      await sendOtpEmail({ to: staff.email, name: staff.name, otp });
      return res.status(200).json({
        success:   true,
        emailSent: true,
        message:   "A new OTP has been sent to the staff member's email.",
      });
    } catch (emailErr) {
      console.error("[resendStaffOtp] OTP email failed:", {
        staffId: staff._id, message: emailErr.message, code: emailErr.code,
      });
      return res.status(200).json({
        success:   true,
        emailSent: false,
        message:   "A new OTP was generated, but the email could not be sent. Please check the email configuration.",
      });
    }
  } catch (err) {
    console.error("AdminStaff resendStaffOtp:", err);
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

    const updated = await Staff.findByIdAndUpdate(req.params.id, update, { returnDocument: 'after', runValidators: true })
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
