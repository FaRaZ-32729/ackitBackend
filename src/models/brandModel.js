// models/brandModel.js
const mongoose = require("mongoose");

const brandSchema = new mongoose.Schema(
    {
        configureId: {
            type: String,
            required: true,
            unique: true,
            trim: true,
        },

        brandName: {
            type: String,
            required: true,
            unique: true,
            trim: true,
            lowercase: true,
        },

        // Power commands
        powerCommands: {
            on: { type: String, trim: true, default: "" },
            off: { type: String, trim: true, default: "" },
        },

        // Mode commands
        modes: {
            cool: { type: String, trim: true, default: "" },
            heat: { type: String, trim: true, default: "" },
            dry: { type: String, trim: true, default: "" },
            fanOnly: { type: String, trim: true, default: "" },
            smartAuto: { type: String, trim: true, default: "" },
        },

        // Temperature commands (°C 16–30)
        temperatureCommands: {
            sixteen: { type: String, trim: true, default: "" },
            seventeen: { type: String, trim: true, default: "" },
            eighteen: { type: String, trim: true, default: "" },
            nineteen: { type: String, trim: true, default: "" },
            twenty: { type: String, trim: true, default: "" },
            twentyOne: { type: String, trim: true, default: "" },
            twentyTwo: { type: String, trim: true, default: "" },
            twentyThree: { type: String, trim: true, default: "" },
            twentyFour: { type: String, trim: true, default: "" },
            twentyFive: { type: String, trim: true, default: "" },
            twentySix: { type: String, trim: true, default: "" },
            twentySeven: { type: String, trim: true, default: "" },
            twentyEight: { type: String, trim: true, default: "" },
            twentyNine: { type: String, trim: true, default: "" },
            thirty: { type: String, trim: true, default: "" },
        },

        // Fan speed commands
        fanSpeedCommands: {
            low: { type: String, trim: true, default: "" },
            medium: { type: String, trim: true, default: "" },
            high: { type: String, trim: true, default: "" },
            ultra: { type: String, trim: true, default: "" },
            turbo: { type: String, trim: true, default: "" },
        },
    },
    { timestamps: true }
);

const brandModel = mongoose.model("Brand", brandSchema);

module.exports = brandModel;
