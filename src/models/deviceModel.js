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
        // Stored as lowercase `apikey` (not unique — deviceId already is)
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

const Device = mongoose.model("Device", deviceSchema);

/**
 * Drop legacy indexes that break inserts.
 * Old unique index `apiKey_1` treated missing camelCase field as null,
 * so only one device could exist (second insert → E11000 apiKey: null).
 */
async function cleanupStaleDeviceIndexes() {
    try {
        const indexes = await Device.collection.indexes();
        const stale = indexes.filter(
            (idx) =>
                idx.name === "apiKey_1" ||
                (idx.key && idx.key.apiKey != null && idx.unique)
        );

        for (const idx of stale) {
            await Device.collection.dropIndex(idx.name);
            console.log(`[Device] dropped stale index: ${idx.name}`);
        }
    } catch (error) {
        // Ignore "index not found"
        if (error?.codeName !== "IndexNotFound" && error?.code !== 27) {
            console.warn(
                "[Device] stale index cleanup skipped:",
                error.message
            );
        }
    }
}

module.exports = Device;
module.exports.cleanupStaleDeviceIndexes = cleanupStaleDeviceIndexes;
