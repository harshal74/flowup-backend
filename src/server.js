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

// Staff approval system — no email/OTP required for registration

const PORT = process.env.PORT || 5000;

httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🔌 WebSocket server ready`);
});
