/**
 * Order tracking tokens.
 *
 * A tracking token proves "I placed this order". It is an HMAC of the order's
 * _id under a key derived from JWT_SECRET, so nothing new is stored on the
 * order and the same token can be recomputed for idempotent retries.
 *
 * The token is returned ONLY in the response to the customer who created the
 * order. It is never stored, logged, emitted over sockets, or included in
 * admin/staff APIs. Anyone without it gets a 404 from the public status API,
 * so guessing or editing an order number in the URL reveals nothing.
 */

const crypto = require("crypto");

const tokenKey = () =>
  crypto.createHash("sha256").update(`${process.env.JWT_SECRET}:order-tracking:v1`).digest();

function trackingTokenFor(order) {
  return crypto.createHmac("sha256", tokenKey()).update(String(order._id)).digest("base64url");
}

function verifyTrackingToken(order, token) {
  if (!order || typeof token !== "string" || !token) return false;
  const expected = Buffer.from(trackingTokenFor(order));
  const given = Buffer.from(token);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** Plain copy of an order document with its tracking token attached. */
function withTrackingToken(order) {
  if (!order) return order;
  const plain = typeof order.toObject === "function" ? order.toObject() : { ...order };
  plain.trackingToken = trackingTokenFor(order);
  return plain;
}

module.exports = { trackingTokenFor, verifyTrackingToken, withTrackingToken };
