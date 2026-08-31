const bcrypt = require("bcryptjs");
const Admin = require("../models/Admin");
const Setting = require("../models/Setting");
const { generateToken } = require("../utils/jwt");
const {
  recordAdminLogin,
  recordAdminLoginFailed,
} = require("../services/loginActivityService");

// Login Admin
const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validation
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    // Find Admin
    const admin = await Admin.findOne({
      email: email.toLowerCase().trim(),
    }).select("+password");

    if (!admin) {
      // Account not found — record as failed, safe reason
      recordAdminLoginFailed(email, "Invalid credentials", null, null, null, req);
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    // Check Active Status
    if (!admin.isActive) {
      recordAdminLoginFailed(email, "Account suspended", admin.role, admin.restaurantId, admin.restaurantName, req);
      return res.status(403).json({
        success: false,
        message: "Account is disabled",
      });
    }

    // Compare Password
    const isMatch = await bcrypt.compare(password, admin.password);

    if (!isMatch) {
      recordAdminLoginFailed(email, "Invalid credentials", admin.role, admin.restaurantId, admin.restaurantName, req);
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    // Check restaurant suspension and expiry (SUPER_ADMIN bypasses)
    if (admin.role !== "SUPER_ADMIN") {
      const settings = await Setting.findOne({ restaurantId: admin.restaurantId })
        .select("accountStatus expiresAt restaurantName")
        .lean();

      if (settings?.accountStatus === "SUSPENDED") {
        recordAdminLoginFailed(email, "Restaurant suspended", admin.role, admin.restaurantId, settings?.restaurantName || admin.restaurantName, req);
        return res.status(403).json({
          success: false,
          message: "Your restaurant has been suspended. Please contact FlowUp support.",
          suspended: true,
        });
      }

      if (settings?.expiresAt && new Date() >= new Date(settings.expiresAt)) {
        recordAdminLoginFailed(email, "Restaurant expired", admin.role, admin.restaurantId, settings?.restaurantName || admin.restaurantName, req);
        return res.status(403).json({
          success: false,
          message: "Your restaurant subscription has expired. Please contact FlowUp support.",
          expired: true,
        });
      }
    }

    // Generate JWT
    const token = generateToken({
      id: admin._id,
      email: admin.email,
      role: admin.role,
      restaurantId: admin.restaurantId,
    });

    // Update Last Login
    admin.lastLogin = new Date();
    await admin.save();

    // Record successful login — fire-and-forget
    recordAdminLogin(admin, req, admin.restaurantName || null);

    return res.status(200).json({
      success: true,
      message: "Login successful",
      token,
      admin: {
        id: admin._id,
        name: admin.name,
        email: admin.email,
        mobile: admin.mobile,
        role: admin.role,
        restaurantName: admin.restaurantName,
        restaurantId: admin.restaurantId,
      },
    });
  } catch (error) {
    console.error("Login Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// Get Logged In Admin Profile
const getProfile = async (req, res) => {
  try {
    const admin = await Admin.findById(req.user.id).select(
      "-password"
    );

    if (!admin) {
      return res.status(404).json({
        success: false,
        message: "Admin not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: admin,
    });
  } catch (error) {
    console.error("Get Profile Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// Change Password
const changePassword = async (req, res) => {
  try {
    const {
      currentPassword,
      newPassword,
      confirmPassword,
    } = req.body;

    if (
      !currentPassword ||
      !newPassword ||
      !confirmPassword
    ) {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
      });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "Passwords do not match",
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message:
          "Password must be at least 6 characters",
      });
    }

    const admin = await Admin.findById(
      req.user.id
    ).select("+password");

    if (!admin) {
      return res.status(404).json({
        success: false,
        message: "Admin not found",
      });
    }

    const isMatch = await bcrypt.compare(
      currentPassword,
      admin.password
    );

    if (!isMatch) {
      return res.status(400).json({
        success: false,
        message: "Current password is incorrect",
      });
    }

    const hashedPassword = await bcrypt.hash(
      newPassword,
      10
    );

    admin.password = hashedPassword;

    await admin.save();

    return res.status(200).json({
      success: true,
      message: "Password changed successfully",
    });
  } catch (error) {
    console.error("Change Password Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// Logout
const logout = async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      message: "Logged out successfully",
    });
  } catch (error) {
    console.error("Logout Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

module.exports = {
  login,
  getProfile,
  changePassword,
  logout,
};