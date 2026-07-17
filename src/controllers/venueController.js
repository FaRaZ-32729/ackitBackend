// src/Controllers/venueController.js
const Venue = require("../models/venueModel");
const Organization = require("../models/organizationModel");
const { createVenueSchema, updateVenueSchema } = require("../validations/venueValidation");
const checkSubscriptionLimit = require("../middlewares/subscriptionLimit");
const User = require("../models/userModel");
const Device = require("../models/deviceModel");

// ==================== CREATE VENUE ====================
const createVenue = async (req, res) => {
    try {
        const validatedData = createVenueSchema.parse(req.body);
        const user = req.user;

        // Check if organization exists and belongs to user
        const organization = await Organization.findById(validatedData.organization);
        if (!organization) {
            return res.status(404).json({
                success: false,
                message: "Organization not found"
            });
        }

        // Check ownership (Admin can create anywhere, Manager only in their orgs)
        if (user.role !== "admin") {
            const userOrgIds = (user.organizations || []).map((id) => id.toString());
            if (!userOrgIds.includes(validatedData.organization)) {
                return res.status(403).json({
                    success: false,
                    message: "You can only create venues in your own organizations"
                });
            }
        }

        // Check subscription limit
        if (user.role !== "admin") {
            await checkSubscriptionLimit("venue")(req, res, () => { });
            if (res.headersSent) return;
        }

        // Check duplicate venue name in same organization
        const existingVenue = await Venue.findOne({
            name: { $regex: new RegExp(`^${validatedData.name}$`, 'i') },
            organization: validatedData.organization
        });

        if (existingVenue) {
            return res.status(400).json({
                success: false,
                message: "Venue with this name already exists in this organization"
            });
        }

        // Create Venue
        const venue = await Venue.create({
            name: validatedData.name,
            organization: validatedData.organization,
        });

        // await User.findByIdAndUpdate(user._id, {
        //     $push: { venues: venue._id },
        // });

        res.status(201).json({
            success: true,
            message: "Venue created successfully",
            venue
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

        console.error("Create Venue Error:", error);
        res.status(500).json({
            success: false,
            message: "Server error while creating venue"
        });
    }
};

// ==================== GET ALL VENUES ====================
const getAllVenues = async (req, res) => {
    try {
        const venues = await Venue.find()
            .populate("organization", "name")
            .sort({ createdAt: -1 });

        return res.status(200).json({
            success: true,
            count: venues.length,
            venues
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: "Server error" });
    }
};

// ==================== GET VENUES BY ORGANIZATION ====================
const getVenuesByOrganization = async (req, res) => {
    try {
        const { organizationId } = req.params;

        const venues = await Venue.find({ organization: organizationId })
            .populate("organization", "name");

        return res.status(200).json({
            success: true,
            count: venues.length,
            venues
        });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error" });
    }
};

// ==================== GET SINGLE VENUE ====================
const getSingleVenue = async (req, res) => {
    try {
        const { id } = req.params;

        const venue = await Venue.findById(id).populate("organization", "name");

        if (!venue) {
            return res.status(404).json({ success: false, message: "Venue not found" });
        }

        res.status(200).json({
            success: true,
            venue
        });
    } catch (error) {
        res.status(500).json({ success: false, message: "Server error" });
    }
};

// ==================== UPDATE VENUE====================
const updateVenue = async (req, res) => {
    try {
        const { id } = req.params;
        const validatedData = updateVenueSchema.parse(req.body);
        const user = req.user;

        // Find existing venue
        const venue = await Venue.findById(id);
        if (!venue) {
            return res.status(404).json({ success: false, message: "Venue not found" });
        }

        // Permission Check
        if (user.role !== "admin") {
            const org = await Organization.findById(venue.organization);
            if (!org || org.owner.toString() !== user._id.toString()) {
                return res.status(403).json({
                    success: false,
                    message: "You can only update venues in your own organizations"
                });
            }
        }

        // ==================== NAME DUPLICATE CHECK ====================
        if (validatedData.name) {
            const duplicateVenue = await Venue.findOne({
                name: { $regex: new RegExp(`^${validatedData.name}$`, 'i') },
                organization: validatedData.organization || venue.organization,
                _id: { $ne: id }   // Exclude current venue
            });

            if (duplicateVenue) {
                return res.status(400).json({
                    success: false,
                    message: "A venue with this name already exists in this organization"
                });
            }
        }

        // ==================== ORGANIZATION CHANGE VALIDATION ====================
        if (validatedData.organization && validatedData.organization !== venue.organization.toString()) {
            const newOrg = await Organization.findById(validatedData.organization);
            if (!newOrg) {
                return res.status(404).json({ success: false, message: "New organization not found" });
            }

            if (user.role !== "admin" && newOrg.owner.toString() !== user._id.toString()) {
                return res.status(403).json({
                    success: false,
                    message: "You don't have access to the new organization"
                });
            }
        }

        // ==================== UPDATE FIELDS ====================
        if (validatedData.name) venue.name = validatedData.name;
        if (validatedData.organization) venue.organization = validatedData.organization;

        await venue.save();

        return res.status(200).json({
            success: true,
            message: "Venue updated successfully",
            venue
        });

    } catch (error) {
        if (error.name === "ZodError") {
            return res.status(400).json({
                success: false,
                message: "Validation failed",
                errors: error.issues.map(err => ({
                    field: err.path[0],
                    message: err.message
                }))
            });
        }

        console.error("Update Venue Error:", error);
        res.status(500).json({ success: false, message: "Server error while updating venue" });
    }
};

// ==================== DELETE VENUE (CASCADE DELETE)====================
const deleteVenue = async (req, res) => {
    try {
        const { id } = req.params;
        const user = req.user;

        // Find venue
        const venue = await Venue.findById(id);
        if (!venue) {
            return res.status(404).json({
                success: false,
                message: "Venue not found"
            });
        }

        // Permission Check
        const organization = await Organization.findById(venue.organization);
        if (!organization) {
            return res.status(404).json({ success: false, message: "Organization not found" });
        }

        if (user.role !== "admin" && organization.owner.toString() !== user._id.toString()) {
            return res.status(403).json({
                success: false,
                message: "You don't have permission to delete this venue"
            });
        }

        // ==================== CASCADE DELETE ====================

        // 1. Delete all devices in this venue
        await Device.deleteMany({ venue: id });

        // 2. Remove this venue from ALL users' venues array
        await User.updateMany(
            { "venues.venueId": id },                    // Find users who have this venue
            { $pull: { venues: { venueId: id } } }       // Remove the venue object
        );

        // 3. Finally delete the venue
        await Venue.findByIdAndDelete(id);

        res.status(200).json({
            success: true,
            message: "Venue and all its devices deleted successfully. References removed from all users."
        });

    } catch (error) {
        console.error("Delete Venue Error:", error);
        res.status(500).json({
            success: false,
            message: "Server error while deleting venue"
        });
    }
};

module.exports = { createVenue, getAllVenues, getVenuesByOrganization, getSingleVenue, updateVenue, deleteVenue };