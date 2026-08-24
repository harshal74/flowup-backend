/**
 * One-Time Migration: Generate restaurantSlug for existing restaurants.
 *
 * Usage:
 *   node scripts/migrateRestaurantSlugs.js --dry-run    (preview only)
 *   node scripts/migrateRestaurantSlugs.js              (apply changes)
 *
 * Idempotent: only processes restaurants without a slug.
 * Never changes restaurantId or any other data.
 */

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const mongoose = require("mongoose");
const Setting = require("../src/models/Setting");
const { generateRestaurantSlug } = require("../src/utils/generateRestaurantSlug");

const isDryRun = process.argv.includes("--dry-run");

async function main() {
  if (!process.env.MONGO_URI) {
    console.error("❌ MONGO_URI is not set.");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ Connected to MongoDB");
  console.log(isDryRun ? "🔍 DRY RUN — no changes will be made.\n" : "🚀 APPLYING migration…\n");

  const restaurants = await Setting.find({
    $or: [
      { restaurantSlug: null },
      { restaurantSlug: "" },
      { restaurantSlug: { $exists: false } },
    ],
  }).select("restaurantId restaurantName restaurantSlug");

  if (restaurants.length === 0) {
    console.log("✅ All restaurants already have slugs. Nothing to migrate.");
    process.exit(0);
  }

  console.log(`Found ${restaurants.length} restaurant(s) without slug:\n`);
  console.log("restaurantId        | restaurantName              | generatedSlug");
  console.log("─".repeat(80));

  let updated = 0;

  for (const r of restaurants) {
    try {
      const slug = await generateRestaurantSlug(r.restaurantName);
      console.log(`${r.restaurantId.padEnd(20)}| ${(r.restaurantName || "").padEnd(28)}| ${slug}`);

      if (!isDryRun) {
        await Setting.findOneAndUpdate(
          { restaurantId: r.restaurantId },
          { $set: { restaurantSlug: slug } }
        );
        updated++;
      }
    } catch (err) {
      console.error(`  ✗ Failed for ${r.restaurantId}: ${err.message}`);
    }
  }

  console.log("\n" + "─".repeat(80));
  if (isDryRun) {
    console.log(`\n🔍 DRY RUN complete. ${restaurants.length} slug(s) would be generated.`);
    console.log("   Run without --dry-run to apply.");
  } else {
    console.log(`\n✅ Migration complete. ${updated} slug(s) assigned.`);
  }

  await mongoose.connection.close();
  process.exit(0);
}

main().catch(err => {
  console.error("❌ Migration failed:", err.message);
  process.exit(1);
});
