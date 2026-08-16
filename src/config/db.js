const mongoose = require("mongoose");

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      // Connection pool — handles concurrent requests efficiently
      maxPoolSize: 20,
      minPoolSize: 5,
      // Timeout settings for production reliability
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
      // Buffering: reject operations immediately if disconnected
      bufferCommands: false,
    });
    console.log("✅ MongoDB Connected");

    // Reconnection logging
    mongoose.connection.on("disconnected", () => {
      console.warn("⚠️  MongoDB disconnected — Mongoose will attempt reconnect");
    });
    mongoose.connection.on("reconnected", () => {
      console.log("✅ MongoDB reconnected");
    });
    mongoose.connection.on("error", (err) => {
      console.error("❌ MongoDB connection error:", err.message);
    });
  } catch (error) {
    console.error("❌ Database Connection Failed:", error.message);
    process.exit(1);
  }
};

module.exports = connectDB;
