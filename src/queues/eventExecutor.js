const Event = require("../models/eventModel");
const Device = require("../models/deviceModel");
const {
    publishDeviceApplyCommand,
    publishDeviceRemoteMode,
} = require("../mqtt/mqttConfig");
const { cleanupOneTimeEvent } = require("./scheduleService");
const { oneTimeFireTimesUtcMs } = require("./cronHelper");

const SCOPE_RANK = {
    organization: 3,
    venue: 2,
    device: 1,
};

function hhmmNowInTz(timeZone = "UTC") {
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        weekday: "short",
    }).formatToParts(new Date());

    const get = (type) => parts.find((p) => p.type === type)?.value || "";
    const hour = get("hour");
    const minute = get("minute");
    const weekday = get("weekday"); // Mon, Tue, ...
    return {
        time: `${hour}:${minute}`,
        day: weekday,
    };
}

function isTimeWithinWindow(nowHm, startHm, endHm) {
    if (startHm <= endHm) {
        return nowHm >= startHm && nowHm < endHm;
    }
    // overnight
    return nowHm >= startHm || nowHm < endHm;
}

/**
 * Whether an event’s window covers "now".
 * Recurring: UTC weekday + HH:mm.
 * One-time (empty days): absolute windowStartAt/windowEndAt (or reconstructed).
 */
function isEventActiveAt(event, now) {
    const startDays = event.days || [];
    const isOneTime =
        event.isRecurring === false ||
        !Array.isArray(startDays) ||
        startDays.length === 0;

    if (isOneTime) {
        const t = Date.now();
        if (event.windowStartAt && event.windowEndAt) {
            const startMs = new Date(event.windowStartAt).getTime();
            const endMs = new Date(event.windowEndAt).getTime();
            return t >= startMs && t < endMs;
        }
        // Existing one-time events without persisted window — reconstruct
        try {
            const createdMs = event.createdAt
                ? new Date(event.createdAt).getTime() - 60_000
                : t - 24 * 60 * 60 * 1000;
            const { startAt, endAt } = oneTimeFireTimesUtcMs({
                localStartTime: event.localStartTime || event.startTime,
                localEndTime: event.localEndTime || event.endTime,
                timezoneOffsetMinutes: event.timezoneOffsetMinutes ?? 0,
                afterMs: createdMs,
            });
            return t >= startAt && t < endAt;
        } catch {
            return false;
        }
    }

    const endDays =
        Array.isArray(event.endDays) && event.endDays.length > 0
            ? event.endDays
            : startDays;
    const overnight =
        Boolean(event.isOvernight) ||
        String(event.startTime) > String(event.endTime);

    if (!overnight) {
        return (
            startDays.includes(now.day) &&
            isTimeWithinWindow(now.time, event.startTime, event.endTime)
        );
    }

    if (startDays.includes(now.day) && now.time >= event.startTime) return true;
    if (endDays.includes(now.day) && now.time < event.endTime) return true;
    return false;
}

/** Whether an org event applies to this device (respects allowedVenues). */
function orgEventCoversDevice(event, device) {
    if (String(event.organization) !== String(device.organization)) {
        return false;
    }
    const allowed = event.allowedVenues || [];
    if (allowed.length === 0) return true;
    if (!device.venue) return false;
    return allowed.some((id) => String(id) === String(device.venue));
}

function isDeviceIgnoredByEvent(event, deviceId) {
    if (!deviceId) return false;
    const ids = event.ignoredDeviceIds || [];
    if (!ids.some((id) => String(id) === String(deviceId))) {
        return false;
    }
    // Expired ignore (past this occurrence) → treat as not ignored
    if (event.ignoreUntil) {
        const until = new Date(event.ignoreUntil).getTime();
        if (Number.isFinite(until) && Date.now() >= until) {
            return false;
        }
    }
    return true;
}

/** Does this event currently cover this device (scope + active window + not ignored)? */
function eventCoversDeviceNow(event, device, now) {
    if (!isEventActiveAt(event, now)) return false;
    if (isDeviceIgnoredByEvent(event, device._id)) return false;

    const isSuperlocked = device.remote === "superlock";

    if (event.scope === "device") {
        return (
            Boolean(event.device) &&
            String(event.device) === String(device._id)
        );
    }
    if (event.scope === "venue") {
        if (isSuperlocked) return false;
        return (
            Boolean(event.venue) &&
            String(event.venue) === String(device.venue)
        );
    }
    if (event.scope === "organization") {
        if (isSuperlocked) return false;
        return orgEventCoversDevice(event, device);
    }
    return false;
}

/**
 * Find enabled ACTIVE events whose UTC window currently covers this device.
 */
async function findCoveringEventsForDevice(device) {
    if (!device) return [];
    const now = hhmmNowInTz("UTC");
    const candidates = await Event.find({
        enabled: true,
        status: "ACTIVE",
        organization: device.organization,
    }).lean();

    const covering = candidates.filter((ev) =>
        eventCoversDeviceNow(ev, device, now)
    );
    console.log(
        `[Event] covering check device=${device.deviceId} now=${now.day} ${now.time} → ${covering.length} event(s)`
    );
    return covering;
}

/**
 * Find higher-priority ACTIVE events that currently cover this device.
 * Org > Venue > Device. Superlocked devices ignore org/venue overrides.
 */
async function findBlockingHigherEvent(device, candidateEvent, now) {
    const candidateRank = SCOPE_RANK[candidateEvent.scope] || 0;
    const isSuperlocked = device.remote === "superlock";

    // Superlock: only device-scoped events apply; org/venue cannot override
    if (isSuperlocked && candidateEvent.scope !== "device") {
        return {
            blocked: true,
            reason: "device_superlock",
        };
    }

    const others = await Event.find({
        _id: { $ne: candidateEvent._id },
        enabled: true,
        status: "ACTIVE",
        organization: device.organization,
    }).lean();

    for (const other of others) {
        const rank = SCOPE_RANK[other.scope] || 0;
        if (rank <= candidateRank) continue;
        if (!eventCoversDeviceNow(other, device, now)) {
            continue;
        }

        if (other.scope === "organization") {
            if (isSuperlocked) continue;
            return { blocked: true, reason: "org_event", event: other };
        }
        if (other.scope === "venue") {
            if (isSuperlocked) continue;
            return { blocked: true, reason: "venue_event", event: other };
        }
        if (other.scope === "device") {
            continue;
        }
    }

    return { blocked: false };
}

async function resolveTargetDevices(event) {
    if (event.scope === "device") {
        const device = await Device.findById(event.device);
        return device ? [device] : [];
    }
    if (event.scope === "venue") {
        return Device.find({ venue: event.venue });
    }
    if (event.scope === "organization") {
        const query = { organization: event.organization };
        const allowed = event.allowedVenues || [];
        if (allowed.length > 0) {
            query.venue = { $in: allowed };
        }
        return Device.find(query);
    }
    return [];
}

function applyStartToDevice(device, event) {
    const remote =
        event.action === "OFF" ? "lock" : event.remote || "unlock";

    // ESP accepts action=apply / set_remote on /control (existing firmware)
    if (event.action === "ON") {
        publishDeviceApplyCommand(device.deviceId, {
            key: "power.on",
            state: "on",
            temperature: event.targetTemp || device.temperature,
        });
        if (event.targetTemp) {
            publishDeviceApplyCommand(device.deviceId, {
                key: `temp.${event.targetTemp}`,
                state: "on",
                temperature: event.targetTemp,
            });
        }
        device.state = "on";
        if (event.targetTemp) device.temperature = event.targetTemp;
    } else {
        // OFF event START: power OFF + lock remote
        publishDeviceApplyCommand(device.deviceId, {
            key: "power.off",
            state: "off",
            temperature: null,
        });
        device.state = "off";
    }

    publishDeviceRemoteMode(device.deviceId, {
        remote,
        state: device.state,
        temperature: device.temperature,
    });
    device.remote = remote;

    return device.save();
}

function applyEndToDevice(device, event) {
    if (event.action === "OFF") {
        // OFF event END: keep AC off — only unlock remote
        publishDeviceRemoteMode(device.deviceId, {
            remote: "unlock",
            state: "off",
            temperature: device.temperature,
        });
        device.state = "off";
        device.remote = "unlock";
        return device.save();
    }

    // ON event END: turn OFF + unlock
    publishDeviceApplyCommand(device.deviceId, {
        key: "power.off",
        state: "off",
        temperature: null,
    });
    publishDeviceRemoteMode(device.deviceId, {
        remote: "unlock",
        state: "off",
        temperature: device.temperature,
    });
    device.state = "off";
    device.remote = "unlock";
    return device.save();
}

/**
 * Execute a scheduled event phase (start | end) with priority rules.
 */
async function executeEventJob({ eventId, phase }) {
    const event = await Event.findById(eventId);
    if (!event) {
        console.warn(`[Event] not found ${eventId}`);
        return { skipped: true, reason: "missing_event" };
    }
    if (!event.enabled || event.status !== "ACTIVE") {
        console.log(
            `[Event] rejected ${eventId} phase=${phase} — inactive (enabled=${event.enabled} status=${event.status})`
        );
        return { skipped: true, reason: "inactive" };
    }

    const tz = "UTC";
    const now = hhmmNowInTz(tz);
    const devices = await resolveTargetDevices(event);

    console.log(
        `[Event] ${phase} ${event.name} (${event.scope}/${event.action}) → ${devices.length} device(s) @ ${now.day} ${now.time}`
    );

    // Recurring: each new START is a fresh day — clear yesterday's manual ignores
    if (phase === "start") {
        const hasIgnores =
            (event.ignoredDeviceIds && event.ignoredDeviceIds.length > 0) ||
            event.ignoreUntil;
        if (hasIgnores) {
            event.ignoredDeviceIds = [];
            event.ignoreUntil = null;
            await event.save();
            console.log(
                `[Event] cleared prior ignores for ${event._id} (new occurrence)`
            );
        }
    }

    const results = [];

    for (const device of devices) {
        if (device.status !== "online") {
            results.push({
                deviceId: device.deviceId,
                skipped: true,
                reason: "offline",
            });
            continue;
        }

        if (isDeviceIgnoredByEvent(event, device._id)) {
            results.push({
                deviceId: device.deviceId,
                skipped: true,
                reason: "manually_ignored",
            });
            continue;
        }

        if (phase === "start") {
            const block = await findBlockingHigherEvent(device, event, now);
            if (block.blocked) {
                console.log(
                    `[Event] skip ${device.deviceId}: blocked by ${block.reason}`
                );
                results.push({
                    deviceId: device.deviceId,
                    skipped: true,
                    reason: block.reason,
                });
                continue;
            }

            // Device-scope event on superlock always allowed; org/venue already filtered above
            await applyStartToDevice(device, event);
            results.push({ deviceId: device.deviceId, applied: "start" });

            if (global.io) {
                global.io.emit("device:state", {
                    id: String(device._id),
                    deviceId: device.deviceId,
                    state: device.state,
                    isOn: device.state === "on",
                    temperature: device.temperature,
                });
                global.io.emit("device:remote", {
                    id: String(device._id),
                    remote: device.remote,
                    isLocked: device.remote === "lock" || device.remote === "superlock",
                    eventLocked: device.remote === "superlock",
                });
            }
        } else if (phase === "end") {
            // Re-check any covering event (org/venue/device) except this one
            const covering = await Event.find({
                _id: { $ne: event._id },
                enabled: true,
                status: "ACTIVE",
                organization: device.organization,
            }).lean();

            let keepOn = false;
            for (const other of covering) {
                if (!eventCoversDeviceNow(other, device, now)) {
                    continue;
                }
                if (other.scope === "organization") {
                    keepOn = true;
                    break;
                }
                if (other.scope === "venue") {
                    keepOn = true;
                    break;
                }
                if (other.scope === "device") {
                    keepOn = true;
                    break;
                }
            }

            if (keepOn) {
                results.push({
                    deviceId: device.deviceId,
                    skipped: true,
                    reason: "other_active_event",
                });
                continue;
            }

            // Superlock device: org/venue end must not touch it
            if (device.remote === "superlock" && event.scope !== "device") {
                results.push({
                    deviceId: device.deviceId,
                    skipped: true,
                    reason: "device_superlock",
                });
                continue;
            }

            await applyEndToDevice(device, event);
            results.push({ deviceId: device.deviceId, applied: "end" });

            if (global.io) {
                global.io.emit("device:state", {
                    id: String(device._id),
                    deviceId: device.deviceId,
                    state: device.state,
                    isOn: device.state === "on",
                    temperature: device.temperature,
                });
                global.io.emit("device:remote", {
                    id: String(device._id),
                    remote: device.remote,
                    isLocked:
                        device.remote === "lock" ||
                        device.remote === "superlock",
                    eventLocked: device.remote === "superlock",
                });
            }
        }
    }

    // Clear manual ignores when the window ends so the next cycle applies cleanly
    if (phase === "end") {
        const hasIgnores =
            (event.ignoredDeviceIds && event.ignoredDeviceIds.length > 0) ||
            event.ignoreUntil;
        if (hasIgnores) {
            event.ignoredDeviceIds = [];
            event.ignoreUntil = null;
            await event.save();
        }
    }

    // One-time event: after END job finishes, remove from queue + Mongo
    const isOneTime =
        event.isRecurring === false ||
        !Array.isArray(event.days) ||
        event.days.length === 0;
    if (phase === "end" && isOneTime) {
        await cleanupOneTimeEvent(event);
    }

    return { success: true, results };
}

module.exports = {
    executeEventJob,
    findBlockingHigherEvent,
    findCoveringEventsForDevice,
    resolveTargetDevices,
    isEventActiveAt,
    orgEventCoversDevice,
    isDeviceIgnoredByEvent,
    SCOPE_RANK,
};
