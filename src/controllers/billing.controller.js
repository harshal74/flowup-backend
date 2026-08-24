const Order    = require("../models/Order");
const Bill     = require("../models/Bill");
const Customer = require("../models/Customer");
const Setting  = require("../models/Setting");
const mongoose = require("mongoose");
const { sendBillWhatsApp } = require("../services/whatsapp.service");

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
      const customers = await Customer.find({
        restaurantId,
        name: { $regex: customer, $options: "i" },
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
    const gst        = Math.round(subtotal * 0.05 * 100) / 100;
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

    const settings = await Setting.findOne({ restaurantId }).select("restaurantName whatsappNotificationsEnabled upiId");
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
      paymentSettings: { upiId, restaurantName },
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

    const bill = await Bill.findOne({ _id: billId, restaurantId });
    if (!bill) return res.status(404).json({ success: false, message: "Bill not found." });
    if (bill.paymentStatus === "Paid") return res.status(400).json({ success: false, message: "Bill already confirmed." });

    bill.paymentStatus = "Paid";
    bill.paidAt = new Date();
    await bill.save();

    await Order.updateMany({ _id: { $in: bill.orderIds } }, { $set: { paymentStatus: "PAID" } });

    return res.status(200).json({ success: true, message: "Payment confirmed.", bill });
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

    const skip  = (Number(page) - 1) * Number(limit);
    const total = await Bill.countDocuments({ restaurantId });

    const bills = await Bill.find({ restaurantId })
      .populate({ path: "orderIds", populate: { path: "customerId", select: "name mobile" } })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit));

    return res.status(200).json({ success: true, count: bills.length, total, page: Number(page), limit: Number(limit), bills });
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
