const { z } = require("zod");

const createVenueSchema = z.object({
    name: z.string()
        .min(2, "Venue name must be at least 2 characters")
        .max(100, "Venue name is too long"),

    organization: z.string()
        .min(1, "Organization ID is required")
        .regex(/^[0-9a-fA-F]{24}$/, "Invalid Organization ID format")
});

const updateVenueSchema = z.object({
    name: z.string().min(2).max(100).optional(),
    description: z.string().max(500).optional(),
    organization: z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid Organization ID").optional()
});

module.exports = {
    createVenueSchema,
    updateVenueSchema
};