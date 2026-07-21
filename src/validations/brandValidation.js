const { z } = require("zod");

/** Non-empty IR pulse string when a command is included */
const pulseValueSchema = z
    .string({ required_error: "Pulse value is required" })
    .trim()
    .min(1, "Pulse value cannot be empty");

/** Optional command: omit / null / "" = brand does not use this key */
const optionalPulseSchema = z
    .union([pulseValueSchema, z.literal(""), z.null(), z.undefined()])
    .optional()
    .transform((v) => (v == null || v === "" ? "" : v));

const powerCommandsSchema = z.object({
    on: pulseValueSchema,
    off: pulseValueSchema,
});

const modesSchema = z
    .object({
        cool: optionalPulseSchema,
        heat: optionalPulseSchema,
        dry: optionalPulseSchema,
        fanOnly: optionalPulseSchema,
        smartAuto: optionalPulseSchema,
        // frontend aliases accepted and normalized in controller
        fan: optionalPulseSchema,
        auto: optionalPulseSchema,
    })
    .partial()
    .optional()
    .default({});

const temperatureCommandsSchema = z
    .object({
        sixteen: optionalPulseSchema,
        seventeen: optionalPulseSchema,
        eighteen: optionalPulseSchema,
        nineteen: optionalPulseSchema,
        twenty: optionalPulseSchema,
        twentyOne: optionalPulseSchema,
        twentyTwo: optionalPulseSchema,
        twentyThree: optionalPulseSchema,
        twentyFour: optionalPulseSchema,
        twentyFive: optionalPulseSchema,
        twentySix: optionalPulseSchema,
        twentySeven: optionalPulseSchema,
        twentyEight: optionalPulseSchema,
        twentyNine: optionalPulseSchema,
        thirty: optionalPulseSchema,
    })
    .partial()
    .optional()
    .default({});

const fanSpeedCommandsSchema = z
    .object({
        low: optionalPulseSchema,
        medium: optionalPulseSchema,
        high: optionalPulseSchema,
        ultra: optionalPulseSchema,
        turbo: optionalPulseSchema,
    })
    .partial()
    .optional()
    .default({});

/**
 * Flat dotted map, e.g.:
 * { "power.on": "...", "power.off": "...", "temp.24": "...", "mode.cool": "...", "fan.low": "..." }
 * Only included keys must have non-empty pulses. power.on + power.off are required.
 */
const dottedCommandsSchema = z
    .record(z.string(), pulseValueSchema)
    .superRefine((commands, ctx) => {
        if (!commands["power.on"]) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "power.on pulse is required",
                path: ["power.on"],
            });
        }
        if (!commands["power.off"]) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "power.off pulse is required",
                path: ["power.off"],
            });
        }

        const allowed = new Set([
            "power.on",
            "power.off",
            "mode.cool",
            "mode.heat",
            "mode.dry",
            "mode.fan",
            "mode.auto",
            "mode.fanOnly",
            "mode.smartAuto",
            "fan.low",
            "fan.medium",
            "fan.high",
            "fan.ultra",
            "fan.turbo",
            ...Array.from({ length: 15 }, (_, i) => `temp.${i + 16}`),
        ]);

        for (const key of Object.keys(commands)) {
            if (!allowed.has(key)) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    message: `Unknown command key: ${key}`,
                    path: [key],
                });
            }
        }
    });

/**
 * Save brand body.
 * Prefer nested schema fields OR flat `commands` map (power.on style).
 * Also accepts legacy `signals` from the admin UI.
 *
 * Required: configureId, brandName, power on + off pulses.
 * Optional: each mode / temp 16–30 / fan speed (omit keys the brand does not support).
 * If a key is sent, its pulse value must be non-empty.
 */
const saveBrandSchema = z
    .object({
        configureId: z
            .string({ required_error: "configureId is required" })
            .trim()
            .min(1, "configureId is required"),
        brandName: z
            .string({ required_error: "brandName is required" })
            .trim()
            .min(1, "brandName is required")
            .max(100, "brandName is too long")
            .transform((name) => name.toLowerCase()),

        // Nested (schema-shaped)
        powerCommands: powerCommandsSchema.optional(),
        modes: modesSchema,
        temperatureCommands: temperatureCommandsSchema,
        fanSpeedCommands: fanSpeedCommandsSchema,

        // Flat dotted keys
        commands: dottedCommandsSchema.optional(),

        // Legacy frontend shape
        signals: z
            .object({
                powerOn: z.union([pulseValueSchema, z.literal(""), z.null()]).optional(),
                powerOff: z.union([pulseValueSchema, z.literal(""), z.null()]).optional(),
                temperatures: z.record(z.string(), z.union([pulseValueSchema, z.literal(""), z.null()])).optional(),
                fanSpeeds: z
                    .object({
                        low: optionalPulseSchema,
                        medium: optionalPulseSchema,
                        high: optionalPulseSchema,
                        ultra: optionalPulseSchema,
                        turbo: optionalPulseSchema,
                    })
                    .partial()
                    .optional(),
                modes: z
                    .object({
                        cool: optionalPulseSchema,
                        heat: optionalPulseSchema,
                        dry: optionalPulseSchema,
                        fan: optionalPulseSchema,
                        auto: optionalPulseSchema,
                    })
                    .partial()
                    .optional(),
            })
            .optional(),
    })
    .superRefine((data, ctx) => {
        const hasNestedPower = data.powerCommands?.on && data.powerCommands?.off;
        const hasDottedPower = data.commands?.["power.on"] && data.commands?.["power.off"];
        const hasSignalsPower =
            data.signals?.powerOn &&
            String(data.signals.powerOn).trim() &&
            data.signals?.powerOff &&
            String(data.signals.powerOff).trim();

        if (!hasNestedPower && !hasDottedPower && !hasSignalsPower) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "power.on and power.off pulses are required (map Device ON and Device OFF before saving)",
                path: ["powerCommands"],
            });
        }
    });

module.exports = {
    saveBrandSchema,
    pulseValueSchema,
    optionalPulseSchema,
};
