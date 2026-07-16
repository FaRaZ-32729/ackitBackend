// src/controllers/subscriptionPlanController.js
const subscriptionModel = require("../models/subscriptionModel");
const SubscriptionPlan = require("../models/subscriptionPlanModel");
const User = require("../models/userModel");
const { createPlanSchema } = require("../validations/subscriptionValidations");

// Create New Plan (free , basic , premium , Admin Custom , User Custom)
const createSubscriptionPlan = async (req, res) => {
    try {
        const validatedData = createPlanSchema.parse(req.body);

        // Free plan must be 15 days
        if (validatedData.type === "free" && validatedData.durationDays !== 15) {
            return res.status(400).json({
                success: false,
                message: "Free plan must have exactly 15 days duration"
            });
        }

        let finalAssignedToEmail = validatedData.assignedToEmail;

        if (validatedData.type === "custom") {
            if (req.user.role === "admin") {
                if (!finalAssignedToEmail) {
                    return res.status(400).json({
                        success: false,
                        message: "Customer's email is required"
                    });
                }
            } else {
                finalAssignedToEmail = req.user.email;
            }
        }

        // Check duplicate plan name
        const existing = await SubscriptionPlan.findOne({ name: validatedData.name });
        if (existing) {
            return res.status(400).json({
                success: false,
                message: `Plan with name "${validatedData.name}" already exists`
            });
        }

        // ==================== CREATE PLAN ====================
        const plan = await SubscriptionPlan.create({
            name: validatedData.name,
            type: validatedData.type,
            description: validatedData.description,
            price: validatedData.price,
            durationDays: validatedData.durationDays,
            maxOrganizations: validatedData.maxOrganizations,
            maxVenues: validatedData.maxVenues,
            maxDevices: validatedData.maxDevices,
            maxUsers: validatedData.maxUsers,
            assignedToEmail: finalAssignedToEmail,
            isCustom: validatedData.type === "custom",
            isTrial: validatedData.type === "free",
            createdBy: req.user._id
        });

        // ==================== AUTO CREATE SUBSCRIPTION ====================
        // ONLY for Admin-created Custom Plans
        let subscription = null;

        if (validatedData.type === "custom" && req.user.role === "admin" && finalAssignedToEmail) {

            const existingUser = await User.findOne({ email: finalAssignedToEmail });

            const startDate = new Date();
            const endDate = new Date();
            endDate.setDate(endDate.getDate() + plan.durationDays);

            subscription = await subscriptionModel.create({
                user: existingUser ? existingUser._id : null,        // user id if exists
                email: finalAssignedToEmail,
                isAdmin: true,
                plan: plan._id,
                startDate,
                endDate,
                status: "active",
                isTrial: false,
                paymentInfo: {
                    amountPaid: plan.price,
                    paymentMethod: "admin-assigned",
                },
                assignedEmail: finalAssignedToEmail   // ← Always store email for future linking
            });

            // If user already exists → Activate them
            if (existingUser) {
                existingUser.currentSubscription = subscription._id;
                await existingUser.save();
            }
        }

        res.status(201).json({
            success: true,
            message: "Subscription Plan created successfully" +
                (subscription ? " and assigned to user" : ""),
            plan,
            subscription: subscription ? {
                id: subscription._id,
                assignedEmail: finalAssignedToEmail,
                userId: subscription.user,
                status: subscription.status
            } : null
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

        console.error("Create Plan Error:", error);
        res.status(500).json({
            success: false,
            message: "Server error while creating plan"
        });
    }
};

// Get All Plans
const getAllPlans = async (req, res) => {
    try {
        const plans = await SubscriptionPlan.find({ isActive: true }).sort({ price: 1 });
        res.json({ success: true, plans });
    } catch (error) {
        res.status(500).json({ message: "Server error" });
    }
};

// Get Single Plan
const getPlanById = async (req, res) => {
    try {
        const plan = await SubscriptionPlan.findById(req.params.id);
        if (!plan) return res.status(404).json({ message: "Plan not found" });

        res.json({ success: true, plan });
    } catch (error) {
        res.status(500).json({ message: "Server error" });
    }
};

module.exports = {
    createSubscriptionPlan,
    getAllPlans,
    getPlanById
};