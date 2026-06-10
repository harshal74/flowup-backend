const express = require("express");

const {
  getCustomers,
  getCustomerById,
  getCustomerOrders,
  blockCustomer,
  unblockCustomer,
} = require("../controllers/customer.controller");

const protect = require("../middleware/auth.middleware");

const router = express.Router();

router.get("/", protect, getCustomers);

router.get("/:id", protect, getCustomerById);

router.get(
  "/:id/orders",
  protect,
  getCustomerOrders
);

router.patch(
  "/:id/block",
  protect,
  blockCustomer
);

router.patch(
  "/:id/unblock",
  protect,
  unblockCustomer
);

module.exports = router;