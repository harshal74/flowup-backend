const Order          = require("../models/Order");
const Bill           = require("../models/Bill");
const Customer       = require("../models/Customer");
const Setting        = require("../models/Setting");
const WaiterRequest  = require("../models/WaiterRequest");
const TableReservation = require("../models/TableReservation");
const mongoose       = require("mongoose");
const { sendBillWhatsApp }   = require("../services/whatsapp.service");
const { emitToRestaurant }   = require("../socket");
const { logActivity }        = require("../services/staffActivityService");

/**
 * Escape a user-supplied string for safe use inside a MongoDB $regex.
 * Without escaping, a search for "(" produces a regex parse error (500),
 * and ".*" matches the entire collection (data scraping / ReDoS risk).
 */
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const generateInvoiceNumber = () => {
  const now  = new Date();
  const date = now.getFullYear().toString()
    + String(now.getMonth() + 1).padStart(2, "0")
    + String(now.getDate()).padStart(2, "0");
  const random = Math.floor(100000 + Math.random() * 900000);
  return `FL-${date}-${random}`;
};

// ── GET /api/billing/orders ─────────────────────────────────────
exports.getUnpaidOrders = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const { customer, table } = req.query;

    let customerIds = [];
    if (customer) {
      // FIX H2: escape user input before using in MongoDB $regex to prevent
      // regex parse errors (e.g. searching "(") and ReDoS attacks.
      const safeCustomer = escapeRegex(customer);
      const customers = await Customer.find({
        restaurantId,
        name: { $regex: safeCustomer, $options: "i" },
      }).select("_id");
      customerIds = customers.map(c => c._id);
    }

    const filter = {
      restaurantId,
      status:        "COMPLETED",
      paymentStatus: "PENDING",
      $or: [{ billId: null }, { billId: { $exists: false } }],
    };
    if (table)    filter.tableNumber = Number(table);
    if (customer) filter.customerId  = { $in: customerIds };

    const orders = await Order.find(filter)
      .populate("customerId", "name mobile")
      .sort({ createdAt: -1 });

    return res.status(200).json({ success: true, count: orders.length, orders });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Failed to fetch unpaid orders." });
  }
};

// ── POST /api/billing/generate ──────────────────────────────────
exports.generateBill = async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const restaurantId = req.user.restaurantId;

    const rawOrderIds = req.body.orderIds;
    const orderIds    = rawOrderIds ? [...new Set(rawOrderIds.map(String))] : [];
    const discount    = Math.max(0, Number(req.body.discount) || 0);
    const paymentMethod = req.body.paymentMethod || "Cash";

    if (orderIds.length === 0) {
      return res.status(400).json({ success: false, message: "Please select orders." });
    }

    // Validate payment method
    if (!["Cash", "UPI", "Card"].includes(paymentMethod)) {
      return res.status(400).json({ success: false, message: "Invalid payment method." });
    }

    // Start transaction
    session.startTransaction();

    // Find qualifying orders within transaction — atomically ensures no concurrent bill
    const orders = await Order.find({
      _id:           { $in: orderIds },
      restaurantId,
      status:        "COMPLETED",
      paymentStatus: "PENDING",
      $or: [{ billId: null }, { billId: { $exists: false } }],
    }).populate("customerId", "name mobile").session(session);

    if (orders.length === 0) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: "No unpaid completed orders found." });
    }

    if (orders.length !== orderIds.length) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: "Some selected orders are already billed or invalid." });
    }

    const tableNumber = orders[0].tableNumber ?? null;

    let rawSubtotal = 0;
    const items = [];
    orders.forEach(order => {
      rawSubtotal += order.totalAmount;
      order.items.forEach(item => {
        items.push({ menuItemId: item.menuId, name: item.name, quantity: item.quantity, price: item.price, total: item.subtotal });
      });
    });

    const subtotal   = Math.round(rawSubtotal * 100) / 100;

    // ── Load restaurant settings once — used for GST, UPI, WhatsApp, and receipt ──
    // Must be fetched BEFORE the GST calculation block.
    const settings = await Setting.findOne({ restaurantId })
      .select("restaurantName whatsappNotificationsEnabled upiId gstEnabled sgstRate cgstRate")
      .lean();

    // ── GST calculation — read from restaurant settings, not hardcoded ──
    const gstEnabled = settings?.gstEnabled ?? false;
    const sgstRate   = gstEnabled ? (settings?.sgstRate ?? 0) : 0;
    const cgstRate   = gstEnabled ? (settings?.cgstRate ?? 0) : 0;

    const sgst     = Math.round(subtotal * sgstRate / 100 * 100) / 100;
    const cgst     = Math.round(subtotal * cgstRate / 100 * 100) / 100;
    const gst      = Math.round((sgst + cgst) * 100) / 100;
    const grandTotal = Math.round(Math.max(0, subtotal + gst - discount) * 100) / 100;

    // Validate discount
    if (discount > subtotal + gst) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: "Discount cannot exceed subtotal + GST." });
    }

    // Create bill inside transaction
    const [bill] = await Bill.create([{
      restaurantId,
      tableNumber,
      orderIds,
      items,
      subtotal,
      gst,
      sgst,
      cgst,
      discount,
      grandTotal,
      paymentMethod,
      paymentStatus: "Pending",
      invoiceNumber: generateInvoiceNumber(),
      generatedBy:   req.user?._id || null,
    }], { session });

    // Update orders to reference this bill — inside same transaction
    await Order.updateMany(
      { _id: { $in: orderIds } },
      { $set: { billId: bill._id } },
      { session }
    );

    // Commit — both bill + order updates succeed atomically
    await session.commitTransaction();

    const customerMobile = orders[0].customerId?.mobile || "";
    const customerName   = orders[0].customerId?.name   || "";

    if (orders.length > 1) {
      const uniqueCustomers = new Set(orders.map(o => String(o.customerId?._id)).filter(Boolean));
      if (uniqueCustomers.size > 1) {
        console.warn(`[WhatsApp] Bill has ${uniqueCustomers.size} different customers — only notifying the first.`);
      }
    }

    // settings is already loaded above (before GST calculation) — do NOT re-query here
    const restaurantName = settings?.restaurantName || "FlowUp Restaurant";
    const upiId          = settings?.upiId          || "";

    if (settings?.whatsappNotificationsEnabled !== false) {
      sendBillWhatsApp({ mobile: customerMobile, bill, customerName, restaurantName })
        .catch(err => console.error("[WhatsApp] Unexpected error:", err));
    }

    return res.status(201).json({
      success: true,
      message: "Bill generated. Awaiting payment confirmation.",
      bill,
      customer: { name: customerName, mobile: customerMobile },
      // Payment settings needed by frontend to render the UPI QR code
      paymentSettings: { upiId, restaurantName, gstEnabled, sgstRate, cgstRate },
    });
  } catch (error) {
    // Abort transaction if it's still active
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    console.error("[Billing] generateBill error:", error.message);
    return res.status(500).json({ success: false, message: "Failed to generate bill." });
  } finally {
    session.endSession();
  }
};

// ── PATCH /api/billing/:billId/confirm ──────────────────────────
exports.confirmPayment = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const { billId } = req.params;

    // FIX H3: Atomic findOneAndUpdate — only transitions from "Pending" to "Paid".
    // Two simultaneous requests will race; the second will find no document matching
    // paymentStatus: "Pending" and receive a clean 400 "already confirmed" response.
    const bill = await Bill.findOneAndUpdate(
      { _id: billId, restaurantId, paymentStatus: "Pending" },
      { $set: { paymentStatus: "Paid", paidAt: new Date() } },
      { new: true }
    );

    if (!bill) {
      // Either the bill does not belong to this restaurant, or it was already confirmed.
      // Distinguish the two cases for a better error message.
      const exists = await Bill.findOne({ _id: billId, restaurantId }).select("paymentStatus").lean();
      if (!exists) {
        return res.status(404).json({ success: false, message: "Bill not found." });
      }
      return res.status(400).json({ success: false, message: "Bill already confirmed." });
    }

    // Mark all orders on this bill as PAID
    await Order.updateMany({ _id: { $in: bill.orderIds } }, { $set: { paymentStatus: "PAID" } });

    // ── Check for remaining unpaid eligible orders at the same table ──
    // Eligible = COMPLETED + paymentStatus PENDING + no billId + same table + not just-paid
    let remainingOrders = [];
    const tableNumber = bill.tableNumber ?? null;
    // Will be populated below if an ARRIVED reservation is auto-completed
    let reservationCompleted = null;

    if (tableNumber != null) {
      const paidOrderIds = bill.orderIds.map(id => String(id));

      remainingOrders = await Order.find({
        restaurantId,
        tableNumber,
        status:        "COMPLETED",
        paymentStatus: "PENDING",
        $or: [{ billId: null }, { billId: { $exists: false } }],
        _id: { $nin: paidOrderIds },
      })
        .populate("customerId", "name mobile")
        .select("_id orderNumber totalAmount subtotalAmount items customerId tableNumber createdAt")
        .lean();

      // ── If no more unpaid orders remain at this table, resolve waiter requests ──
      if (remainingOrders.length === 0) {
        const activeRequests = await WaiterRequest.find({
          restaurantId,
          tableNumber,
          status: { $in: ["PENDING", "ACCEPTED"] },
        }).select("_id tableNumber");

        if (activeRequests.length > 0) {
          await WaiterRequest.updateMany(
            { restaurantId, tableNumber, status: { $in: ["PENDING", "ACCEPTED"] } },
            { $set: { status: "COMPLETED" } }
          );
          // Notify all connected clients (admin + waiter) so the bell clears immediately
          activeRequests.forEach(r => {
            emitToRestaurant(restaurantId, "waiter_request_updated", {
              _id:         r._id.toString(),
              status:      "COMPLETED",
              tableNumber: r.tableNumber,
            });
          });
        }

        // ── Auto-complete an ARRIVED reservation for this DINE_IN table ──────
        // Conditions: all orders at the table are now paid, the bill is for a
        // dine-in context (tableNumber != null), and a reservation is ARRIVED.
        // Uses findOneAndUpdate for atomicity — concurrent payments won't
        // double-complete. Only ARRIVED reservations are targeted; RESERVED,
        // CANCELLED, NO_SHOW, and COMPLETED are intentionally excluded.
        //
        // DELIVERY and TAKE_AWAY safety: the bill's tableNumber is null for
        // those order types (set in generateBill from orders[0].tableNumber),
        // so this block is naturally skipped for non-dine-in scenarios.
        const completedReservation = await TableReservation.findOneAndUpdate(
          {
            restaurantId,
            tableNumber,
            status: "ARRIVED",
          },
          { $set: { status: "COMPLETED" } },
          { new: true }
        );

        if (completedReservation) {
          // Emit real-time update so Tables pages update immediately
          emitToRestaurant(restaurantId, "table_reservation_updated", {
            _id:              completedReservation._id.toString(),
            restaurantId:     completedReservation.restaurantId,
            tableNumber:      completedReservation.tableNumber,
            guestName:        completedReservation.guestName,
            mobileNumber:     completedReservation.mobileNumber || null,
            numberOfPeople:   completedReservation.numberOfPeople,
            reservationStart: completedReservation.reservationStart
              ? completedReservation.reservationStart.toISOString()
              : null,
            reservationEnd: completedReservation.reservationEnd
              ? completedReservation.reservationEnd.toISOString()
              : null,
            notes:          completedReservation.notes || "",
            reservedByName: completedReservation.reservedByName,
            reservedByRole: completedReservation.reservedByRole,
            status:         "COMPLETED",
            updatedAt:      new Date().toISOString(),
          });

          // Audit log — fire-and-forget, never blocks the billing response
          // req.user is the admin/staff who confirmed payment
          logActivity({
            staff: {
              _id:          req.user._id,
              restaurantId: req.user.restaurantId,
              name:         req.user.name || req.user.email || "Staff",
              role:         req.user.role || "ADMIN",
            },
            action:     "TABLE_RESERVATION_COMPLETED",
            entityType: "TableReservation",
            entityId:   completedReservation._id,
            oldValue:   `Table ${completedReservation.tableNumber} — ${completedReservation.guestName} (${completedReservation.numberOfPeople} ${completedReservation.numberOfPeople === 1 ? "person" : "people"})`,
            newValue:   "COMPLETED — Dine-in bill paid",
            req,
          });

          // Expose reservation details in the response so the frontend can
          // show the "Reservation Completed" notification to Admin/Assistant.
          reservationCompleted = {
            reservationId:  completedReservation._id.toString(),
            tableNumber:    completedReservation.tableNumber,
            guestName:      completedReservation.guestName,
            numberOfPeople: completedReservation.numberOfPeople,
          };
        }
      }
    }

    return res.status(200).json({
      success: true,
      message: "Payment confirmed.",
      bill,
      // remainingOrders: orders at the same table still unpaid after this payment.
      // Empty array = table is fully settled.
      // items are included so the frontend can show order details in the popup.
      remainingOrders: remainingOrders.map(o => ({
        _id:            String(o._id),
        orderNumber:    o.orderNumber,
        totalAmount:    o.totalAmount,
        subtotalAmount: o.subtotalAmount,
        tableNumber:    o.tableNumber,
        customerName:   o.customerId?.name || "Guest",
        // Return the full items array (name, quantity, price, subtotal) for the popup.
        // menuId and itemNote are excluded — not needed for display.
        items: (o.items || []).map(item => ({
          name:     item.name,
          quantity: item.quantity,
          price:    item.price,
          subtotal: item.subtotal,
        })),
        createdAt: o.createdAt,
      })),
      // reservationCompleted: populated when an ARRIVED reservation for this table
      // was automatically completed after all dine-in orders were paid.
      // null when no ARRIVED reservation existed or remaining orders still exist.
      reservationCompleted,
    });
  } catch (error) {
    console.error("Confirm Payment Error:", error);
    return res.status(500).json({ success: false, message: "Failed to confirm payment." });
  }
};

// ── DELETE /api/billing/:billId ─────────────────────────────────
exports.cancelBill = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const { billId } = req.params;

    const bill = await Bill.findOne({ _id: billId, restaurantId });
    if (!bill) return res.status(404).json({ success: false, message: "Bill not found." });
    if (bill.paymentStatus === "Paid") return res.status(400).json({ success: false, message: "Cannot cancel a paid bill." });

    await Order.updateMany({ _id: { $in: bill.orderIds } }, { $set: { billId: null } });
    await Bill.findByIdAndDelete(billId);

    return res.status(200).json({ success: true, message: "Bill cancelled." });
  } catch (error) {
    console.error("Cancel Bill Error:", error);
    return res.status(500).json({ success: false, message: "Failed to cancel bill." });
  }
};

// ── GET /api/billing/history ────────────────────────────────────
exports.getBillHistory = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const { page = 1, limit = 50 } = req.query;

    // FIX M5: Cap limit to prevent unbounded queries.
    const requestedLimit = Number(limit);
    const effectiveLimit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 200)
      : 50;

    const skip  = (Number(page) - 1) * effectiveLimit;
    const total = await Bill.countDocuments({ restaurantId });

    const bills = await Bill.find({ restaurantId })
      .populate({ path: "orderIds", populate: { path: "customerId", select: "name mobile" } })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(effectiveLimit);

    return res.status(200).json({ success: true, count: bills.length, total, page: Number(page), limit: effectiveLimit, bills });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Failed to fetch bill history." });
  }
};

// ── GET /api/billing/:billId ────────────────────────────────────
exports.getBillById = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const { billId } = req.params;

    const bill = await Bill.findOne({ _id: billId, restaurantId })
      .populate({ path: "orderIds", populate: { path: "customerId", select: "name mobile address" } });

    if (!bill) return res.status(404).json({ success: false, message: "Bill not found." });

    return res.status(200).json({ success: true, bill });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ success: false, message: "Failed to fetch bill." });
  }
};
