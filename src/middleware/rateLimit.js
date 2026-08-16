/**
 * Lightweight in-memory rate limiter middleware.
 *
 * Suitable for single-instance deployments (Render free/starter tier).
 * NOT suitable for multi-instance horizontal scaling — use Redis-backed
 * (e.g., express-rate-limit + rate-limit-redis) for that.
 *
 * This does NOT provide DDoS protection. It protects against:
 * - Brute-force login attacks
 * - Accidental double-submissions
 * - Automated scrapers/bots hitting public endpoints
 *
 * Usage:
 *   const { rateLimit } = require("../middleware/rateLimit");
 *   router.post("/login", rateLimit({ windowMs: 60000, max: 7 }), ctrl.login);
 *
 *   // Custom key (e.g., IP + customer mobile for order endpoint):
 *   router.post("/orders", rateLimit({
 *     windowMs: 60000,
 *     max: 3,
 *     keyGenerator: (req) => `${req.ip}:${req.body?.customer?.mobile || "anon"}`,
 *   }), ctrl.createOrder);
 */

const store = new Map(); // key → { count, resetAt }

// Cleanup expired entries every 5 minutes to prevent unbounded memory growth.
// .unref() ensures this timer does not block graceful process shutdown.
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now >= entry.resetAt) store.delete(key);
  }
}, 5 * 60 * 1000);
cleanupTimer.unref();

/**
 * Create a rate-limit middleware.
 *
 * @param {object} options
 * @param {number} options.windowMs       - Time window in ms (default: 60000 = 1 min)
 * @param {number} options.max            - Max requests per window per key (default: 10)
 * @param {string} [options.message]      - Error message when limit exceeded
 * @param {(req) => string} [options.keyGenerator] - Custom key function (default: req.ip)
 */
function rateLimit({ windowMs = 60000, max = 10, message, keyGenerator } = {}) {
  const msg = message || "Too many requests. Please try again later.";

  return (req, res, next) => {
    // Derive the rate-limit key.
    // req.ip is set correctly when trust proxy is configured (app.set("trust proxy", 1)).
    const key = keyGenerator
      ? keyGenerator(req)
      : req.ip || "unknown";

    const now = Date.now();
    let entry = store.get(key);

    if (!entry || now >= entry.resetAt) {
      entry = { count: 1, resetAt: now + windowMs };
      store.set(key, entry);
      return next();
    }

    entry.count += 1;

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({ success: false, message: msg });
    }

    next();
  };
}

module.exports = { rateLimit };
