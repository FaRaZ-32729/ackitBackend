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
            (value) => [1, 1.5, 2, 2.5, 3, 3.5].includes(value),
            "Capacity must be one of 1.0, 1.5, 2.0, 2.5, 3.0 or 3.5 tons"
        ),
});

module.exports = { createDeviceSchema };
