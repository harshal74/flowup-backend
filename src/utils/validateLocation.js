/**
 * Validates deliveryLocation for delivery orders.
 * Returns { valid: true, lat, lng } or { valid: false, message }.
 */
function validateDeliveryLocation(deliveryLocation) {
  if (!deliveryLocation || typeof deliveryLocation !== "object") {
    return { valid: false, message: "Live location is required for delivery orders." };
  }

  const lat = Number(deliveryLocation.latitude);
  const lng = Number(deliveryLocation.longitude);

  if (isNaN(lat) || isNaN(lng)) {
    return { valid: false, message: "Invalid location coordinates." };
  }

  if (!isFinite(lat) || !isFinite(lng)) {
    return { valid: false, message: "Invalid location coordinates." };
  }

  if (lat < -90 || lat > 90) {
    return { valid: false, message: "Latitude must be between -90 and 90." };
  }

  if (lng < -180 || lng > 180) {
    return { valid: false, message: "Longitude must be between -180 and 180." };
  }

  return { valid: true, lat, lng };
}

module.exports = { validateDeliveryLocation };
