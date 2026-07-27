const scheduleQueue = require("./scheduleQueue");
const redisConnection = require("../config/redisConnection");
const { generateCron, oneTimeFireTimesUtcMs } = require("./cronHelper");
const Event = require("../models/eventModel");

const EVENT_REDIS_PREFIX = "ackit:event:";

function redisMetaKey(eventId) {
    return `${EVENT_REDIS_PREFIX}${eventId}`;
}

/**
 * Persist start/end (UTC) in Redis for worker lookups / debugging.
 */
async function saveEventTimesToRedis(event) {
    const key = redisMetaKey(String(event._id));
    const payload = {
        eventId: String(event._id),
        name: event.name,
        scope: event.scope,
        action: event.action,
        startTime: event.startTime,
        endTime: event.endTime,
        days: JSON.stringify(event.days || []),
        endDays: JSON.stringify(event.endDays || event.days || []),
        isOvernight: event.isOvernight ? "1" : "0",
        isRecurring: event.isRecurring ? "1" : "0",
        targetTemp: event.targetTemp == null ? "" : String(event.targetTemp),
        remote: event.remote || "unlock",
        organization: String(event.organization || ""),
        venue: event.venue ? String(event.venue) : "",
        device: event.device ? String(event.device) : "",
        timezone: "UTC",
        enabled: event.enabled ? "1" : "0",
    };
    await redisConnection.hset(key, payload);
    return key;
}

async function removeEventTimesFromRedis(eventId) {
    await redisConnection.del(redisMetaKey(String(eventId)));
}

/**
 * Schedule start + end jobs.
 * - Recurring (days selected): BullMQ repeatable cron in UTC
 * - One-time (no days): delayed jobs for next local occurrence, then removed after end
 */
async function scheduleEventJobs(event) {
    const eventId = String(event._id);
    const startJobId = `event:${eventId}:start`;
    const endJobId = `event:${eventId}:end`;
    const isRecurring =
        event.isRecurring !== false &&
        Array.isArray(event.days) &&
        event.days.length > 0;

    await removeEventJobs(startJobId, endJobId);

    if (!isRecurring) {
        const localStart = event.localStartTime || event.startTime;
        const localEnd = event.localEndTime || event.endTime;
        const { startAt, endAt } = oneTimeFireTimesUtcMs({
            localStartTime: localStart,
            localEndTime: localEnd,
            timezoneOffsetMinutes: event.timezoneOffsetMinutes ?? 0,
        });

        const startDelay = Math.max(0, startAt - Date.now());
        const endDelay = Math.max(0, endAt - Date.now());

        await scheduleQueue.add(
            "ackit-event",
            {
                eventId,
                phase: "start",
                scope: event.scope,
                action: event.action,
                oneTime: true,
            },
            {
                jobId: startJobId,
                delay: startDelay,
                attempts: 3,
                backoff: { type: "exponential", delay: 2000 },
                removeOnComplete: true,
                removeOnFail: true,
            }
        );

        await scheduleQueue.add(
            "ackit-event",
            {
                eventId,
                phase: "end",
                scope: event.scope,
                action: event.action,
                oneTime: true,
            },
            {
                jobId: endJobId,
                delay: endDelay,
                attempts: 3,
                backoff: { type: "exponential", delay: 2000 },
                removeOnComplete: true,
                removeOnFail: true,
            }
        );

        await saveEventTimesToRedis(event);

        console.log(
            `📅 One-time event ${eventId} start in ${Math.round(startDelay / 1000)}s ` +
                `end in ${Math.round(endDelay / 1000)}s ` +
                `(${new Date(startAt).toISOString()} → ${new Date(endAt).toISOString()})`
        );

        // Persist absolute window so "covering now" checks work (empty days)
        try {
            await Event.findByIdAndUpdate(eventId, {
                windowStartAt: new Date(startAt),
                windowEndAt: new Date(endAt),
            });
        } catch (err) {
            console.warn(
                `[Event] failed to save window for ${eventId}:`,
                err.message
            );
        }

        return {
            startJobId,
            endJobId,
            startCron: null,
            endCron: null,
            oneTime: true,
            startAt,
            endAt,
        };
    }

    const tz = "UTC";
    const startDays = event.days || [];
    const endDays =
        Array.isArray(event.endDays) && event.endDays.length > 0
            ? event.endDays
            : startDays;

    const startCron = generateCron(event.startTime, startDays);
    const endCron = generateCron(event.endTime, endDays);

    await scheduleQueue.add(
        "ackit-event",
        {
            eventId,
            phase: "start",
            scope: event.scope,
            action: event.action,
            oneTime: false,
        },
        {
            jobId: startJobId,
            repeat: { pattern: startCron, tz },
            attempts: 3,
            backoff: { type: "exponential", delay: 2000 },
        }
    );

    await scheduleQueue.add(
        "ackit-event",
        {
            eventId,
            phase: "end",
            scope: event.scope,
            action: event.action,
            oneTime: false,
        },
        {
            jobId: endJobId,
            repeat: { pattern: endCron, tz },
            attempts: 3,
            backoff: { type: "exponential", delay: 2000 },
        }
    );

    await saveEventTimesToRedis(event);

    console.log(
        `📅 Recurring event (UTC) ${eventId} start=${startCron} end=${endCron}` +
            (event.isOvernight ? " overnight=yes" : "")
    );

    return { startJobId, endJobId, startCron, endCron, oneTime: false };
}

async function removeEventJobs(startJobId, endJobId) {
    try {
        const repeatables = await scheduleQueue.getRepeatableJobs();
        for (const job of repeatables) {
            const id = job.id || "";
            const key = job.key || "";
            if (
                id === startJobId ||
                id === endJobId ||
                (startJobId && key.includes(startJobId)) ||
                (endJobId && key.includes(endJobId))
            ) {
                await scheduleQueue.removeRepeatableByKey(job.key);
            }
        }
    } catch (error) {
        console.warn("removeEventJobs:", error.message);
    }

    try {
        if (startJobId) {
            const j = await scheduleQueue.getJob(startJobId);
            if (j) await j.remove();
        }
        if (endJobId) {
            const j = await scheduleQueue.getJob(endJobId);
            if (j) await j.remove();
        }
    } catch (_) {
        /* ignore */
    }
}

async function unscheduleEvent(event) {
    const startJobId = event.startJobId || `event:${event._id}:start`;
    const endJobId = event.endJobId || `event:${event._id}:end`;
    await removeEventJobs(startJobId, endJobId);
    await removeEventTimesFromRedis(event._id);
}

/**
 * After a one-time event's end job finishes: remove queue jobs + delete Mongo doc.
 */
async function cleanupOneTimeEvent(event) {
    if (!event) return;
    const id = String(event._id);
    try {
        await unscheduleEvent(event);
        await event.deleteOne();
        if (global.io) {
            global.io.emit("event:deleted", { id });
        }
        console.log(`🗑️ One-time event ${id} removed after completion`);
    } catch (err) {
        console.error(`cleanupOneTimeEvent ${id}:`, err.message);
    }
}

module.exports = {
    scheduleEventJobs,
    unscheduleEvent,
    cleanupOneTimeEvent,
    saveEventTimesToRedis,
    removeEventTimesFromRedis,
    redisMetaKey,
};
