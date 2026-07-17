// src/modules/users/userController.js
const User = require("../models/userModel");
const Organization = require("../models/organizationModel");
const Venue = require("../models/venueModel");
const Device = require("../models/deviceModel");
const SubscriptionPlan = require("../models/subscriptionPlanModel");
const Subscription = require("../models/subscriptionModel");
const sendEmail = require("../services/emailServices");


// ====================== GET ALL USERS (EXCEPT ADMIN) ======================
const getAllUsers = async (req, res) => {
    try {
        const users = await User.find({ role: { $ne: "admin" } })
            .select("-password -otp -otpExpiry -setupToken -resetToken -resetTokenExpiry")
            .populate("organizations", "name")
            .populate("currentSubscription", "plan status")
            .sort({ createdAt: -1 });

        if (users.length === 0) {
            return res.status(404).json({ message: "Users not found" })
        }

        return res.status(200).json({
            success: true,
            count: users.length,
            users
        });
    } catch (error) {
        console.error("Get All Users Error:", error);
        return res.status(500).json({ success: false, message: "Server error" });
    }
};

// ====================== GET ALL MANAGERS ======================
const getAllManagers = async (req, res) => {
    try {
        const managers = await User.find({ role: "manager" })
            .select("-password -otp -otpExpiry -setupToken -resetToken -resetTokenExpiry")
            .populate("currentSubscription", "plan status endDate")
            .populate("organizations", "name")
            .sort({ createdAt: -1 });

        if (managers.length === 0) {
            return res.status(404).json({ message: "Managers not found" })
        }
        return res.status(200).json({
            success: true,
            count: managers.length,
            managers
        });
    } catch (error) {
        console.error("Get All Managers Error:", error);
        return res.status(500).json({ success: false, message: "Server error" });
    }
};

// ====================== GET USERS OF A SPECIFIC MANAGER ======================
const getUsersByManager = async (req, res) => {
    try {
        const { managerId } = req.params;

        const manager = await User.findById(managerId);
        if (!manager || manager.role !== "manager") {
            return res.status(404).json({
                success: false,
                message: "Manager not found"
            });
        }

        const subUsers = await User.find({
            creatorId: managerId,
            role: "user"
        }).select("-password -otp -otpExpiry -setupToken -resetToken -resetTokenExpiry")
            .populate("organizations", "name")
            .populate("venues.venueId", "name")
            .sort({ createdAt: -1 });

        return res.status(200).json({
            success: true,
            manager: {
                id: manager._id,
                name: manager.name,
                email: manager.email
            },
            count: subUsers.length,
            subUsers
        });

    } catch (error) {
        console.error("Get Users By Manager Error:", error);
        return res.status(500).json({ success: false, message: "Server error" });
    }
};

// ====================== GET SINGLE USER ======================
const getSingleUser = async (req, res) => {
    try {
        const { userId } = req.params;

        const user = await User.findById(userId)
            .select("-password -otp -otpExpiry -setupToken -resetToken -resetTokenExpiry")
            .populate("organizations", "name")
            .populate("currentSubscription", "plan status endDate")
            .populate("venues.venueId", "name")
            .populate("creatorId", "name email role");

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        // Security: Managers can only see their own sub-users
        // if (req.user.role === "manager" && user.creatorId?.toString() !== req.user._id.toString()) {
        //     return res.status(403).json({
        //         success: false,
        //         message: "You can only view your own sub-users"
        //     });
        // }

        return res.status(200).json({
            success: true,
            user
        });

    } catch (error) {
        console.error("Get Single User Error:", error);
        return res.status(500).json({
            success: false,
            message: "Server error while fetching user"
        });
    }
};

// this api is used to add or remove organization , venues , and update permission
const updateManagerCreatedUser = async (req, res) => {
    try {

        const manager = req.user;
        const { userId } = req.params;

        const {
            organizations,
            venues,
            permission
        } = req.body;

        // ================= ONLY MANAGER =================
        if (manager.role !== "manager") {
            return res.status(403).json({
                success: false,
                message: "Only managers can update users"
            });
        }

        // ================= FIND USER =================
        const user = await User.findById(userId);

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        // ================= CHECK OWNERSHIP =================
        if (
            user.creatorId.toString() !== manager._id.toString()
        ) {
            return res.status(403).json({
                success: false,
                message: "You can only update your own users"
            });
        }

        // ================= ONLY NORMAL USERS =================
        if (user.role !== "user") {
            return res.status(400).json({
                success: false,
                message: "Only normal users can be updated"
            });
        }

        // ================= VALIDATE ORGANIZATIONS =================

        if (organizations && organizations.length > 0) {

            const validOrganizations = await Organization.find({
                _id: { $in: organizations },
                owner: manager._id
            });

            if (validOrganizations.length !== organizations.length) {
                return res.status(403).json({
                    success: false,
                    message: "One or more organizations are invalid"
                });
            }

            user.organizations = organizations;
        }

        // ================= VALIDATE VENUES =================

        if (Array.isArray(venues)) {
            if (venues.length === 0) {
                user.venues = [];
            } else {
                const orgIds = (organizations && organizations.length > 0)
                    ? organizations
                    : user.organizations;

                const validVenues = await Venue.find({
                    _id: { $in: venues },
                    organization: { $in: orgIds }
                });

                if (validVenues.length !== venues.length) {
                    return res.status(403).json({
                        success: false,
                        message: "One or more venues are invalid"
                    });
                }

                user.venues = validVenues.map(v => ({
                    venueId: v._id,
                    venueName: v.name
                }));
            }
        }

        // ================= VALIDATE PERMISSION =================

        if (permission) {
            const allowedPermissions = ["view", "manage"];

            if (!allowedPermissions.includes(permission)) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid permission value. Allowed: view, manage"
                });
            }

            user.permission = permission;
        }

        // ================= SAVE =================
        await user.save();

        return res.status(200).json({
            success: true,
            message: "User access updated successfully",
            user
        });

    } catch (error) {

        console.error("Update Manager User Access Error:", error);

        return res.status(500).json({
            success: false,
            message: "Server error while updating user"
        });
    }
};


// update user status
const suspendManager = async (req, res) => {
    try {
        const { managerId } = req.params;
        const { isActive, suspensionReason } = req.body;

        if (typeof isActive !== "boolean") {
            return res.status(400).json({
                success: false,
                message: "isActive field is required (true/false)"
            });
        }

        if (!isActive && !suspensionReason) {
            return res.status(400).json({
                success: false,
                message: "Suspension reason is required when deactivating"
            });
        }

        // Find manager
        const manager = await User.findById(managerId);
        if (!manager) {
            return res.status(404).json({ success: false, message: "Manager not found" });
        }

        if (manager.role !== "manager") {
            return res.status(400).json({ success: false, message: "This user is not a manager" });
        }

        // Update Manager
        manager.isActive = isActive;
        manager.suspensionReason = isActive ? null : suspensionReason;
        await manager.save();

        // Update ALL sub-users created by this manager
        await User.updateMany(
            { creatorId: manager._id, role: "user" },
            {
                isActive: isActive,
                suspensionReason: isActive ? null : suspensionReason
            }
        );

        const action = isActive ? "activated" : "suspended";

        res.status(200).json({
            success: true,
            message: `Manager and all its sub-users have been ${action} successfully`,
            manager: {
                id: manager._id,
                name: manager.name,
                email: manager.email,
                isActive: manager.isActive,
                suspensionReason: manager.suspensionReason
            }
        });

    } catch (error) {
        console.error("Suspend Manager Error:", error);
        res.status(500).json({
            success: false,
            message: "Server error while suspending manager"
        });
    }
};

// simply deletes user
const deleteUser = async (req, res) => {
    try {

        const { id } = req.params;

        const user = await User.findById(id);

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        await User.findByIdAndDelete(id);

        return res.status(200).json({
            success: true,
            message: "User deleted successfully"
        });

    } catch (error) {
        console.error("Delete User Error:", error);

        return res.status(500).json({
            success: false,
            message: "Server error while deleting user"
        });
    }
};

// delete manager and his created orgnaizations + venues + users
const deleteManager = async (req, res) => {
    try {

        const { id } = req.params;

        // Find manager
        const manager = await User.findById(id);

        if (!manager) {
            return res.status(404).json({
                success: false,
                message: "Manager not found"
            });
        }

        if (manager.role !== "manager") {
            return res.status(400).json({
                success: false,
                message: "User is not a manager"
            });
        }

        // ================= ORGANIZATIONS =================
        const organizations = await Organization.find({
            owner: manager._id
        });

        const organizationIds = organizations.map(org => org._id);

        // ================= VENUES =================
        const venues = await Venue.find({
            organization: { $in: organizationIds }
        });

        const venueIds = venues.map(v => v._id);

        // ================= DEVICES =================
        await Device.deleteMany({
            venue: { $in: venueIds }
        });

        // ================= VENUES DELETE =================
        await Venue.deleteMany({
            organization: { $in: organizationIds }
        });

        // ================= ORGANIZATIONS DELETE =================
        await Organization.deleteMany({
            owner: manager._id
        });

        // ================= MANAGER USERS DELETE =================
        await User.deleteMany({
            creatorId: manager._id,
            role: "user"
        });

        // ================= CUSTOM PLANS DELETE =================
        await SubscriptionPlan.deleteMany({
            assignedToEmail: manager.email,
            isCustom: true
        });

        // ================= SUBSCRIPTIONS DELETE =================
        await Subscription.deleteMany({
            user: manager._id
        });

        // ================= DELETE MANAGER =================
        await User.findByIdAndDelete(manager._id);

        return res.status(200).json({
            success: true,
            message: "Manager and all related data deleted successfully"
        });

    } catch (error) {

        console.error("Delete Manager Error:", error);

        return res.status(500).json({
            success: false,
            message: "Server error while deleting manager"
        });
    }
};


// ==================== REQUEST EMAIL CHANGE ====================
const requestEmailChange = async (req, res) => {
    try {
        const { newEmail } = req.body;
        const user = req.user;

        if (!newEmail) {
            return res.status(400).json({ success: false, message: "New email is required" });
        }

        if (newEmail === user.email) {
            return res.status(400).json({ success: false, message: "New email cannot be same as current" });
        }

        // Check if new email already exists
        const existingUser = await User.findOne({ email: newEmail });
        if (existingUser) {
            return res.status(400).json({ success: false, message: "Email already in use" });
        }

        // Generate OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        // Save temporary email change request
        user.tempEmail = newEmail;
        user.emailChangeOtp = otp;
        user.emailChangeOtpExpiry = Date.now() + 10 * 60 * 1000; // 10 minutes
        await user.save();

        // Send OTP to NEW email
        await sendEmail(
            newEmail,
            "Verify Your New Email - AC-KIT",
            `
            <h2>Email Change Request</h2>
            <p>Your OTP to change email is: <strong>${otp}</strong></p>
            <p>This OTP will expire in 10 minutes.</p>
            `
        );

        res.status(200).json({
            success: true,
            message: "OTP sent to your new email. Please verify."
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Server error" });
    }
};

// ==================== VERIFY EMAIL CHANGE ====================
const verifyEmailChange = async (req, res) => {
    try {
        const { otp } = req.body;
        const user = req.user;

        if (!otp) {
            return res.status(400).json({ success: false, message: "OTP is required" });
        }

        if (!user.tempEmail || !user.emailChangeOtp || user.emailChangeOtpExpiry < Date.now()) {
            return res.status(400).json({ success: false, message: "No pending email change or OTP expired" });
        }

        if (user.emailChangeOtp !== otp) {
            return res.status(400).json({ success: false, message: "Invalid OTP" });
        }

        const oldEmail = user.email;
        const newEmail = user.tempEmail;

        // Update User
        user.email = newEmail;
        user.tempEmail = null;
        user.emailChangeOtp = null;
        user.emailChangeOtpExpiry = null;
        await user.save();

        // Update Subscription
        await Subscription.updateMany(
            { email: oldEmail },
            { email: newEmail }
        );

        // Update SubscriptionPlan
        await SubscriptionPlan.updateMany(
            { assignedToEmail: oldEmail },
            { assignedToEmail: newEmail }
        );

        console.log(`Email updated successfully: ${oldEmail} → ${newEmail}`);

        res.status(200).json({
            success: true,
            message: "Email updated successfully",
            email: newEmail
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Server error" });
    }
};

module.exports = { getSingleUser, suspendManager, getAllUsers, getAllManagers, getUsersByManager, deleteUser, deleteManager, updateManagerCreatedUser, requestEmailChange, verifyEmailChange,};