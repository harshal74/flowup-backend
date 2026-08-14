const Setting = require("../models/Setting");
const Order   = require("../models/Order");
const { restaurantId: DEFAULT_RESTAURANT_ID } = require("../config/env");

// Get Settings
const getSettings = async (req, res) => {
  try {
    // Accept restaurantId from query param (customer frontend) or req.user (admin)
    const restaurantId =
      req.user?.restaurantId ||
      req.query.restaurantId ||
      DEFAULT_RESTAURANT_ID;

    const settings =
      await Setting.findOne({
        restaurantId,
      });


    if (!settings) {
      return res.status(404).json({
        success: false,
        message:
          "Settings not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: settings,
    });
  } catch (error) {
    console.error(
      "Get Settings Error:",
      error
    );

    return res.status(500).json({
      success: false,
      message:
        "Internal server error",
    });
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
      }

      // Store as integer
      req.body.totalTables = newTotal;
    }

    const settings = await Setting.findOneAndUpdate(
      { restaurantId },
      { ...req.body, restaurantId },
      { upsert: true, new: true, runValidators: true }
    );

    return res.status(200).json({
      success: true,
      message: "Settings updated successfully",
      data: settings,
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
      { new: true }  // BUG 11 FIX
    );

    return res.status(200).json({
      success: true,
      message: "Shop opened successfully",
      data: settings,
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
      { new: true }  // BUG 11 FIX
    );

    return res.status(200).json({
      success: true,
      message: "Shop closed successfully",
      data: settings,
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

    return res.status(200).json({
      success: true,
      message: "Feedback setting updated",
      data: settings,
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

    return res.status(200).json({
      success: true,
      message: "WhatsApp setting updated",
      data: settings,
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

module.exports = {
  getSettings,
  updateSettings,
  openShop,
  closeShop,
  toggleFeedback,
  toggleWhatsappNotifications,
};