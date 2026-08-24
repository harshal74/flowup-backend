const crypto = require("crypto");
const Setting = require("../models/Setting");

/**
 * Generates a unique system-controlled restaurant identifier.
 * Format: flw_ + 8 random alphanumeric characters
 * Example: flw_a7kx9m2p
 *
 * Uses crypto.randomBytes for cryptographic security.
 * Retries on collision (checked against Settings collection).
 */
async function generateRestaurantId(maxRetries = 5) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const bytes = crypto.randomBytes(8);
    let id = "flw_";
    for (let i = 0; i < 8; i++) {
      id += chars[bytes[i] % chars.length];
    }

    // Check uniqueness against Settings
    const existing = await Setting.findOne({ restaurantId: id });
    if (!existing) return id;
  }

  throw new Error("Failed to generate unique restaurantId after multiple attempts");
}

module.exports = { generateRestaurantId };
