const mongoose = require("mongoose");

/**
 * LoginActivity — audit trail for all login attempts across FlowUp.
 *
 * SECURITY RULES (enforced here and in the logging service):
 *   - NEVER store: password, password hash, JWT token, refresh token, OTP,
 *     session secret, cookies, or any authentication credential.
 *   - Only store the minimum identity information needed for audit purposes.
 *   - Failed logins store the submitted identifier (email/name) — NOT the password.
 *   - failureReason uses safe human-readable categories, not internal error details.
 *
 * Session tracking limitation:
 *   FlowUp uses stateless JWTs. There is no server-side session store.
 *   logoutAt CANNOT be reliably correlated with a login event.
 *   logoutAt is omitted — this is a historical login event log, not a session tracker.
 *
 * Multiple devices:
 *   Multiple logins from different devices produce separate records.
 *   A login record does NOT mean the user is currently active.
 */
const loginActivitySchema = new mongoose.Schema(
  {
    // ── Identity fields ─────────────────────────────────────────
    // Populated on successful login; may be null on failed attempts
    // where the account cannot be found.

    // ObjectId of the Admin (restaurant admin or SUPER_ADMIN)
    adminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Admin",
      default: null,
      index: true,
    },

    // ObjectId of the Staff (waiter/chef/assistant)
    staffId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      default: null,
      index: true,
    },

    // The restaurant this account belongs to (null for SUPER_ADMIN)
    restaurantId: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },

    // Display name of the restaurant (denormalized for query performance)
    restaurantName: {
      type: String,
      default: null,
      trim: true,
    },

    // Human-readable account identifier for display — email or staff name.
    // On failed attempts where the account is not found, stores the submitted
    // email (safe to store — it's the identifier the user typed, not a secret).
    identifier: {
      type: String,
      default: null,
      trim: true,
      maxlength: 200,
    },

    // Role of the account — SUPER_ADMIN, ADMIN, CHEF, WAITER, ASSISTANT
    role: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },

    // ── Login event ─────────────────────────────────────────────
    loginAt: {
      type: Date,
      default: Date.now,
      index: true,
    },

    status: {
      type: String,
      enum: ["SUCCESS", "FAILED"],
      required: true,
      index: true,
    },

    // Safe failure category — never expose internal authentication details.
    // Valid values: "Invalid credentials" | "Account suspended" |
    //   "Account blocked" | "Account pending approval" | "Account rejected" |
    //   "Restaurant suspended" | "Restaurant expired" | "Authentication failed"
    failureReason: {
      type: String,
      default: null,
      trim: true,
      maxlength: 200,
    },

    // ── Request metadata ────────────────────────────────────────
    ipAddress: {
      type: String,
      default: null,
      trim: true,
      maxlength: 64,
    },

    // Raw user-agent string — useful for debugging, shown in detail view
    userAgent: {
      type: String,
      default: null,
      trim: true,
      maxlength: 512,
    },

    // Parsed device info (derived from userAgent at write time)
    deviceType: {
      type: String,
      enum: ["Desktop", "Mobile", "Tablet", "Unknown"],
      default: "Unknown",
    },

    browser: {
      type: String,
      default: "Unknown",
      trim: true,
      maxlength: 60,
    },

    operatingSystem: {
      type: String,
      default: "Unknown",
      trim: true,
      maxlength: 60,
    },
  },
  {
    timestamps: true,
    // Explicit collection name for clarity
    collection: "loginactivities",
  }
);

// Compound indexes for common Platform queries
loginActivitySchema.index({ loginAt: -1 });
loginActivitySchema.index({ status: 1, loginAt: -1 });
loginActivitySchema.index({ role: 1, loginAt: -1 });
loginActivitySchema.index({ restaurantId: 1, loginAt: -1 });
loginActivitySchema.index({ adminId: 1, loginAt: -1 });
loginActivitySchema.index({ staffId: 1, loginAt: -1 });

module.exports =
  mongoose.models.LoginActivity ||
  mongoose.model("LoginActivity", loginActivitySchema);
