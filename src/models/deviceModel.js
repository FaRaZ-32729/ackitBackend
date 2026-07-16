// models/deviceModel.js
const mongoose = require("mongoose");


const deviceSchema = new mongoose.Schema({
    deviceId: { type: String, required: true, unique: true, trim: true },
    deviceName: { type: String, required: true, trim: true },
}, { timestamps: true });



const Device = mongoose.model("Device", deviceSchema);
module.exports = Device;