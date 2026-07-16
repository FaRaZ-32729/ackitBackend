// src/modules/users/userController.js
const User = require("../models/userModel");
const Organization = require("../models/organizationModel");
const Venue = require("../models/venueModel");
const Device = require("../models/deviceModel");
const SubscriptionPlan = require("../models/subscriptionPlanModel");
const Subscription = require("../models/subscriptionModel");
const mongoose = require("mongoose")


// ==================== FRONTEND WALA NAMUNA KI FARMISHI APIS ====================

// GET /admin/managers/stats
const getManagersStats = async (req, res) => {
    try {
        const managers = await User.find({ role: "manager" })
            .select("name email isActive currentSubscription createdAt")
            .populate({
                path: "currentSubscription",
                populate: { path: "plan", select: "name type price durationDays maxOrganizations maxVenues maxDevices maxUsers" }
            })
            .lean();

        let totalManagers = managers.length;
        let activeManagers = 0;
        let inactiveManagers = 0;

        const result = await Promise.all(managers.map(async (manager) => {
            if (manager.isActive) activeManagers++;
            else inactiveManagers++;

            // Organizations by ownerId (as you requested)
            const organizations = await Organization.find({ owner: manager._id })
                .select("name")
                .lean();

            const orgStats = await Promise.all(organizations.map(async (org) => {
                const venues = await Venue.find({ organization: org._id }).select("_id name");
                const venueIds = venues.map(v => v._id);

                const devicesCount = await Device.countDocuments({ venue: { $in: venueIds } });

                return {
                    id: org._id,
                    name: org.name,
                    venuesCount: venues.length,
                    devicesCount
                };
            }));

            const totalOrganizations = organizations.length;
            const totalVenues = orgStats.reduce((sum, org) => sum + org.venuesCount, 0);
            const totalDevices = orgStats.reduce((sum, org) => sum + org.devicesCount, 0);

            // Users created by this manager
            const totalUsersCreated = await User.countDocuments({
                creatorId: manager._id,
                role: "user"
            });

            return {
                id: manager._id,
                name: manager.name,
                email: manager.email,
                isActive: manager.isActive,
                createdAt: manager.createdAt,
                plan: manager.currentSubscription?.plan || null,
                organizationsCount: totalOrganizations,
                organizations: orgStats,
                totalUsersCreated,
                totalVenues,
                totalDevices
            };
        }));

        res.status(200).json({
            success: true,
            totalManagers,
            activeManagers,
            inactiveManagers,
            managers: result
        });

    } catch (error) {
        console.error("Get Managers Stats Error:", error);
        res.status(500).json({
            success: false,
            message: "Server error while fetching managers statistics"
        });
    }
};

// src/controllers/adminController.js  (or userController.js)
const getManagerFullDetails = async (req, res) => {
    try {
        const { managerId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(managerId)) {
            return res.status(400).json({ success: false, message: "Invalid Manager ID" });
        }

        // ==================== 1. MANAGER DETAILS ====================
        const manager = await User.findById(managerId)
            .select("name email isActive createdAt currentSubscription")
            .populate("currentSubscription", "plan status")
            .lean();

        if (!manager) {
            return res.status(404).json({ success: false, message: "Manager not found" });
        }

        // ==================== 2. SUB-USERS (Created by this Manager) ====================
        const subUsers = await User.find({
            creatorId: managerId,
            role: "user"
        })
            .select("name email isActive permission venues")
            .lean();

        // Calculate device count for each sub-user
        const subUsersWithStats = await Promise.all(subUsers.map(async (user) => {
            const venueIds = user.venues ? user.venues.map(v => v.venueId) : [];
            const devicesCount = venueIds.length > 0
                ? await Device.countDocuments({ venue: { $in: venueIds } })
                : 0;

            const totalAssignedOrganizations = user.organizations ? user.organizations.length : 0;

            return {
                id: user._id,
                name: user.name,
                email: user.email,
                isActive: user.isActive,
                permission: user.permission,
                totalAssignedOrganizations,
                totalAssignedVenues: venueIds.length,
                totalDevices: devicesCount

            };
        }));

        // ==================== 3. ORGANIZATIONS (Owned by Manager) ====================
        const organizations = await Organization.find({ owner: managerId })
            .select("name")
            .lean();

        const orgStats = await Promise.all(organizations.map(async (org) => {
            const venues = await Venue.find({ organization: org._id })
                .select("name")
                .lean();

            const venueIds = venues.map(v => v._id);
            const devicesCount = await Device.countDocuments({ venue: { $in: venueIds } });

            return {
                id: org._id,
                name: org.name,
                totalVenues: venues.length,
                totalDevices: devicesCount,
                venues: venues.map(v => ({ id: v._id, name: v.name }))
            };
        }));

        // ==================== 4. VENUES (All venues under manager's organizations) ====================
        const allVenues = await Venue.find({
            organization: { $in: organizations.map(o => o._id) }
        })
            .populate("organization", "name")
            .lean();

        const venueStats = await Promise.all(allVenues.map(async (venue) => {
            const devicesCount = await Device.countDocuments({ venue: venue._id });

            return {
                id: venue._id,
                name: venue.name,
                organization: venue.organization?.name || "N/A",
                totalDevices: devicesCount
            };
        }));

        // ==================== 5. DEVICES (All devices under manager) ====================
        const devices = await Device.find({
            venue: { $in: allVenues.map(v => v._id) }
        })
            .select("deviceId deviceName deviceType category status state venue")
            .populate("venue", "name")
            .lean();

        const deviceStats = devices.map(d => ({
            deviceId: d.deviceId,
            deviceName: d.deviceName,
            deviceType: d.deviceType,
            category: d.category,
            status: d.status,
            state: d.state,
            venueName: d.venue?.name || "N/A"
        }));

        res.status(200).json({
            success: true,
            manager: {
                id: manager._id,
                name: manager.name,
                email: manager.email,
                isActive: manager.isActive,
                plan: manager.currentSubscription?.plan || null
            },
            totalUsers: {
                total: subUsersWithStats.length,
                users: subUsersWithStats
            },
            totalOrganizations: {
                total: orgStats.length,
                organizations: orgStats
            },
            totalVenues: {
                total: venueStats.length,
                venues: venueStats
            },
            totalDevices: {
                total: deviceStats.length,
                devices: deviceStats
            }
        });

    } catch (error) {
        console.error("Get Manager Full Details Error:", error);
        res.status(500).json({
            success: false,
            message: "Server error while fetching manager details"
        });
    }
};

// src/controllers/userController.js  (or adminController.js)
const getSubUserDetails = async (req, res) => {
    try {
        const { userId } = req.params;

        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return res.status(400).json({ success: false, message: "Invalid User ID" });
        }

        // ==================== FETCH USER ====================
        const user = await User.findById(userId)
            .select("name email isActive permission organizations venues")
            .lean();

        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        // if (user.role !== "user") {
        //     return res.status(400).json({ success: false, message: "This API is only for sub-users (role: user)" });
        // }

        // ==================== ASSIGNED ORGANIZATIONS ====================
        const totalAssignedOrganizations = user.organizations ? user.organizations.length : 0;

        // ==================== ASSIGNED VENUES ====================
        const venueIds = user.venues ? user.venues.map(v => v.venueId) : [];
        const totalAssignedVenues = venueIds.length;

        // ==================== DEVICES IN ASSIGNED VENUES ====================
        const devices = await Device.find({
            venue: { $in: venueIds }
        })
            .select("deviceId deviceName deviceType category status state")
            .populate("venue", "name")
            .lean();

        const totalDevices = devices.length;

        // Format devices nicely
        const deviceList = devices.map(d => ({
            deviceId: d.deviceId,
            deviceName: d.deviceName,
            deviceType: d.deviceType,
            category: d.category,
            status: d.status,
            state: d.state,
            venueName: d.venue?.name || "N/A"
        }));

        res.status(200).json({
            success: true,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                isActive: user.isActive,
                permission: user.permission,
                totalAssignedOrganizations,
                totalAssignedVenues,
                totalDevices
            },
            devices: {
                total: totalDevices,
                list: deviceList
            }
        });

    } catch (error) {
        console.error("Get Sub-User Details Error:", error);
        res.status(500).json({
            success: false,
            message: "Server error while fetching user details"
        });
    }
};

// src/controllers/organizationController.js
const getAllOrganizations = async (req, res) => {
    try {
        const organizations = await Organization.find()
            .populate("owner", "name email")   // Get owner details
            .lean();

        if (organizations.length === 0) {
            return res.status(200).json({
                success: true,
                total: 0,
                organizations: []
            });
        }

        // Enrich each organization with venue & device counts
        const enrichedOrgs = await Promise.all(organizations.map(async (org) => {
            // Get all venues in this organization
            const venues = await Venue.find({ organization: org._id })
                .select("_id name")
                .lean();

            const venueIds = venues.map(v => v._id);

            // Get total devices in all these venues
            const totalDevices = venueIds.length > 0
                ? await Device.countDocuments({ venue: { $in: venueIds } })
                : 0;

            return {
                id: org._id,
                name: org.name,
                owner: {
                    id: org.owner?._id,
                    name: org.owner?.name || "N/A",
                    email: org.owner?.email || "N/A"
                },
                totalVenues: venues.length,
                totalDevices: totalDevices,
                // venues: venues.map(v => ({
                //     id: v._id,
                //     name: v.name
                // }))
            };
        }));

        res.status(200).json({
            success: true,
            total: enrichedOrgs.length,
            organizations: enrichedOrgs
        });

    } catch (error) {
        console.error("Get All Organizations Error:", error);
        res.status(500).json({
            success: false,
            message: "Server error while fetching organizations"
        });
    }
};

// src/controllers/venueController.js
const getAllVenues = async (req, res) => {
    try {
        const venues = await Venue.find()
            .populate("organization", "name")   // Get organization name
            .lean();

        if (venues.length === 0) {
            return res.status(200).json({
                success: true,
                total: 0,
                venues: []
            });
        }

        // Add device count for each venue
        const enrichedVenues = await Promise.all(venues.map(async (venue) => {
            const totalDevices = await Device.countDocuments({
                venue: venue._id
            });

            return {
                id: venue._id,
                name: venue.name,
                organization: {
                    id: venue.organization?._id,
                    name: venue.organization?.name || "N/A"
                },
                totalDevices: totalDevices
            };
        }));

        res.status(200).json({
            success: true,
            total: enrichedVenues.length,
            venues: enrichedVenues
        });

    } catch (error) {
        console.error("Get All Venues Error:", error);
        res.status(500).json({
            success: false,
            message: "Server error while fetching venues"
        });
    }
};

// src/controllers/deviceController.js
const getAllDevices = async (req, res) => {
    try {
        const devices = await Device.find()
            .select("deviceId deviceName deviceType category status state venue")
            .populate("venue", "name")           // Get venue name
            .lean();

        if (devices.length === 0) {
            return res.status(200).json({
                success: true,
                total: 0,
                devices: []
            });
        }

        const formattedDevices = devices.map(device => ({
            deviceId: device.deviceId,
            deviceName: device.deviceName,
            deviceType: device.deviceType,
            category: device.category,
            status: device.status,
            state: device.state,
            venueName: device.venue?.name || "N/A"
        }));

        res.status(200).json({
            success: true,
            total: formattedDevices.length,
            devices: formattedDevices
        });

    } catch (error) {
        console.error("Get All Devices Error:", error);
        res.status(500).json({
            success: false,
            message: "Server error while fetching devices"
        });
    }
};




module.exports = { getManagersStats, getManagerFullDetails, getSubUserDetails, getAllOrganizations, getAllVenues, getAllDevices };