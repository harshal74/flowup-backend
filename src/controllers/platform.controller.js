const bcrypt   = require("bcryptjs");
const mongoose = require("mongoose");
const Admin    = require("../models/Admin");
const Setting  = require("../models/Setting");
const Order    = require("../models/Order");
const Customer = require("../models/Customer");
const Staff    = require("../models/Staff");
const Menu     = require("../models/Menu");
const PlatformAuditLog = require("../models/PlatformAuditLog");
const { generateRestaurantId } = require("../utils/generateRestaurantId");
const { generateRestaurantSlug } = require("../utils/generateRestaurantSlug");
const { disconnectRestaurant } = require("../socket");

const EMAIL_RE  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const { isValidMobile, normalizeMobile, MOBILE_ERROR_MESSAGE } = require("../utils/validateMobile");

// Allowed sort fields (whitelist — never inject arbitrary field names)
const SORT_WHITELIST = {
  createdAt:      "createdAt",
  restaurantName: "restaurantName",
  totalTables:    "totalTables",
  expiresAt:      "expiresAt",
};

/**
 * Escape a user-supplied string for safe use inside a MongoDB $regex.
 * Without escaping, a search for "(" produces a regex parse error (500),
 * and patterns like "(a+)+" are treated as executable regex (ReDoS risk).
 */
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// IST offset: UTC+5:30 = 5.5 hours
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Parse a YYYY-MM-DD date string (calendar date chosen by platform admin in IST)
 * and return the exclusive UTC cutoff instant — i.e. the start of the NEXT
 * calendar day in IST, converted to UTC.
 *
 * Example: "2026-09-30"
 *   → next IST day start:  2026-10-01T00:00:00 IST
 *   → stored UTC instant:  2026-09-30T18:30:00.000Z
 *
 * Access is blocked when: new Date() >= storedUtcInstant
 * The restaurant therefore remains active for the entire IST calendar day
 * of the selected date and is blocked from IST midnight of the next day.
 */
function parseExpiryDateIST(dateStr) {
  // Accept only YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const [year, month, day] = dateStr.split("-").map(Number);
  if (!year || !month || !day) return null;
  // Next calendar day at midnight IST, converted to UTC
  // midnight IST next day = Date.UTC(year, month-1, day+1) - IST_OFFSET_MS
  const nextDayMidnightIST = Date.UTC(year, month - 1, day + 1); // midnight UTC of next day
  const utcInstant = nextDayMidnightIST - IST_OFFSET_MS;         // subtract 5h30m to get IST midnight in UTC
  const result = new Date(utcInstant);
  return isNaN(result.getTime()) ? null : result;
}

/**
 * Returns the current IST calendar date as a YYYY-MM-DD string.
 * Used for "same-day or past" validation against admin's selected date.
 */
function todayIST() {
  const now = new Date();
  const istMs = now.getTime() + IST_OFFSET_MS;
  const istDate = new Date(istMs);
  const y = istDate.getUTCFullYear();
  const m = String(istDate.getUTCMonth() + 1).padStart(2, "0");
  const d = String(istDate.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ══════════════════════════════════════════════════════════════════
// POST /api/platform/restaurants — Create restaurant
// ══════════════════════════════════════════════════════════════════
exports.createRestaurant = async (req, res) => {
  const session = await mongoose.startSession();

  try {
    const {
      restaurantName, restaurantDescription, whatsappNumber,
      contactNumber, email, address,
      adminName, adminEmail, adminMobile, adminPassword,
      subscriptionAmount,
    } = req.body;

    if (!restaurantName || !restaurantName.trim()) {
      return res.status(400).json({ success: false, message: "Restaurant name is required." });
    }
    if (!whatsappNumber || !whatsappNumber.trim()) {
      return res.status(400).json({ success: false, message: "WhatsApp number is required." });
    }
    if (!adminName || !adminName.trim()) {
      return res.status(400).json({ success: false, message: "Admin name is required." });
    }
    if (!adminEmail || !EMAIL_RE.test(adminEmail.trim())) {
      return res.status(400).json({ success: false, message: "Valid admin email is required." });
    }
    if (!adminMobile || !isValidMobile(adminMobile)) {
      return res.status(400).json({ success: false, message: MOBILE_ERROR_MESSAGE });
    }
    if (!adminPassword || adminPassword.length < 6) {
      return res.status(400).json({ success: false, message: "Admin password must be at least 6 characters." });
    }

    const existingAdmin = await Admin.findOne({ email: adminEmail.trim().toLowerCase() });
    if (existingAdmin) {
      return res.status(409).json({ success: false, message: "An admin with this email already exists." });
    }

    // Validate subscriptionAmount (optional — defaults to 0)
    let parsedSubscriptionAmount = 0;
    if (subscriptionAmount !== undefined && subscriptionAmount !== null && subscriptionAmount !== "") {
      const n = Number(subscriptionAmount);
      if (isNaN(n) || !isFinite(n) || n < 0) {
        return res.status(400).json({ success: false, message: "Subscription amount must be a non-negative number." });
      }
      if (n > 10000000) {
        return res.status(400).json({ success: false, message: "Subscription amount exceeds maximum allowed value." });
      }
      parsedSubscriptionAmount = Math.round(n * 100) / 100;
    }

    const restaurantId = await generateRestaurantId();
    const hashedPassword = await bcrypt.hash(adminPassword, 10);

    // Generate slug (auto from name, or custom if provided)
    let restaurantSlug;
    try {
      restaurantSlug = await generateRestaurantSlug(restaurantName.trim(), req.body.restaurantSlug);
    } catch (slugErr) {
      return res.status(409).json({ success: false, message: slugErr.message });
    }

    session.startTransaction();

    const [settings] = await Setting.create([{
      restaurantId,
      restaurantSlug,
      restaurantName: restaurantName.trim(),
      restaurantDescription: (restaurantDescription || "").trim(),
      whatsappNumber: whatsappNumber.trim(),
      contactNumber: (contactNumber || "").trim(),
      email: (email || "").trim(),
      address: (address || "").trim(),
      shopOpen: true,
      totalTables: 10,
      deliveryPaymentMode: "COD",
      accountStatus: "ACTIVE",
      subscriptionAmount: parsedSubscriptionAmount,
    }], { session });

    const [admin] = await Admin.create([{
      restaurantId,
      restaurantName: restaurantName.trim(),
      name: adminName.trim(),
      email: adminEmail.trim().toLowerCase(),
      password: hashedPassword,
      mobile: normalizeMobile(adminMobile),
      role: "ADMIN",
      isActive: true,
    }], { session });

    await session.commitTransaction();

    // Audit log (fire-and-forget)
    PlatformAuditLog.create({
      action: "RESTAURANT_CREATED",
      restaurantId,
      restaurantName: restaurantName.trim(),
      performedBy: req.user._id,
      performedByEmail: req.user.email,
    }).catch(() => {});

    return res.status(201).json({
      success: true,
      message: "Restaurant and admin created successfully.",
      restaurant: { restaurantId, restaurantName: settings.restaurantName, restaurantSlug: settings.restaurantSlug },
      admin: { name: admin.name, email: admin.email, role: admin.role },
    });
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern || {})[0];
      return res.status(409).json({ success: false, message: `Duplicate value for: ${field}` });
    }
    console.error("[Platform] createRestaurant error:", error.message);
    return res.status(500).json({ success: false, message: "Failed to create restaurant." });
  } finally {
    session.endSession();
  }
};

// ══════════════════════════════════════════════════════════════════
// GET /api/platform/restaurants — List with search/filter/sort/pagination
// ══════════════════════════════════════════════════════════════════
exports.listRestaurants = async (req, res) => {
  try {
    const {
      search, status, sortBy = "createdAt", sortOrder = "desc",
      page = 1, limit = 20, createdFrom, createdTo,
    } = req.query;

    const effectiveLimit = Math.min(Number(limit) || 20, 100);
    const effectivePage  = Math.max(Number(page) || 1, 1);
    const skip = (effectivePage - 1) * effectiveLimit;

    // Build filter
    const filter = {};

    // Status filter
    // Existing restaurants created before accountStatus was added have no field —
    // they should be treated as ACTIVE (not suspended).
    if (status === "ACTIVE") {
      filter.accountStatus = { $ne: "SUSPENDED" };
    } else if (status === "SUSPENDED") {
      filter.accountStatus = "SUSPENDED";
    }

    // Date filter
    if (createdFrom || createdTo) {
      filter.createdAt = {};
      if (createdFrom) filter.createdAt.$gte = new Date(createdFrom);
      if (createdTo)   filter.createdAt.$lte = new Date(createdTo);
    }

    // Search (case-insensitive across multiple fields)
    // FIX: escape user input before using in MongoDB $regex to prevent
    // regex parse errors (e.g. searching "(") and ReDoS attacks.
    if (search && search.trim()) {
      const q = escapeRegex(search.trim());
      filter.$or = [
        { restaurantName: { $regex: q, $options: "i" } },
        { restaurantId:   { $regex: q, $options: "i" } },
        { email:          { $regex: q, $options: "i" } },
        { whatsappNumber: { $regex: q, $options: "i" } },
        { address:        { $regex: q, $options: "i" } },
      ];
    }

    // Sort (whitelist only)
    const sortField = SORT_WHITELIST[sortBy] || "createdAt";
    const sortDir   = sortOrder === "asc" ? 1 : -1;

    const total = await Setting.countDocuments(filter);

    let restaurants;

    if (sortField === "expiresAt") {
      // Special aggregation sort for expiresAt:
      // null expiresAt must appear LAST (treat as far future: 9999-12-31).
      // This ensures: expired → expiring-soon → no-expiry ordering.
      restaurants = await Setting.aggregate([
        { $match: filter },
        {
          $addFields: {
            _sortExpiry: {
              $ifNull: ["$expiresAt", new Date("9999-12-31T00:00:00.000Z")],
            },
          },
        },
        { $sort: { _sortExpiry: sortDir } },
        { $skip: skip },
        { $limit: effectiveLimit },
        {
          $project: {
            restaurantId: 1, restaurantName: 1, restaurantSlug: 1, restaurantLogo: 1,
            shopOpen: 1, totalTables: 1, accountStatus: 1,
            suspendedAt: 1, suspensionReason: 1, expiresAt: 1,
            createdAt: 1, updatedAt: 1,
          },
        },
      ]);
    } else {
      restaurants = await Setting.find(filter)
        .select("restaurantId restaurantName restaurantSlug restaurantLogo shopOpen totalTables accountStatus suspendedAt suspensionReason expiresAt createdAt updatedAt")
        .sort({ [sortField]: sortDir })
        .skip(skip)
        .limit(effectiveLimit)
        .lean();
    }

    return res.status(200).json({
      success: true,
      data: restaurants,
      pagination: {
        page: effectivePage,
        limit: effectiveLimit,
        total,
        totalPages: Math.ceil(total / effectiveLimit),
      },
    });
  } catch (error) {
    console.error("[Platform] listRestaurants error:", error.message);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ══════════════════════════════════════════════════════════════════
// GET /api/platform/restaurants/:restaurantId — Restaurant detail
// ══════════════════════════════════════════════════════════════════
exports.getRestaurantDetail = async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const settings = await Setting.findOne({ restaurantId }).lean();
    if (!settings) {
      return res.status(404).json({ success: false, message: "Restaurant not found." });
    }

    // Get admin info (no password/hash)
    const admin = await Admin.findOne({ restaurantId, role: "ADMIN" })
      .select("name email mobile isActive lastLogin createdAt")
      .lean();

    return res.status(200).json({
      success: true,
      data: {
        settings,
        admin: admin || null,
      },
    });
  } catch (error) {
    console.error("[Platform] getRestaurantDetail error:", error.message);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ══════════════════════════════════════════════════════════════════
// GET /api/platform/restaurants/:restaurantId/stats — Usage stats
// ══════════════════════════════════════════════════════════════════
exports.getRestaurantStats = async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const settings = await Setting.findOne({ restaurantId }).select("restaurantId").lean();
    if (!settings) {
      return res.status(404).json({ success: false, message: "Restaurant not found." });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [totalOrders, todayOrders, totalCustomers, totalStaff, totalMenuItems, revenueAgg] =
      await Promise.all([
        Order.countDocuments({ restaurantId }),
        Order.countDocuments({ restaurantId, createdAt: { $gte: today } }),
        Customer.countDocuments({ restaurantId }),
        Staff.countDocuments({ restaurantId, status: "ACTIVE" }),
        Menu.countDocuments({ restaurantId }),
        Order.aggregate([
          { $match: { restaurantId, status: "COMPLETED", paymentStatus: "PAID" } },
          { $group: { _id: null, revenue: { $sum: "$totalAmount" } } },
        ]),
      ]);

    return res.status(200).json({
      success: true,
      data: {
        totalOrders,
        todayOrders,
        totalCustomers,
        totalStaff,
        totalMenuItems,
        totalRevenue: revenueAgg[0]?.revenue || 0,
      },
    });
  } catch (error) {
    console.error("[Platform] getRestaurantStats error:", error.message);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ══════════════════════════════════════════════════════════════════
// PATCH /api/platform/restaurants/:restaurantId/suspend
// ══════════════════════════════════════════════════════════════════
exports.suspendRestaurant = async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { reason } = req.body;

    const settings = await Setting.findOne({ restaurantId });
    if (!settings) {
      return res.status(404).json({ success: false, message: "Restaurant not found." });
    }

    if (settings.accountStatus === "SUSPENDED") {
      return res.status(409).json({ success: false, message: "Restaurant is already suspended." });
    }

    settings.accountStatus = "SUSPENDED";
    settings.suspendedAt = new Date();
    settings.suspendedBy = req.user._id;
    settings.suspensionReason = reason ? String(reason).trim().slice(0, 500) : "";
    await settings.save();

    // Audit log
    PlatformAuditLog.create({
      action: "RESTAURANT_SUSPENDED",
      restaurantId,
      restaurantName: settings.restaurantName,
      performedBy: req.user._id,
      performedByEmail: req.user.email,
      reason: settings.suspensionReason,
    }).catch(() => {});

    // Disconnect all active sockets for this restaurant
    disconnectRestaurant(restaurantId).catch(() => {});

    return res.status(200).json({
      success: true,
      message: `${settings.restaurantName} has been suspended.`,
      data: {
        restaurantId,
        accountStatus: "SUSPENDED",
        suspendedAt: settings.suspendedAt,
        suspensionReason: settings.suspensionReason,
      },
    });
  } catch (error) {
    console.error("[Platform] suspendRestaurant error:", error.message);
    return res.status(500).json({ success: false, message: "Failed to suspend restaurant." });
  }
};

// ══════════════════════════════════════════════════════════════════
// PATCH /api/platform/restaurants/:restaurantId/reactivate
// ══════════════════════════════════════════════════════════════════
exports.reactivateRestaurant = async (req, res) => {
  try {
    const { restaurantId } = req.params;

    const settings = await Setting.findOne({ restaurantId });
    if (!settings) {
      return res.status(404).json({ success: false, message: "Restaurant not found." });
    }

    if (settings.accountStatus === "ACTIVE") {
      return res.status(409).json({ success: false, message: "Restaurant is already active." });
    }

    // Guard: if the restaurant is also expired, reactivation alone would not
    // unblock access (expiry check is independent of accountStatus). Inform
    // the platform admin so they know to extend/clear expiry too.
    const isExpired = settings.expiresAt && new Date() >= new Date(settings.expiresAt);
    if (isExpired) {
      return res.status(400).json({
        success: false,
        message: "This restaurant's subscription has expired. Please extend or clear the expiry date before reactivating.",
        expired: true,
      });
    }

    settings.accountStatus = "ACTIVE";
    settings.suspendedAt = null;
    settings.suspendedBy = null;
    settings.suspensionReason = null;
    await settings.save();

    // Audit log
    PlatformAuditLog.create({
      action: "RESTAURANT_REACTIVATED",
      restaurantId,
      restaurantName: settings.restaurantName,
      performedBy: req.user._id,
      performedByEmail: req.user.email,
    }).catch(() => {});

    return res.status(200).json({
      success: true,
      message: `${settings.restaurantName} has been reactivated.`,
      data: { restaurantId, accountStatus: "ACTIVE" },
    });
  } catch (error) {
    console.error("[Platform] reactivateRestaurant error:", error.message);
    return res.status(500).json({ success: false, message: "Failed to reactivate restaurant." });
  }
};

// ══════════════════════════════════════════════════════════════════
// GET /api/platform/summary — Dashboard summary cards
// ══════════════════════════════════════════════════════════════════
exports.getPlatformSummary = async (req, res) => {
  try {
    const thisMonth = new Date();
    thisMonth.setDate(1);
    thisMonth.setHours(0, 0, 0, 0);

    const [total, active, suspended, addedThisMonth] = await Promise.all([
      Setting.countDocuments({}),
      Setting.countDocuments({ accountStatus: { $ne: "SUSPENDED" } }),
      Setting.countDocuments({ accountStatus: "SUSPENDED" }),
      Setting.countDocuments({ createdAt: { $gte: thisMonth } }),
    ]);

    return res.status(200).json({
      success: true,
      data: { total, active, suspended, addedThisMonth },
    });
  } catch (error) {
    console.error("[Platform] getPlatformSummary error:", error.message);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ══════════════════════════════════════════════════════════════════
// PATCH /api/platform/restaurants/:restaurantId/expiry
// Set, change, or clear a restaurant's subscription expiry date.
// SUPER_ADMIN only (enforced by platformAuth middleware on the router).
//
// Request body:
//   { "expiresAt": "2026-09-30" }  → set/change expiry to end of 30 Sep IST
//   { "expiresAt": null }          → clear expiry (no expiry)
//
// The selected calendar date is interpreted in IST (UTC+5:30).
// The stored MongoDB Date is the exclusive start of the next IST calendar day,
// i.e. the instant from which access becomes blocked.
// ══════════════════════════════════════════════════════════════════
exports.setExpiry = async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { expiresAt: rawExpiry } = req.body;

    const settings = await Setting.findOne({ restaurantId });
    if (!settings) {
      return res.status(404).json({ success: false, message: "Restaurant not found." });
    }

    // Clearing expiry — always allowed
    if (rawExpiry === null || rawExpiry === undefined || rawExpiry === "") {
      settings.expiresAt = null;
      await settings.save();

      PlatformAuditLog.create({
        action: "RESTAURANT_EXPIRY_CLEARED",
        restaurantId,
        restaurantName: settings.restaurantName,
        performedBy: req.user._id,
        performedByEmail: req.user.email,
      }).catch(() => {});

      return res.status(200).json({
        success: true,
        message: "Expiry date cleared. Restaurant has no expiry.",
        data: { restaurantId, expiresAt: null },
      });
    }

    // Validate format — accept only YYYY-MM-DD string
    if (typeof rawExpiry !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(rawExpiry.trim())) {
      return res.status(400).json({
        success: false,
        message: "Invalid expiry date format. Use YYYY-MM-DD (e.g. 2026-09-30).",
      });
    }

    const dateStr = rawExpiry.trim();

    // Validate: selected date must be strictly after today's IST calendar date
    const today = todayIST(); // e.g. "2026-08-29"
    if (dateStr <= today) {
      return res.status(400).json({
        success: false,
        message: `Expiry date must be after today (${today}). Same-day and past dates are not allowed.`,
      });
    }

    // Convert to UTC storage value using IST semantics
    const expiryUtc = parseExpiryDateIST(dateStr);
    if (!expiryUtc) {
      return res.status(400).json({ success: false, message: "Invalid expiry date." });
    }

    const oldExpiry = settings.expiresAt;
    settings.expiresAt = expiryUtc;
    await settings.save();

    PlatformAuditLog.create({
      action: "RESTAURANT_EXPIRY_SET",
      restaurantId,
      restaurantName: settings.restaurantName,
      performedBy: req.user._id,
      performedByEmail: req.user.email,
      metadata: {
        selectedDateIST: dateStr,
        expiresAtUTC:    expiryUtc.toISOString(),
        previousExpiry:  oldExpiry ? oldExpiry.toISOString() : null,
      },
    }).catch(() => {});

    return res.status(200).json({
      success: true,
      message: `Expiry date set. Restaurant remains active through ${dateStr} (IST).`,
      data: {
        restaurantId,
        expiresAt:        expiryUtc.toISOString(),
        selectedDateIST:  dateStr,
      },
    });
  } catch (error) {
    console.error("[Platform] setExpiry error:", error.message);
    return res.status(500).json({ success: false, message: "Failed to update expiry date." });
  }
};

// ══════════════════════════════════════════════════════════════════
// PATCH /api/platform/restaurants/:restaurantId/slug — Change slug
// ══════════════════════════════════════════════════════════════════
exports.updateSlug = async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { restaurantSlug: newSlug } = req.body;

    const settings = await Setting.findOne({ restaurantId });
    if (!settings) {
      return res.status(404).json({ success: false, message: "Restaurant not found." });
    }

    let finalSlug;
    try {
      finalSlug = await generateRestaurantSlug(settings.restaurantName, newSlug, restaurantId);
    } catch (slugErr) {
      return res.status(409).json({ success: false, message: slugErr.message });
    }

    const oldSlug = settings.restaurantSlug || null;
    settings.restaurantSlug = finalSlug;
    await settings.save();

    // Audit log
    PlatformAuditLog.create({
      action: "RESTAURANT_SLUG_CHANGED",
      restaurantId,
      restaurantName: settings.restaurantName,
      performedBy: req.user._id,
      performedByEmail: req.user.email,
      metadata: { oldSlug, newSlug: finalSlug },
    }).catch(() => {});

    return res.status(200).json({
      success: true,
      message: "Restaurant slug updated.",
      data: {
        restaurantId,
        restaurantName: settings.restaurantName,
        restaurantSlug: finalSlug,
      },
    });
  } catch (error) {
    console.error("[Platform] updateSlug error:", error.message);
    return res.status(500).json({ success: false, message: "Failed to update slug." });
  }
};

// ══════════════════════════════════════════════════════════════════
// PATCH /api/platform/restaurants/:restaurantId/admin/reset-password
// SUPER_ADMIN force-resets the restaurant ADMIN's password.
// Never reads or returns any password or hash.
// ══════════════════════════════════════════════════════════════════
exports.resetAdminPassword = async (req, res) => {
  try {
    const { restaurantId } = req.params;
    const { newPassword }  = req.body;

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

    // ── Find the restaurant ADMIN (not SUPER_ADMIN) ────────────
    const admin = await Admin.findOne({ restaurantId, role: "ADMIN" });
    if (!admin) {
      return res.status(404).json({ success: false, message: "Admin account not found for this restaurant." });
    }

    // ── Hash and save — never store plaintext ──────────────────
    const hashedPassword = await bcrypt.hash(trimmedPassword, 10);
    admin.password = hashedPassword;
    await admin.save();

    // ── Audit log (fire-and-forget) — NO password in log ──────
    PlatformAuditLog.create({
      action:           "ADMIN_PASSWORD_RESET",
      restaurantId,
      restaurantName:   admin.restaurantName || "",
      performedBy:      req.user._id,
      performedByEmail: req.user.email,
      metadata: {
        targetAdminEmail: admin.email,
        performedAt:      new Date().toISOString(),
      },
    }).catch(() => {});

    return res.status(200).json({
      success: true,
      message: "Admin password has been reset successfully.",
    });
  } catch (error) {
    console.error("[Platform] resetAdminPassword error:", error.message);
    return res.status(500).json({ success: false, message: "Failed to reset admin password." });
  }
};

// ══════════════════════════════════════════════════════════════════
// GET /api/platform/audit-logs — Platform audit trail
// ══════════════════════════════════════════════════════════════════
exports.getAuditLogs = async (req, res) => {
  try {
    const { page = 1, limit = 30 } = req.query;
    const effectiveLimit = Math.min(Number(limit) || 30, 100);
    const effectivePage  = Math.max(Number(page) || 1, 1);
    const skip = (effectivePage - 1) * effectiveLimit;

    const total = await PlatformAuditLog.countDocuments({});
    const logs = await PlatformAuditLog.find({})
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(effectiveLimit)
      .lean();

    return res.status(200).json({
      success: true,
      data: logs,
      pagination: {
        page: effectivePage,
        limit: effectiveLimit,
        total,
        totalPages: Math.ceil(total / effectiveLimit),
      },
    });
  } catch (error) {
    console.error("[Platform] getAuditLogs error:", error.message);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};
