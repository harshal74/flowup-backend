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
const billingRoutes = require("./routes/billing.route");
const staffRoutes   = require("./routes/staffRoutes");
const adminStaffRoutes = require("./routes/adminStaff.route");

const app = express();

// Trust the first proxy hop (Render/Railway reverse proxy).
// This makes req.ip return the real client IP from X-Forwarded-For
// instead of the proxy's internal IP.
app.set("trust proxy", 1);

// Allowed origins — covers dev ports + production Netlify/Railway domains.
// Set ADMIN_ORIGIN and CUSTOMER_ORIGIN on Railway for production.
const ALLOWED_ORIGINS = [
  process.env.ADMIN_ORIGIN,
  process.env.CUSTOMER_ORIGIN,
  process.env.WAITER_ORIGIN,
  // Development
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
  "http://localhost:5176",   // waiter frontend
  "http://localhost:3000",
].filter(Boolean);

// Global Middleware
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (curl, Postman, mobile apps, server-to-server)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    // Allow any *.netlify.app subdomain automatically so preview deploys work
    if (/\.netlify\.app$/.test(origin)) return callback(null, true);
    // Allow any *.up.railway.app subdomain
    if (/\.up\.railway\.app$/.test(origin)) return callback(null, true);
    // Allow any *.onrender.com subdomain
    if (/\.onrender\.com$/.test(origin)) return callback(null, true);
    callback(new Error(`CORS: origin '${origin}' not allowed`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

app.use(express.json({ limit: "2mb" }));

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
app.use("/api/billing", billingRoutes);
app.use("/api/staff",   staffRoutes);
app.use("/api/admin/staff", adminStaffRoutes);

// ── 404 handler for unknown API routes ────────────────────────────
app.use("/api/{*path}", (req, res) => {
  res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` });
});

// ── Global error handler ──────────────────────────────────────────
app.use((err, req, res, _next) => {
  // CORS errors from the origin callback
  if (err.message && err.message.startsWith("CORS:")) {
    return res.status(403).json({ success: false, message: err.message });
  }
  console.error("[Global Error]", err.message || err);
  res.status(500).json({ success: false, message: "Internal server error" });
});

module.exports = { app, ALLOWED_ORIGINS };