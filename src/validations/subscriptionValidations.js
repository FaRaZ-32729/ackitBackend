const z = require("zod");

const createPlanSchema = z.object({
    name: z.string(),

    type: z.enum(["free", "basic", "premium", "custom"]),

    description: z.string().min(5).optional(),

    price: z.number().min(0, "Price must be 0 or greater"),

    durationDays: z.number()
        .positive("Duration must be greater than 0")
        .int("Duration must be a whole number"),

    maxOrganizations: z.number()
        .positive("Max organizations must be greater than 0")
        .int(),

    maxVenues: z.number()
        .positive("Max venues must be greater than 0")
        .int(),

    maxDevices: z.number()
        .positive("Max devices must be greater than 0")
        .int(),

    maxUsers: z.number().positive("Max users must be greater than 0").int(),

    // Optional: Only used when creating custom plan for a specific user
    assignedToEmail: z.string()
        .email("Invalid email format")
        .optional(),

}).refine((data) => {
    // Extra validation for Free Plan
    if (data.name === "free" && data.durationDays !== 15) {
        return false;
    }
    return true;
}, {
    message: "Free plan must have exactly 15 days duration",
    path: ["durationDays"]
});


const purchaseSubscriptionSchema = z.object({
    planId: z.string().min(1)
});

module.exports = {
    createPlanSchema,
    purchaseSubscriptionSchema
};