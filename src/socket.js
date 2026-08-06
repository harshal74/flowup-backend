const { Server } = require("socket.io");

let io = null;

/**
 * Initialise Socket.IO on the given HTTP server.
 * Uses the same origin-matching logic as Express CORS so both
 * REST requests and WebSocket connections are treated identically.
 */
function initSocket(httpServer, allowedOrigins) {
  const staticOrigins = [...(allowedOrigins || []),
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:5175",
    "http://localhost:3000",
  ].filter(Boolean);

  io = new Server(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (staticOrigins.includes(origin)) return callback(null, true);
        if (/\.netlify\.app$/.test(origin)) return callback(null, true);
        if (/\.up\.railway\.app$/.test(origin)) return callback(null, true);
        if (/\.onrender\.com$/.test(origin)) return callback(null, true);
        callback(new Error(`Socket CORS: origin '${origin}' not allowed`));
      },
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  io.on("connection", (socket) => {
    const restaurantId = socket.handshake.query.restaurantId;

    if (!restaurantId) {
      socket.emit("error", { message: "restaurantId is required" });
      socket.disconnect(true);
      return;
    }

    socket.join(restaurantId);
    console.log(`[Socket] Connected: ${socket.id}  restaurant: ${restaurantId}`);

    socket.on("disconnect", () => {
      console.log(`[Socket] Disconnected: ${socket.id}  restaurant: ${restaurantId}`);
    });
  });

  console.log("[Socket] Socket.IO server initialised");
  return io;
}

/**
 * Broadcast an event to every socket in a restaurant's room.
 */
function emitToRestaurant(restaurantId, eventName, payload) {
  if (!io) {
    console.warn(`[Socket] emitToRestaurant called before init — '${eventName}' dropped`);
    return;
  }
  io.to(restaurantId).emit(eventName, payload);
}

module.exports = { initSocket, emitToRestaurant };
