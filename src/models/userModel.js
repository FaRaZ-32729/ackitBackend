// models/userModel.js
const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    },
    password: {
        type: String,
        required: false   // Will be set later if created by admin
    },

    role: {
        type: String,
        enum: ["admin", "manager", "user"],
        default: "manager"
    },

    // ==================== CREATION METHOD ====================
    createdBy: {
        type: String,
        enum: ["self", "admin", "manager"],
        default: "self"
    },

    creatorId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        default: null
    },

    // ==================== SUBSCRIPTION ====================
    currentSubscription: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Subscription",
        default: null
    },

    // ==================== ORGANIZATIONS ====================
    organizations: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: "Organization"
    }],

    activeOrganization: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Organization",
        default: null
    },

    // ==================== VENUES (for sub-users) ====================
    venues: [{
        venueId: { type: mongoose.Schema.Types.ObjectId, ref: "Venue" },
        venueName: String
    }],

    // ==================== ACCOUNT STATUS ====================
    isActive: {
        type: Boolean,
        default: false
    },
    isVerified: {
        type: Boolean,
        default: false
    },
    suspensionReason: {
        type: String,
        default: null
    },
    permission: {
        type: String,
        default: null
    },

    // ==================== AUTH TOKENS ====================
    otp: String,
    otpExpiry: Date,
    setupToken: String,
    resetToken: String,
    resetTokenExpiry: Date,
    lastLogin: Date,


    tempEmail: {
        type: String,
        lowercase: true,
        trim: true,
        default: null
    },
    emailChangeOtp: String,
    emailChangeOtpExpiry: Date,

}, {
    timestamps: true
});

// Indexes
userSchema.index({ role: 1 });
userSchema.index({ createdBy: 1 });
userSchema.index({ creatorId: 1 });

const userModel = mongoose.model("User", userSchema);
module.exports = userModel;