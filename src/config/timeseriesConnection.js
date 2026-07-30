const mongoose = require("mongoose");
const dotenv = require("dotenv");

dotenv.config();

/**
 * Separate MongoDB connection for time-series collections only
 * (e.g. device_currents). Main app data stays on MONGODB_URL.
 */
const timeseriesUri = process.env.MONGODB_TIMESERIES_DB;

let timeseriesConnection = null;

if (timeseriesUri) {
    timeseriesConnection = mongoose.createConnection(timeseriesUri, {
        bufferCommands: true,
    });

    timeseriesConnection.on("connected", () => {
        console.log("Timeseries DB Connected Successfully");
    });

    timeseriesConnection.on("error", (err) => {
        console.log("Timeseries DB connection error:", err.message);
    });
} else {
    console.warn(
        "[Timeseries DB] MONGODB_TIMESERIES_DB is not set — current samples will fail to save"
    );
}

module.exports = timeseriesConnection;
