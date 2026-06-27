const Setting = require("../models/Setting");

// Get Settings
const getSettings = async (
  req,
  res
) => {
  try {
    const restaurantId =
      req.user?.restaurantId ||
      process.env.RESTAURANT_ID ||
      "FLOWUP001";

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

    const settings = await Setting.findOneAndUpdate(
      { restaurantId },
      {
        ...req.body,
        restaurantId,
      },
      {
        upsert: true,
        returnDocument: "after",
        runValidators: true,
      }
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
      { returnDocument: "after" }
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
      { returnDocument: "after" }
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