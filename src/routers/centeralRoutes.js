// src/routes/centralRoutes.js
const express = require("express");
const router = express.Router();

// Import all module routes
const authRoutes = require("./authRoutes")
const subscriptionRoutes = require("./subscriptionRoutes")
const organizationRoutes = require("./organizationRoutes")
const venueRoutes = require("./venueRoutes")
const userRoutes = require("./userRoutes")
const adminDashboardRoutes = require("./adminDashboardRoutes");
const brandRoutes = require("./brandRoutes");
const authenticate = require("../middlewares/auth");

// Mount all routes with proper prefixes
router.use("/auth", authRoutes);
router.use("/subscription", subscriptionRoutes);
router.use("/organization", organizationRoutes);
router.use("/venue", venueRoutes);
router.use("/user", userRoutes);
router.use("/dashboard", authenticate, adminDashboardRoutes);
router.use("/brand", brandRoutes);

// Health check route
router.get("/health", (req, res) => {
    res.status(200).json({
        success: true,
        message: "Hellow FaRaZ your IOTFIY-ACKIT Backend",
        timestamp: new Date().toISOString()
    });
});

module.exports = router;