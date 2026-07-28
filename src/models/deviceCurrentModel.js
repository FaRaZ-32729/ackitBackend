const mongoose = require("mongoose");

/**
 * Time-series of ESP SCT-013 current samples (typically every 5 minutes).
 * Fields: device (_id) + current (A) + timestamp only.
 */
const deviceCurrentSchema = new mongoose.Schema(
    {
        timestamp: {
            type: Date,
            required: true,
            default: Date.now,
        },
        device: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Device",
            required: true,
        },
        current: {
            type: Number,
            required: true,
            min: 0,
        },
    },
    {
        timeseries: {
            timeField: "timestamp",
            metaField: "device",
            granularity: "minutes",
        },
        autoCreate: true,
        versionKey: false,
        strict: true,
    }
);

deviceCurrentSchema.index({ device: 1, timestamp: -1 });

module.exports = mongoose.model(
    "DeviceCurrent",
    deviceCurrentSchema,
    "device_currents"
);
