const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth.route");
const categoryRoutes = require("./routes/category.route");
const menuRoutes = require("./routes/menu.route");
const orderRoutes = require("./routes/order.route");
const customerRoutes = require("./routes/customer.route");
const dashboardRoutes = require("./routes/dashboard.route");
const settingsRoutes = require("./routes/settings.route");
const waiterRequestRoutes = require("./routes/waiterRequest.route");

const app = express();

// Allowed origins — must match on both REST and Socket.IO to avoid
// preflight failures when the browser sends credentials or the
// Socket.IO client connects from a Vite dev server.
const ALLOWED_ORIGINS = [
  process.env.ADMIN_ORIGIN    || "http://localhost:5173",
  process.env.CUSTOMER_ORIGIN || "http://localhost:5174",
  // Common alternative Vite ports
  "http://localhost:5175",
  "http://localhost:3000",
];

// Global Middleware
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, Postman, server-to-server)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin '${origin}' not allowed`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json());

// Health Check
app.get("/", (req, res) => {
  res.send("FlowUp API Running");
});

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/categories", categoryRoutes);
app.use("/api/menu", menuRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/waiter-requests", waiterRequestRoutes);

module.exports = { app, ALLOWED_ORIGINS };