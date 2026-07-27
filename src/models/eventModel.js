const mongoose = require("mongoose");

/**
 * Scheduled AC events (device / venue / organization scope).
 * BullMQ repeatable jobs fire at startTime and endTime on selected days.
 */
const eventSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        /** Who created the event */
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
        },
        scope: {
            type: String,
            enum: ["device", "venue", "organization"],
            required: true,
        },
        organization: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Organization",
            required: true,
        },
        venue: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Venue",
            default: null,
        },
        device: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Device",
            default: null,
        },
        /**
         * For organization-scoped events created by venue-restricted users:
         * only these venues receive the event. Empty = entire organization.
         */
        allowedVenues: {
            type: [
                {
                    type: mongoose.Schema.Types.ObjectId,
                    ref: "Venue",
                },
            ],
            default: [],
        },
        /** ON or OFF event */
        action: {
            type: String,
            enum: ["ON", "OFF"],
            required: true,
        },
        /** Target temp for ON events (16–30) */
        targetTemp: {
            type: Number,
            min: 16,
            max: 30,
            default: null,
        },
        /** HH:mm in UTC (used by BullMQ) */
        startTime: { type: String, required: true },
        /** HH:mm in UTC (used by BullMQ) */
        endTime: { type: String, required: true },
        /**
         * UTC weekdays for START jobs when recurring: Mon, Tue, ... Sun.
         * Empty array = one-time event.
         */
        days: {
            type: [String],
            default: [],
        },
        /** UTC weekdays for END jobs (may differ when overnight / TZ shift) */
        endDays: {
            type: [String],
            default: [],
        },
        /** false when no days selected — runs once then deleted */
        isRecurring: {
            type: Boolean,
            default: true,
        },
        isOvernight: { type: Boolean, default: false },
        /** Original user-local inputs (for UI display) */
        localStartTime: { type: String, default: "" },
        localEndTime: { type: String, default: "" },
        localDays: { type: [String], default: [] },
        /** Date#getTimezoneOffset() at create time */
        timezoneOffsetMinutes: { type: Number, default: 0 },
        /**
         * Remote lock preference for ON events.
         * OFF events always force lock.
         */
        remote: {
            type: String,
            enum: ["lock", "unlock"],
            default: "unlock",
        },
        enabled: { type: Boolean, default: true },
        status: {
            type: String,
            enum: ["ACTIVE", "INACTIVE"],
            default: "ACTIVE",
        },
        /**
         * Devices that manually overrode this event for the current occurrence only.
         * Cleared on event END and again on the next START (so recurring resumes next day).
         * To stop an event permanently, disable it.
         */
        ignoredDeviceIds: {
            type: [
                {
                    type: mongoose.Schema.Types.ObjectId,
                    ref: "Device",
                },
            ],
            default: [],
        },
        /** When current ignores expire (end of this occurrence) */
        ignoreUntil: { type: Date, default: null },
        /** Absolute UTC window for one-time events (covering / ignore checks) */
        windowStartAt: { type: Date, default: null },
        windowEndAt: { type: Date, default: null },
        /** BullMQ repeatable job keys */
        startJobId: { type: String, default: "" },
        endJobId: { type: String, default: "" },
        /** Always UTC for scheduling */
        timezone: {
            type: String,
            default: "UTC",
        },
    },
    { timestamps: true }
);

eventSchema.index({ organization: 1, scope: 1, enabled: 1 });
eventSchema.index({ venue: 1, enabled: 1 });
eventSchema.index({ device: 1, enabled: 1 });

module.exports = mongoose.model("Event", eventSchema);
