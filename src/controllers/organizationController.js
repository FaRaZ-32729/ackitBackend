// src/controllers/organizationController.js
const Organization = require("../models/organizationModel");
const { createOrganizationSchema } = require("../validations/organizationValidation");
const checkSubscriptionLimit = require("../middlewares/subscriptionLimit");
const User = require("../models/userModel");
const Venue = require("../models/venueModel");
const Device = require("../models/deviceModel");


const createOrganization = async (req, res) => {
    try {
        const validatedData = createOrganizationSchema.parse(req.body);
        const user = req.user;

        if (user.role !== "admin") {
            await checkSubscriptionLimit("organization")(req, res, () => {
            });
            if (res.headersSent) return;
        }

        // Check duplicate organization name for THIS user only
        const existingOrg = await Organization.findOne({
            name: { $regex: new RegExp(`^${validatedData.name}$`, 'i') },
            owner: user._id
        });

        if (existingOrg) {
            return res.status(400).json({
                success: false,
                message: "You already have an organization with this name"
            });
        }

        // Create Organization
        const organization = await Organization.create({
            name: validatedData.name,
            owner: user._id,
        });

        // Add to user's organizations
        await User.findByIdAndUpdate(user._id, {
            $push: { organizations: organization._id },
        });

        res.status(201).json({
            success: true,
            message: "Organization created successfully",
            organization
        });

    } catch (error) {
        if (error.name === "ZodError") {
            return res.status(400).json({
                success: false,
                errors: error.issues.map(err => ({
                    field: err.path[0],
                    message: err.message
                }))
            });
        }

        console.error("Create Organization Error:", error);
        res.status(500).json({
            success: false,
            message: "Server error while creating organization"
        });
    }
};

// ==================== GET ALL ORGANIZATIONS ====================
const getAllOrganizations = async (req, res) => {
    try {
        const organizations = await Organization.find()
            .populate("owner", "name email role");

        if (!organizations) {
            return res.status(404).json({ success: false, message: "No Oragnizaiton Found" });
        }
        return res.status(200).json({
            success: true,
            count: organizations.length,
            organizations
        });
    } catch (error) {
        console.error("Get All Organizations Error:", error);
        return res.status(500).json({
            success: false,
            message: "Server error while fetching organizations"
        });
    }
};

// ==================== GET ORGANIZATION BY OWNER ====================
const getOrganizationsByOwner = async (req, res) => {
    try {
        const { ownerId } = req.params;

        const organizations = await Organization.find({ owner: ownerId })
            .populate("owner", "name email role");

        if (organizations.length === 0) {
            return res.status(404).json({
                success: false,
                message: "No organizations found for this owner"
            });
        }

        return res.status(200).json({
            success: true,
            count: organizations.length,
            organizations
        });

    } catch (error) {
        console.error("Get Organizations By Owner Error:", error);
        return res.status(500).json({
            success: false,
            message: "Server error"
        });
    }
};

// ==================== GET SINGLE ORGANIZATION ====================
const getOrganizationById = async (req, res) => {
    try {
        const { id } = req.params;

        const organization = await Organization.findById(id)
            .populate("owner", "name email role");

        if (!organization) {
            return res.status(404).json({
                success: false,
                message: "Organization not found"
            });
        }

        return res.status(200).json({
            success: true,
            organization
        });

    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Server error"
        });
    }
};

// ====================== GET USER'S ORGANIZATIONS ======================
const getUserOrganizations = async (req, res) => {
    try {
        const userId = req.params.userId || req.user._id;

        // If a specific userId is provided, check permission
        if (req.params.userId) {
            if (req.user.role !== "admin" && req.params.userId !== req.user._id.toString()) {
                return res.status(403).json({
                    success: false,
                    message: "You can only view your own organizations"
                });
            }
        }

        const user = await User.findById(userId)
            .populate({
                path: "organizations",
                select: "name description createdAt",
                // populate: {
                //     path: "owner",
                //     select: "name email"
                // }
            });

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        res.status(200).json({
            success: true,
            count: user.organizations.length,
            organizations: user.organizations
        });

    } catch (error) {
        console.error("Get User Organizations Error:", error);
        res.status(500).json({
            success: false,
            message: "Server error while fetching organizations"
        });
    }
};

const updateOrganization = async (req, res) => {
    try {
        const { id } = req.params;
        const { name } = req.body;   // Only allowing name change
        const user = req.user;

        if (!name || name.trim() === "") {
            return res.status(400).json({
                success: false,
                message: "Organization name is required"
            });
        }

        // Find organization
        const organization = await Organization.findById(id);
        if (!organization) {
            return res.status(404).json({
                success: false,
                message: "Organization not found"
            });
        }

        // Permission Check: Only owner or admin
        if (user.role !== "admin" && organization.owner.toString() !== user._id.toString()) {
            return res.status(403).json({
                success: false,
                message: "You don't have permission to update this organization"
            });
        }

        // Check if new name is same as old name
        if (name.trim().toLowerCase() === organization.name.toLowerCase()) {
            return res.status(400).json({
                success: false,
                message: "New name is same as current name"
            });
        }

        // Check duplicate name for this owner
        const existingOrg = await Organization.findOne({
            name: { $regex: new RegExp(`^${name}$`, 'i') },
            owner: organization.owner,
            _id: { $ne: id }
        });

        if (existingOrg) {
            return res.status(400).json({
                success: false,
                message: "You already have an organization with this name"
            });
        }

        // Update name
        organization.name = name.trim();
        await organization.save();

        res.status(200).json({
            success: true,
            message: "Organization name updated successfully",
            organization: {
                id: organization._id,
                name: organization.name,
                owner: organization.owner
            }
        });

    } catch (error) {
        console.error("Update Organization Error:", error);
        res.status(500).json({
            success: false,
            message: "Server error while updating organization"
        });
    }
};

// ====================== DELETE ORGANIZATION ======================
const deleteOrganization = async (req, res) => {
    try {
        const { id } = req.params;
        const user = req.user;

        // Find organization
        const organization = await Organization.findById(id);
        if (!organization) {
            return res.status(404).json({
                success: false,
                message: "Organization not found"
            });
        }

        // Permission Check: Only owner or admin can delete
        if (user.role !== "admin" && organization.owner.toString() !== user._id.toString()) {
            return res.status(403).json({
                success: false,
                message: "You don't have permission to delete this organization"
            });
        }

        // ==================== CASCADE DELETE ====================

        // 1. Find all venues in this organization
        const venues = await Venue.find({ organization: id });
        const venueIds = venues.map(v => v._id);

        // 2. Delete all devices in those venues
        await Device.deleteMany({ venue: { $in: venueIds } });

        // 3. Delete all venues
        await Venue.deleteMany({ organization: id });

        // 4. Remove this organization from ALL users who have it
        await User.updateMany(
            { organizations: id },
            { $pull: { organizations: id } }
        );

        // 5. Finally delete the organization
        await Organization.findByIdAndDelete(id);

        res.status(200).json({
            success: true,
            message: "Organization and all related venues & devices deleted successfully"
        });

    } catch (error) {
        console.error("Delete Organization Error:", error);
        res.status(500).json({
            success: false,
            message: "Server error while deleting organization"
        });
    }
};

module.exports = { createOrganization, getAllOrganizations, getOrganizationsByOwner, getOrganizationById, getUserOrganizations, deleteOrganization };