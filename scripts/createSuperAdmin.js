/**
 * One-Time SUPER_ADMIN Account Setup
 *
 * Creates the initial platform owner account.
 * Must be run ONCE after initial deployment.
 *
 * Usage:
 *   SUPER_ADMIN_EMAIL=you@email.com SUPER_ADMIN_PASSWORD=yourpassword node scripts/createSuperAdmin.js
 *
 * Or set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD in .env before running:
 *   node scripts/createSuperAdmin.js
 *
 * Idempotent: running twice will NOT create a duplicate — it detects
 * an existing SUPER_ADMIN and exits safely.
 *
 * Security:
 * - Password is hashed with bcrypt (same as existing backend)
 * - Plaintext password is never stored or logged
 * - Bcrypt hash is never printed
 */

const path = require("path");

// Load .env from the backend root (one level up from /scripts)
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const mongoose = require("mongoose");
const bcrypt   = require("bcryptjs");
const Admin    = require("../src/models/Admin");

const MONGO_URI = process.env.MONGO_URI;

async function main() {
  // ── Validate environment ────────────────────────────────────────
  if (!MONGO_URI) {
    console.error("❌ MONGO_URI is not set. Configure it in .env or environment.");
    process.exit(1);
  }

  const email    = process.env.SUPER_ADMIN_EMAIL;
  const password = process.env.SUPER_ADMIN_PASSWORD;

  if (!email || !email.trim()) {
    console.error("❌ SUPER_ADMIN_EMAIL is required.");
    console.error("   Set it in .env or pass as environment variable.");
    console.error("   Example: SUPER_ADMIN_EMAIL=admin@flowup.in node scripts/createSuperAdmin.js");
    process.exit(1);
  }

  if (!password) {
    console.error("❌ SUPER_ADMIN_PASSWORD is required.");
    console.error("   Set it in .env or pass as environment variable.");
    console.error("   Example: SUPER_ADMIN_PASSWORD=your_secure_password node scripts/createSuperAdmin.js");
    process.exit(1);
  }

  if (password.length < 6) {
    console.error("❌ SUPER_ADMIN_PASSWORD must be at least 6 characters.");
    process.exit(1);
  }

  // ── Connect to MongoDB ──────────────────────────────────────────
  try {
    await mongoose.connect(MONGO_URI);
    console.log("✅ Connected to MongoDB");
  } catch (err) {
    console.error("❌ Failed to connect to MongoDB:", err.message);
    process.exit(1);
  }

  try {
    // ── Check if SUPER_ADMIN already exists ─────────────────────
    const existing = await Admin.findOne({ role: "SUPER_ADMIN" });

    if (existing) {
      console.log("");
      console.log("ℹ️  SUPER_ADMIN already exists. No changes made.");
      console.log(`   Email: ${existing.email}`);
      console.log(`   Created: ${existing.createdAt || "unknown"}`);
      console.log("");
      console.log("   To reset the password, use MongoDB shell:");
      console.log('   db.admins.updateOne({ role: "SUPER_ADMIN" }, { $set: { password: "<new bcrypt hash>" } })');
      console.log("");
      process.exit(0);
    }

    // ── Check email uniqueness ────────────────────────────────────
    const emailConflict = await Admin.findOne({ email: email.trim().toLowerCase() });
    if (emailConflict) {
      console.error(`❌ An admin with email "${email.trim().toLowerCase()}" already exists (role: ${emailConflict.role}).`);
      console.error("   Choose a different email for the SUPER_ADMIN.");
      process.exit(1);
    }

    // ── Check restaurantId uniqueness ─────────────────────────────
    const platformConflict = await Admin.findOne({ restaurantId: "PLATFORM" });
    if (platformConflict) {
      console.error('❌ An admin with restaurantId "PLATFORM" already exists.');
      process.exit(1);
    }

    // ── Hash password ─────────────────────────────────────────────
    const hashedPassword = await bcrypt.hash(password, 10);

    // ── Create SUPER_ADMIN ────────────────────────────────────────
    await Admin.create({
      restaurantId:   "PLATFORM",
      restaurantName: "FlowUp Platform",
      name:           "Platform Admin",
      email:          email.trim().toLowerCase(),
      password:       hashedPassword,
      mobile:         "+910000000000",
      role:           "SUPER_ADMIN",
      isActive:       true,
    });

    console.log("");
    console.log("✅ SUPER_ADMIN account created successfully.");
    console.log(`   Email: ${email.trim().toLowerCase()}`);
    console.log("   Role: SUPER_ADMIN");
    console.log("   Restaurant ID: PLATFORM (platform identity — not a real restaurant)");
    console.log("");
    console.log("   You can now log in at the Platform Frontend.");
    console.log("");

    process.exit(0);
  } catch (err) {
    console.error("❌ Failed to create SUPER_ADMIN:", err.message);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
  }
}

main();
