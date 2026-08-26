const express = require("express");
const { rateLimit } = require("../middleware/rateLimit");
const { listPublicRestaurants } = require("../controllers/restaurants.controller");

const router = express.Router();

// Rate limit: 60 requests per minute per IP — generous enough for a search-as-you-type
// UX while preventing trivial scraping.
const discoverLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: "Too many requests. Please wait a moment.",
});

// Public — no authentication required
router.get("/public", discoverLimiter, listPublicRestaurants);

module.exports = router;
