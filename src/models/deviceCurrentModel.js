const mongoose = require("mongoose");
const timeseriesConnection = require("../config/timeseriesConnection");

/**
 * Time-series of ESP SCT-013 current samples (typically every 5 minutes).
 * Stored ONLY on MONGODB_TIMESERIES_DB — not the main app database.
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

if (!timeseriesConnection) {
    throw new Error(
        "MONGODB_TIMESERIES_DB is required for DeviceCurrent time-series storage"
    );
}

module.exports = timeseriesConnection.model(
    "DeviceCurrent",
    deviceCurrentSchema,
    "device_currents"
);
