// src/middleware/subscriptionLimit.js

const User = require("../models/userModel");
const Organization = require("../models/organizationModel");
const Venue = require("../models/venueModel");
const Device = require("../models/deviceModel");

const checkSubscriptionLimit = (resourceType) => {
    return async (req, res, next) => {
        try {
            let user = req.user;

            // If the logged-in user is a sub-user, find their manager (creator)
            if (user.role === "user" && user.creatorId) {
                user = await User.findById(user.creatorId)
                    .populate({
                        path: "currentSubscription",
                        populate: { path: "plan" }
                    });
            }
            // If manager or admin, use their own subscription
            else {
                user = await User.findById(user._id)
                    .populate({
                        path: "currentSubscription",
                        populate: { path: "plan" }
                    });
            }

            if (!user) {
                return res.status(404).json({ success: false, message: "User not found" });
            }

            if (!user.currentSubscription) {
                return res.status(403).json({
                    success: false,
                    message: "No active subscription found. Please subscribe to a plan first."
                });
            }

            const subscription = user.currentSubscription;

            if (subscription.status !== "active") {
                return res.status(403).json({
                    success: false,
                    message: `Your subscription is ${subscription.status}. Please renew it.`
                });
            }

            const plan = subscription.plan;
            if (!plan) {
                return res.status(403).json({
                    success: false,
                    message: "Subscription plan details not found"
                });
            }

            let currentCount = 0;
            let maxLimit = 0;

            switch (resourceType) {
                case "organization":
                    currentCount = user.organizations ? user.organizations.length : 0;
                    maxLimit = plan.maxOrganizations;
                    break;

                case "venue":
                    const orgIds = user.organizations || [];
                    currentCount = await Organization.aggregate([
                        { $match: { _id: { $in: orgIds } } },
                        { $lookup: { from: "venues", localField: "_id", foreignField: "organization", as: "venues" } },
                        { $unwind: "$venues" },
                        { $count: "total" }
                    ]).then(result => result[0]?.total || 0);

                    maxLimit = plan.maxVenues;
                    break;

                case "device":
                    const orgIdsForDevice = user.organizations || [];
                    const venues = await Venue.find({ organization: { $in: orgIdsForDevice } }).select("_id");
                    const venueIds = venues.map(v => v._id);

                    currentCount = await Device.countDocuments({ venue: { $in: venueIds } });
                    maxLimit = plan.maxDevices;
                    break;

                case "user":
                    currentCount = await User.countDocuments({
                        creatorId: user._id,
                        role: "user"
                    });
                    maxLimit = plan.maxUsers || 10;
                    break;

                default:
                    return res.status(400).json({
                        success: false,
                        message: "Invalid resource type"
                    });
            }

            if (currentCount >= maxLimit) {
                return res.status(403).json({
                    success: false,
                    message: `Limit reached! You can create maximum ${maxLimit} ${resourceType}s under your manager's plan.`
                });
            }

            next();

        } catch (error) {
            console.error("Subscription Limit Check Error:", error);
            return res.status(500).json({
                success: false,
                message: "Subscription check failed. Please try again."
            });
        }
    };
};

module.exports = checkSubscriptionLimit;