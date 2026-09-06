const Setting          = require("../models/Setting");
const Order            = require("../models/Order");
const TableReservation = require("../models/TableReservation");
const { isSupportedCountry } = require("../utils/phoneE164");

// Get Settings
const getSettings = async (req, res) => {
  try {
    // Use resolved public restaurantId (from middleware) or admin's restaurantId
    const restaurantId = req.restaurantId || req.user?.restaurantId;

    if (!restaurantId) {
      return res.status(400).json({ success: false, message: "restaurantId is required" });
    }

    const settings = await Setting.findOne({ restaurantId })
      .select("-subscriptionAmount -suspendedBy -deletedAt");

    if (!settings) {
      return res.status(404).json({ success: false, message: "Settings not found" });
    }

    return res.status(200).json({ success: true, data: settings });
  } catch (error) {
    console.error("Get Settings Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// Update Settings
const updateSettings = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;

    // ── totalTables validation ────────────────────────────────
    if (req.body.totalTables !== undefined) {
      const newTotal = Number(req.body.totalTables);

      if (!Number.isInteger(newTotal) || newTotal < 1 || newTotal > 200) {
        return res.status(400).json({
          success: false,
          message: "Total tables must be a whole number between 1 and 200.",
        });
      }

      // Check if we are reducing the count
      const current = await Setting.findOne({ restaurantId }).select("totalTables");
      const currentTotal = current?.totalTables ?? 10;

      if (newTotal < currentTotal) {
        // Find any active orders on tables that would be removed
        const ACTIVE_STATUSES = ["PENDING", "ACCEPTED", "PREPARING", "READY", "OUT_FOR_DELIVERY"];
        const conflictOrders = await Order.find({
          restaurantId,
          status:      { $in: ACTIVE_STATUSES },
          tableNumber: { $gt: newTotal },
        }).select("tableNumber orderNumber");

        if (conflictOrders.length > 0) {
          const tables   = [...new Set(conflictOrders.map(o => o.tableNumber))].sort((a, b) => a - b);
          const tableStr = tables.join(", ");
          return res.status(409).json({
            success: false,
            message: `Cannot reduce table count to ${newTotal} because table${tables.length > 1 ? "s" : ""} ${tableStr} currently ${tables.length > 1 ? "have" : "has"} active orders. Please complete those orders first.`,
            conflictTables: tables,
          });
        }

        // Also block if any table being removed has an ACTIVE reservation
        const conflictReservations = await TableReservation.find({
          restaurantId,
          tableNumber: { $gt: newTotal },
          status: "ACTIVE",
        }).select("tableNumber guestName");

        if (conflictReservations.length > 0) {
          const rTables = [...new Set(conflictReservations.map(r => r.tableNumber))].sort((a, b) => a - b);
          const rStr = rTables.join(", ");
          return res.status(409).json({
            success: false,
            message: `Cannot reduce table count to ${newTotal} because table${rTables.length > 1 ? "s" : ""} ${rStr} ${rTables.length > 1 ? "have" : "has"} an active reservation. Please cancel those reservations first.`,
            conflictTables: rTables,
          });
        }
      }

      // Store as integer
      req.body.totalTables = newTotal;
    }

    // Never allow Admin to change restaurantSlug through settings update
    // (only SUPER_ADMIN can change slug via platform API)
    delete req.body.restaurantSlug;
    delete req.body.accountStatus;
    delete req.body.suspendedAt;
    delete req.body.suspendedBy;
    delete req.body.suspensionReason;
    // Subscription expiry is managed exclusively by SUPER_ADMIN via the Platform API.
    // A restaurant admin must never be able to extend, clear, or change their own expiry.
    delete req.body.expiresAt;
    // Subscription amount is PLATFORM PRIVATE DATA — never writable by restaurant admin.
    delete req.body.subscriptionAmount;

    // ── GST rate validation ──────────────────────────────────
    if (req.body.sgstRate !== undefined) {
      const r = Number(req.body.sgstRate);
      if (isNaN(r) || r < 0 || r > 50) {
        return res.status(400).json({ success: false, message: "SGST rate must be a number between 0 and 50." });
      }
      req.body.sgstRate = r;
    }
    if (req.body.cgstRate !== undefined) {
      const r = Number(req.body.cgstRate);
      if (isNaN(r) || r < 0 || r > 50) {
        return res.status(400).json({ success: false, message: "CGST rate must be a number between 0 and 50." });
      }
      req.body.cgstRate = r;
    }

    // ── countryCode validation ────────────────────────────────
    // ISO 3166-1 alpha-2, supported by phoneE164 (COUNTRY_DIAL_CODES).
    // Normalize (trim + uppercase) then validate; reject "IND", "91",
    // "+91", "india", "USA", empty, etc. with a clean 400 rather than an
    // uncontrolled Mongoose ValidationError. Country is NEVER inferred from
    // currency/address/whatsapp number.
    if (req.body.countryCode !== undefined) {
      if (typeof req.body.countryCode !== "string") {
        return res.status(400).json({ success: false, message: "countryCode must be a string ISO alpha-2 code (e.g. IN, US, GB)." });
      }
      const cc = req.body.countryCode.trim().toUpperCase();
      if (!isSupportedCountry(cc)) {
        return res.status(400).json({
          success: false,
          message: "Unsupported or invalid countryCode. Use a supported ISO alpha-2 code (e.g. IN, US, GB, AE).",
        });
      }
      req.body.countryCode = cc;
    }

    // ── FIX: Explicit whitelist — only restaurant-admin-writable fields ──────
    // Mass-assignment protection: only the fields listed here can be updated
    // by a restaurant admin. Platform-only and internal fields are never
    // included regardless of what the request body contains.
    //
    // Protected fields NOT in this list (always blocked):
    //   restaurantId, restaurantSlug, accountStatus, suspendedAt, suspendedBy,
    //   suspensionReason, expiresAt, subscriptionAmount, createdAt, updatedAt,
    //   and any future platform-internal field not explicitly whitelisted here.
    const allowedUpdates = {};

    const stringFields = [
      "restaurantName", "restaurantDescription", "restaurantLogo",
      "whatsappNumber", "contactNumber", "email", "address",
      "openingTime", "closingTime", "currency", "upiId",
      "deliveryPaymentMode", "countryCode",
    ];
    for (const field of stringFields) {
      if (req.body[field] !== undefined) allowedUpdates[field] = req.body[field];
    }

    const numberFields = [
      "deliveryCharge", "minimumOrderAmount", "averagePreparationTime",
      "sgstRate", "cgstRate",
    ];
    for (const field of numberFields) {
      if (req.body[field] !== undefined) allowedUpdates[field] = req.body[field];
    }

    const boolFields = ["feedbackEnabled", "whatsappNotificationsEnabled", "gstEnabled", "onlineDeliveryEnabled"];
    for (const field of boolFields) {
      if (req.body[field] !== undefined) allowedUpdates[field] = req.body[field];
    }

    // totalTables was validated and sanitised above — include the clean integer value
    if (req.body.totalTables !== undefined) {
      allowedUpdates.totalTables = req.body.totalTables;
    }

    const settings = await Setting.findOneAndUpdate(
      { restaurantId },
      { ...allowedUpdates, restaurantId },
      { upsert: true, returnDocument: 'after', runValidators: true }
    );

    // ── FIX: Strip platform-private fields before returning to restaurant admin ──
    // subscriptionAmount, suspendedBy, and deletedAt are platform-only data.
    // They must never be exposed through any restaurant-facing API response,
    // mirroring the .select("-subscriptionAmount -suspendedBy -deletedAt") in getSettings.
    const safeData = settings.toObject();
    delete safeData.subscriptionAmount;
    delete safeData.suspendedBy;
    delete safeData.deletedAt;

    return res.status(200).json({
      success: true,
      message: "Settings updated successfully",
      data: safeData,
    });
  } catch (error) {
    console.error("Update Settings Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// Open Shop
const openShop = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;

    const settings = await Setting.findOneAndUpdate(
      { restaurantId },
      { shopOpen: true },
      { returnDocument: 'after' }
    );

    // Strip platform-private fields before returning to restaurant admin
    const safeData = settings.toObject();
    delete safeData.subscriptionAmount;
    delete safeData.suspendedBy;
    delete safeData.deletedAt;

    return res.status(200).json({
      success: true,
      message: "Shop opened successfully",
      data: safeData,
    });
  } catch (error) {
    console.error("Open Shop Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// Close Shop
const closeShop = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;

    const settings = await Setting.findOneAndUpdate(
      { restaurantId },
      { shopOpen: false },
      { returnDocument: 'after' }
    );

    // Strip platform-private fields before returning to restaurant admin
    const safeData = settings.toObject();
    delete safeData.subscriptionAmount;
    delete safeData.suspendedBy;
    delete safeData.deletedAt;

    return res.status(200).json({
      success: true,
      message: "Shop closed successfully",
      data: safeData,
    });
  } catch (error) {
    console.error("Close Shop Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// Toggle Feedback
const toggleFeedback = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;

    const settings = await Setting.findOne({
      restaurantId,
    });

    if (!settings) {
      return res.status(404).json({
        success: false,
        message: "Settings not found",
      });
    }

    settings.feedbackEnabled =
      !settings.feedbackEnabled;

    await settings.save();

    // Strip platform-private fields before returning to restaurant admin
    const safeData = settings.toObject();
    delete safeData.subscriptionAmount;
    delete safeData.suspendedBy;
    delete safeData.deletedAt;

    return res.status(200).json({
      success: true,
      message: "Feedback setting updated",
      data: safeData,
    });
  } catch (error) {
    console.error("Toggle Feedback Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// Toggle WhatsApp Notifications
const toggleWhatsappNotifications = async (
  req,
  res
) => {
  try {
    const restaurantId = req.user.restaurantId;

    const settings = await Setting.findOne({
      restaurantId,
    });

    if (!settings) {
      return res.status(404).json({
        success: false,
        message: "Settings not found",
      });
    }

    settings.whatsappNotificationsEnabled =
      !settings.whatsappNotificationsEnabled;

    await settings.save();

    // Strip platform-private fields before returning to restaurant admin
    const safeData = settings.toObject();
    delete safeData.subscriptionAmount;
    delete safeData.suspendedBy;
    delete safeData.deletedAt;

    return res.status(200).json({
      success: true,
      message: "WhatsApp setting updated",
      data: safeData,
    });
  } catch (error) {
    console.error(
      "Toggle WhatsApp Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// Toggle Online Delivery
const toggleOnlineDelivery = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;

    const settings = await Setting.findOne({ restaurantId });

    if (!settings) {
      return res.status(404).json({
        success: false,
        message: "Settings not found",
      });
    }

    settings.onlineDeliveryEnabled = !settings.onlineDeliveryEnabled;

    await settings.save();

    // Strip platform-private fields before returning to restaurant admin
    const safeData = settings.toObject();
    delete safeData.subscriptionAmount;
    delete safeData.suspendedBy;
    delete safeData.deletedAt;

    return res.status(200).json({
      success: true,
      message: settings.onlineDeliveryEnabled
        ? "Online delivery enabled"
        : "Online delivery disabled",
      data: safeData,
    });
  } catch (error) {
    console.error("Toggle Online Delivery Error:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

module.exports = {
  getSettings,
  updateSettings,
  openShop,
  closeShop,
  toggleFeedback,
  toggleWhatsappNotifications,
  toggleOnlineDelivery,
};