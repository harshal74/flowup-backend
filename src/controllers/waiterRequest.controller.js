const WaiterRequest = require("../models/WaiterRequest");
const { emitToRestaurant } = require("../socket");

// ── Create (public — called by customer) ─────────────────────────
const createWaiterRequest = async (req, res) => {
  try {
    const { tableNumber, customerName, orderId } = req.body;

    // Use validated restaurantId from resolvePublicRestaurant middleware
    const restaurantId = req.restaurantId;
    if (!restaurantId) {
      return res.status(400).json({ success: false, message: "Restaurant context is required." });
    }

    if (!tableNumber || tableNumber < 1) {
      return res.status(400).json({ success: false, message: "Table number is required" });
    }

    // Block duplicate requests within 5 minutes from the same table + restaurant
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
    const existing = await WaiterRequest.findOne({
      restaurantId, tableNumber, status: "PENDING",
      createdAt: { $gte: fiveMinutesAgo },
    });

    if (existing) {
      return res.status(429).json({
        success: false,
        message: "A waiter request for this table is already active. Please wait.",
      });
    }

    const request = await WaiterRequest.create({
      restaurantId,
      tableNumber,
      customerName: customerName || "",
      orderId: orderId || null,
      status: "PENDING",
    });

    // Emit to admin room — _id as string so frontend dedup works
    emitToRestaurant(restaurantId, "waiter_requested", {
      _id:          request._id.toString(),
      restaurantId: request.restaurantId,
      tableNumber:  request.tableNumber,
      customerName: request.customerName,
      status:       request.status,
      createdAt:    request.createdAt.toISOString(),
    });

    return res.status(201).json({ success: true, message: "Waiter request sent", data: request });
  } catch (error) {
    console.error("Create Waiter Request Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── Get all active (admin) ────────────────────────────────────────
const getWaiterRequests = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const requests = await WaiterRequest.find({
      restaurantId,
      status: { $in: ["PENDING", "ACCEPTED"] },
    }).sort({ createdAt: -1 });

    return res.status(200).json({ success: true, count: requests.length, data: requests });
  } catch (error) {
    console.error("Get Waiter Requests Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── Update status (admin/staff) ───────────────────────────────────
const updateWaiterRequestStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!["ACCEPTED", "COMPLETED"].includes(status)) {
      return res.status(400).json({ success: false, message: "Status must be ACCEPTED or COMPLETED" });
    }

    // BUG AB FIX: scope by restaurantId so cross-tenant updates are blocked
    const restaurantId = req.user.restaurantId;
    const request = await WaiterRequest.findOne({ _id: req.params.id, restaurantId });
    if (!request) return res.status(404).json({ success: false, message: "Not found" });

    request.status = status;
    await request.save();

    emitToRestaurant(request.restaurantId, "waiter_request_updated", {
      _id: request._id.toString(), status: request.status, tableNumber: request.tableNumber,
    });

    return res.status(200).json({ success: true, message: `Marked as ${status}`, data: request });
  } catch (error) {
    console.error("Update Waiter Request Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── Delete one (admin — dismiss from notification) ────────────────
const deleteWaiterRequest = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    // BUG 2 FIX: check if document actually existed before returning 200
    const deleted = await WaiterRequest.findOneAndDelete({ _id: req.params.id, restaurantId });
    if (!deleted) return res.status(404).json({ success: false, message: "Not found" });

    // Notify all connected clients (admin + waiter) so they remove it immediately
    emitToRestaurant(restaurantId, "waiter_request_updated", {
      _id: deleted._id.toString(), status: "COMPLETED", tableNumber: deleted.tableNumber,
    });

    return res.status(200).json({ success: true, message: "Dismissed" });
  } catch (error) {
    console.error("Delete Waiter Request Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── Delete all active (admin — clear all) ─────────────────────────
const deleteAllWaiterRequests = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    // Fetch IDs before deleting so we can emit events for each
    const active = await WaiterRequest.find(
      { restaurantId, status: { $in: ["PENDING", "ACCEPTED"] } },
      "_id tableNumber"
    );
    await WaiterRequest.deleteMany({ restaurantId, status: { $in: ["PENDING", "ACCEPTED"] } });

    // Emit one event per request so all clients clean up their state
    active.forEach(r => {
      emitToRestaurant(restaurantId, "waiter_request_updated", {
        _id: r._id.toString(), status: "COMPLETED", tableNumber: r.tableNumber,
      });
    });

    return res.status(200).json({ success: true, message: "All cleared" });
  } catch (error) {
    console.error("Delete All Waiter Requests Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── Resolve all active requests for a specific table ──────────────
const resolveTable = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const tableNumber = Number(req.params.tableNumber);

    if (!tableNumber || tableNumber < 1) {
      return res.status(400).json({ success: false, message: "Valid table number is required" });
    }

    // Find all active requests for this table
    const active = await WaiterRequest.find({
      restaurantId,
      tableNumber,
      status: { $in: ["PENDING", "ACCEPTED"] },
    });

    if (active.length === 0) {
      return res.status(200).json({ success: true, message: "No active requests for this table", resolved: 0 });
    }

    // Bulk update all to COMPLETED
    await WaiterRequest.updateMany(
      { restaurantId, tableNumber, status: { $in: ["PENDING", "ACCEPTED"] } },
      { $set: { status: "COMPLETED" } }
    );

    // Emit events so all connected clients update immediately
    active.forEach(r => {
      emitToRestaurant(restaurantId, "waiter_request_updated", {
        _id: r._id.toString(), status: "COMPLETED", tableNumber: r.tableNumber,
      });
    });

    return res.status(200).json({
      success: true,
      message: `Table ${tableNumber} resolved — ${active.length} request${active.length !== 1 ? 's' : ''} completed`,
      resolved: active.length,
    });
  } catch (error) {
    console.error("Resolve Table Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

module.exports = {
  createWaiterRequest,
  getWaiterRequests,
  updateWaiterRequestStatus,
  deleteWaiterRequest,
  deleteAllWaiterRequests,
  resolveTable,
};
