// src/queues/scheduleQueue.js
const { Queue } = require("bullmq");
const redisConnection = require("../config/redisConnection");

const scheduleQueue = new Queue("ackit-schedules", {
    connection: redisConnection,
    defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: false,
        removeOnFail: false
    }
});

console.log("✅ Schedule Queue Initialized");

module.exports = scheduleQueue;