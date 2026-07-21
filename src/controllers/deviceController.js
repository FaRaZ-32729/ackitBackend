const Device = require("../models/deviceModel");
const Organization = require("../models/organizationModel");
const Venue = require("../models/venueModel");
const Brand = require("../models/brandModel");
const checkSubscriptionLimit = require("../middlewares/subscriptionLimit");
const { createDeviceSchema } = require("../validations/deviceValidation");

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

        const device = await Device.create({
            deviceId: await generateUniqueDeviceId(),
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

module.exports = {
    createDevice,
    getDeviceBrandOptions,
};
