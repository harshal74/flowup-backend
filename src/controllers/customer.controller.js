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

// Get Customer By Id
const getCustomerById = async (req, res) => {
  try {
    const { id } = req.params;

    const customer = await Customer.findById(id);

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "Customer not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: customer,
    });
  } catch (error) {
    console.error("Get Customer Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// Get Customer Orders
const getCustomerOrders = async (req, res) => {
  try {
    const { id } = req.params;

    const orders = await Order.find({
      customerId: id,
    }).sort({
      createdAt: -1,
    });

    return res.status(200).json({
      success: true,
      count: orders.length,
      data: orders,
    });
  } catch (error) {
    console.error("Customer Orders Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// Block Customer
const blockCustomer = async (req, res) => {
  try {
    const { id } = req.params;

    const customer = await Customer.findById(id);

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "Customer not found",
      });
    }

    customer.isBlocked = true;

    await customer.save();

    return res.status(200).json({
      success: true,
      message: "Customer blocked successfully",
      data: customer,
    });
  } catch (error) {
    console.error("Block Customer Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

// Unblock Customer
const unblockCustomer = async (req, res) => {
  try {
    const { id } = req.params;

    const customer = await Customer.findById(id);

    if (!customer) {
      return res.status(404).json({
        success: false,
        message: "Customer not found",
      });
    }

    customer.isBlocked = false;

    await customer.save();

    return res.status(200).json({
      success: true,
      message: "Customer unblocked successfully",
      data: customer,
    });
  } catch (error) {
    console.error("Unblock Customer Error:", error);

    return res.status(500).json({
      success: false,
      message: "Internal server error",
    });
  }
};

module.exports = {
  getCustomers,
  getCustomerById,
  getCustomerOrders,
  blockCustomer,
  unblockCustomer,
};