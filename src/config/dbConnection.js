const mongoose = require("mongoose");
const dotenv = require("dotenv");
const timeseriesConnection = require("./timeseriesConnection");

dotenv.config();

const dbConnection = async () => {
    // const dns = require('node:dns');
    // dns.setServers(['8.8.8.8', '8.8.4.4']);

    try {
        // Main app DB (users, devices, brands, orgs, …)
        await mongoose.connect(process.env.MONGODB_URL);
        console.log("DB Connected Successfully");

        // Time-series DB (device current samples only)
        if (timeseriesConnection && process.env.MONGODB_TIMESERIES_DB) {
            await timeseriesConnection.asPromise();
        } else {
            console.warn(
                "MONGODB_TIMESERIES_DB missing — skipping timeseries DB connect"
            );
        }

        // Fix legacy unique apiKey index that blocked new device creates
        const { cleanupStaleDeviceIndexes } = require("../models/deviceModel");
        await cleanupStaleDeviceIndexes();
    } catch (error) {
        console.log("error while connection with mongoDB", error.message);
    }
};

module.exports = dbConnection;
