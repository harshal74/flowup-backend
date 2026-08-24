/**
 * Centralized environment configuration.
 * All process.env reads go through here — never scatter them across controllers.
 *
 * Restaurant-specific data (UPI ID, name, logo, tables…) belongs in MongoDB.
 * Only deployment/infrastructure settings belong here.
 */

module.exports = {
  nodeEnv:      process.env.NODE_ENV      || "development",
  port:         Number(process.env.PORT)  || 5000,
  mongoUri:     process.env.MONGO_URI,
  jwtSecret:    process.env.JWT_SECRET,

  // CORS origins for each frontend (production values set on Render)
  adminOrigin:    process.env.ADMIN_ORIGIN,
  customerOrigin: process.env.CUSTOMER_ORIGIN,
  waiterOrigin:   process.env.WAITER_ORIGIN,

  // Twilio — WhatsApp notifications
  twilioAccountSid:    process.env.TWILIO_ACCOUNT_SID,
  twilioAuthToken:     process.env.TWILIO_AUTH_TOKEN,
  twilioWhatsappFrom:  process.env.TWILIO_WHATSAPP_FROM,

  // (Email/OTP config removed — staff uses admin approval workflow)
};
