const mongoose = require("mongoose");
const Device = require("../models/deviceModel");
const Organization = require("../models/organizationModel");
const Venue = require("../models/venueModel");
const DeviceCurrent = require("../models/deviceCurrentModel");
const {
    getPeriodSampleWindow,
    buildEnergySeriesFromSamples,
    currentsToKwh,
    currentToPower,
    LINE_VOLTAGE_V,
    POWER_VOLTAGE_V,
    SAMPLES_PER_HOUR,
} = require("../utils/energyConsumptionCalc");

const VALID_PERIODS = new Set([
    "hourly",
    "daily",
    "weekly",
    "monthly",
    "yearly",
]);

function hasOrganizationAccess(user, organization) {
    if (user.role === "admin") return true;
    if (String(organization.owner) === String(user._id)) return true;
    return (user.organizations || []).some(
        (id) => String(id) === String(organization._id)
    );
}

function hasVenueAccess(user, venueId) {
    if (user.role !== "user") return true;
    return (user.venues || []).some(
        (entry) => String(entry.venueId || entry) === String(venueId)
    );
}

function parseDeviceIds(raw) {
    if (Array.isArray(raw)) {
        return raw.map(String).map((s) => s.trim()).filter(Boolean);
    }
    if (typeof raw === "string") {
        return raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
    }
    return [];
}

/**
 * GET /api/device/energy?deviceIds=id1,id2&period=daily
 *
 * Per device: newest (hours × 12) current samples →
 *   units (kWh) = (207 × sum(current) / 1000) × (1/12)
 *   power (W)   = latestCurrent × 230
 */
const getDeviceEnergy = async (req, res) => {
    try {
        const period = String(req.query.period || "daily").toLowerCase();
        if (!VALID_PERIODS.has(period)) {
            return res.status(400).json({
                success: false,
                message:
                    "Invalid period. Use hourly, daily, weekly, monthly, or yearly.",
            });
        }

        const deviceIds = parseDeviceIds(req.query.deviceIds);
        if (deviceIds.length === 0) {
            return res.status(400).json({
                success: false,
                message: "deviceIds query param is required",
            });
        }

        for (const id of deviceIds) {
            if (!mongoose.Types.ObjectId.isValid(id)) {
                return res.status(400).json({
                    success: false,
                    message: `Invalid device id: ${id}`,
                });
            }
        }

        const devices = await Device.find({ _id: { $in: deviceIds } })
            .select("_id deviceName organization venue")
            .lean();

        if (devices.length !== deviceIds.length) {
            return res.status(404).json({
                success: false,
                message: "One or more devices were not found",
            });
        }

        const orgIds = [
            ...new Set(devices.map((d) => String(d.organization))),
        ];
        const venueIds = [...new Set(devices.map((d) => String(d.venue)))];

        const [organizations, venues] = await Promise.all([
            Organization.find({ _id: { $in: orgIds } }).lean(),
            Venue.find({ _id: { $in: venueIds } }).lean(),
        ]);

        const orgById = new Map(
            organizations.map((o) => [String(o._id), o])
        );
        const venueById = new Map(venues.map((v) => [String(v._id), v]));

        for (const device of devices) {
            const organization = orgById.get(String(device.organization));
            if (!organization) {
                return res.status(404).json({
                    success: false,
                    message: "Organization not found for a device",
                });
            }
            if (!hasOrganizationAccess(req.user, organization)) {
                return res.status(403).json({
                    success: false,
                    message: "Access denied to one or more devices",
                });
            }
            if (!hasVenueAccess(req.user, device.venue)) {
                return res.status(403).json({
                    success: false,
                    message: "Access denied to one or more device venues",
                });
            }
        }

        const { hours, sampleLimit } = getPeriodSampleWindow(period);

        // Newest → oldest: hours × 12 samples per device
        const perDeviceSamples = await Promise.all(
            devices.map((device) =>
                DeviceCurrent.find({ device: device._id })
                    .sort({ timestamp: -1 })
                    .limit(sampleLimit)
                    .select("current timestamp")
                    .lean()
            )
        );

        const deviceRows = devices.map((device, index) => {
            const samples = perDeviceSamples[index] || [];
            const currents = samples.map((s) => Number(s.current));
            const energy = currentsToKwh(currents);
            // Newest sample first (sorted timestamp desc)
            const latestCurrent =
                samples.length > 0 ? Number(samples[0].current) : 0;
            const power = currentToPower(latestCurrent);
            const organization = orgById.get(String(device.organization));
            const venue = venueById.get(String(device.venue));

            return {
                deviceId: String(device._id),
                deviceName: device.deviceName || "—",
                organizationId: String(device.organization),
                organizationName: organization?.name || "—",
                venueId: String(device.venue),
                venueName: venue?.name || "—",
                unitsKwh: energy.kwh,
                sumCurrent: energy.sumCurrent,
                sampleCount: energy.sampleCount,
                currentA: power.currentA,
                powerW: power.powerW,
                powerKw: power.powerKw,
            };
        });

        // Preserve request order when possible
        const rowById = new Map(deviceRows.map((r) => [r.deviceId, r]));
        const orderedRows = deviceIds
            .map((id) => rowById.get(String(id)))
            .filter(Boolean);

        const samples = perDeviceSamples.flat();
        const built = buildEnergySeriesFromSamples(samples, period);

        return res.status(200).json({
            success: true,
            period,
            hours,
            sampleLimit,
            deviceCount: orderedRows.length,
            samplesFetched: built.sampleCount,
            sumCurrent: built.sumCurrent,
            totalKwh: built.totalKwh,
            formula: {
                energyVoltageV: LINE_VOLTAGE_V,
                powerVoltageV: POWER_VOLTAGE_V,
                samplesPerHour: SAMPLES_PER_HOUR,
                energyExpression:
                    "units_kWh = (207 × sum(current) / 1000) × (1/12)",
                powerExpression: "power_W = current × 230",
            },
            series: built.series,
            devices: orderedRows,
        });
    } catch (error) {
        console.error("getDeviceEnergy error:", error);
        return res.status(500).json({
            success: false,
            message: "Server error while computing energy consumption",
        });
    }
};

module.exports = {
    getDeviceEnergy,
};
