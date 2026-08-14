require("dotenv").config();

const http = require("http");
const connectDB = require("./config/db");
const { app, ALLOWED_ORIGINS } = require("./app");
const { initSocket } = require("./socket");

connectDB();

// Wrap Express in a plain HTTP server so Socket.IO can share port 5000
const httpServer = http.createServer(app);

// Attach Socket.IO — pass the same allowed origins so CORS is consistent
initSocket(httpServer, ALLOWED_ORIGINS);

// ── Test email config at startup ──────────────────────────────
const emailUser = process.env.EMAIL_USER;
const emailPass = process.env.EMAIL_PASS;
if (!emailUser || !emailPass || emailUser === "your-email@gmail.com" || emailPass === "your-app-password-here") {
  console.warn("⚠️  Email NOT configured — OTPs will print to console only.");
  console.warn("   Fix: set EMAIL_USER and EMAIL_PASS (Gmail App Password) in backend/.env");
} else {
  console.log(`📧 Email config found: ${emailUser} — testing connection…`);
  const { testSmtpConnection } = require("./services/emailService");
  // Test asynchronously so it doesn't block server startup
  setTimeout(async () => {
    const result = await testSmtpConnection();
    if (result.ok) {
      console.log(`✅ SMTP connected — emails will be sent to real addresses`);
    } else {
      console.error(`❌ SMTP FAILED: ${result.reason}`);
      console.error(`   CODE: ${result.code || "unknown"}`);
      console.error(`   FIX:  Go to myaccount.google.com/apppasswords and generate a new App Password`);
      console.error(`   OTPs will fall back to console logging until SMTP is fixed`);
    }
  }, 2000); // wait 2s for DB connection to settle first
}

const PORT = process.env.PORT || 5000;

httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔌 WebSocket server ready`);
});
