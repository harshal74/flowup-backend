const express = require("express");
const cors = require("cors");

const authRoutes = require("./routes/auth.route");
const categoryRoutes = require("./routes/category.route");
const menuRoutes = require("./routes/menu.route");
const orderRoutes = require("./routes/order.route");
const customerRoutes = require("./routes/customer.route");
const dashboardRoutes = require("./routes/dashboard.route");
const settingsRoutes = require("./routes/settings.route");

const app = express();

// Global Middleware
app.use(cors());
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

module.exports = app;