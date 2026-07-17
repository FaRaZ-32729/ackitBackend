const { z } = require("zod");

const optionalAddress = z
    .string()
    .trim()
    .optional()
    .transform((val) => (val ? val : undefined));

const createOrganizationSchema = z.object({
    name: z.string().min(3, "Organization name must be at least 3 characters"),
    address: optionalAddress,
});

const updateOrganizationSchema = z.object({
    name: z.string().min(3, "Organization name must be at least 3 characters"),
    address: z
        .string()
        .trim()
        .optional()
        .transform((val) => (val === undefined ? undefined : val)),
});

module.exports = { createOrganizationSchema, updateOrganizationSchema };
