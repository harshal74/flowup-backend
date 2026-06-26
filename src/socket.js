const { Server } = require("socket.io");

let io = null;

/**
 * Initialise Socket.IO on the given HTTP server.
 * @param {import('http').Server} httpServer
 * @param {string[]} allowedOrigins  — same list used by Express CORS
 */
function initSocket(httpServer, allowedOrigins) {
  const origins = allowedOrigins || [
    process.env.ADMIN_ORIGIN    || "http://localhost:5173",
    process.env.CUSTOMER_ORIGIN || "http://localhost:5174",
  ];

  io = new Server(httpServer, {
    cors: {
      origin: origins,
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  io.on("connection", (socket) => {
    // Every client must supply restaurantId in handshake query
    const restaurantId = socket.handshake.query.restaurantId;

    if (!restaurantId) {
      socket.emit("error", { message: "restaurantId is required" });
      socket.disconnect(true);
      return;
    }

    // Join the room for this restaurant — ensures tenant isolation
    socket.join(restaurantId);

    console.log(
      `[Socket] Connected: ${socket.id}  restaurant: ${restaurantId}`
    );

    socket.on("disconnect", () => {
      console.log(
        `[Socket] Disconnected: ${socket.id}  restaurant: ${restaurantId}`
      );
    });
  });

  console.log("[Socket] Socket.IO server initialised");
  return io;
}

/**
 * Broadcast an event to every socket in a restaurant's room.
 * Safe to call before initSocket — logs a warning and returns
 * gracefully if the server hasn't been initialised yet.
 */
function emitToRestaurant(restaurantId, eventName, payload) {
  if (!io) {
    console.warn(
      `[Socket] emitToRestaurant called before init — event '${eventName}' dropped`
    );
    return;
  }
  io.to(restaurantId).emit(eventName, payload);
}

module.exports = { initSocket, emitToRestaurant };
