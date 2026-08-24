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
const MOBILE_RE = /^\+?\d{7,15}$/;

// Allowed sort fields (whitelist — never inject arbitrary field names)
const SORT_WHITELIST = {
  createdAt: "createdAt",
  restaurantName: "restaurantName",
  totalTables: "totalTables",
};

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
    if (!adminMobile || !MOBILE_RE.test(adminMobile.trim().replace(/\s/g, ""))) {
      return res.status(400).json({ success: false, message: "Valid admin mobile number is required." });
    }
    if (!adminPassword || adminPassword.length < 6) {
      return res.status(400).json({ success: false, message: "Admin password must be at least 6 characters." });
    }

    const existingAdmin = await Admin.findOne({ email: adminEmail.trim().toLowerCase() });
    if (existingAdmin) {
      return res.status(409).json({ success: false, message: "An admin with this email already exists." });
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
    }], { session });

    const [admin] = await Admin.create([{
      restaurantId,
      restaurantName: restaurantName.trim(),
      name: adminName.trim(),
      email: adminEmail.trim().toLowerCase(),
      password: hashedPassword,
      mobile: adminMobile.trim().replace(/\s/g, ""),
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
    if (search && search.trim()) {
      const q = search.trim();
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
    const restaurants = await Setting.find(filter)
      .select("restaurantId restaurantName restaurantSlug restaurantLogo shopOpen totalTables accountStatus suspendedAt suspensionReason createdAt updatedAt")
      .sort({ [sortField]: sortDir })
      .skip(skip)
      .limit(effectiveLimit)
      .lean();

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
