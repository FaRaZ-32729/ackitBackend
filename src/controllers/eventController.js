const Event = require("../models/eventModel");
const Device = require("../models/deviceModel");
const Organization = require("../models/organizationModel");
const Venue = require("../models/venueModel");
const { createEventSchema } = require("../validations/eventValidation");
const {
    scheduleEventJobs,
    unscheduleEvent,
} = require("../queues/scheduleService");
const { convertLocalScheduleToUtc } = require("../queues/cronHelper");
const {
    findCoveringEventsForDevice,
    resolveTargetDevices,
} = require("../queues/eventExecutor");
const { publishDeviceRemoteMode } = require("../mqtt/mqttConfig");

function hasOrganizationAccess(user, organization) {
    if (user.role === "admin") return true;
    if (String(organization.owner) === String(user._id)) return true;
    return (user.organizations || []).some(
        (id) => String(id) === String(organization._id)
    );
}

/** Managers/admins: full venue access. Sub-users (`role=user`): assigned venues only. */
function hasVenueAccess(user, venueId) {
    if (user.role !== "user") return true;
    if (!venueId) return false;
    return (user.venues || []).some(
        (entry) => String(entry.venueId || entry) === String(venueId)
    );
}

/**
 * Release event-applied remote lock so physical remotes work after ignore.
 * Does not change superlock (user-set protection).
 */
async function unlockEventLockOnDevices(devices) {
    for (const device of devices) {
        if (!device || device.remote !== "lock") continue;

        device.remote = "unlock";
        await device.save();

        publishDeviceRemoteMode(device.deviceId, {
            remote: "unlock",
            state: device.state,
            temperature: device.temperature,
        });

        if (global.io) {
            global.io.emit("device:remote", {
                id: String(device._id),
                remote: "unlock",
                isLocked: false,
                eventLocked: false,
            });
        }
    }
}

/**
 * null = no restriction (all venues in org).
 * string[] = venue ids the user may target.
 */
function getUserVenueRestriction(user) {
    if (user.role !== "user") return null;
    return (user.venues || [])
        .map((entry) => entry.venueId || entry)
        .filter(Boolean)
        .map((id) => String(id));
}

/** True when day sets collide (empty days = one-time → conflicts with any). */
function daysOverlap(aDays, bDays) {
    const a = Array.isArray(aDays) ? aDays : [];
    const b = Array.isArray(bDays) ? bDays : [];
    if (a.length === 0 || b.length === 0) return true;
    const setB = new Set(b);
    return a.some((d) => setB.has(d));
}

/**
 * Reject create if an ACTIVE event already exists on the same target
 * with the same start time and overlapping days (or one-time).
 */
async function findScheduleConflict({
    organizationId,
    scope,
    deviceId,
    venueId,
    startTime,
    days,
    allowedVenues = [],
}) {
    const filter = {
        organization: organizationId,
        scope,
        enabled: true,
        status: "ACTIVE",
        startTime,
    };

    if (scope === "device") filter.device = deviceId;
    if (scope === "venue") filter.venue = venueId;

    const existing = await Event.find(filter).lean();
    for (const ev of existing) {
        if (!daysOverlap(days, ev.days || [])) continue;

        // Org events with disjoint allowedVenues do not conflict
        if (scope === "organization") {
            const a = (allowedVenues || []).map(String);
            const b = (ev.allowedVenues || []).map(String);
            // Empty = whole org → conflicts with any org event at this time
            if (a.length > 0 && b.length > 0) {
                const overlap = a.some((id) => b.includes(id));
                if (!overlap) continue;
            }
        }

        return ev;
    }
    return null;
}

function mapEvent(doc) {
    return {
        id: String(doc._id),
        name: doc.name,
        scope: doc.scope,
        organizationId: String(doc.organization),
        venueId: doc.venue ? String(doc.venue) : null,
        deviceId: doc.device ? String(doc.device) : null,
        allowedVenueIds: (doc.allowedVenues || []).map((id) => String(id)),
        action: doc.action,
        targetTemp: doc.targetTemp,
        /** UTC schedule (source of truth for BullMQ) */
        startTime: doc.startTime,
        endTime: doc.endTime,
        days: doc.days || [],
        endDays: doc.endDays || [],
        isOvernight: Boolean(doc.isOvernight),
        isRecurring:
            doc.isRecurring !== false &&
            Array.isArray(doc.days) &&
            doc.days.length > 0,
        /** Original user-local inputs */
        localStartTime: doc.localStartTime || "",
        localEndTime: doc.localEndTime || "",
        localDays: doc.localDays || [],
        timezoneOffsetMinutes: doc.timezoneOffsetMinutes ?? 0,
        remote: doc.remote,
        enabled: doc.enabled,
        status: doc.status,
        ignoredDeviceIds: (doc.ignoredDeviceIds || []).map((id) => String(id)),
        ignoreUntil: doc.ignoreUntil || null,
        timezone: doc.timezone || "UTC",
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    };
}

// POST /api/event/create
const createEvent = async (req, res) => {
    try {
        const data = createEventSchema.parse(req.body);

        const organization = await Organization.findById(data.organizationId);
        if (!organization) {
            return res.status(404).json({
                success: false,
                message: "Organization not found",
            });
        }
        if (!hasOrganizationAccess(req.user, organization)) {
            return res.status(403).json({
                success: false,
                message: "You cannot create events for this organization",
            });
        }

        let venue = null;
        let device = null;

        if (data.scope === "venue") {
            venue = await Venue.findById(data.venueId);
            if (!venue) {
                return res.status(404).json({
                    success: false,
                    message: "Venue not found",
                });
            }
            const venueOrg = String(venue.organization || "");
            if (venueOrg !== String(organization._id)) {
                return res.status(400).json({
                    success: false,
                    message: "Venue does not belong to this organization",
                });
            }
            if (!hasVenueAccess(req.user, venue._id)) {
                return res.status(403).json({
                    success: false,
                    message: "You do not have access to this venue",
                });
            }
        }

        if (data.scope === "device") {
            device = await Device.findById(data.deviceId);
            if (!device) {
                return res.status(404).json({
                    success: false,
                    message: "Device not found",
                });
            }
            if (String(device.organization) !== String(organization._id)) {
                return res.status(400).json({
                    success: false,
                    message: "Device does not belong to this organization",
                });
            }
            if (!hasVenueAccess(req.user, device.venue)) {
                return res.status(403).json({
                    success: false,
                    message: "You do not have access to this device's venue",
                });
            }
        }

        // Org events for venue-restricted users → only their accessible venues
        let allowedVenues = [];
        if (data.scope === "organization") {
            const restriction = getUserVenueRestriction(req.user);
            if (restriction) {
                const orgVenues = await Venue.find({
                    organization: organization._id,
                })
                    .select("_id")
                    .lean();
                const orgVenueIds = new Set(orgVenues.map((v) => String(v._id)));
                allowedVenues = restriction.filter((id) => orgVenueIds.has(id));
                if (allowedVenues.length === 0) {
                    return res.status(403).json({
                        success: false,
                        message:
                            "You have no venue access in this organization, so you cannot create an organization event",
                    });
                }
            }
        }

        const remote =
            data.action === "OFF" ? "lock" : data.remote || "unlock";

        // Convert user-local time/days → UTC (empty days = one-time)
        const utcSchedule = convertLocalScheduleToUtc({
            startTime: data.startTime,
            endTime: data.endTime,
            days: data.days || [],
            timezoneOffsetMinutes: data.timezoneOffsetMinutes,
        });
        const isRecurring = Boolean(utcSchedule.isRecurring);

        // Same event name not allowed on the same device
        if (data.scope === "device" && device) {
            const nameRegex = new RegExp(
                `^${String(data.name).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
                "i"
            );
            const nameConflict = await Event.findOne({
                scope: "device",
                device: device._id,
                name: nameRegex,
            }).lean();

            if (nameConflict) {
                return res.status(409).json({
                    success: false,
                    message: `An event named "${data.name.trim()}" already exists on this device. Choose a different name.`,
                    conflict: mapEvent(nameConflict),
                });
            }
        }

        const conflict = await findScheduleConflict({
            organizationId: organization._id,
            scope: data.scope,
            deviceId: data.scope === "device" ? device._id : null,
            venueId:
                data.scope === "venue"
                    ? venue._id
                    : data.scope === "device"
                      ? device.venue
                      : null,
            startTime: utcSchedule.startTime,
            days: isRecurring ? utcSchedule.days : [],
            allowedVenues:
                data.scope === "organization" ? allowedVenues : [],
        });

        if (conflict) {
            return res.status(409).json({
                success: false,
                message: `An event already exists at this time (${
                    conflict.localStartTime || conflict.startTime
                })${
                    conflict.name ? `: "${conflict.name}"` : ""
                }. Choose a different time or day.`,
                conflict: mapEvent(conflict),
            });
        }

        const event = await Event.create({
            name: data.name,
            createdBy: req.user._id,
            scope: data.scope,
            organization: organization._id,
            venue:
                data.scope === "organization"
                    ? null
                    : data.scope === "venue"
                      ? venue._id
                      : device.venue,
            device: data.scope === "device" ? device._id : null,
            allowedVenues:
                data.scope === "organization" ? allowedVenues : [],
            action: data.action,
            targetTemp: data.action === "ON" ? data.targetTemp : null,
            startTime: utcSchedule.startTime,
            endTime: utcSchedule.endTime,
            days: isRecurring ? utcSchedule.days : [],
            endDays: isRecurring ? utcSchedule.endDays : [],
            isOvernight: utcSchedule.isOvernight,
            isRecurring,
            localStartTime: data.startTime,
            localEndTime: data.endTime,
            localDays: data.days || [],
            timezoneOffsetMinutes: data.timezoneOffsetMinutes,
            remote,
            enabled: true,
            status: "ACTIVE",
            timezone: "UTC",
        });

        const jobs = await scheduleEventJobs(event);
        event.startJobId = jobs.startJobId;
        event.endJobId = jobs.endJobId;
        await event.save();

        if (global.io) {
            global.io.emit("event:created", mapEvent(event));
        }

        return res.status(201).json({
            success: true,
            message: isRecurring
                ? "Recurring event created and scheduled (UTC)"
                : "One-time event created and scheduled",
            event: mapEvent(event),
            jobs,
            utcSchedule,
        });
    } catch (error) {
        if (error.name === "ZodError") {
            return res.status(400).json({
                success: false,
                message: "Validation failed",
                errors: error.issues.map((issue) => ({
                    field: issue.path.join("."),
                    message: issue.message,
                })),
            });
        }
        console.error("Create Event Error:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Server error while creating event",
        });
    }
};

// GET /api/event/list?organizationId=&venueId=&deviceId=&scope=
const listEvents = async (req, res) => {
    try {
        const { organizationId, venueId, deviceId, scope } = req.query;
        const filter = {};

        if (organizationId) filter.organization = organizationId;
        if (venueId) filter.venue = venueId;
        if (deviceId) filter.device = deviceId;
        if (scope) filter.scope = scope;

        if (!organizationId && !venueId && !deviceId) {
            return res.status(400).json({
                success: false,
                message: "organizationId, venueId, or deviceId is required",
            });
        }

        if (organizationId) {
            const organization = await Organization.findById(organizationId);
            if (!organization || !hasOrganizationAccess(req.user, organization)) {
                return res.status(403).json({
                    success: false,
                    message: "You cannot view events for this organization",
                });
            }
        }

        const events = await Event.find(filter).sort({ createdAt: -1 }).lean();
        return res.status(200).json({
            success: true,
            events: events.map(mapEvent),
        });
    } catch (error) {
        console.error("List Events Error:", error);
        return res.status(500).json({
            success: false,
            message: "Server error while listing events",
        });
    }
};

// PATCH /api/event/:id/enabled  body: { enabled: boolean }
const setEventEnabled = async (req, res) => {
    try {
        const { id } = req.params;
        const enabled = Boolean(req.body?.enabled);
        const event = await Event.findById(id);
        if (!event) {
            return res.status(404).json({
                success: false,
                message: "Event not found",
            });
        }

        const organization = await Organization.findById(event.organization);
        if (!organization || !hasOrganizationAccess(req.user, organization)) {
            return res.status(403).json({
                success: false,
                message: "You cannot update this event",
            });
        }

        event.enabled = enabled;
        event.status = enabled ? "ACTIVE" : "INACTIVE";
        await event.save();

        if (enabled) {
            const jobs = await scheduleEventJobs(event);
            event.startJobId = jobs.startJobId;
            event.endJobId = jobs.endJobId;
            await event.save();
        } else {
            await unscheduleEvent(event);
        }

        return res.status(200).json({
            success: true,
            event: mapEvent(event),
        });
    } catch (error) {
        console.error("Set Event Enabled Error:", error);
        return res.status(500).json({
            success: false,
            message: "Server error while updating event",
        });
    }
};

// DELETE /api/event/:id
const deleteEvent = async (req, res) => {
    try {
        const { id } = req.params;
        const event = await Event.findById(id);
        if (!event) {
            return res.status(404).json({
                success: false,
                message: "Event not found",
            });
        }

        const organization = await Organization.findById(event.organization);
        if (!organization || !hasOrganizationAccess(req.user, organization)) {
            return res.status(403).json({
                success: false,
                message: "You cannot delete this event",
            });
        }

        await unscheduleEvent(event);
        await event.deleteOne();

        if (global.io) {
            global.io.emit("event:deleted", { id: String(id) });
        }

        console.log(`🗑️ Event ${id} deleted (queue jobs removed)`);

        return res.status(200).json({
            success: true,
            message: "Event deleted",
        });
    } catch (error) {
        console.error("Delete Event Error:", error);
        return res.status(500).json({
            success: false,
            message: "Server error while deleting event",
        });
    }
};

// GET /api/event/covering?deviceIds=id1,id2
const getCoveringEvents = async (req, res) => {
    try {
        const raw = String(req.query.deviceIds || req.query.deviceId || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);

        if (raw.length === 0) {
            return res.status(400).json({
                success: false,
                message: "deviceIds is required",
            });
        }

        const devices = await Device.find({ _id: { $in: raw } });
        if (devices.length === 0) {
            return res.status(200).json({ success: true, events: [] });
        }

        for (const device of devices) {
            const organization = await Organization.findById(device.organization);
            if (!organization || !hasOrganizationAccess(req.user, organization)) {
                return res.status(403).json({
                    success: false,
                    message: "You cannot view covering events for these devices",
                });
            }
            if (!hasVenueAccess(req.user, device.venue)) {
                return res.status(403).json({
                    success: false,
                    message: "You do not have access to one or more device venues",
                });
            }
        }

        const byEvent = new Map();

        for (const device of devices) {
            const covering = await findCoveringEventsForDevice(device);
            for (const ev of covering) {
                const id = String(ev._id);
                if (!byEvent.has(id)) {
                    byEvent.set(id, {
                        ...mapEvent(ev),
                        deviceIds: [],
                    });
                }
                byEvent.get(id).deviceIds.push(String(device._id));
            }
        }

        return res.status(200).json({
            success: true,
            events: Array.from(byEvent.values()),
        });
    } catch (error) {
        console.error("Get Covering Events Error:", error);
        return res.status(500).json({
            success: false,
            message: "Server error while checking covering events",
        });
    }
};

// POST /api/event/:id/ignore  body: { deviceId?: string, all?: boolean }
const ignoreEvent = async (req, res) => {
    try {
        const { id } = req.params;
        const all = Boolean(req.body?.all);
        const deviceId = req.body?.deviceId ? String(req.body.deviceId) : null;

        if (!all && !deviceId) {
            return res.status(400).json({
                success: false,
                message: "Provide deviceId or all: true",
            });
        }

        const event = await Event.findById(id);
        if (!event) {
            return res.status(404).json({
                success: false,
                message: "Event not found",
            });
        }

        const organization = await Organization.findById(event.organization);
        if (!organization || !hasOrganizationAccess(req.user, organization)) {
            return res.status(403).json({
                success: false,
                message: "You cannot ignore this event",
            });
        }

        const ignored = new Set(
            (event.ignoredDeviceIds || []).map((x) => String(x))
        );
        /** Devices to unlock after ignore (event lock → physical remote OK) */
        const devicesToUnlock = [];

        if (all) {
            const targets = await resolveTargetDevices(event);
            for (const device of targets) {
                if (!hasVenueAccess(req.user, device.venue)) continue;
                ignored.add(String(device._id));
                devicesToUnlock.push(device);
            }
        } else {
            const device = await Device.findById(deviceId);
            if (!device) {
                return res.status(404).json({
                    success: false,
                    message: "Device not found",
                });
            }
            if (String(device.organization) !== String(event.organization)) {
                return res.status(400).json({
                    success: false,
                    message: "Device does not belong to this event's organization",
                });
            }
            if (!hasVenueAccess(req.user, device.venue)) {
                return res.status(403).json({
                    success: false,
                    message: "You do not have access to this device's venue",
                });
            }
            ignored.add(String(device._id));
            devicesToUnlock.push(device);
        }

        event.ignoredDeviceIds = Array.from(ignored);
        // Ignore only lasts for this occurrence (cleared on next START / END)
        if (!event.ignoreUntil) {
            if (event.windowEndAt) {
                event.ignoreUntil = event.windowEndAt;
            } else if (event.endTime) {
                // Recurring: end of today's UTC window
                const [eh, em] = String(event.endTime)
                    .split(":")
                    .map(Number);
                const until = new Date();
                until.setUTCSeconds(0, 0);
                until.setUTCHours(eh || 0, em || 0, 0, 0);
                if (until.getTime() <= Date.now()) {
                    until.setUTCDate(until.getUTCDate() + 1);
                }
                event.ignoreUntil = until;
            }
        }
        await event.save();

        // Event lock must not block physical remotes after ignore
        await unlockEventLockOnDevices(devicesToUnlock);

        if (global.io) {
            global.io.emit("event:ignored", {
                id: String(event._id),
                ignoredDeviceIds: event.ignoredDeviceIds.map((x) => String(x)),
                ignoreUntil: event.ignoreUntil || null,
                all,
                deviceId,
            });
        }

        return res.status(200).json({
            success: true,
            event: mapEvent(event),
        });
    } catch (error) {
        console.error("Ignore Event Error:", error);
        return res.status(500).json({
            success: false,
            message: "Server error while ignoring event",
        });
    }
};

module.exports = {
    createEvent,
    listEvents,
    setEventEnabled,
    deleteEvent,
    getCoveringEvents,
    ignoreEvent,
    mapEvent,
};
