// models/organizationModel.js
const mongoose = require("mongoose");

const organizationSchema = new mongoose.Schema({
    name: {
        type: String,
        trim: true,
        unique: true
    },

    address: {
        type: String,
        trim: true,
        default: null,
    },

    // Current owner/manager
    owner: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true
    },

}, {
    timestamps: true
});

// Index for faster search
organizationSchema.index({ owner: 1, name: 1 }, { unique: true });

module.exports = mongoose.model("Organization", organizationSchema);
