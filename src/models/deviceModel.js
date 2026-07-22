// models/deviceModel.js
const mongoose = require("mongoose");

const deviceSchema = new mongoose.Schema(
    {
        deviceId: {
            type: String,
            required: true,
            unique: true,
            uppercase: true,
            trim: true,
            minlength: 6,
            maxlength: 6,
        },
        deviceName: { type: String, required: true, trim: true },
        organization: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Organization",
            required: true,
        },
        venue: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Venue",
            required: true,
        },
        brand: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Brand",
            required: true,
        },
        capacity: {
            type: Number,
            enum: [1, 1.5, 2, 2.5, 3, 3.5],
            required: true,
        },
        status: {
            type: String,
            enum: ["online", "offline"],
            default: "offline",
        },
        state: {
            type: String,
            enum: ["on", "off"],
            default: "off",
        },
        health: {
            type: String,
            enum: ["healthy", "faulty"],
            default: "healthy",
        },
        version: { type: String, default: "0.0.0" },
        remote: {
            type: String,
            enum: ["lock", "unlock", "superlock"],
            default: "unlock",
        },
        apikey: { type: String, default: "" },
        temperature: {
            type: Number,
            min: 16,
            max: 30,
            default: 16,
        },
        powerConsumption: { type: Number, default: 0 },
        configure: {
            type: Boolean,
            default: false,
        },
    },
    { timestamps: true }
);

deviceSchema.index({ organization: 1 });
deviceSchema.index({ venue: 1 });
// Device name must be unique within the same venue (but may repeat across venues)
deviceSchema.index({ venue: 1, deviceName: 1 }, { unique: true });

module.exports = mongoose.model("Device", deviceSchema);