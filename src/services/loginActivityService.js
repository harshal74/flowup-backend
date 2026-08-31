/**
 * loginActivityService — records login attempts in the LoginActivity collection.
 *
 * All logging is fire-and-forget (never blocks the login response).
 * Errors are swallowed so a logging failure never breaks authentication.
 *
 * SECURITY:
 *   - No password, JWT token, OTP, or any authentication secret is ever stored.
 *   - failureReason uses safe human-readable categories only.
 *   - Submitted email on a failed attempt is stored as `identifier` — it is
 *     the value the user typed, not a secret. This matches audit-log industry
 *     practice (e.g. AWS CloudTrail stores the attempted username).
 */

const LoginActivity = require("../models/LoginActivity");

// ── Lightweight UA parser ──────────────────────────────────────
// No external dependency — uses regex matching against the User-Agent string.
// Returns "Unknown" for any field that cannot be reliably determined.
// Accuracy is sufficient for audit display; not intended for analytics.

/**
 * Detect device type from UA string.
 * @param {string} ua
 * @returns {"Mobile"|"Tablet"|"Desktop"|"Unknown"}
 */
function detectDeviceType(ua) {
  if (!ua) return "Unknown";
  const s = ua.toLowerCase();
  // Tablet check before mobile (iPads match "mobile" in some older UA strings)
  if (/ipad|tablet|kindle|silk|playbook/.test(s)) return "Tablet";
  if (/mobile|android|iphone|ipod|blackberry|iemobile|opera mini|windows phone/.test(s)) return "Mobile";
  if (/mozilla|chrome|safari|firefox|opera|msie|trident|edge/.test(s)) return "Desktop";
  return "Unknown";
}

/**
 * Detect browser name from UA string.
 * @param {string} ua
 * @returns {string}
 */
function detectBrowser(ua) {
  if (!ua) return "Unknown";
  const s = ua.toLowerCase();
  // Order matters — Edge/OPR must come before Chrome/Safari checks
  if (/edg\/|edghtml\//.test(s))             return "Edge";
  if (/opr\/|opios\//.test(s))               return "Opera";
  if (/samsungbrowser/.test(s))              return "Samsung Browser";
  if (/ucbrowser/.test(s))                   return "UC Browser";
  if (/fxios/.test(s))                       return "Firefox";
  if (/firefox\//.test(s))                   return "Firefox";
  if (/chrome\//.test(s) && !/chromium/.test(s)) return "Chrome";
  if (/chromium/.test(s))                    return "Chromium";
  if (/safari\//.test(s) && !/chrome/.test(s))   return "Safari";
  if (/msie |trident\//.test(s))             return "Internet Explorer";
  return "Unknown";
}

/**
 * Detect operating system from UA string.
 * @param {string} ua
 * @returns {string}
 */
function detectOS(ua) {
  if (!ua) return "Unknown";
  const s = ua.toLowerCase();
  if (/windows nt/.test(s))       return "Windows";
  if (/android/.test(s))          return "Android";
  if (/iphone|ipad|ipod/.test(s)) return "iOS";
  if (/mac os x|macintosh/.test(s)) return "macOS";
  if (/linux/.test(s))            return "Linux";
  if (/cros/.test(s))             return "ChromeOS";
  return "Unknown";
}

/**
 * Extract the client IP address from an Express request.
 * The backend sets `trust proxy: 1` so req.ip returns the real IP
 * from the first X-Forwarded-For hop when behind Render/Railway proxy.
 *
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function extractIP(req) {
  if (!req) return null;
  const ip = req.ip || req.connection?.remoteAddress || null;
  if (!ip) return null;
  // Normalize IPv4-mapped IPv6 (::ffff:x.x.x.x → x.x.x.x)
  return ip.replace(/^::ffff:/, "").trim().slice(0, 64) || null;
}

/**
 * Parse user-agent metadata from an Express request.
 * @param {import('express').Request} req
 * @returns {{ userAgent: string|null, deviceType: string, browser: string, operatingSystem: string }}
 */
function parseUA(req) {
  const ua = req?.headers?.["user-agent"] || null;
  if (!ua) {
    return { userAgent: null, deviceType: "Unknown", browser: "Unknown", operatingSystem: "Unknown" };
  }
  const truncated = ua.slice(0, 512); // cap stored length
  return {
    userAgent:       truncated,
    deviceType:      detectDeviceType(ua),
    browser:         detectBrowser(ua),
    operatingSystem: detectOS(ua),
  };
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Record a successful ADMIN or SUPER_ADMIN login.
 * Fire-and-forget — call without await in the login controller.
 *
 * @param {object} admin  - Mongoose Admin document (identity known)
 * @param {object} req    - Express request (for IP + UA)
 * @param {string|null} restaurantName - Denormalized restaurant name (pass null for SUPER_ADMIN)
 */
function recordAdminLogin(admin, req, restaurantName = null) {
  const { userAgent, deviceType, browser, operatingSystem } = parseUA(req);
  LoginActivity.create({
    adminId:        admin._id,
    staffId:        null,
    restaurantId:   admin.role === "SUPER_ADMIN" ? null : admin.restaurantId,
    restaurantName: admin.role === "SUPER_ADMIN" ? null : (restaurantName || admin.restaurantName || null),
    identifier:     admin.email,
    role:           admin.role,
    status:         "SUCCESS",
    failureReason:  null,
    ipAddress:      extractIP(req),
    userAgent,
    deviceType,
    browser,
    operatingSystem,
  }).catch(err => console.error("[LoginActivity] Failed to record admin login:", err.message));
}

/**
 * Record a failed ADMIN/SUPER_ADMIN login attempt.
 * Fire-and-forget.
 *
 * @param {string} submittedEmail - The email the user typed (not a secret — it's an identifier)
 * @param {string} reason         - Safe failure category string
 * @param {string|null} role      - Role if the account was found (null if not found)
 * @param {string|null} restaurantId
 * @param {string|null} restaurantName
 * @param {object} req
 */
function recordAdminLoginFailed(submittedEmail, reason, role, restaurantId, restaurantName, req) {
  const { userAgent, deviceType, browser, operatingSystem } = parseUA(req);
  LoginActivity.create({
    adminId:        null,
    staffId:        null,
    restaurantId:   restaurantId || null,
    restaurantName: restaurantName || null,
    identifier:     submittedEmail ? String(submittedEmail).trim().slice(0, 200) : null,
    role:           role || null,
    status:         "FAILED",
    failureReason:  reason || "Authentication failed",
    ipAddress:      extractIP(req),
    userAgent,
    deviceType,
    browser,
    operatingSystem,
  }).catch(err => console.error("[LoginActivity] Failed to record admin login failure:", err.message));
}

/**
 * Record a successful Staff/Waiter login.
 * Fire-and-forget.
 *
 * @param {object} staff - Mongoose Staff document
 * @param {object} req
 * @param {string|null} restaurantName
 */
function recordStaffLogin(staff, req, restaurantName = null) {
  const { userAgent, deviceType, browser, operatingSystem } = parseUA(req);
  LoginActivity.create({
    adminId:        null,
    staffId:        staff._id,
    restaurantId:   staff.restaurantId,
    restaurantName: restaurantName || null,
    identifier:     staff.email || staff.name || null,
    role:           staff.role,
    status:         "SUCCESS",
    failureReason:  null,
    ipAddress:      extractIP(req),
    userAgent,
    deviceType,
    browser,
    operatingSystem,
  }).catch(err => console.error("[LoginActivity] Failed to record staff login:", err.message));
}

/**
 * Record a failed Staff/Waiter login attempt.
 * Fire-and-forget.
 *
 * @param {string} submittedEmail
 * @param {string} reason
 * @param {string|null} role
 * @param {string|null} restaurantId
 * @param {string|null} restaurantName
 * @param {object} req
 */
function recordStaffLoginFailed(submittedEmail, reason, role, restaurantId, restaurantName, req) {
  const { userAgent, deviceType, browser, operatingSystem } = parseUA(req);
  LoginActivity.create({
    adminId:        null,
    staffId:        null,
    restaurantId:   restaurantId || null,
    restaurantName: restaurantName || null,
    identifier:     submittedEmail ? String(submittedEmail).trim().slice(0, 200) : null,
    role:           role || null,
    status:         "FAILED",
    failureReason:  reason || "Authentication failed",
    ipAddress:      extractIP(req),
    userAgent,
    deviceType,
    browser,
    operatingSystem,
  }).catch(err => console.error("[LoginActivity] Failed to record staff login failure:", err.message));
}

module.exports = {
  recordAdminLogin,
  recordAdminLoginFailed,
  recordStaffLogin,
  recordStaffLoginFailed,
};
