/**
 * Reservation WhatsApp messages.
 *
 *  sendReservationConfirmation(id) — once, right after a reservation is made.
 *  runReservationReminders()       — every few minutes: reminds guests whose
 *                                    reservation starts within the next hour.
 *
 * Each message is claimed atomically (confirmationSentAt / reminderSentAt) so
 * it is sent at most once, even with several server instances. Uses the
 * existing WhatsApp service (default provider); respects the restaurant's
 * whatsappNotificationsEnabled setting. Never throws to callers.
 */

const TableReservation = require("../models/TableReservation");
const Setting = require("../models/Setting");
const { sendOrderStatusWhatsApp } = require("./whatsapp.service");

const REMINDER_LEAD_MS = 60 * 60 * 1000;     // remind 1 hour before
const REMINDER_INTERVAL_MS = 5 * 60 * 1000;  // check every 5 minutes

const fmtIST = (d, opts) =>
  new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", ...opts });
const dateIST = (d) => fmtIST(d, { weekday: "short", day: "numeric", month: "short" });
const timeIST = (d) => fmtIST(d, { hour: "numeric", minute: "2-digit" });

function buildConfirmationMessage(r, restaurantName) {
  return (
    `✅ Table Reserved!\n\n` +
    `Restaurant : ${restaurantName}\n` +
    `Name       : ${r.guestName}\n` +
    `Table      : ${r.tableNumber}\n` +
    `Guests     : ${r.numberOfPeople}\n` +
    (r.reservationStart
      ? `Date       : ${dateIST(r.reservationStart)}\n` +
        `Time       : ${timeIST(r.reservationStart)}${r.reservationEnd ? ` – ${timeIST(r.reservationEnd)}` : ""}\n`
      : "") +
    `\nWe look forward to seeing you! 🙏`
  );
}

function buildReminderMessage(r, restaurantName) {
  return (
    `⏰ Reservation Reminder\n\n` +
    `Hi ${r.guestName}, your table at ${restaurantName} is booked for ` +
    `${timeIST(r.reservationStart)} today (Table ${r.tableNumber}, ${r.numberOfPeople} ` +
    `${r.numberOfPeople === 1 ? "guest" : "guests"}).\n\nSee you soon! 🍽️`
  );
}

async function sendTo(r, body, event) {
  const settings = await Setting.findOne({ restaurantId: r.restaurantId })
    .select("restaurantName whatsappNotificationsEnabled countryCode")
    .lean();
  if (settings?.whatsappNotificationsEnabled === false) return { skipped: true };
  return sendOrderStatusWhatsApp({
    mobile: r.mobileNumber,
    countryContext: settings?.countryCode,
    logContext: { restaurantId: r.restaurantId, countryCode: settings?.countryCode },
    body: typeof body === "function" ? body(settings?.restaurantName || "FlowUp Restaurant") : body,
    event,
  });
}

async function sendReservationConfirmation(reservationId) {
  try {
    // Claim the confirmation once; only guests with a mobile number get it
    const r = await TableReservation.findOneAndUpdate(
      { _id: reservationId, confirmationSentAt: null, mobileNumber: { $nin: [null, ""] } },
      { $set: { confirmationSentAt: new Date() } },
      { returnDocument: "after" }
    ).lean();
    if (!r) return null;
    return await sendTo(r, (name) => buildConfirmationMessage(r, name), "reservation_confirmed");
  } catch (err) {
    console.error("[Reservation WhatsApp] confirmation failed:", err.message);
    return null;
  }
}

async function runReservationReminders(now = new Date()) {
  let sent = 0;
  try {
    const soon = new Date(now.getTime() + REMINDER_LEAD_MS);
    const due = await TableReservation.find({
      status: { $in: ["RESERVED", "ACTIVE"] },
      reminderSentAt: null,
      mobileNumber: { $nin: [null, ""] },
      reservationStart: { $gt: now, $lte: soon },
    }).select("_id").limit(200).lean();

    for (const { _id } of due) {
      // Atomic claim → a reminder is never sent twice
      const r = await TableReservation.findOneAndUpdate(
        { _id, reminderSentAt: null, status: { $in: ["RESERVED", "ACTIVE"] } },
        { $set: { reminderSentAt: new Date() } },
        { returnDocument: "after" }
      ).lean();
      if (!r) continue;
      try {
        await sendTo(r, (name) => buildReminderMessage(r, name), "reservation_reminder");
        sent++;
      } catch (err) {
        console.error("[Reservation WhatsApp] reminder failed:", err.message);
      }
    }
  } catch (err) {
    console.error("[Reservation WhatsApp] reminder run failed:", err.message);
  }
  return sent;
}

let timer = null;
function startReservationReminderScheduler() {
  if (timer) return timer;
  timer = setInterval(() => { runReservationReminders(); }, REMINDER_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref(); // never keeps the process alive
  runReservationReminders();
  return timer;
}

module.exports = {
  sendReservationConfirmation,
  runReservationReminders,
  startReservationReminderScheduler,
  buildConfirmationMessage,
  buildReminderMessage,
};
