// src/middleware/checkPendingSubscription.js
const Subscription = require("../models/subscriptionModel");
const User = require("../models/userModel");

const checkPendingSubscription = async (req, res, next) => {
    try {
        const { email } = req.body;

        if (!email) return next();

        // Find pending subscription (where user is null but assignedEmail exists)
        const pendingSubscription = await Subscription.findOne({
            email: email.toLowerCase(),
            user: null,
            status: "active"
        });

        console.log("Pending Subscription Found:", pendingSubscription ? "YES" : "NO");

        if (pendingSubscription) {
            console.log(`Found pending subscription for ${email}`);

            // Attach to request so controller can use it
            req.pendingSubscription = pendingSubscription;
        }

        next();

    } catch (error) {
        console.error("Check Pending Subscription Error:", error);
        next();
    }
};

module.exports = checkPendingSubscription;