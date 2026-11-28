/**
 * Loyalty points — admin only.
 *   POST /api/loyalty/earn                    (called after order settlement)
 *   GET  /api/loyalty                         (all customers' balances)
 *   GET  /api/loyalty/:customerId             (one customer's balance + history)
 *   POST /api/loyalty/:customerId/redeem       (redeem points as discount)
 */

const express = require("express");
const protect = require("../middleware/auth.middleware");
const { earnPoints, getCustomerPoints, redeemPoints, listAll } = require("../controllers/loyalty.controller");

const router = express.Router();
router.use(protect);

router.post("/earn", earnPoints);
router.get("/", listAll);
router.get("/:customerId", getCustomerPoints);
router.post("/:customerId/redeem", redeemPoints);

module.exports = router;
