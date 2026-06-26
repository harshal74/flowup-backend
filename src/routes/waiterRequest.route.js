const express = require("express");
const {
  createWaiterRequest,
  getWaiterRequests,
  updateWaiterRequestStatus,
  deleteWaiterRequest,
  deleteAllWaiterRequests,
} = require("../controllers/waiterRequest.controller");
const protect = require("../middleware/auth.middleware");

const router = express.Router();

router.post("/",   createWaiterRequest);                        // public — customer
router.get("/",    protect, getWaiterRequests);                 // admin — load all
router.patch("/:id/status", protect, updateWaiterRequestStatus); // admin — update status
router.delete("/all", protect, deleteAllWaiterRequests);        // admin — clear all
router.delete("/:id",  protect, deleteWaiterRequest);           // admin — dismiss one

module.exports = router;
