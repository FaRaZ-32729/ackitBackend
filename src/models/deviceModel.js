// models/deviceModel.js
const mongoose = require("mongoose");


const deviceSchema = new mongoose.Schema({
    deviceId: { type: String, required: true, unique: true, trim: true },
    deviceName: { type: String, required: true, trim: true },
    status: { type: String, enum: ["online", "offline"], trim: true, default: "offline" },
    state:{type:String, enum:["on","off"], trim: true, default: "off"},
    brand:{type:mongoose.Schema.Types.ObjectId, ref:"Brand", required:true},
    capacity:{type:Number, required:true},
    version:{type:String, default:"0.0.0"},
    remote:{type:String, enum:["lock","unlock", "superlock" ], trim: true, default: "unlock"},
    apikey:{type:String},
    venue:{type:mongoose.Schema.Types.ObjectId, ref:"Venue", required:true},
    temprature:{type:Number, enum:["16","17","18","19","20","21","22","23","24","25","26","27","28","29","30"], default:0},
    powerConsumption:{type:Number, default:0},
}, { timestamps: true });



const Device = mongoose.model("Device", deviceSchema);
module.exports = Device;