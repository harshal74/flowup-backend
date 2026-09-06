const mongoose = require("mongoose");

/**
 * MetaOAuthState — short-lived, single-use CSRF/state records for the Meta
 * Embedded Signup OAuth transaction (Phase 11).
 *
 * Security purpose:
 *   The OAuth callback does NOT carry the authenticated request context. This
 *   record binds a cryptographically-random `state` value to the INITIATING
 *   authenticated restaurant, so the callback can recover the trusted tenant
 *   identity WITHOUT trusting any client-supplied restaurantId/wabaId/etc.
 *
 * Rules:
 *   • state is unique, unpredictable (crypto.randomBytes), single-use (`used`).
 *   • expiresAt gives a short TTL; a MongoDB TTL index auto-purges old records.
 *   • Contains NO tokens, NO secrets, NO encryption keys — only the binding.
 */
const metaOAuthStateSchema = new mongoose.Schema(
  {
    state: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    // Trusted tenant this OAuth transaction belongs to (from req.user.restaurantId).
    restaurantId: {
      type: String,
      required: true,
      trim: true,
    },

    used: {
      type: Boolean,
      default: false,
    },

    usedAt: {
      type: Date,
      default: null,
    },

    // Short TTL — the state is only valid for the duration of the signup flow.
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  { timestamps: true }
);

// TTL index: MongoDB removes documents once expiresAt is reached.
metaOAuthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports =
  mongoose.models.MetaOAuthState ||
  mongoose.model("MetaOAuthState", metaOAuthStateSchema);
