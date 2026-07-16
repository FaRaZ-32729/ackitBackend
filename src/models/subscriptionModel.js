// models/subscriptionModel.js
const mongoose = require("mongoose");

const subscriptionSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
    },
    email: {
        type: String,
        required: true
    },
    isAdmin: {
        type: Boolean,
        default: false
    },
    plan: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "SubscriptionPlan",
        required: true
    },

    startDate: {
        type: Date,
        default: Date.now
    },

    endDate: {
        type: Date,
        required: true
    },

    status: {
        type: String,
        enum: ["active", "expired", "cancelled", "trial"],
        default: "active"
    },

    isTrial: {
        type: Boolean,
        default: false
    },

    // Payment Information
    paymentInfo: {
        transactionId: String,
        paymentMethod: String,
        amountPaid: Number,
        currency: {
            type: String,
            default: "USD"
        }
    },

    // For future use (upgrade/downgrade)
    previousPlan: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "SubscriptionPlan"
    }

}, {
    timestamps: true
});

subscriptionSchema.pre('save', async function () {
    const now = new Date();
    if (this.endDate < now && this.status === "active") {
        this.status = "expired";
    }
});
const subscriptionModel = mongoose.model("Subscription", subscriptionSchema);
module.exports = subscriptionModel;