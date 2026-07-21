const Brand = require("../models/brandModel");
const {
    createSession,
    getSession,
    hasPendingConfigureId,
    setPendingField,
    clearDraftField,
    deleteSession,
} = require("../services/brandConfigureSession");
const {
    parseCommandSelector,
    toFrontendSignals,
    resolveSaveCommands,
} = require("../utils/brandCommandMap");
const { saveBrandSchema } = require("../validations/brandValidation");
const { publishBrandCommand } = require("../mqtt/mqttConfig");

const CONFIGURE_ID_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateConfigureCode() {
    let code = "";
    for (let i = 0; i < 6; i += 1) {
        code += CONFIGURE_ID_CHARS.charAt(Math.floor(Math.random() * CONFIGURE_ID_CHARS.length));
    }
    return code;
}

async function createUniqueConfigureId() {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        const configureId = generateConfigureCode();
        if (hasPendingConfigureId(configureId)) continue;

        const exists = await Brand.exists({ configureId });
        if (!exists) return configureId;
    }
    throw new Error("Unable to generate a unique configure id");
}

function zodErrorResponse(res, error) {
    return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: error.issues.map((err) => ({
            field: err.path.join(".") || "body",
            message: err.message,
        })),
    });
}

// POST /api/brand/configure — generate pairing code only (not saved to DB yet)
const createConfigureId = async (req, res) => {
    try {
        const configureId = await createUniqueConfigureId();
        createSession(configureId, req.user._id);

        return res.status(201).json({
            success: true,
            message: "Configure code generated. Use it to pair the IR receiver via MQTT.",
            configureId,
        });
    } catch (error) {
        console.error("Create Configure ID Error:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Failed to generate configure code",
        });
    }
};

// POST /api/brand/select-command — admin selected a UI button; next IR pulse maps here
const selectCommand = async (req, res) => {
    try {
        const { configureId, command } = req.body;

        if (!configureId) {
            return res.status(400).json({ success: false, message: "configureId is required" });
        }

        const session = getSession(configureId);
        if (!session) {
            return res.status(404).json({
                success: false,
                message: "Configure session not found or expired. Click Configure again.",
            });
        }

        if (String(session.adminUserId) !== String(req.user._id) && req.user.role !== "admin") {
            return res.status(403).json({ success: false, message: "Not your configure session" });
        }

        const parsed = parseCommandSelector(command);
        if (parsed.error) {
            return res.status(400).json({ success: false, message: parsed.error });
        }

        setPendingField(configureId, { group: parsed.group, key: parsed.key });

        return res.status(200).json({
            success: true,
            message: "Waiting for IR pulse from device",
            configureId,
            pendingField: parsed,
            deviceConnected: session.deviceConnected,
        });
    } catch (error) {
        console.error("Select Command Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to select command target",
        });
    }
};

// POST /api/brand/clear-command — clear one mapped field in the live session
const clearCommand = async (req, res) => {
    try {
        const { configureId, command } = req.body;
        const session = getSession(configureId);
        if (!session) {
            return res.status(404).json({ success: false, message: "Configure session not found" });
        }

        const parsed = parseCommandSelector(command);
        if (parsed.error) {
            return res.status(400).json({ success: false, message: parsed.error });
        }

        clearDraftField(configureId, parsed.group, parsed.key);

        return res.status(200).json({
            success: true,
            message: "Command cleared",
            signals: toFrontendSignals(getSession(configureId).draft),
        });
    } catch (error) {
        console.error("Clear Command Error:", error);
        return res.status(500).json({ success: false, message: "Failed to clear command" });
    }
};

// GET /api/brand/session/:configureId
const getConfigureSession = async (req, res) => {
    try {
        const session = getSession(req.params.configureId);
        if (!session) {
            return res.status(404).json({ success: false, message: "Session not found" });
        }

        return res.status(200).json({
            success: true,
            configureId: session.configureId,
            deviceConnected: session.deviceConnected,
            pendingField: session.pendingField,
            signals: toFrontendSignals(session.draft),
        });
    } catch (error) {
        console.error("Get Session Error:", error);
        return res.status(500).json({ success: false, message: "Failed to load session" });
    }
};

// POST /api/brand/save — persist brand + all trained command pulses
const saveBrand = async (req, res) => {
    try {
        const parsed = saveBrandSchema.safeParse(req.body);
        if (!parsed.success) {
            return zodErrorResponse(res, parsed.error);
        }

        const data = parsed.data;
        const configureId = data.configureId.trim();
        // Always normalize to lowercase before uniqueness check and save
        const brandName = String(data.brandName).trim().toLowerCase();

        const existingName = await Brand.findOne({ brandName });
        if (existingName) {
            return res.status(400).json({
                success: false,
                message: "A brand with this name already exists",
            });
        }

        const existingConfigure = await Brand.findOne({ configureId });
        if (existingConfigure) {
            return res.status(400).json({
                success: false,
                message: "This configure id is already linked to a saved brand",
            });
        }

        const commands = resolveSaveCommands(data);
        if (!commands) {
            return res.status(400).json({
                success: false,
                message: "No command pulses provided. Send commands / powerCommands / signals in the body.",
            });
        }

        if (!commands.powerCommands.on || !commands.powerCommands.off) {
            return res.status(400).json({
                success: false,
                message: "power.on and power.off pulses are required before saving",
            });
        }

        const brand = await Brand.create({
            configureId,
            brandName,
            powerCommands: commands.powerCommands,
            modes: commands.modes,
            temperatureCommands: commands.temperatureCommands,
            fanSpeedCommands: commands.fanSpeedCommands,
        });

        deleteSession(configureId);

        return res.status(201).json({
            success: true,
            message: "Brand saved successfully",
            brand,
        });
    } catch (error) {
        if (error.code === 11000) {
            return res.status(400).json({
                success: false,
                message: "Brand name or configure id already exists",
            });
        }
        console.error("Save Brand Error:", error);
        return res.status(500).json({ success: false, message: "Failed to save brand" });
    }
};

// POST /api/brand/apply — publish a command so the ESP re-transmits it to the AC.
// Works for saved brands and for live training sessions (verify before save).
const applyCommand = async (req, res) => {
    try {
        const { configureId, command } = req.body;

        if (!configureId) {
            return res.status(400).json({ success: false, message: "configureId is required" });
        }

        const parsed = parseCommandSelector(command);
        if (parsed.error) {
            return res.status(400).json({ success: false, message: parsed.error });
        }

        // Prefer the live training session draft, fall back to the saved brand
        const session = getSession(configureId);
        let value = session?.draft?.[parsed.group]?.[parsed.key] || "";

        if (!value) {
            const brand = await Brand.findOne({ configureId });
            value = brand?.[parsed.group]?.[parsed.key] || "";
        }

        if (!value) {
            return res.status(404).json({
                success: false,
                message: "This command is not trained yet",
            });
        }

        const sent = publishBrandCommand(configureId, value);
        if (!sent) {
            return res.status(503).json({
                success: false,
                message: "MQTT is not connected. Could not send command.",
            });
        }

        return res.status(200).json({
            success: true,
            message: "Command sent to device",
            command,
            value,
        });
    } catch (error) {
        console.error("Apply Command Error:", error);
        return res.status(500).json({ success: false, message: "Failed to apply command" });
    }
};

// GET /api/brand/all
const getAllBrands = async (_req, res) => {
    try {
        const brands = await Brand.find().sort({ createdAt: -1 });
        return res.status(200).json({
            success: true,
            brands,
            count: brands.length,
        });
    } catch (error) {
        console.error("Get Brands Error:", error);
        return res.status(500).json({ success: false, message: "Failed to fetch brands" });
    }
};

// DELETE /api/brand/:id
const deleteBrand = async (req, res) => {
    try {
        const brand = await Brand.findByIdAndDelete(req.params.id);
        if (!brand) {
            return res.status(404).json({ success: false, message: "Brand not found" });
        }
        return res.status(200).json({
            success: true,
            message: "Brand deleted",
        });
    } catch (error) {
        console.error("Delete Brand Error:", error);
        return res.status(500).json({ success: false, message: "Failed to delete brand" });
    }
};

module.exports = {
    createConfigureId,
    selectCommand,
    clearCommand,
    getConfigureSession,
    saveBrand,
    applyCommand,
    getAllBrands,
    deleteBrand,
};
