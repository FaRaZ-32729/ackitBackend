/**
 * Standalone schedule worker (optional).
 * Prefer: npm start — API now embeds the worker automatically.
 * Run separately only if you want a dedicated process: npm run worker
 */
require("dotenv").config();
const dbConnection = require("./src/config/dbConnection");
const { connectMqtt } = require("./src/mqtt/mqttConfig");
const { startScheduleWorker } = require("./src/queues/startScheduleWorker");

console.log("✅ Ackit Schedule Worker starting (standalone)...");
console.log("REDIS_HOST =", process.env.REDIS_HOST || "127.0.0.1");
console.log("REDIS_PORT =", process.env.REDIS_PORT || 6379);

dbConnection();

(async () => {
    try {
        await connectMqtt();
        console.log("✅ MQTT connected in worker");
    } catch (err) {
        console.error("❌ MQTT connect failed in worker:", err.message);
    }
    startScheduleWorker();
})();
