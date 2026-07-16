// models/venueModel.js
const mongoose = require("mongoose");

const venueSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },

    organization: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Organization",
        required: true
    },

}, {
    timestamps: true
});

// Indexes
venueSchema.index({ name: 1, organization: 1 }, { unique: true }); // Unique venue name per organization
venueSchema.index({ organization: 1 });

module.exports = mongoose.model("Venue", venueSchema);