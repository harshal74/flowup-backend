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
const { markTableDirtyIfSettled } = require("../services/tableClean.service");
const { buildSplits, toP, fromP, PAYMENT_METHODS } = require("../services/billSplit.service");

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

    // One bill = one table. Dine-in orders can't be mixed with other tables
    // or with takeaway/delivery orders (counter bills may combine non-dine-in orders).
    const hasDineIn = orders.some(o => o.orderType === "DINE_IN");
    if (hasDineIn) {
      const tables = new Set(orders.map(o => (o.orderType === "DINE_IN" ? o.tableNumber : "non-dine-in")));
      if (tables.size !== 1) {
        await session.abortTransaction();
        return res.status(400).json({
          success: false,
          message: "All dine-in orders on a bill must be from the same table. Bill each table separately.",
        });
      }
    }

    const tableNumber = hasDineIn ? orders[0].tableNumber : (orders[0].tableNumber ?? null);

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
      .select("restaurantName whatsappNotificationsEnabled upiId gstEnabled sgstRate cgstRate countryCode")
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

    // ── Optional split at generation time (omitted / "NONE" = single payment) ──
    const splitType = req.body.splitType || "NONE";
    let splits = [];
    if (splitType !== "NONE") {
      const built = buildSplits(
        { items, subtotal, sgst, cgst, discount, grandTotal },
        { splitType, splits: req.body.splits, splitCount: req.body.splitCount, defaultMethod: paymentMethod }
      );
      if (built.error) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: built.error });
      }
      splits = built.splits;
    }

    // Create bill inside transaction
    const [bill] = await Bill.create([{
      splitType,
      splits,
      paidAmount: 0,
      remainingAmount: grandTotal,
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
      sendBillWhatsApp({
        mobile: customerMobile,
        countryContext: settings?.countryCode,
        logContext: { restaurantId, customerId: orders[0].customerId?._id, orderId: orders[0]._id, countryCode: settings?.countryCode },
        // Phase 18: structured Meta template input (Phase 9 flowup_bill).
        templateInput: {
          restaurantName,
          invoiceNumber: bill.invoiceNumber,
          amount: Number(bill.grandTotal).toFixed(2),
        },
        bill, customerName, restaurantName,
      })
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
// Single-payment bills only. Split bills are settled split by split.
exports.confirmPayment = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const { billId } = req.params;
    if (!mongoose.isValidObjectId(billId)) {
      return res.status(404).json({ success: false, message: "Bill not found." });
    }

    // FIX H3: Atomic findOneAndUpdate — only transitions from "Pending" to "Paid".
    // Two simultaneous requests will race; the second will find no document matching
    // paymentStatus: "Pending" and receive a clean 400 "already confirmed" response.
    let bill = await Bill.findOneAndUpdate(
      { _id: billId, restaurantId, paymentStatus: "Pending", splitType: { $in: [null, "NONE"] } },
      { $set: { paymentStatus: "Paid", paidAt: new Date() } },
      { new: true }
    );
    if (bill) {
      // Settlement totals (only this request reached here, so a plain update is safe)
      bill = await Bill.findByIdAndUpdate(
        bill._id,
        { $set: { paidAmount: bill.grandTotal, remainingAmount: 0 } },
        { new: true }
      );
    }

    if (!bill) {
      // Not this restaurant's bill, already confirmed, or a split bill.
      const exists = await Bill.findOne({ _id: billId, restaurantId }).select("paymentStatus splitType").lean();
      if (!exists) {
        return res.status(404).json({ success: false, message: "Bill not found." });
      }
      if (exists.paymentStatus === "Pending" && exists.splitType && exists.splitType !== "NONE") {
        return res.status(409).json({ success: false, message: "This bill is split. Confirm each person's payment separately." });
      }
      return res.status(400).json({ success: false, message: "Bill already confirmed." });
    }

    const settlement = await settlePaidBill(req, restaurantId, bill);
    return res.status(200).json({ success: true, message: "Payment confirmed.", bill, ...settlement });
  } catch (error) {
    console.error("Confirm Payment Error:", error);
    return res.status(500).json({ success: false, message: "Failed to confirm payment." });
  }
};

/**
 * Everything that happens once a bill is fully paid (single payment or the
 * last split): orders → PAID, revenue event, waiter requests closed, ARRIVED
 * reservation completed, table marked dirty. Returns the response extras.
 */
async function settlePaidBill(req, restaurantId, bill) {
    // Mark all orders on this bill as PAID
    await Order.updateMany({ _id: { $in: bill.orderIds } }, { $set: { paymentStatus: "PAID" } });

    // Let live dashboards count this revenue without a reload (dedicated event,
    // so existing order_status_updated listeners are unaffected).
    emitToRestaurant(restaurantId, "order_payment_updated", {
      orderIds: bill.orderIds.map(String),
      paymentStatus: "PAID",
    });

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

      // ── Table cleaning: mark the table DIRTY once its dine-in orders are
      // completed + paid and nothing else is using it. Idempotent, never throws,
      // and ignored for non-dine-in bills (orders are validated inside).
      await markTableDirtyIfSettled({
        restaurantId,
        tableNumber,
        orderIds: bill.orderIds,
        billId:   bill._id,
      });

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

    return {
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
    };
}

// ── PATCH /api/billing/:billId/split ────────────────────────────
// Split (or re-split / un-split with splitType "NONE") a Pending bill.
// Not allowed once any split has been paid.
exports.splitBill = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const { billId } = req.params;
    if (!mongoose.isValidObjectId(billId)) {
      return res.status(404).json({ success: false, message: "Bill not found." });
    }

    const bill = await Bill.findOne({ _id: billId, restaurantId });
    if (!bill) return res.status(404).json({ success: false, message: "Bill not found." });
    if (bill.paymentStatus !== "Pending") {
      return res.status(400).json({ success: false, message: "Only unpaid bills can be split." });
    }
    if ((bill.splits || []).some((s) => s.paymentStatus === "Paid")) {
      return res.status(409).json({ success: false, message: "Some people have already paid. This split can no longer be changed." });
    }

    const splitType = req.body?.splitType || "NONE";
    let update;
    if (splitType === "NONE") {
      update = { splitType: "NONE", splits: [], paidAmount: 0, remainingAmount: bill.grandTotal };
    } else {
      const built = buildSplits(bill, {
        splitType,
        splits: req.body?.splits,
        splitCount: req.body?.splitCount,
        defaultMethod: bill.paymentMethod,
      });
      if (built.error) return res.status(400).json({ success: false, message: built.error });
      update = { splitType, splits: built.splits, paidAmount: 0, remainingAmount: bill.grandTotal };
    }

    // Conditional write: fails if a split was paid since we read the bill.
    const updated = await Bill.findOneAndUpdate(
      { _id: bill._id, restaurantId, paymentStatus: "Pending", "splits.paymentStatus": { $ne: "Paid" } },
      { $set: update },
      { new: true, runValidators: true }
    );
    if (!updated) {
      return res.status(409).json({ success: false, message: "The bill changed while splitting. Please reopen it and try again." });
    }

    return res.status(200).json({ success: true, message: splitType === "NONE" ? "Split removed." : "Bill split.", bill: updated });
  } catch (error) {
    console.error("[Billing] splitBill error:", error.message);
    return res.status(500).json({ success: false, message: "Failed to split bill." });
  }
};

// ── PATCH /api/billing/:billId/splits/:splitId/confirm ──────────
// Body: { paymentMethod: "Cash" | "UPI" | "Card" }
// Marks one person's share as paid. When the last share is paid the bill and
// its orders become Paid and the normal table settlement runs.
exports.confirmSplitPayment = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const { billId, splitId } = req.params;
    if (!mongoose.isValidObjectId(billId) || !mongoose.isValidObjectId(splitId)) {
      return res.status(404).json({ success: false, message: "Split not found." });
    }
    const paymentMethod = req.body?.paymentMethod;
    if (paymentMethod !== undefined && !PAYMENT_METHODS.includes(paymentMethod)) {
      return res.status(400).json({ success: false, message: "Invalid payment method." });
    }

    const current = await Bill.findOne({ _id: billId, restaurantId }).lean();
    if (!current) return res.status(404).json({ success: false, message: "Bill not found." });
    const split = (current.splits || []).find((s) => String(s._id) === String(splitId));
    if (!split) return res.status(404).json({ success: false, message: "Split not found." });
    if (current.paymentStatus !== "Pending") {
      return res.status(400).json({ success: false, message: "This bill is already fully paid." });
    }

    // Atomic: only a Pending split can become Paid (two staff tapping at once → one wins)
    const now = new Date();
    const updated = await Bill.findOneAndUpdate(
      {
        _id: billId,
        restaurantId,
        paymentStatus: "Pending",
        splits: { $elemMatch: { _id: splitId, paymentStatus: "Pending" } },
      },
      {
        $set: {
          "splits.$.paymentStatus": "Paid",
          "splits.$.paidAt": now,
          "splits.$.paymentMethod": paymentMethod || split.paymentMethod || "Cash",
        },
      },
      { new: true }
    );
    if (!updated) {
      return res.status(400).json({ success: false, message: `${split.label || "This split"} is already paid.` });
    }

    // Recompute progress from the stored splits (in paise, so it never drifts)
    const paidP = updated.splits.filter((s) => s.paymentStatus === "Paid").reduce((t, s) => t + toP(s.amount), 0);
    const allPaid = updated.splits.every((s) => s.paymentStatus === "Paid");

    if (!allPaid) {
      const progressed = await Bill.findOneAndUpdate(
        { _id: billId, restaurantId, paymentStatus: "Pending" },
        { $set: { paidAmount: fromP(paidP), remainingAmount: fromP(toP(updated.grandTotal) - paidP) } },
        { new: true }
      );
      emitBillProgress(restaurantId, progressed || updated);
      return res.status(200).json({
        success: true,
        message: `${split.label || "Split"} paid.`,
        bill: progressed || updated,
        billPaid: false,
      });
    }

    // Last split: flip the whole bill to Paid exactly once
    const paidBill = await Bill.findOneAndUpdate(
      { _id: billId, restaurantId, paymentStatus: "Pending", "splits.paymentStatus": { $ne: "Pending" } },
      { $set: { paymentStatus: "Paid", paidAt: now, paidAmount: updated.grandTotal, remainingAmount: 0 } },
      { new: true }
    );
    if (!paidBill) {
      // A concurrent request finished the bill first; it ran the settlement.
      const latest = await Bill.findById(billId);
      return res.status(200).json({ success: true, message: "Bill fully paid.", bill: latest, billPaid: true });
    }

    const settlement = await settlePaidBill(req, restaurantId, paidBill);
    emitBillProgress(restaurantId, paidBill);
    return res.status(200).json({
      success: true,
      message: "All splits paid. Bill closed.",
      bill: paidBill,
      billPaid: true,
      ...settlement,
    });
  } catch (error) {
    console.error("[Billing] confirmSplitPayment error:", error.message);
    return res.status(500).json({ success: false, message: "Failed to confirm split payment." });
  }
};

function emitBillProgress(restaurantId, bill) {
  if (!bill) return;
  emitToRestaurant(restaurantId, "bill_updated", {
    billId: String(bill._id),
    tableNumber: bill.tableNumber ?? null,
    paymentStatus: bill.paymentStatus,
    paidAmount: bill.paidAmount ?? 0,
    remainingAmount: bill.remainingAmount ?? bill.grandTotal,
  });
}

// ── DELETE /api/billing/:billId ─────────────────────────────────
exports.cancelBill = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const { billId } = req.params;
    if (!mongoose.isValidObjectId(billId)) {
      return res.status(404).json({ success: false, message: "Bill not found." });
    }

    const bill = await Bill.findOne({ _id: billId, restaurantId });
    if (!bill) return res.status(404).json({ success: false, message: "Bill not found." });
    if (bill.paymentStatus === "Paid") return res.status(400).json({ success: false, message: "Cannot cancel a paid bill." });
    if ((bill.splits || []).some((s) => s.paymentStatus === "Paid")) {
      return res.status(400).json({ success: false, message: "Some people have already paid this bill, so it can't be cancelled." });
    }

    // Atomic delete: only while nothing is paid (guards against a split being paid right now)
    const deleted = await Bill.findOneAndDelete({
      _id: billId, restaurantId, paymentStatus: "Pending", "splits.paymentStatus": { $ne: "Paid" },
    });
    if (!deleted) {
      return res.status(409).json({ success: false, message: "The bill changed. Please reopen it and try again." });
    }
    await Order.updateMany({ _id: { $in: bill.orderIds } }, { $set: { billId: null } });

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
