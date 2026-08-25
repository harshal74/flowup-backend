const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const Setting = require("./models/Setting");

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
    "http://localhost:5176",  // waiter frontend dev port
    "http://localhost:5177",  // platform frontend dev port
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

  io.on("connection", async (socket) => {
    // ── Authentication check ─────────────────────────────────────
    // SECURITY: The room a socket joins is derived ONLY from the verified
    // JWT — never from the client-supplied query param. The query param is
    // treated as an untrusted hint and must match the token, but it is never
    // used as the room key. This makes it impossible for a client to join
    // another restaurant's room by manipulating the query string, and it
    // fails CLOSED if the token lacks a restaurantId claim.
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;

    if (!token) {
      socket.emit("error", { message: "Authentication required" });
      socket.disconnect(true);
      return;
    }

    let restaurantId;
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const tokenRestaurantId = decoded.restaurantId;

      // Fail closed: a token with no restaurantId claim cannot join any room.
      if (!tokenRestaurantId) {
        socket.emit("error", { message: "Token missing restaurant context" });
        socket.disconnect(true);
        return;
      }

      // If the client sent a restaurantId hint, it MUST match the token.
      const requestedRestaurantId = socket.handshake.query.restaurantId;
      if (requestedRestaurantId && requestedRestaurantId !== tokenRestaurantId) {
        socket.emit("error", { message: "Restaurant mismatch" });
        socket.disconnect(true);
        return;
      }

      // The room is the TRUSTED value from the token, not the query param.
      restaurantId = tokenRestaurantId;
    } catch {
      socket.emit("error", { message: "Invalid or expired token" });
      socket.disconnect(true);
      return;
    }

    // ── Restaurant suspension check ──────────────────────────────
    // Block connections to suspended restaurants.
    // PLATFORM restaurantId is exempt (SUPER_ADMIN identity).
    if (restaurantId !== "PLATFORM") {
      try {
        const settings = await Setting.findOne({ restaurantId })
          .select("accountStatus")
          .lean();

        if (settings?.accountStatus === "SUSPENDED") {
          socket.emit("error", { message: "Restaurant is suspended" });
          socket.disconnect(true);
          return;
        }
      } catch {
        // DB error — allow connection (fail-open for real-time, REST enforces on each request)
      }
    }

    socket.join(restaurantId);

    socket.on("disconnect", () => {
      // disconnect logged at debug level only
    });
  });

  console.log("[Socket] Socket.IO initialised");
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

/**
 * Disconnect all sockets in a restaurant's room.
 * Called when SUPER_ADMIN suspends a restaurant.
 */
async function disconnectRestaurant(restaurantId) {
  if (!io) return;

  const sockets = await io.in(restaurantId).fetchSockets();
  for (const s of sockets) {
    s.emit("restaurant_suspended", { message: "Your restaurant has been suspended." });
    s.disconnect(true);
  }

  if (sockets.length > 0) {
    console.log(`[Socket] Disconnected ${sockets.length} socket(s) for suspended restaurant: ${restaurantId}`);
  }
}

module.exports = { initSocket, emitToRestaurant, disconnectRestaurant };
