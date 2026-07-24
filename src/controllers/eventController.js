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

function hasOrganizationAccess(user, organization) {
    if (user.role === "admin") return true;
    if (String(organization.owner) === String(user._id)) return true;
    return (user.organizations || []).some(
        (id) => String(id) === String(organization._id)
    );
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
        if (daysOverlap(days, ev.days || [])) {
            return ev;
        }
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

module.exports = {
    createEvent,
    listEvents,
    setEventEnabled,
    deleteEvent,
    mapEvent,
};
