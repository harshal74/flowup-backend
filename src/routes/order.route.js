const express = require("express");

const {
  createOrder,
  getOrders,
  getOrderById,
  acceptOrder,
  rejectOrder,
  updateOrderStatus,
} = require("../controllers/order.controller");

const protect = require("../middleware/auth.middleware");

const router = express.Router();

// ── Public: reverse geocode lat/lng → readable address via Nominatim ──
// We proxy this on the backend so the client never talks to Nominatim
// directly and we can add a meaningful User-Agent header as required
// by the Nominatim usage policy.
router.get("/geocode/reverse", async (req, res) => {
  const { lat, lng } = req.query;

  if (!lat || !lng || isNaN(Number(lat)) || isNaN(Number(lng))) {
    return res.status(400).json({ success: false, message: "lat and lng query params are required" });
  }

  const latitude  = Number(lat);
  const longitude = Number(lng);

  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return res.status(400).json({ success: false, message: "lat/lng out of valid range" });
  }

  try {
    // Use the built-in fetch (Node 18+) or fallback to https
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${latitude}&lon=${longitude}&accept-language=en`;

    const response = await fetch(url, {
      headers: {
        // Nominatim usage policy requires a descriptive User-Agent
        "User-Agent": "FlowUp/1.0 (restaurant-management; contact@flowup.app)",
        "Accept-Language": "en",
      },
    });

    if (!response.ok) {
      return res.status(502).json({ success: false, message: "Geocoding service unavailable" });
    }

    const data = await response.json();

    if (!data || data.error) {
      return res.status(404).json({ success: false, message: "No address found for this location" });
    }

    // Build a clean, readable address from the Nominatim response
    const addr = data.address || {};

    // Priority order: road/suburb, city/town, state, country
    const parts = [
      addr.road || addr.pedestrian || addr.residential || "",
      addr.suburb || addr.neighbourhood || addr.quarter || "",
      addr.village || addr.town || addr.city || addr.municipality || "",
      addr.state_district || addr.county || "",
      addr.state || "",
      addr.country || "",
    ].filter(Boolean);

    // Remove consecutive duplicates
    const unique = parts.filter((p, i) => p !== parts[i - 1]);
    const readableAddress = unique.join(", ");

    return res.json({
      success: true,
      address: readableAddress || data.display_name || "Address not found",
      displayName: data.display_name,
    });
  } catch (err) {
    console.error("[Geocode] Reverse geocoding error:", err.message);
    return res.status(500).json({ success: false, message: "Failed to fetch address" });
  }
});

router.post("/", createOrder);

router.get("/", protect, getOrders);

router.get("/:id", protect, getOrderById);

router.patch(
  "/:id/accept",
  protect,
  acceptOrder
);

router.patch(
  "/:id/reject",
  protect,
  rejectOrder
);

router.patch(
  "/:id/status",
  protect,
  updateOrderStatus
);

module.exports = router;