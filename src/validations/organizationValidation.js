const { z } = require("zod");

const createOrganizationSchema = z.object({
    name: z.string().min(3, "Organization name must be at least 3 characters"),
});

module.exports = { createOrganizationSchema };