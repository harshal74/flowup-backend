const express     = require("express");
const platformAuth = require("../middleware/platformAuth");
const {
  getLeads,
  getLeadById,
  updateLead,
  deleteLead,
  convertLead,
} = require("../controllers/leads.controller");

const router = express.Router();

// All lead-management endpoints require SUPER_ADMIN authentication.
// A restaurant-level admin must NEVER access FlowUp sales leads.
router.use(platformAuth);

router.get("/",           getLeads);
router.get("/:id",        getLeadById);
router.patch("/:id",      updateLead);
router.delete("/:id",     deleteLead);
router.post("/:id/convert", convertLead);

module.exports = router;
