require("dotenv").config();

// ── Fail-fast: required environment variables ─────────────────────
const REQUIRED_ENV = ["MONGO_URI", "JWT_SECRET"];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error(`\n❌ FATAL: Missing required environment variables:\n   ${missing.join("\n   ")}\n`);
  console.error("   Configure these in .env (development) or Render environment (production).");
  console.error("   See .env.example for reference.\n");
  process.exit(1);
}

const http = require("http");
const mongoose = require("mongoose");
const connectDB = require("./config/db");
const { app, ALLOWED_ORIGINS } = require("./app");
const { initSocket } = require("./socket");
const { runWhatsAppStartupCheck } = require("./services/whatsappStartupCheck");

connectDB();

// ── WhatsApp Meta idempotency-index readiness (Phase 26) ──────────
// READ-ONLY operator diagnostic. Runs once the DB connection is open. It never
// creates/modifies an index, never crashes the app, and never enables Meta —
// the authoritative fail-closed gate remains in the send path. If the index is
// missing, Meta outbound stays BLOCKED while Twilio + the app keep working.
mongoose.connection.once("open", () => {
  runWhatsAppStartupCheck().catch(() => { /* never disturb startup */ });
});

// Wrap Express in a plain HTTP server so Socket.IO can share port 5000
const httpServer = http.createServer(app);

// Attach Socket.IO — pass the same allowed origins so CORS is consistent
const io = initSocket(httpServer, ALLOWED_ORIGINS);

const PORT = process.env.PORT || 5000;

httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔌 WebSocket server ready`);
});

// ── Graceful Shutdown ─────────────────────────────────────────────
// Render/Railway send SIGTERM on deploy. We need to drain connections
// before the process is killed, or in-flight requests get dropped.
function gracefulShutdown(signal) {
  console.log(`\n⏳ ${signal} received — shutting down gracefully…`);

  // Stop accepting new connections
  httpServer.close(() => {
    console.log("   ✓ HTTP server closed");

    // Close Socket.IO
    if (io) {
      io.close(() => {
        console.log("   ✓ Socket.IO closed");
      });
    }

    // Close MongoDB
    mongoose.connection.close(false).then(() => {
      console.log("   ✓ MongoDB connection closed");
      process.exit(0);
    }).catch(() => {
      process.exit(0);
    });
  });

  // Force kill after 10s if graceful shutdown stalls
  setTimeout(() => {
    console.error("   ✗ Forced shutdown (timeout)");
    process.exit(1);
  }, 10000);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));
