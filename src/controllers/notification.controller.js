const Notification = require("../models/Notification");
const mongoose = require("mongoose");

function isValidId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

// ── GET /api/notifications ──────────────────────────────────────
// List the authenticated restaurant's notifications (newest first).
// Optional filters: ?type=LOW_STOCK  ?read=true|false  ?limit=
// Tenant is ALWAYS req.user.restaurantId — never accepted from the client.
const getNotifications = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;
    const { type, read, limit } = req.query;

    const filter = { restaurantId };
    if (type === "LOW_STOCK") filter.type = "LOW_STOCK";
    if (read === "true")  filter.read = true;
    if (read === "false") filter.read = false;

    const cap = Math.min(Number(limit) || 100, 200);

    const notifications = await Notification.find(filter)
      .sort({ createdAt: -1 })
      .limit(cap)
      .lean();

    const unreadCount = await Notification.countDocuments({ restaurantId, read: false });

    return res.status(200).json({
      success: true,
      count: notifications.length,
      unreadCount,
      data: notifications,
    });
  } catch (error) {
    console.error("Get Notifications Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── PATCH /api/notifications/:id/read ───────────────────────────
// Mark one notification as read. The restaurantId is included in the query so
// an admin can NEVER mark another restaurant's notification as read.
const markNotificationRead = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: "Invalid ID" });

    const restaurantId = req.user.restaurantId;
    const updated = await Notification.findOneAndUpdate(
      { _id: id, restaurantId },              // tenant-scoped guard
      { $set: { read: true } },
      { returnDocument: "after" }
    ).lean();

    if (!updated) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }

    return res.status(200).json({ success: true, message: "Notification marked as read", data: updated });
  } catch (error) {
    console.error("Mark Notification Read Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// ── DELETE /api/notifications/:id ───────────────────────────────
// Dismiss (delete) one notification. Tenant-scoped.
const deleteNotification = async (req, res) => {
  try {
    const { id } = req.params;
    if (!isValidId(id)) return res.status(400).json({ success: false, message: "Invalid ID" });

    const restaurantId = req.user.restaurantId;
    const deleted = await Notification.findOneAndDelete({ _id: id, restaurantId });

    if (!deleted) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }

    return res.status(200).json({ success: true, message: "Notification dismissed" });
  } catch (error) {
    console.error("Delete Notification Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

module.exports = { getNotifications, markNotificationRead, deleteNotification };
