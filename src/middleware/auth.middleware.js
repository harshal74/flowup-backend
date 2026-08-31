const { verifyToken } = require("../utils/jwt");
const Admin = require("../models/Admin");
const Setting = require("../models/Setting");

const protect = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized access",
      });
    }

    const token = authHeader.split(" ")[1];

    const decoded = verifyToken(token);

    const admin = await Admin.findById(decoded.id);

    if (!admin) {
      return res.status(401).json({
        success: false,
        message: "Admin not found",
      });
    }

    // SUPER_ADMIN bypasses restaurant suspension and expiry checks
    if (admin.role !== "SUPER_ADMIN") {
      // Check restaurant account status and expiry for regular ADMINs
      const settings = await Setting.findOne({ restaurantId: admin.restaurantId })
        .select("accountStatus expiresAt")
        .lean();

      if (settings?.accountStatus === "SUSPENDED") {
        return res.status(403).json({
          success: false,
          message: "Your restaurant has been suspended. Please contact FlowUp support.",
          suspended: true,
        });
      }

      // Expiry check: block if current time >= expiresAt (India calendar-date semantics)
      // expiresAt stores the exclusive UTC instant of the start of the next IST calendar day.
      // null expiresAt = no expiry = always allowed.
      if (settings?.expiresAt && new Date() >= new Date(settings.expiresAt)) {
        return res.status(403).json({
          success: false,
          message: "Your restaurant subscription has expired. Please contact FlowUp support.",
          expired: true,
        });
      }
    }

    req.user = admin;

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
    });
  }
};

module.exports = protect;
