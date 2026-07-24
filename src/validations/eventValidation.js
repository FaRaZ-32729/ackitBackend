const { z } = require("zod");

const dayEnum = z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);

const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/;

const createEventSchema = z
    .object({
        name: z.string().trim().min(1).max(120),
        scope: z.enum(["device", "venue", "organization"]),
        organizationId: z.string().regex(/^[0-9a-fA-F]{24}$/),
        venueId: z
            .string()
            .regex(/^[0-9a-fA-F]{24}$/)
            .optional()
            .nullable(),
        deviceId: z
            .string()
            .regex(/^[0-9a-fA-F]{24}$/)
            .optional()
            .nullable(),
        action: z.enum(["ON", "OFF"]),
        targetTemp: z.number().int().min(16).max(30).optional().nullable(),
        startTime: z.string().regex(timeRegex, "startTime must be HH:mm"),
        endTime: z.string().regex(timeRegex, "endTime must be HH:mm"),
        days: z.array(dayEnum).default([]),
        remote: z.enum(["lock", "unlock"]).optional().default("unlock"),
        /**
         * Browser Date#getTimezoneOffset() — minutes to add to local to get UTC.
         * Required so start/end/days are stored and scheduled in UTC.
         */
        timezoneOffsetMinutes: z.number().int().min(-840).max(840),
    })
    .superRefine((data, ctx) => {
        // Empty days = one-time event; non-empty = recurring
        if (data.scope === "device" && !data.deviceId) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "deviceId is required for device events",
                path: ["deviceId"],
            });
        }
        if (data.scope === "venue" && !data.venueId) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "venueId is required for venue events",
                path: ["venueId"],
            });
        }
        if (data.action === "ON" && (data.targetTemp == null || data.targetTemp === undefined)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "targetTemp is required for ON events",
                path: ["targetTemp"],
            });
        }
    });

module.exports = {
    createEventSchema,
};
