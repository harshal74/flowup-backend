const mongoose = require("mongoose");

/**
 * FlowUpLead — A business enquiry/lead from the FlowUp marketing landing page.
 *
 * This is NOT a restaurant customer enquiry.
 * It represents a potential restaurant owner who wants to use FlowUp.
 *
 * Lifecycle:
 *   NEW → CONTACTED → DEMO_SCHEDULED → DEMO_COMPLETED → PAYMENT_PENDING → CONVERTED
 *   At any point: NOT_INTERESTED | CLOSED
 */
const STATUSES = [
  "NEW",
  "CONTACTED",
  "DEMO_SCHEDULED",
  "DEMO_COMPLETED",
  "PAYMENT_PENDING",
  "CONVERTED",
  "NOT_INTERESTED",
  "CLOSED",
];

const flowUpLeadSchema = new mongoose.Schema(
  {
    // Submitted by the prospective restaurant owner
    name:           { type: String, required: true, trim: true, maxlength: 120 },
    restaurantName: { type: String, required: true, trim: true, maxlength: 160 },
    phone:          { type: String, required: true, trim: true, maxlength: 40  },
    email:          { type: String, required: true, trim: true, lowercase: true, maxlength: 160 },
    city:           { type: String, trim: true, maxlength: 120, default: "" },
    message:        { type: String, trim: true, maxlength: 4000, default: "" },

    // Status lifecycle
    status: {
      type:    String,
      enum:    STATUSES,
      default: "NEW",
      index:   true,
    },

    // Timestamps for each stage (set automatically when status changes)
    contactedAt:         { type: Date, default: null },
    demoScheduledAt:     { type: Date, default: null },
    demoCompletedAt:     { type: Date, default: null },
    convertedAt:         { type: Date, default: null },
    closedAt:            { type: Date, default: null },

    // Internal admin notes (not visible to lead submitter)
    notes: { type: String, trim: true, maxlength: 4000, default: "" },

    // Conversion details
    convertedRestaurantId: { type: String, default: null, trim: true },
    convertedBy: {
      type:    mongoose.Schema.Types.ObjectId,
      ref:     "Admin",
      default: null,
    },
  },
  { timestamps: true }
);

// Efficient queries by status (most common filter)
flowUpLeadSchema.index({ status: 1, createdAt: -1 });
// Search by email (uniqueness check before converting)
flowUpLeadSchema.index({ email: 1 });

module.exports =
  mongoose.models.FlowUpLead ||
  mongoose.model("FlowUpLead", flowUpLeadSchema);
