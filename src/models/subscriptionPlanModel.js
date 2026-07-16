// models/subscriptionPlanModel.js
const mongoose = require("mongoose");

const subscriptionPlanSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        unique: true
    },
    type: {
        type: String,
        required: true,
        enum: ["free", "basic", "premium", "custom"],
    },
    description: {
        type: String,
    },

    price: {
        type: Number,
        required: true,
        min: 0
    },

    durationDays: {
        type: Number,
        required: true
    },

    // Plan Limits
    maxOrganizations: {
        type: Number,
        required: true
    },
    maxVenues: {
        type: Number,
        required: true
    },
    maxDevices: {
        type: Number,
        required: true
    },

    maxUsers: {
        type: Number,
        required: true,
        default: 1
    },

    isActive: {
        type: Boolean,
        default: true
    },

    isTrial: {
        type: Boolean,
        default: false
    },
    isCustom: { type: Boolean, default: false },
    assignedToEmail: {
        type: String,
        lowercase: true,
        trim: true,
        default: null
    },
    createdBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true
    }
}, {
    timestamps: true
});

subscriptionPlanSchema.pre('save', async function () {
    if (this.name === "free") {
        this.isTrial = true;
    }
});

const subscriptionPlanModel = mongoose.model("SubscriptionPlan", subscriptionPlanSchema);
module.exports = subscriptionPlanModel;