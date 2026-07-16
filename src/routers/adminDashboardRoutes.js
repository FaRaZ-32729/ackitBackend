// src/modules/authRoutes.js
const express = require("express");
const authenticate = require("../middlewares/auth");
const roleGuard = require("../middlewares/roleGuard");
const { getManagersStats, getManagerFullDetails, getSubUserDetails, getAllOrganizations, getAllVenues, getAllDevices } = require("../controllers/adminDashboardController");
const router = express.Router();

// ==================== FRONTEND WALA NAMUNA KI FARMISHI APIS ====================
router.get("/all-managers", roleGuard(["admin"]), getManagersStats);
router.get("/managerDetails/:managerId", roleGuard(["admin"]), getManagerFullDetails);
router.get("/userDetails/:userId", roleGuard(["admin"]), getSubUserDetails);
router.get("/all-orgWithDetails", roleGuard(["admin"]), getAllOrganizations);
router.get("/all-venueWithDevices", roleGuard(["admin"]), getAllVenues);
router.get("/all-devices", roleGuard(["admin"]), getAllDevices);


module.exports = router;