const TEMP_WORD_BY_C = {
    16: "sixteen",
    17: "seventeen",
    18: "eighteen",
    19: "nineteen",
    20: "twenty",
    21: "twentyOne",
    22: "twentyTwo",
    23: "twentyThree",
    24: "twentyFour",
    25: "twentyFive",
    26: "twentySix",
    27: "twentySeven",
    28: "twentyEight",
    29: "twentyNine",
    30: "thirty",
};

const TEMP_C_BY_WORD = Object.fromEntries(
    Object.entries(TEMP_WORD_BY_C).map(([c, word]) => [word, Number(c)])
);

const MODE_FRONTEND_TO_SCHEMA = {
    cool: "cool",
    heat: "heat",
    dry: "dry",
    fan: "fanOnly",
    auto: "smartAuto",
};

const MODE_SCHEMA_TO_FRONTEND = {
    cool: "cool",
    heat: "heat",
    dry: "dry",
    fanOnly: "fan",
    smartAuto: "auto",
};

/**
 * Parse UI / API command selectors into schema { group, key }.
 * Accepted forms:
 *  - power.on | power.off
 *  - mode.cool | mode.heat | mode.dry | mode.fan | mode.auto | mode.fanOnly | mode.smartAuto
 *  - temp.16 | temp.sixteen | temperature.16
 *  - fan.low | fan.medium | fan.high | fan.ultra | fan.turbo
 */
function parseCommandSelector(command) {
    if (!command || typeof command !== "string") {
        return { error: "command is required" };
    }

    const parts = command.trim().split(".");
    if (parts.length !== 2) {
        return { error: "Invalid command format. Use group.key (e.g. power.on)" };
    }

    const [groupRaw, keyRaw] = parts;
    const group = groupRaw.toLowerCase();
    const key = keyRaw.trim();

    if (group === "power") {
        const powerKey = key.toLowerCase();
        if (powerKey !== "on" && powerKey !== "off") {
            return { error: "power key must be on or off" };
        }
        return { group: "powerCommands", key: powerKey };
    }

    if (group === "mode" || group === "modes") {
        const mapped = MODE_FRONTEND_TO_SCHEMA[key] || (["cool", "heat", "dry", "fanOnly", "smartAuto"].includes(key) ? key : null);
        if (!mapped) {
            return { error: "Invalid mode key" };
        }
        return { group: "modes", key: mapped };
    }

    if (group === "temp" || group === "temperature" || group === "temperatures") {
        const asNum = Number(key);
        const word = Number.isFinite(asNum) ? TEMP_WORD_BY_C[asNum] : (TEMP_C_BY_WORD[key] ? key : null);
        if (!word) {
            return { error: "Temperature must be 16–30" };
        }
        return { group: "temperatureCommands", key: word };
    }

    if (group === "fan" || group === "fanspeed" || group === "fanspeedcommands") {
        const fanKey = key.toLowerCase();
        if (!["low", "medium", "high", "ultra", "turbo"].includes(fanKey)) {
            return { error: "Invalid fan speed key" };
        }
        return { group: "fanSpeedCommands", key: fanKey };
    }

    return { error: "Unknown command group" };
}

function normalizePulseValue(payload) {
    if (payload == null) return null;

    if (typeof payload === "string") {
        const trimmed = payload.trim();
        return trimmed || null;
    }

    if (Array.isArray(payload)) {
        return JSON.stringify(payload);
    }

    if (typeof payload === "object") {
        // Decoded IR command from the ESP: keep protocol + bits + code together
        if (payload.code != null && payload.protocol != null) {
            return JSON.stringify({
                protocol: payload.protocol,
                bits: payload.bits,
                code: payload.code,
            });
        }
        if (payload.pulses != null) {
            return normalizePulseValue(payload.pulses);
        }
        if (payload.raw != null) {
            return normalizePulseValue(payload.raw);
        }
        if (payload.code != null) {
            return normalizePulseValue(payload.code);
        }
        return JSON.stringify(payload);
    }

    return String(payload);
}

function toFrontendSignals(draft) {
    const temperatures = {};
    for (const [c, word] of Object.entries(TEMP_WORD_BY_C)) {
        const value = draft.temperatureCommands?.[word] || "";
        temperatures[Number(c)] = value || null;
    }

    return {
        powerOn: draft.powerCommands?.on || null,
        powerOff: draft.powerCommands?.off || null,
        temperatures,
        fanSpeeds: {
            low: draft.fanSpeedCommands?.low || null,
            medium: draft.fanSpeedCommands?.medium || null,
            high: draft.fanSpeedCommands?.high || null,
            ultra: draft.fanSpeedCommands?.ultra || null,
            turbo: draft.fanSpeedCommands?.turbo || null,
        },
        modes: {
            cool: draft.modes?.cool || null,
            heat: draft.modes?.heat || null,
            dry: draft.modes?.dry || null,
            fan: draft.modes?.fanOnly || null,
            auto: draft.modes?.smartAuto || null,
        },
    };
}

function buildSchemaCommandsFromFrontend(signals = {}) {
    const powerCommands = {
        on: signals.powerOn || "",
        off: signals.powerOff || "",
    };

    const modes = {
        cool: signals.modes?.cool || "",
        heat: signals.modes?.heat || "",
        dry: signals.modes?.dry || "",
        fanOnly: signals.modes?.fan || "",
        smartAuto: signals.modes?.auto || "",
    };

    const temperatureCommands = {};
    for (const [c, word] of Object.entries(TEMP_WORD_BY_C)) {
        temperatureCommands[word] = signals.temperatures?.[Number(c)] || "";
    }

    const fanSpeedCommands = {
        low: signals.fanSpeeds?.low || "",
        medium: signals.fanSpeeds?.medium || "",
        high: signals.fanSpeeds?.high || "",
        ultra: signals.fanSpeeds?.ultra || "",
        turbo: signals.fanSpeeds?.turbo || "",
    };

    return { powerCommands, modes, temperatureCommands, fanSpeedCommands };
}

/**
 * Convert flat dotted commands { "power.on": pulse, "temp.24": pulse, ... }
 * into brand schema fields. Missing keys stay empty (brand doesn't support them).
 */
function buildSchemaCommandsFromDotted(commands = {}) {
    const draft = {
        powerCommands: { on: "", off: "" },
        modes: {
            cool: "",
            heat: "",
            dry: "",
            fanOnly: "",
            smartAuto: "",
        },
        temperatureCommands: Object.fromEntries(
            Object.values(TEMP_WORD_BY_C).map((word) => [word, ""])
        ),
        fanSpeedCommands: {
            low: "",
            medium: "",
            high: "",
            ultra: "",
            turbo: "",
        },
    };

    for (const [selector, value] of Object.entries(commands || {})) {
        if (value == null || String(value).trim() === "") continue;
        const parsed = parseCommandSelector(selector);
        if (parsed.error) continue;
        draft[parsed.group][parsed.key] = String(value).trim();
    }

    return draft;
}

/**
 * Merge nested body fields (powerCommands / modes / …) into schema shape.
 * Empty optional fields remain "".
 */
function buildSchemaCommandsFromNested(body = {}) {
    const base = {
        powerCommands: {
            on: body.powerCommands?.on || "",
            off: body.powerCommands?.off || "",
        },
        modes: {
            cool: body.modes?.cool || "",
            heat: body.modes?.heat || "",
            dry: body.modes?.dry || "",
            fanOnly: body.modes?.fanOnly || body.modes?.fan || "",
            smartAuto: body.modes?.smartAuto || body.modes?.auto || "",
        },
        temperatureCommands: Object.fromEntries(
            Object.values(TEMP_WORD_BY_C).map((word) => [
                word,
                body.temperatureCommands?.[word] || "",
            ])
        ),
        fanSpeedCommands: {
            low: body.fanSpeedCommands?.low || "",
            medium: body.fanSpeedCommands?.medium || "",
            high: body.fanSpeedCommands?.high || "",
            ultra: body.fanSpeedCommands?.ultra || "",
            turbo: body.fanSpeedCommands?.turbo || "",
        },
    };

    // Allow numeric temp keys in temperatureCommands: { "16": "...", "24": "..." }
    if (body.temperatureCommands && typeof body.temperatureCommands === "object") {
        for (const [key, value] of Object.entries(body.temperatureCommands)) {
            if (value == null || String(value).trim() === "") continue;
            const asNum = Number(key);
            const word = Number.isFinite(asNum) ? TEMP_WORD_BY_C[asNum] : key;
            if (word && word in base.temperatureCommands) {
                base.temperatureCommands[word] = String(value).trim();
            }
        }
    }

    return base;
}

/**
 * Resolve final command document from validated save body.
 * Priority: dotted `commands` > nested schema fields > legacy `signals`.
 */
function resolveSaveCommands(body) {
    if (body.commands && Object.keys(body.commands).length > 0) {
        return buildSchemaCommandsFromDotted(body.commands);
    }

    if (body.powerCommands || body.modes || body.temperatureCommands || body.fanSpeedCommands) {
        return buildSchemaCommandsFromNested(body);
    }

    if (body.signals) {
        return buildSchemaCommandsFromFrontend(body.signals);
    }

    return null;
}

/** Build flat dotted map from UI signals (for save payload). Only non-empty pulses. */
function signalsToDottedCommands(signals = {}) {
    const commands = {};

    if (signals.powerOn) commands["power.on"] = signals.powerOn;
    if (signals.powerOff) commands["power.off"] = signals.powerOff;

    for (const [key, value] of Object.entries(signals.modes || {})) {
        if (value) commands[`mode.${key}`] = value;
    }

    for (const [c, value] of Object.entries(signals.temperatures || {})) {
        if (value) commands[`temp.${c}`] = value;
    }

    for (const [key, value] of Object.entries(signals.fanSpeeds || {})) {
        if (value) commands[`fan.${key}`] = value;
    }

    return commands;
}

module.exports = {
    TEMP_WORD_BY_C,
    TEMP_C_BY_WORD,
    MODE_FRONTEND_TO_SCHEMA,
    MODE_SCHEMA_TO_FRONTEND,
    parseCommandSelector,
    normalizePulseValue,
    toFrontendSignals,
    buildSchemaCommandsFromFrontend,
    buildSchemaCommandsFromDotted,
    buildSchemaCommandsFromNested,
    resolveSaveCommands,
    signalsToDottedCommands,
};
