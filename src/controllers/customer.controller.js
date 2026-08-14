const Customer = require("../models/Customer");
const Order = require("../models/Order");

// Get All Customers
// Uses aggregation to join Order collection and attach
// each customer's distinct orderTypes in a single DB query.
const getCustomers = async (req, res) => {
  try {
    const restaurantId = req.user.restaurantId;

    const customers = await Customer.aggregate([
      // 1. Only this restaurant's customers
      { $match: { restaurantId } },

      // 2. Join orders for each customer
      {
        $lookup: {
          from: "orders",
          localField: "_id",
          foreignField: "customerId",
          as: "orders",
          pipeline: [
            { $project: { orderType: 1, _id: 0 } },
          ],
        },
      },

      // 3. Derive distinct orderTypes array from joined orders
      {
        $addFields: {
          orderTypes: {
            $setUnion: ["$orders.orderType", []],
          },
        },
      },

      // 4. Drop the full orders array — we only needed it for the types
      { $project: { orders: 0 } },

      // 5. Latest first
      { $sort: { createdAt: -1 } },
    ]);

    return res.status(200).json({
      success: true,
      count: customers.length,
      data: customers,
    });
  } catch (error) {
    console.error("Get Customers Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// Get Customer By Id — BUG A FIX: scope by restaurantId
const getCustomerById = async (req, res) => {
  try {
    const { id } = req.params;
    const restaurantId = req.user.restaurantId;

    const customer = await Customer.findOne({ _id: id, restaurantId });

    if (!customer) {
      return res.status(404).json({ success: false, message: "Customer not found" });
    }

    return res.status(200).json({ success: true, data: customer });
  } catch (error) {
    console.error("Get Customer Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// Get Customer Orders — BUG A FIX: scope orders to restaurant
const getCustomerOrders = async (req, res) => {
  try {
    const { id } = req.params;
    const restaurantId = req.user.restaurantId;

    // Verify customer belongs to this restaurant first
    const customer = await Customer.findOne({ _id: id, restaurantId });
    if (!customer) {
      return res.status(404).json({ success: false, message: "Customer not found" });
    }

    const orders = await Order.find({ customerId: id, restaurantId }).sort({ createdAt: -1 });

    return res.status(200).json({ success: true, count: orders.length, data: orders });
  } catch (error) {
    console.error("Customer Orders Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// Block Customer — BUG B FIX: scope by restaurantId
const blockCustomer = async (req, res) => {
  try {
    const { id } = req.params;
    const restaurantId = req.user.restaurantId;

    const customer = await Customer.findOne({ _id: id, restaurantId });
    if (!customer) {
      return res.status(404).json({ success: false, message: "Customer not found" });
    }

    customer.isBlocked = true;
    await customer.save();

    return res.status(200).json({ success: true, message: "Customer blocked successfully", data: customer });
  } catch (error) {
    console.error("Block Customer Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

// Unblock Customer — BUG B FIX: scope by restaurantId
const unblockCustomer = async (req, res) => {
  try {
    const { id } = req.params;
    const restaurantId = req.user.restaurantId;

    const customer = await Customer.findOne({ _id: id, restaurantId });
    if (!customer) {
      return res.status(404).json({ success: false, message: "Customer not found" });
    }

    customer.isBlocked = false;
    await customer.save();

    return res.status(200).json({ success: true, message: "Customer unblocked successfully", data: customer });
  } catch (error) {
    console.error("Unblock Customer Error:", error);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
};

module.exports = {
  getCustomers,
  getCustomerById,
  getCustomerOrders,
  blockCustomer,
  unblockCustomer,
};