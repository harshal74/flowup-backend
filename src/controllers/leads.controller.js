const FlowUpLead            = require("../models/FlowUpLead");
const { emitToRestaurant }  = require("../socket");
const { createRestaurant: createRestaurantFn } = require("./platform.controller");

const VALID_STATUSES = [
  "NEW", "CONTACTED", "DEMO_SCHEDULED", "DEMO_COMPLETED",
  "PAYMENT_PENDING", "CONVERTED", "NOT_INTERESTED", "CLOSED",
];

// Status → timestamp field mapping
const STATUS_TIMESTAMPS = {
  CONTACTED:      "contactedAt",
  DEMO_SCHEDULED: "demoScheduledAt",
  DEMO_COMPLETED: "demoCompletedAt",
  CONVERTED:      "convertedAt",
  CLOSED:         "closedAt",
};

// Statuses considered "active" (should appear in notification count)
const ACTIVE_STATUSES = ["NEW"];

// ── GET /api/leads  (SUPER_ADMIN only) ────────────────────────────
exports.getLeads = async (req, res) => {
  try {
    const {
      status, search, page = 1, limit = 50,
      sortBy = "createdAt", sortOrder = "desc",
    } = req.query;

    const effectiveLimit = Math.min(Number(limit) || 50, 200);
    const effectivePage  = Math.max(Number(page) || 1, 1);
    const skip = (effectivePage - 1) * effectiveLimit;

    const filter = {};

    if (status && VALID_STATUSES.includes(status)) {
      filter.status = status;
    }

    if (search && search.trim()) {
      const q = search.trim();
      filter.$or = [
        { name:           { $regex: q, $options: "i" } },
        { restaurantName: { $regex: q, $options: "i" } },
        { phone:          { $regex: q, $options: "i" } },
        { email:          { $regex: q, $options: "i" } },
        { city:           { $regex: q, $options: "i" } },
      ];
    }

    const sortDir = sortOrder === "asc" ? 1 : -1;
    const SORT_WHITELIST = { createdAt: "createdAt", updatedAt: "updatedAt" };
    const sortField = SORT_WHITELIST[sortBy] || "createdAt";

    const [total, leads, summaryCounts] = await Promise.all([
      FlowUpLead.countDocuments(filter),
      FlowUpLead.find(filter)
        .sort({ [sortField]: sortDir })
        .skip(skip)
        .limit(effectiveLimit)
        .populate("convertedBy", "name email")
        .lean(),
      FlowUpLead.aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
    ]);

    // Build summary object
    const summary = VALID_STATUSES.reduce((acc, s) => { acc[s] = 0; return acc; }, {});
    summary.total = 0;
    for (const row of summaryCounts) {
      summary[row._id] = row.count;
      summary.total += row.count;
    }
    summary.active = summary["NEW"] || 0;

    return res.status(200).json({
      success: true,
      data:    leads,
      pagination: {
        page:       effectivePage,
        limit:      effectiveLimit,
        total,
        totalPages: Math.ceil(total / effectiveLimit),
      },
      summary,
    });
  } catch (err) {
    console.error("[Leads] getLeads:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ── GET /api/leads/:id  (SUPER_ADMIN only) ────────────────────────
exports.getLeadById = async (req, res) => {
  try {
    const lead = await FlowUpLead.findById(req.params.id)
      .populate("convertedBy", "name email");

    if (!lead) {
      return res.status(404).json({ success: false, message: "Lead not found." });
    }

    return res.status(200).json({ success: true, data: lead });
  } catch (err) {
    console.error("[Leads] getLeadById:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ── PATCH /api/leads/:id  (SUPER_ADMIN only) ──────────────────────
// Updates status and/or internal notes.
exports.updateLead = async (req, res) => {
  try {
    const lead = await FlowUpLead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ success: false, message: "Lead not found." });
    }

    const { status, notes } = req.body;

    if (status !== undefined) {
      if (!VALID_STATUSES.includes(status)) {
        return res.status(400).json({
          success: false,
          message: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`,
        });
      }
      // Prevent re-opening a converted lead via this endpoint
      if (lead.status === "CONVERTED" && status !== "CONVERTED") {
        return res.status(409).json({
          success: false,
          message: "A converted lead cannot be moved back. Contact support if this is an error.",
        });
      }
      lead.status = status;

      // Set stage timestamp if moving into a new stage
      const tsField = STATUS_TIMESTAMPS[status];
      if (tsField && !lead[tsField]) {
        lead[tsField] = new Date();
      }
    }

    if (notes !== undefined) {
      lead.notes = String(notes).trim().slice(0, 4000);
    }

    await lead.save();

    // Emit update so platform frontend badge can update without refresh
    emitToRestaurant("PLATFORM", "lead_updated", {
      _id:    lead._id.toString(),
      status: lead.status,
    });

    return res.status(200).json({ success: true, message: "Lead updated.", data: lead });
  } catch (err) {
    console.error("[Leads] updateLead:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ── DELETE /api/leads/:id  (SUPER_ADMIN only) ─────────────────────
exports.deleteLead = async (req, res) => {
  try {
    const deleted = await FlowUpLead.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ success: false, message: "Lead not found." });
    }
    return res.status(200).json({ success: true, message: "Lead deleted." });
  } catch (err) {
    console.error("[Leads] deleteLead:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ── POST /api/leads/:id/convert  (SUPER_ADMIN only) ───────────────
// Converts a lead into a FlowUp restaurant using the existing
// platform.controller.createRestaurant logic. Atomic: if restaurant
// creation fails, the lead is NOT marked as converted.
exports.convertLead = async (req, res) => {
  try {
    const lead = await FlowUpLead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ success: false, message: "Lead not found." });
    }

    if (lead.status === "CONVERTED") {
      return res.status(409).json({
        success: false,
        message: "This lead has already been converted into a restaurant.",
        convertedRestaurantId: lead.convertedRestaurantId,
      });
    }

    // ── Delegate to the EXISTING platform restaurant creation ──
    // We build a mock Express req/res that captures the result from
    // createRestaurant without duplicating any of its logic.
    const {
      adminName,
      adminEmail,
      adminMobile,
      adminPassword,
      whatsappNumber,
      contactNumber,
      address,
      restaurantSlug,
      restaurantDescription,
    } = req.body;

    // Required fields that must come from the request body (not in the lead)
    const missingFields = [];
    if (!adminName || !String(adminName).trim())     missingFields.push("adminName");
    if (!adminEmail || !String(adminEmail).trim())   missingFields.push("adminEmail");
    if (!adminMobile || !String(adminMobile).trim()) missingFields.push("adminMobile");
    if (!adminPassword || adminPassword.length < 6)  missingFields.push("adminPassword (min 6 chars)");
    if (!whatsappNumber || !String(whatsappNumber).trim()) missingFields.push("whatsappNumber");

    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Missing required fields for restaurant creation: ${missingFields.join(", ")}`,
      });
    }

    // Build a fake req object with the combined lead + body data
    let capturedStatus = null;
    let capturedData   = null;

    const fakeReq = {
      user: req.user, // SUPER_ADMIN from platformAuth
      body: {
        restaurantName:        lead.restaurantName,
        restaurantDescription: restaurantDescription || "",
        restaurantSlug:        restaurantSlug || "",
        whatsappNumber:        String(whatsappNumber).trim(),
        contactNumber:         contactNumber || "",
        email:                 lead.email,
        address:               address || "",
        adminName:             String(adminName).trim(),
        adminEmail:            String(adminEmail).trim(),
        adminMobile:           String(adminMobile).trim(),
        adminPassword:         adminPassword,
      },
    };

    const fakeRes = {
      status: (code) => {
        capturedStatus = code;
        return {
          json: (data) => { capturedData = data; },
        };
      },
    };

    // Call the existing controller function
    await createRestaurantFn(fakeReq, fakeRes);

    if (capturedStatus !== 201 || !capturedData?.success) {
      // Restaurant creation failed — do NOT update the lead
      return res.status(capturedStatus || 500).json({
        success: false,
        message: capturedData?.message || "Restaurant creation failed.",
      });
    }

    // ── Restaurant created successfully — update the lead ──────
    const { restaurantId, restaurantName } = capturedData.restaurant || {};

    lead.status               = "CONVERTED";
    lead.convertedAt          = new Date();
    lead.convertedBy          = req.user._id;
    lead.convertedRestaurantId = restaurantId || null;

    await lead.save();

    // Remove from platform active notification
    emitToRestaurant("PLATFORM", "lead_updated", {
      _id:    lead._id.toString(),
      status: "CONVERTED",
    });

    return res.status(201).json({
      success: true,
      message: `Restaurant "${restaurantName || lead.restaurantName}" created and lead converted successfully.`,
      restaurant: capturedData.restaurant,
      adminAccount: capturedData.admin,
      lead: {
        _id:                   lead._id,
        status:                lead.status,
        convertedRestaurantId: lead.convertedRestaurantId,
        convertedAt:           lead.convertedAt,
      },
    });
  } catch (err) {
    console.error("[Leads] convertLead:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};
