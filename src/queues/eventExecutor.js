const Event = require("../models/eventModel");
const Device = require("../models/deviceModel");
const {
    publishDeviceApplyCommand,
    publishDeviceRemoteMode,
} = require("../mqtt/mqttConfig");
const { cleanupOneTimeEvent } = require("./scheduleService");

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

/** Whether an event’s UTC window covers this UTC weekday + HH:mm (incl. overnight). */
function isEventActiveAt(event, now) {
    const startDays = event.days || [];
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
        if (!isEventActiveAt(other, now)) {
            continue;
        }

        // Scope must actually cover this device
        if (other.scope === "organization") {
            if (String(other.organization) !== String(device.organization)) continue;
            // Superlock device ignores org
            if (isSuperlocked) continue;
            return { blocked: true, reason: "org_event", event: other };
        }
        if (other.scope === "venue") {
            if (!other.venue || String(other.venue) !== String(device.venue)) continue;
            if (isSuperlocked) continue;
            return { blocked: true, reason: "venue_event", event: other };
        }
        if (other.scope === "device") {
            if (!other.device || String(other.device) !== String(device._id)) continue;
            // Higher than candidate only if candidate is somehow lower — device is lowest
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
        return Device.find({ organization: event.organization });
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
                if (!isEventActiveAt(other, now)) {
                    continue;
                }
                if (other.scope === "organization") {
                    if (device.remote === "superlock") continue;
                    keepOn = true;
                    break;
                }
                if (
                    other.scope === "venue" &&
                    other.venue &&
                    String(other.venue) === String(device.venue)
                ) {
                    if (device.remote === "superlock") continue;
                    keepOn = true;
                    break;
                }
                if (
                    other.scope === "device" &&
                    other.device &&
                    String(other.device) === String(device._id)
                ) {
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
    resolveTargetDevices,
    SCOPE_RANK,
};
