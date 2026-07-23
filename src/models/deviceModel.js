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
        /** Human-readable fault reason from ESP (e.g. vent temp above set) */
        healthAlert: {
            type: String,
            default: "",
            trim: true,
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
        /** Line voltage (V) used with ESP current to compute power */
        voltage: {
            type: Number,
            min: 100,
            max: 400,
            default: 230,
        },
        /** Live measured current from ESP SCT-013 (A) */
        current: {
            type: Number,
            min: 0,
            default: 0,
        },
        /** Live power = voltage × current / 1000 (kW) */
        powerConsumption: { type: Number, default: 0 },
        /** Last DS18B20 vent/room reading from ESP (°C) */
        ventTemperature: {
            type: Number,
            default: null,
        },
        /** Last applied AC mode (cool/heat/dry/fan/auto) when brand supports it */
        mode: { type: String, default: "" },
        /** Last applied fan speed when brand supports it */
        fanSpeed: { type: String, default: "" },
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
