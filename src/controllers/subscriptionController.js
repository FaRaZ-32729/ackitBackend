// src/controllers/subscriptionController.js
const Subscription = require("../models/subscriptionModel");
const SubscriptionPlan = require("../models/subscriptionPlanModel");
const User = require("../models/userModel");
const Organization = require("../models/organizationModel");
const Venue = require("../models/venueModel");
const Device = require("../models/deviceModel");
const { purchaseSubscriptionSchema } = require("../validations/subscriptionValidations");
const sendEmail = require("../services/emailServices");

// Purchase / Activate Subscription
const purchaseSubscription = async (req, res) => {
    try {
        const { planId } = purchaseSubscriptionSchema.parse(req.body);
        const userId = req.user._id;

        // Fetch plan
        const plan = await SubscriptionPlan.findById(planId);

        if (!plan) {
            return res.status(404).json({ success: false, message: "Plan not found" });
        }

        if (!plan.isActive) {
            return res.status(400).json({ success: false, message: "This plan is currently inactive" });
        }

        // Fetch user
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }

        if (!user.isVerified) {
            return res.status(403).json({ success: false, message: "Please verify your email first" });
        }

        // Optional: Prevent buying if already has active subscription (you can relax later)
        if (user.currentSubscription) {
            const activeSub = await Subscription.findById(user.currentSubscription);
            if (activeSub && activeSub.status === "active") {
                return res.status(400).json({
                    success: false,
                    message: "You already have an active subscription. Please cancel or upgrade later."
                });
            }
        }

        // Calculate dates
        const startDate = new Date();
        const endDate = new Date();
        endDate.setDate(endDate.getDate() + plan.durationDays);

        // Create Subscription
        const subscription = await Subscription.create({
            user: userId,
            plan: planId,
            email: req.user.email,
            startDate,
            endDate,
            status: "active",
            isTrial: plan.isTrial,
            paymentInfo: {
                amountPaid: plan.price,
                paymentMethod: "manual",
            }
        });

        // Update User
        user.currentSubscription = subscription._id;
        await user.save();

        // Send Email
        await sendEmail(
            user.email,
            "🎉 Your IoTify Subscription is Now Active!",
            `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #4F46E5;">Congratulations ${user.name}!</h2>
                <p>Your <strong>${plan.name}</strong> plan has been activated successfully.</p>
                <p>Valid until: <strong>${endDate.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</strong></p>
                <p>You can now create organizations, venues, and devices.</p>
            </div>
            `
        );

        res.status(201).json({
            success: true,
            message: "Subscription activated successfully",
            subscription: {
                id: subscription._id,
                plan: plan.name,
                startDate,
                endDate
            },
            user: {
                isActive: true,
                currentSubscription: subscription._id
            }
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

        console.error("Purchase Subscription Error:", error);
        res.status(500).json({ success: false, message: "Server error" });
    }
};

// Get User's Current Subscription
const getMySubscription = async (req, res) => {
    try {
        const subscription = await Subscription.findOne({ user: req.user._id })
            .populate("plan");

        if (!subscription) {
            return res.status(404).json({ message: "No active subscription found" });
        }

        res.json({ success: true, subscription });
    } catch (error) {
        res.status(500).json({ message: "Server error" });
    }
};

// Get Subscription Usage / Limits Status
const getSubscriptionUsage = async (req, res) => {
    try {
        const user = req.user;

        if (!user.currentSubscription) {
            return res.status(400).json({
                success: false,
                message: "No active subscription found"
            });
        }

        // Populate subscription + plan
        const subscription = await user.populate({
            path: 'currentSubscription',
            populate: { path: 'plan' }
        });

        const plan = subscription.currentSubscription?.plan;

        if (!plan) {
            return res.status(400).json({
                success: false,
                message: "Subscription plan details not found"
            });
        }

        // ==================== CALCULATE USAGE FROM ACTUAL COLLECTIONS ====================

        // 1. Organizations → Count from Organization collection using owner
        const usedOrganizations = await Organization.countDocuments({
            owner: user._id
        });

        // 2. Venues → Under user's organizations
        const userOrgIds = await Organization.find({ owner: user._id }).select('_id');
        const orgIds = userOrgIds.map(org => org._id);

        const usedVenues = await Venue.countDocuments({
            organization: { $in: orgIds }
        });

        // 3. Devices → Under user's venues
        const userVenues = await Venue.find({
            organization: { $in: orgIds }
        }).select('_id');

        const usedDevices = await Device.countDocuments({
            venue: { $in: userVenues.map(v => v._id) }
        });

        // 4. Sub-Users (created by this manager)
        const usedUsers = await User.countDocuments({
            creatorId: user._id,
            role: "user"
        });

        const usage = {
            organizations: {
                used: usedOrganizations,
                total: plan.maxOrganizations,
                remaining: Math.max(0, plan.maxOrganizations - usedOrganizations)
            },
            venues: {
                used: usedVenues,
                total: plan.maxVenues,
                remaining: Math.max(0, plan.maxVenues - usedVenues)
            },
            devices: {
                used: usedDevices,
                total: plan.maxDevices,
                remaining: Math.max(0, plan.maxDevices - usedDevices)
            },
            users: {
                used: usedUsers,
                total: plan.maxUsers || 10,
                remaining: Math.max(0, (plan.maxUsers || 10) - usedUsers)
            }
        };

        res.status(200).json({
            success: true,
            subscription: {
                planName: plan.name,
                planType: plan.type,
                isActive: subscription.currentSubscription.status === "active",
                startDate: subscription.currentSubscription.startDate,
                endDate: subscription.currentSubscription.endDate
            },
            usage,
            overallStatus: {
                isWithinLimit:
                    usedOrganizations <= plan.maxOrganizations &&
                    usedVenues <= plan.maxVenues &&
                    usedDevices <= plan.maxDevices &&
                    usedUsers <= (plan.maxUsers || 10)
            }
        });

    } catch (error) {
        console.error("Get Subscription Usage Error:", error);
        res.status(500).json({
            success: false,
            message: "Server error while fetching usage"
        });
    }
};


module.exports = {
    purchaseSubscription,
    getSubscriptionUsage,
    getMySubscription
};