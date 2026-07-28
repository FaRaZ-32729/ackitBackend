/**
 * Energy consumption from ESP current time-series samples.
 *
 * ESP saves one averaged current reading every 5 minutes
 * → 60 / 5 = 12 samples per hour.
 *
 * ---------------------------------------------------------------------------
 * Formula (matches product calc sheet):
 *
 *   1) hours          = period length in hours
 *   2) y              = hours × 12          // how many newest samples to use
 *   3) samples        = newest y readings from DeviceCurrent
 *   4) sumCurrent     = Σ sample.current
 *   5) units (kWh)    = (207 × sumCurrent / 1000) × (1/12)
 *
 * Why this works physically:
 *   Power (kW) for one sample ≈ V × I / 1000 = 207 × I / 1000
 *   Each sample covers Δt = 5 min = 1/12 hour
 *   Energy (kWh) for one sample ≈ Power × Δt = (207 × I / 1000) × (1/12)
 *   Total over many samples:
 *     kWh = Σ (207 × Iᵢ / 1000 × 1/12)
 *         = (207 / 1000 / 12) × Σ Iᵢ
 *         = (207 × sumCurrent / 1000) × (1/12)
 *
 * NOTE: Use ÷ 1000 (W→kW). Do not use ÷ 100.
 * ---------------------------------------------------------------------------
 */

/** Fixed line voltage used in the energy (kWh) formula (Volts). */
const LINE_VOLTAGE_V = 207;

/**
 * Display / instantaneous power voltage (Volts).
 * Power (W) = latestCurrent(A) × POWER_VOLTAGE_V
 */
const POWER_VOLTAGE_V = 230;

/** Samples per hour when ESP publishes every 5 minutes. */
const SAMPLES_PER_HOUR = 12;

/** Duration represented by one sample (hours). 5 min = 1/12 h. */
const HOURS_PER_SAMPLE = 1 / SAMPLES_PER_HOUR;

/**
 * Period tabs on the Energy Report chart → hours to look back.
 */
const PERIOD_HOURS = {
    hourly: 1,
    daily: 24,
    weekly: 24 * 7,
    monthly: 24 * 30,
    yearly: 24 * 365,
};

/**
 * How many newest samples to fetch for a chart period.
 * y = hours × 12
 *
 * @param {'hourly'|'daily'|'weekly'|'monthly'|'yearly'} period
 * @returns {{ hours: number, sampleLimit: number }}
 */
function getPeriodSampleWindow(period) {
    const hours = PERIOD_HOURS[period];
    if (!hours) {
        throw new Error(`Unknown energy period: ${period}`);
    }
    const sampleLimit = hours * SAMPLES_PER_HOUR;
    return { hours, sampleLimit };
}

/**
 * Convert a list of current readings (A) into energy units (kWh).
 *
 * units = (207 × sum(current) / 1000) × (1/12)
 *
 * @param {number[]} currents - Amp readings from time-series
 * @returns {{ sumCurrent: number, kwh: number, sampleCount: number }}
 */
function currentsToKwh(currents) {
    const list = Array.isArray(currents) ? currents : [];
    const sumCurrent = list.reduce((acc, value) => {
        const n = Number(value);
        return acc + (Number.isFinite(n) && n >= 0 ? n : 0);
    }, 0);

    // (207 × sumCurrent / 1000) × (1/12)
    const kwh =
        ((LINE_VOLTAGE_V * sumCurrent) / 1000) * HOURS_PER_SAMPLE;

    return {
        sumCurrent: Number(sumCurrent.toFixed(6)),
        kwh: Number(kwh.toFixed(6)),
        sampleCount: list.length,
    };
}

/**
 * Same formula for a single pre-computed sum of currents.
 *
 * @param {number} sumCurrent
 * @returns {number} kWh
 */
function sumCurrentToKwh(sumCurrent) {
    const sum = Number(sumCurrent) || 0;
    return Number((((LINE_VOLTAGE_V * sum) / 1000) * HOURS_PER_SAMPLE).toFixed(6));
}

/**
 * Bucket size (ms) used when building chart series for a period.
 * - hourly → 5-minute bars (one bar per sample slot)
 * - daily  → 1-hour bars
 * - weekly / monthly → 1-day bars
 * - yearly → 1-month bars
 */
function getChartBucketMs(period) {
    switch (period) {
        case "hourly":
            return 5 * 60 * 1000;
        case "daily":
            return 60 * 60 * 1000;
        case "weekly":
        case "monthly":
            return 24 * 60 * 60 * 1000;
        case "yearly":
            return 30 * 24 * 60 * 60 * 1000;
        default:
            return 60 * 60 * 1000;
    }
}

/**
 * Format a bucket start time as a short chart label.
 */
function formatBucketLabel(period, date) {
    const d = date instanceof Date ? date : new Date(date);
    if (Number.isNaN(d.getTime())) return "—";

    if (period === "hourly") {
        const hh = String(d.getHours()).padStart(2, "0");
        const mm = String(d.getMinutes()).padStart(2, "0");
        return `${hh}:${mm}`;
    }
    if (period === "daily") {
        const hh = String(d.getHours()).padStart(2, "0");
        return `${hh}:00`;
    }
    if (period === "weekly" || period === "monthly") {
        return d.toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
        });
    }
    // yearly
    return d.toLocaleDateString(undefined, {
        month: "short",
        year: "2-digit",
    });
}

/**
 * Build ordered chart points from raw samples (newest→oldest fetch is OK).
 * Samples are grouped into time buckets; each bucket applies the kWh formula.
 *
 * @param {Array<{ current: number, timestamp: Date|string }>} samples
 * @param {'hourly'|'daily'|'weekly'|'monthly'|'yearly'} period
 * @returns {{ series: Array<{ label: string, kwh: number }>, totalKwh: number, sampleCount: number, sumCurrent: number }}
 */
function buildEnergySeriesFromSamples(samples, period) {
    const list = Array.isArray(samples) ? samples : [];
    const bucketMs = getChartBucketMs(period);
    const buckets = new Map(); // key = bucketStartMs → { sumCurrent, timestamp }

    for (const row of list) {
        const ts = new Date(row.timestamp).getTime();
        if (!Number.isFinite(ts)) continue;
        const current = Number(row.current);
        if (!Number.isFinite(current) || current < 0) continue;

        const bucketStart = Math.floor(ts / bucketMs) * bucketMs;
        const existing = buckets.get(bucketStart) || {
            sumCurrent: 0,
            timestamp: bucketStart,
        };
        existing.sumCurrent += current;
        buckets.set(bucketStart, existing);
    }

    const series = Array.from(buckets.values())
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((b) => ({
            label: formatBucketLabel(period, b.timestamp),
            kwh: sumCurrentToKwh(b.sumCurrent),
        }));

    const allCurrents = list.map((s) => Number(s.current));
    const totals = currentsToKwh(allCurrents);

    return {
        series,
        totalKwh: totals.kwh,
        sampleCount: totals.sampleCount,
        sumCurrent: totals.sumCurrent,
    };
}

/**
 * Instantaneous power from a current reading.
 * powerW = current(A) × 230
 *
 * @param {number} currentA
 * @returns {{ currentA: number, powerW: number, powerKw: number }}
 */
function currentToPower(currentA) {
    const current = Number(currentA);
    const safe = Number.isFinite(current) && current >= 0 ? current : 0;
    const powerW = safe * POWER_VOLTAGE_V;
    return {
        currentA: Number(safe.toFixed(4)),
        powerW: Number(powerW.toFixed(2)),
        powerKw: Number((powerW / 1000).toFixed(4)),
    };
}

module.exports = {
    LINE_VOLTAGE_V,
    POWER_VOLTAGE_V,
    SAMPLES_PER_HOUR,
    HOURS_PER_SAMPLE,
    PERIOD_HOURS,
    getPeriodSampleWindow,
    currentsToKwh,
    sumCurrentToKwh,
    currentToPower,
    getChartBucketMs,
    formatBucketLabel,
    buildEnergySeriesFromSamples,
};
