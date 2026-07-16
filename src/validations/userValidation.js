const { z } = require("zod");

// Validation Schemas
const registerSchema = z.object({
    name: z.string().min(2),
    email: z.string().email(),
    password: z.string().min(8),
});

const adminCreateUserSchema = z.object({
    name: z.string().min(2),
    email: z.string().email(),
});

const createSubUserSchema = z.object({
    name: z.string().min(2),
    email: z.string().email(),
    role: z.literal("user"),
    organizations: z.array(z.string()).min(1, "At least one organization is required"),
    venues: z.array(z.string()).optional(), // Venue IDs
    permission: z.enum(["view", "manage"]).default("view"),
    timer: z.string().optional()
});


module.exports = { registerSchema, adminCreateUserSchema, createSubUserSchema };