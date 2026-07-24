// Map UI short day names + full names → cron weekday numbers (Sun=0)
const dayMap = {
    sun: 0,
    sunday: 0,
    mon: 1,
    monday: 1,
    tue: 2,
    tuesday: 2,
    wed: 3,
    wednesday: 3,
    thu: 4,
    thursday: 4,
    fri: 5,
    friday: 5,
    sat: 6,
    saturday: 6,
};

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dayToIndex(day) {
    const key = String(day || "")
        .toLowerCase()
        .trim();
    if (!(key in dayMap)) throw new Error(`Invalid day: ${day}`);
    return dayMap[key];
}

function indexToDay(index) {
    const i = ((index % 7) + 7) % 7;
    return DAY_LABELS[i];
}

/** Shift Mon/Tue/... by delta days (can be negative). */
function shiftDays(days, delta) {
    return [...new Set((days || []).map((d) => indexToDay(dayToIndex(d) + delta)))];
}

function parseHmToMinutes(time) {
    const [hour, minute] = String(time || "")
        .split(":")
        .map(Number);
    if (
        !Number.isFinite(hour) ||
        !Number.isFinite(minute) ||
        hour < 0 ||
        hour > 23 ||
        minute < 0 ||
        minute > 59
    ) {
        throw new Error(`Invalid time: ${time}`);
    }
    return hour * 60 + minute;
}

function minutesToHm(totalMinutes) {
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Convert one local HH:mm on a given weekday → UTC HH:mm + weekday.
 * timezoneOffsetMinutes = Date#getTimezoneOffset() (UTC - local, in minutes).
 * Example PK (UTC+5): offset = -300 → local 08:00 → UTC 03:00.
 */
function localDayTimeToUtc(localHm, localDay, timezoneOffsetMinutes) {
    const offset = Number(timezoneOffsetMinutes);
    if (!Number.isFinite(offset)) {
        throw new Error("timezoneOffsetMinutes is required");
    }

    let total = parseHmToMinutes(localHm) + offset;
    let dayShift = 0;
    while (total < 0) {
        total += 24 * 60;
        dayShift -= 1;
    }
    while (total >= 24 * 60) {
        total -= 24 * 60;
        dayShift += 1;
    }

    return {
        time: minutesToHm(total),
        day: indexToDay(dayToIndex(localDay) + dayShift),
        dayShift,
    };
}

/**
 * Convert user-local schedule → UTC times/days for BullMQ.
 * Handles overnight windows (end < start in local time) by shifting end to next local day
 * before converting, so UTC end days are correct.
 *
 * Empty days[] = one-time event (times only; no recurring weekdays).
 */
function convertLocalScheduleToUtc({
    startTime,
    endTime,
    days,
    timezoneOffsetMinutes,
}) {
    const overnight = isOvernight(startTime, endTime);
    const dayList = Array.isArray(days) ? days : [];
    const isRecurring = dayList.length > 0;

    // One-time: convert clock times using a placeholder weekday (day labels unused)
    if (!isRecurring) {
        const sampleStart = localDayTimeToUtc(
            startTime,
            "Mon",
            timezoneOffsetMinutes
        );
        const sampleEnd = localDayTimeToUtc(
            endTime,
            overnight ? "Tue" : "Mon",
            timezoneOffsetMinutes
        );
        return {
            startTime: sampleStart.time,
            endTime: sampleEnd.time,
            days: [],
            endDays: [],
            isOvernight: overnight || sampleStart.time > sampleEnd.time,
            isRecurring: false,
            timezone: "UTC",
        };
    }

    const startDaysUtc = [];
    const endDaysUtc = [];

    for (const localDay of dayList) {
        const startUtc = localDayTimeToUtc(
            startTime,
            localDay,
            timezoneOffsetMinutes
        );
        const endLocalDay = overnight
            ? indexToDay(dayToIndex(localDay) + 1)
            : localDay;
        const endUtc = localDayTimeToUtc(
            endTime,
            endLocalDay,
            timezoneOffsetMinutes
        );

        startDaysUtc.push(startUtc.day);
        endDaysUtc.push(endUtc.day);
    }

    const sampleStart = localDayTimeToUtc(
        startTime,
        dayList[0],
        timezoneOffsetMinutes
    );
    const sampleEndDay = overnight
        ? indexToDay(dayToIndex(dayList[0]) + 1)
        : dayList[0];
    const sampleEnd = localDayTimeToUtc(
        endTime,
        sampleEndDay,
        timezoneOffsetMinutes
    );

    return {
        startTime: sampleStart.time,
        endTime: sampleEnd.time,
        days: [...new Set(startDaysUtc)],
        endDays: [...new Set(endDaysUtc)],
        isOvernight: overnight || sampleStart.time > sampleEnd.time,
        isRecurring: true,
        timezone: "UTC",
    };
}

/**
 * Next fire time (UTC ms) for a one-time local HH:mm using the client's
 * Date#getTimezoneOffset() (UTC − local, in minutes).
 */
function nextOneTimeOccurrenceUtcMs(localHm, timezoneOffsetMinutes, afterMs = Date.now()) {
    const offset = Number(timezoneOffsetMinutes);
    if (!Number.isFinite(offset)) {
        throw new Error("timezoneOffsetMinutes is required");
    }
    const localMinutes = parseHmToMinutes(localHm);
    const hour = Math.floor(localMinutes / 60);
    const minute = localMinutes % 60;

    // Represent "now" in the user's local wall-clock via offset
    const offsetMs = offset * 60 * 1000;
    const localNow = new Date(afterMs - offsetMs);

    let localAsUtc = Date.UTC(
        localNow.getUTCFullYear(),
        localNow.getUTCMonth(),
        localNow.getUTCDate(),
        hour,
        minute,
        0,
        0
    );
    // Real UTC instant for that local wall time
    let fireAt = localAsUtc + offsetMs;

    if (fireAt <= afterMs + 1500) {
        localAsUtc += 24 * 60 * 60 * 1000;
        fireAt = localAsUtc + offsetMs;
    }

    return fireAt;
}

/**
 * Start + end UTC ms for a one-time event (handles overnight end after start).
 */
function oneTimeFireTimesUtcMs({
    localStartTime,
    localEndTime,
    timezoneOffsetMinutes,
    afterMs = Date.now(),
}) {
    const startAt = nextOneTimeOccurrenceUtcMs(
        localStartTime,
        timezoneOffsetMinutes,
        afterMs
    );
    let endAt = nextOneTimeOccurrenceUtcMs(
        localEndTime,
        timezoneOffsetMinutes,
        afterMs
    );
    if (endAt <= startAt) {
        endAt += 24 * 60 * 60 * 1000;
    }
    return { startAt, endAt };
}

/**
 * Build a cron expression for HH:mm on selected weekdays (UTC when tz=UTC).
 * Example: startTime "08:30", days ["Mon","Wed"] → "30 8 * * 1,3"
 */
const generateCron = (time, days) => {
    const [hour, minute] = String(time || "")
        .split(":")
        .map(Number);

    if (
        !Number.isFinite(hour) ||
        !Number.isFinite(minute) ||
        hour < 0 ||
        hour > 23 ||
        minute < 0 ||
        minute > 59
    ) {
        throw new Error(`Invalid time: ${time}`);
    }

    if (!Array.isArray(days) || days.length === 0) {
        throw new Error("At least one day is required for cron");
    }

    const cronDays = days
        .map((d) => dayToIndex(d))
        .sort((a, b) => a - b)
        .join(",");

    return `${minute} ${hour} * * ${cronDays}`;
};

const isOvernight = (startTime, endTime) => {
    return String(startTime) > String(endTime);
};

module.exports = {
    generateCron,
    isOvernight,
    dayMap,
    shiftDays,
    localDayTimeToUtc,
    convertLocalScheduleToUtc,
    nextOneTimeOccurrenceUtcMs,
    oneTimeFireTimesUtcMs,
    DAY_LABELS,
};
