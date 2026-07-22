const Device = require("../models/deviceModel");
const Organization = require("../models/organizationModel");
const Venue = require("../models/venueModel");
const Brand = require("../models/brandModel");
const checkSubscriptionLimit = require("../middlewares/subscriptionLimit");
const {
    createDeviceSchema,
    updateDeviceSchema,
    setDevicePowerSchema,
    setDeviceTemperatureSchema,
} = require("../validations/deviceValidation");
const { publishDeviceApplyCommand } = require("../mqtt/mqttConfig");
const { brandDocumentToCommandsMap } = require("../utils/brandCommandMap");

const DEVICE_ID_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateDeviceId() {
    let id = "";
    for (let i = 0; i < 6; i += 1) {
        id += DEVICE_ID_CHARS.charAt(
            Math.floor(Math.random() * DEVICE_ID_CHARS.length)
        );
    }
    return id;
}

async function generateUniqueDeviceId() {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        const deviceId = generateDeviceId();
        if (!(await Device.exists({ deviceId }))) return deviceId;
    }
    throw new Error("Unable to generate a unique device id");
}

function hasOrganizationAccess(user, organization) {
    if (user.role === "admin") return true;
    if (String(organization.owner) === String(user._id)) return true;
    return (user.organizations || []).some(
        (id) => String(id) === String(organization._id)
    );
}

function hasVenueAccess(user, venueId) {
    if (user.role !== "user") return true;
    return (user.venues || []).some(
        (entry) => String(entry.venueId || entry) === String(venueId)
    );
}

const createDevice = async (req, res) => {
    try {
        const data = createDeviceSchema.parse(req.body);

        const [organization, venue, brand] = await Promise.all([
            Organization.findById(data.organization),
            Venue.findById(data.venue),
            Brand.findById(data.brand),
        ]);

        if (!organization) {
            return res.status(404).json({
                success: false,
                message: "Organization not found",
            });
        }
        if (!venue) {
            return res.status(404).json({
                success: false,
                message: "Venue not found",
            });
        }
        if (!brand) {
            return res.status(404).json({
                success: false,
                message: "AC brand not found",
            });
        }

        if (String(venue.organization) !== String(organization._id)) {
            return res.status(400).json({
                success: false,
                message: "Selected venue does not belong to the organization",
            });
        }

        if (!hasOrganizationAccess(req.user, organization)) {
            return res.status(403).json({
                success: false,
                message: "You cannot add devices to this organization",
            });
        }

        if (!hasVenueAccess(req.user, venue._id)) {
            return res.status(403).json({
                success: false,
                message: "You cannot add devices to this venue",
            });
        }

        // Device name must be unique within the same venue (case-insensitive)
        const duplicateName = await Device.findOne({
            venue: venue._id,
            deviceName: {
                $regex: new RegExp(
                    `^${data.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
                    "i"
                ),
            },
        });
        if (duplicateName) {
            return res.status(400).json({
                success: false,
                message: "A device with this name already exists in this venue",
            });
        }

        if (req.user.role !== "admin") {
            await checkSubscriptionLimit("device")(req, res, () => {});
            if (res.headersSent) return;
        }

        const deviceId = await generateUniqueDeviceId();
        const apikey = Buffer.from(deviceId, "utf8").toString("base64");

        const device = await Device.create({
            deviceId,
            apikey,
            deviceName: data.name,
            organization: organization._id,
            venue: venue._id,
            brand: brand._id,
            capacity: data.capacity,
        });

        await device.populate([
            { path: "organization", select: "name" },
            { path: "venue", select: "name organization" },
            { path: "brand", select: "brandName" },
        ]);

        return res.status(201).json({
            success: true,
            message: "Device created successfully",
            device,
        });
    } catch (error) {
        if (error.name === "ZodError") {
            return res.status(400).json({
                success: false,
                message: "Validation failed",
                errors: error.issues.map((issue) => ({
                    field: issue.path.join("."),
                    message: issue.message,
                })),
            });
        }
        if (error.code === 11000) {
            if (error.keyPattern?.deviceName) {
                return res.status(400).json({
                    success: false,
                    message: "A device with this name already exists in this venue",
                });
            }
            return res.status(409).json({
                success: false,
                message: "Generated device id already exists. Please try again.",
            });
        }

        console.error("Create Device Error:", error);
        return res.status(500).json({
            success: false,
            message: "Server error while creating device",
        });
    }
};

const getDeviceBrandOptions = async (_req, res) => {
    try {
        const brands = await Brand.find()
            .select("_id brandName")
            .sort({ brandName: 1 });

        return res.status(200).json({
            success: true,
            count: brands.length,
            brands,
        });
    } catch (error) {
        console.error("Get Device Brand Options Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to load AC brands",
        });
    }
};

// GET /api/device/by-venue/:venueId
const getDevicesByVenue = async (req, res) => {
    try {
        const { venueId } = req.params;

        if (!venueId || !/^[0-9a-fA-F]{24}$/.test(venueId)) {
            return res.status(400).json({
                success: false,
                message: "Valid venue id is required",
            });
        }

        const venue = await Venue.findById(venueId).populate("organization", "name owner");
        if (!venue) {
            return res.status(404).json({
                success: false,
                message: "Venue not found",
            });
        }

        const organization = venue.organization;
        if (!organization) {
            return res.status(404).json({
                success: false,
                message: "Organization for this venue was not found",
            });
        }

        if (!hasOrganizationAccess(req.user, organization)) {
            return res.status(403).json({
                success: false,
                message: "You cannot view devices for this venue",
            });
        }

        if (!hasVenueAccess(req.user, venue._id)) {
            return res.status(403).json({
                success: false,
                message: "You cannot view devices for this venue",
            });
        }

        const devices = await Device.find({ venue: venue._id })
            .populate("organization", "name")
            .populate("venue", "name organization")
            .populate("brand", "brandName")
            .sort({ createdAt: -1 });

        return res.status(200).json({
            success: true,
            count: devices.length,
            devices,
        });
    } catch (error) {
        console.error("Get Devices By Venue Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to load devices for this venue",
        });
    }
};

async function resolveDeviceAccessTargets(data) {
    const [organization, venue, brand] = await Promise.all([
        Organization.findById(data.organization),
        Venue.findById(data.venue),
        Brand.findById(data.brand),
    ]);

    return { organization, venue, brand };
}

// PUT /api/device/update/:id
const updateDevice = async (req, res) => {
    try {
        const { id } = req.params;
        if (!id || !/^[0-9a-fA-F]{24}$/.test(id)) {
            return res.status(400).json({
                success: false,
                message: "Valid device id is required",
            });
        }

        const data = updateDeviceSchema.parse(req.body);
        const device = await Device.findById(id);
        if (!device) {
            return res.status(404).json({
                success: false,
                message: "Device not found",
            });
        }

        const currentOrganization = await Organization.findById(device.organization);
        if (
            currentOrganization &&
            !hasOrganizationAccess(req.user, currentOrganization)
        ) {
            return res.status(403).json({
                success: false,
                message: "You cannot edit this device",
            });
        }
        if (!hasVenueAccess(req.user, device.venue)) {
            return res.status(403).json({
                success: false,
                message: "You cannot edit this device",
            });
        }

        const { organization, venue, brand } = await resolveDeviceAccessTargets(data);

        if (!organization) {
            return res.status(404).json({
                success: false,
                message: "Organization not found",
            });
        }
        if (!venue) {
            return res.status(404).json({
                success: false,
                message: "Venue not found",
            });
        }
        if (!brand) {
            return res.status(404).json({
                success: false,
                message: "AC brand not found",
            });
        }

        if (String(venue.organization) !== String(organization._id)) {
            return res.status(400).json({
                success: false,
                message: "Selected venue does not belong to the organization",
            });
        }

        if (!hasOrganizationAccess(req.user, organization)) {
            return res.status(403).json({
                success: false,
                message: "You cannot move this device to that organization",
            });
        }

        if (!hasVenueAccess(req.user, venue._id)) {
            return res.status(403).json({
                success: false,
                message: "You cannot move this device to that venue",
            });
        }

        const duplicateName = await Device.findOne({
            _id: { $ne: device._id },
            venue: venue._id,
            deviceName: {
                $regex: new RegExp(
                    `^${data.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
                    "i"
                ),
            },
        });
        if (duplicateName) {
            return res.status(400).json({
                success: false,
                message: "A device with this name already exists in this venue",
            });
        }

        device.deviceName = data.name;
        device.organization = organization._id;
        device.venue = venue._id;
        device.brand = brand._id;
        device.capacity = data.capacity;
        await device.save();

        await device.populate([
            { path: "organization", select: "name" },
            { path: "venue", select: "name organization" },
            { path: "brand", select: "brandName" },
        ]);

        return res.status(200).json({
            success: true,
            message: "Device updated successfully",
            device,
        });
    } catch (error) {
        if (error.name === "ZodError") {
            return res.status(400).json({
                success: false,
                message: "Validation failed",
                errors: error.issues.map((issue) => ({
                    field: issue.path.join("."),
                    message: issue.message,
                })),
            });
        }
        if (error.code === 11000) {
            return res.status(400).json({
                success: false,
                message: "A device with this name already exists in this venue",
            });
        }

        console.error("Update Device Error:", error);
        return res.status(500).json({
            success: false,
            message: "Server error while updating device",
        });
    }
};

// DELETE /api/device/delete/:id
const deleteDevice = async (req, res) => {
    try {
        const { id } = req.params;
        if (!id || !/^[0-9a-fA-F]{24}$/.test(id)) {
            return res.status(400).json({
                success: false,
                message: "Valid device id is required",
            });
        }

        const device = await Device.findById(id);
        if (!device) {
            return res.status(404).json({
                success: false,
                message: "Device not found",
            });
        }

        const organization = await Organization.findById(device.organization);
        if (organization && !hasOrganizationAccess(req.user, organization)) {
            return res.status(403).json({
                success: false,
                message: "You cannot delete this device",
            });
        }
        if (!hasVenueAccess(req.user, device.venue)) {
            return res.status(403).json({
                success: false,
                message: "You cannot delete this device",
            });
        }

        await Device.findByIdAndDelete(id);

        return res.status(200).json({
            success: true,
            message: "Device deleted successfully",
        });
    } catch (error) {
        console.error("Delete Device Error:", error);
        return res.status(500).json({
            success: false,
            message: "Server error while deleting device",
        });
    }
};

// POST /api/device/power/:id  body: { state: "on" | "off" }
const setDevicePower = async (req, res) => {
    try {
        const { id } = req.params;
        if (!id || !/^[0-9a-fA-F]{24}$/.test(id)) {
            return res.status(400).json({
                success: false,
                message: "Valid device id is required",
            });
        }

        const data = setDevicePowerSchema.parse(req.body);
        const device = await Device.findById(id).populate("brand");
        if (!device) {
            return res.status(404).json({
                success: false,
                message: "Device not found",
            });
        }

        const organization = await Organization.findById(device.organization);
        if (organization && !hasOrganizationAccess(req.user, organization)) {
            return res.status(403).json({
                success: false,
                message: "You cannot control this device",
            });
        }
        if (!hasVenueAccess(req.user, device.venue)) {
            return res.status(403).json({
                success: false,
                message: "You cannot control this device",
            });
        }

        if (device.status !== "online") {
            return res.status(409).json({
                success: false,
                message: "Device is offline. Turn it on before sending power commands.",
            });
        }

        const commandKey = data.state === "on" ? "power.on" : "power.off";
        const published = publishDeviceApplyCommand(device.deviceId, {
            key: commandKey,
            state: data.state,
        });

        if (!published) {
            return res.status(503).json({
                success: false,
                message: "MQTT broker unavailable. Could not reach the device.",
            });
        }

        return res.status(200).json({
            success: true,
            message: `Power ${data.state} command sent to device`,
            deviceId: device.deviceId,
            requestedState: data.state,
            // Actual Mongo state updates when ESP reports back via MQTT
            currentState: device.state,
        });
    } catch (error) {
        if (error.name === "ZodError") {
            return res.status(400).json({
                success: false,
                message: "Validation failed",
                errors: error.issues.map((issue) => ({
                    field: issue.path.join("."),
                    message: issue.message,
                })),
            });
        }
        console.error("Set Device Power Error:", error);
        return res.status(500).json({
            success: false,
            message: "Server error while controlling device power",
        });
    }
};

// POST /api/device/temperature/:id  body: { temperature: 16..30 }
const setDeviceTemperature = async (req, res) => {
    try {
        const { id } = req.params;
        if (!id || !/^[0-9a-fA-F]{24}$/.test(id)) {
            return res.status(400).json({
                success: false,
                message: "Valid device id is required",
            });
        }

        const data = setDeviceTemperatureSchema.parse(req.body);
        const device = await Device.findById(id).populate("brand");
        if (!device) {
            return res.status(404).json({
                success: false,
                message: "Device not found",
            });
        }

        const organization = await Organization.findById(device.organization);
        if (organization && !hasOrganizationAccess(req.user, organization)) {
            return res.status(403).json({
                success: false,
                message: "You cannot control this device",
            });
        }
        if (!hasVenueAccess(req.user, device.venue)) {
            return res.status(403).json({
                success: false,
                message: "You cannot control this device",
            });
        }

        if (device.status !== "online") {
            return res.status(409).json({
                success: false,
                message: "Device is offline. Connect it before setting temperature.",
            });
        }

        const commandKey = `temp.${data.temperature}`;
        const brandCommands = brandDocumentToCommandsMap(device.brand);
        if (!brandCommands[commandKey]) {
            return res.status(400).json({
                success: false,
                message: `No IR command saved for ${commandKey} on this device's brand`,
            });
        }

        const published = publishDeviceApplyCommand(device.deviceId, {
            key: commandKey,
            state: device.state === "on" ? "on" : "off",
            temperature: data.temperature,
        });

        if (!published) {
            return res.status(503).json({
                success: false,
                message: "MQTT broker unavailable. Could not reach the device.",
            });
        }

        return res.status(200).json({
            success: true,
            message: `Temperature ${data.temperature}°C command sent to device`,
            deviceId: device.deviceId,
            requestedTemperature: data.temperature,
            currentTemperature: device.temperature,
        });
    } catch (error) {
        if (error.name === "ZodError") {
            return res.status(400).json({
                success: false,
                message: "Validation failed",
                errors: error.issues.map((issue) => ({
                    field: issue.path.join("."),
                    message: issue.message,
                })),
            });
        }
        console.error("Set Device Temperature Error:", error);
        return res.status(500).json({
            success: false,
            message: "Server error while controlling device temperature",
        });
    }
};

module.exports = {
    createDevice,
    getDeviceBrandOptions,
    getDevicesByVenue,
    updateDevice,
    deleteDevice,
    setDevicePower,
    setDeviceTemperature,
};
