const { sendEnquiryEmail }  = require("../services/emailService");
const FlowUpLead            = require("../models/FlowUpLead");
const { emitToRestaurant }  = require("../socket");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ── POST /api/contact ─────────────────────────────────────────────
// Public endpoint for the marketing landing page "Get in Touch" form.
// 1. Saves a FlowUpLead record in the database (primary — always)
// 2. Emits a socket event to the PLATFORM admin room (real-time notification)
// 3. Sends email to the FlowUp sales inbox (secondary — fails gracefully)
exports.submitEnquiry = async (req, res) => {
  try {
    const { name, restaurant, phone, email, city, message } = req.body || {};

    // ── Validation ────────────────────────────────────────────
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

    const trim = (v, max) => String(v || "").trim().slice(0, max);
    const payload = {
      name:           trim(name, 120),
      restaurantName: trim(restaurant, 160),
      phone:          trim(phone, 40),
      email:          trim(email, 160),
      city:           trim(city || "", 120),
      message:        trim(message, 4000),
    };

    // ── 1. Save lead in database (always, regardless of email) ──
    const lead = await FlowUpLead.create({
      ...payload,
      status: "NEW",
    });

    // ── 2. Real-time platform notification ─────────────────────
    // PLATFORM is the SUPER_ADMIN's restaurantId room (see createSuperAdmin.js)
    emitToRestaurant("PLATFORM", "new_lead", {
      _id:            lead._id.toString(),
      name:           lead.name,
      restaurantName: lead.restaurantName,
      phone:          lead.phone,
      email:          lead.email,
      city:           lead.city,
      status:         lead.status,
      createdAt:      lead.createdAt.toISOString(),
    });

    // ── 3. Email notification (fail gracefully — DB save already done) ──
    try {
      await sendEnquiryEmail(payload);
    } catch (emailErr) {
      // Email failure must NOT cause the submission to fail.
      // The lead is already in the database.
      console.warn("[Contact] Email notification failed (lead saved):", emailErr.message);
    }

    return res.status(201).json({
      success: true,
      message: "Thanks! Your enquiry has been sent. We'll get back to you shortly.",
    });
  } catch (err) {
    console.error("[Contact] submitEnquiry error:", err.message);
    return res.status(500).json({ success: false, message: "Failed to send enquiry. Please try again." });
  }
};
