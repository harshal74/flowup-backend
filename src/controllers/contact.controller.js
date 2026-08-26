const { sendEnquiryEmail } = require("../services/emailService");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── POST /api/contact ─────────────────────────────────────────────
// Public endpoint for the marketing landing page "Get in Touch" form.
// Emails the enquiry to the FlowUp sales inbox (CONTACT_RECIPIENT_EMAIL).
exports.submitEnquiry = async (req, res) => {
  try {
    const { name, restaurant, phone, email, city, message } = req.body || {};

    // ── Validation (mirror the frontend rules) ────────────────
    if (!name || !String(name).trim()) {
      return res.status(400).json({ success: false, message: "Name is required." });
    }
    if (!restaurant || !String(restaurant).trim()) {
      return res.status(400).json({ success: false, message: "Restaurant name is required." });
    }
    if (!phone || !String(phone).trim()) {
      return res.status(400).json({ success: false, message: "Phone number is required." });
    }
    if (!email || !EMAIL_RE.test(String(email).trim())) {
      return res.status(400).json({ success: false, message: "A valid email is required." });
    }
    if (!message || !String(message).trim()) {
      return res.status(400).json({ success: false, message: "Message is required." });
    }

    // Length guards to prevent abuse
    const trim = (v, max) => String(v).trim().slice(0, max);
    const payload = {
      name:       trim(name, 120),
      restaurant: trim(restaurant, 160),
      phone:      trim(phone, 40),
      email:      trim(email, 160),
      city:       trim(city || "", 120),
      message:    trim(message, 4000),
    };

    await sendEnquiryEmail(payload);

    return res.status(200).json({
      success: true,
      message: "Thanks! Your enquiry has been sent. We'll get back to you shortly.",
    });
  } catch (err) {
    if (err.code === "SMTP_NOT_CONFIGURED") {
      console.error("[Contact] Email not configured:", err.message);
      return res.status(503).json({
        success: false,
        message: "Enquiries are temporarily unavailable. Please email us directly.",
      });
    }
    console.error("[Contact] submitEnquiry error:", err.message);
    return res.status(500).json({ success: false, message: "Failed to send enquiry. Please try again." });
  }
};
