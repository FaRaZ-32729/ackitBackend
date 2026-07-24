/**
 * BullMQ worker for scheduled AC events.
 * Safe to start from the API process (reuses existing MQTT + Mongo).
 */
const { Worker } = require("bullmq");
const redisConnection = require("../config/redisConnection");
const { connectMqtt, getMqttClient } = require("../mqtt/mqttConfig");
const { executeEventJob } = require("./eventExecutor");

let scheduleWorker = null;

async function ensureMqtt() {
    const existing = getMqttClient();
    if (existing?.connected) return;
    connectMqtt();
}

function startScheduleWorker() {
    if (scheduleWorker) return scheduleWorker;

    scheduleWorker = new Worker(
        "ackit-schedules",
        async (job) => {
            console.log("────────────────────────────────────");
            console.log(`⚡ Event job ${job.id}`);
            console.log("   data:", job.data);

            await ensureMqtt();

            const { eventId, phase } = job.data || {};
            if (!eventId || (phase !== "start" && phase !== "end")) {
                console.warn("⚠️ Invalid job payload — expected eventId + phase");
                return { skipped: true, reason: "invalid_payload" };
            }

            const result = await executeEventJob({ eventId, phase });
            console.log("   result:", JSON.stringify(result));
            return result;
        },
        {
            connection: redisConnection,
            concurrency: 5,
        }
    );

    scheduleWorker.on("completed", (job) => {
        console.log(
            `✅ Event done ${job.id} event=${job.data?.eventId} phase=${job.data?.phase}`
        );
    });

    scheduleWorker.on("failed", (job, err) => {
        console.error(`❌ Event failed ${job?.id}:`, err.message);
    });

    scheduleWorker.on("error", (err) => {
        console.error("Schedule worker error:", err.message);
    });

    console.log("✅ Schedule Worker ready (queue: ackit-schedules)");
    return scheduleWorker;
}

module.exports = { startScheduleWorker };
