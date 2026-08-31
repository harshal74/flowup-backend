const DeliveryEnquiry     = require("../models/DeliveryEnquiry");
const { emitToRestaurant } = require("../socket");

const { isValidMobile, MOBILE_ERROR_MESSAGE } = require("../utils/validateMobile");
const EMAIL_RE  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_STATUSES = ["NEW", "CONTACTED", "RESOLVED", "CLOSED"];

/**
 * Escape a user-supplied string for safe use inside a MongoDB $regex.
 * Without escaping, a search for "(" produces a regex parse error (500),
 * and ".*" matches the entire collection (ReDoS risk).
 */
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── POST /api/delivery-enquiries  (public) ─────────────────────────
exports.createDeliveryEnquiry = async (req, res) => {
  try {
    // restaurantId set by resolvePublicRestaurant middleware — never trust body
    const restaurantId = req.restaurantId;
    if (!restaurantId) {
      return res.status(400).json({ success: false, message: "Restaurant context is required." });
    }

    const { customerName, mobile, email, address, deliveryLocation, message } = req.body;

    // ── Validation ──────────────────────────────────────────────
    if (!customerName || !String(customerName).trim()) {
      return res.status(400).json({ success: false, message: "Name is required." });
    }
    if (String(customerName).trim().length > 100) {
      return res.status(400).json({ success: false, message: "Name must be 100 characters or fewer." });
    }
    if (!isValidMobile(String(mobile).trim())) {
      return res.status(400).json({ success: false, message: MOBILE_ERROR_MESSAGE });
    }
    if (!address || !String(address).trim()) {
      return res.status(400).json({ success: false, message: "Delivery address is required." });
    }
    if (String(address).trim().length > 500) {
      return res.status(400).json({ success: false, message: "Address must be 500 characters or fewer." });
    }
    if (email && String(email).trim() && !EMAIL_RE.test(String(email).trim())) {
      return res.status(400).json({ success: false, message: "Invalid email format." });
    }
    if (message && String(message).length > 1000) {
      return res.status(400).json({ success: false, message: "Message must be 1000 characters or fewer." });
    }

    const trim = (v, max) => String(v || "").trim().slice(0, max);

    // Optional GPS coordinates
    let loc = undefined;
    if (deliveryLocation?.latitude != null && deliveryLocation?.longitude != null) {
      const lat = Number(deliveryLocation.latitude);
      const lng = Number(deliveryLocation.longitude);
      if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        loc = { latitude: lat, longitude: lng };
      }
    }

    const enquiry = await DeliveryEnquiry.create({
      restaurantId,
      customerName: trim(customerName, 100),
      mobile:       trim(mobile, 30),
      email:        trim(email || "", 160),
      address:      trim(address, 500),
      ...(loc ? { deliveryLocation: loc } : {}),
      message:      trim(message || "", 1000),
      status:       "NEW",
    });

    // Emit real-time event to admin room — only non-sensitive fields
    emitToRestaurant(restaurantId, "delivery_enquiry_created", {
      _id:          enquiry._id.toString(),
      restaurantId: enquiry.restaurantId,
      customerName: enquiry.customerName,
      mobile:       enquiry.mobile,
      address:      enquiry.address,
      message:      enquiry.message,
      status:       enquiry.status,
      createdAt:    enquiry.createdAt.toISOString(),
    });

    return res.status(201).json({
      success: true,
      message: "Enquiry submitted successfully.",
      data:    enquiry,
    });
  } catch (err) {
    console.error("[DeliveryEnquiry] createDeliveryEnquiry:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ── GET /api/delivery-enquiries  (admin) ───────────────────────────
exports.getDeliveryEnquiries = async (req, res) => {
  try {
    // Always scope to the authenticated admin's restaurant — never trust query param
    const restaurantId = req.user.restaurantId;

    const { status, search, page = 1, limit = 50 } = req.query;

    const effectiveLimit = Math.min(Number(limit) || 50, 200);
    const effectivePage  = Math.max(Number(page) || 1, 1);
    const skip = (effectivePage - 1) * effectiveLimit;

    const filter = { restaurantId };

    if (status && VALID_STATUSES.includes(status)) {
      filter.status = status;
    }

    if (search && search.trim()) {
      // FIX H2: escape user input before using in MongoDB $regex
      const safeQ = escapeRegex(search.trim());
      filter.$or = [
        { customerName: { $regex: safeQ, $options: "i" } },
        { mobile:       { $regex: safeQ, $options: "i" } },
        { address:      { $regex: safeQ, $options: "i" } },
      ];
    }

    const [total, enquiries, newCount, contactedCount, resolvedCount, closedCount] = await Promise.all([
      DeliveryEnquiry.countDocuments(filter),
      DeliveryEnquiry.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(effectiveLimit)
        .populate("resolvedBy", "name email")
        .lean(),
      DeliveryEnquiry.countDocuments({ restaurantId, status: "NEW" }),
      DeliveryEnquiry.countDocuments({ restaurantId, status: "CONTACTED" }),
      DeliveryEnquiry.countDocuments({ restaurantId, status: "RESOLVED" }),
      DeliveryEnquiry.countDocuments({ restaurantId, status: "CLOSED" }),
    ]);

    return res.status(200).json({
      success: true,
      data:    enquiries,
      pagination: {
        page:       effectivePage,
        limit:      effectiveLimit,
        total,
        totalPages: Math.ceil(total / effectiveLimit),
      },
      summary: {
        total:     newCount + contactedCount + resolvedCount + closedCount,
        new:       newCount,
        contacted: contactedCount,
        resolved:  resolvedCount,
        closed:    closedCount,
      },
    });
  } catch (err) {
    console.error("[DeliveryEnquiry] getDeliveryEnquiries:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ── GET /api/delivery-enquiries/:id  (admin) ───────────────────────
exports.getDeliveryEnquiryById = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const enquiry = await DeliveryEnquiry.findOne({ _id: req.params.id, restaurantId })
      .populate("resolvedBy", "name email");

    if (!enquiry) {
      return res.status(404).json({ success: false, message: "Enquiry not found." });
    }

    return res.status(200).json({ success: true, data: enquiry });
  } catch (err) {
    console.error("[DeliveryEnquiry] getDeliveryEnquiryById:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ── PATCH /api/delivery-enquiries/:id  (admin) ────────────────────
exports.updateDeliveryEnquiry = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const enquiry = await DeliveryEnquiry.findOne({ _id: req.params.id, restaurantId });

    if (!enquiry) {
      return res.status(404).json({ success: false, message: "Enquiry not found." });
    }

    const { status, note } = req.body;

    if (status !== undefined) {
      if (!VALID_STATUSES.includes(status)) {
        return res.status(400).json({
          success: false,
          message: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}`,
        });
      }
      enquiry.status = status;

      if (status === "RESOLVED") {
        enquiry.resolvedBy = req.user._id;
        enquiry.resolvedAt = new Date();
      } else {
        // Moving away from RESOLVED — clear resolution metadata
        enquiry.resolvedBy = null;
        enquiry.resolvedAt = null;
      }
    }

    if (note !== undefined) {
      enquiry.note = String(note).trim().slice(0, 1000);
    }

    await enquiry.save();

    emitToRestaurant(restaurantId, "delivery_enquiry_updated", {
      _id:        enquiry._id.toString(),
      status:     enquiry.status,
      resolvedAt: enquiry.resolvedAt?.toISOString() || null,
    });

    return res.status(200).json({ success: true, message: "Enquiry updated.", data: enquiry });
  } catch (err) {
    console.error("[DeliveryEnquiry] updateDeliveryEnquiry:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};

// ── DELETE /api/delivery-enquiries/:id  (admin) ───────────────────
exports.deleteDeliveryEnquiry = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const deleted = await DeliveryEnquiry.findOneAndDelete({ _id: req.params.id, restaurantId });

    if (!deleted) {
      return res.status(404).json({ success: false, message: "Enquiry not found." });
    }

    return res.status(200).json({ success: true, message: "Enquiry deleted." });
  } catch (err) {
    console.error("[DeliveryEnquiry] deleteDeliveryEnquiry:", err.message);
    return res.status(500).json({ success: false, message: "Internal server error." });
  }
};
