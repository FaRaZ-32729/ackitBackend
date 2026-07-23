const { z } = require("zod");

const objectId = z
    .string()
    .trim()
    .regex(/^[0-9a-fA-F]{24}$/, "Invalid ID format");

const createDeviceSchema = z.object({
    name: z
        .string()
        .trim()
        .min(2, "Device name must be at least 2 characters")
        .max(100, "Device name is too long"),
    organization: objectId,
    venue: objectId,
    brand: objectId,
    capacity: z.coerce
        .number()
        .refine(
            (value) =>
                [1, 1.5, 2, 2.5, 3, 3.5].some(
                    (allowed) => Math.abs(allowed - value) < 0.001
                ),
            "Capacity must be one of 1.0, 1.5, 2.0, 2.5, 3.0 or 3.5 tons"
        ),
    voltage: z.coerce
        .number({
            invalid_type_error: "voltage must be a number",
        })
        .min(100, "voltage must be at least 100")
        .max(400, "voltage must be at most 400")
        .optional()
        .default(230),
});

const updateDeviceSchema = createDeviceSchema;

const setDevicePowerSchema = z.object({
    state: z.enum(["on", "off"], {
        required_error: "state is required",
        invalid_type_error: "state must be on or off",
    }),
});

const setDeviceTemperatureSchema = z.object({
    temperature: z.coerce
        .number({
            required_error: "temperature is required",
            invalid_type_error: "temperature must be a number",
        })
        .int("temperature must be a whole number")
        .min(16, "temperature must be at least 16")
        .max(30, "temperature must be at most 30"),
});

const setDeviceRemoteSchema = z.object({
    remote: z.enum(["unlock", "lock", "superlock"], {
        required_error: "remote is required",
        invalid_type_error: "remote must be unlock, lock, or superlock",
    }),
});

const setDeviceModeSchema = z.object({
    mode: z.enum(["cool", "heat", "dry", "fan", "auto"], {
        required_error: "mode is required",
        invalid_type_error: "mode must be cool, heat, dry, fan, or auto",
    }),
});

const setDeviceFanSchema = z.object({
    fan: z.enum(["low", "medium", "high", "ultra", "turbo"], {
        required_error: "fan is required",
        invalid_type_error: "fan must be low, medium, high, ultra, or turbo",
    }),
});

module.exports = {
    createDeviceSchema,
    updateDeviceSchema,
    setDevicePowerSchema,
    setDeviceTemperatureSchema,
    setDeviceRemoteSchema,
    setDeviceModeSchema,
    setDeviceFanSchema,
};
