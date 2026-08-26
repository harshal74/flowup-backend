const express = require("express");
const { rateLimit } = require("../middleware/rateLimit");
const { submitEnquiry } = require("../controllers/contact.controller");

const router = express.Router();

// Rate limit: max 5 enquiries per 10 minutes per IP (anti-spam)
const contactLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  message: "Too many enquiries. Please try again in a few minutes.",
});

// Public — marketing landing page "Get in Touch" form
router.post("/", contactLimiter, submitEnquiry);

module.exports = router;
