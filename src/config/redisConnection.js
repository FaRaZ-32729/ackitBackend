// src/config/redis.js
const { Redis } = require("ioredis");
require("dotenv").config();

const redisConnection = new Redis({
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || null,

    maxRetriesPerRequest: null,     // Required for BullMQ
    enableReadyCheck: true,

    retryStrategy(times) {
        console.log(`Redis reconnecting... attempt ${times}`);
        return Math.min(times * 100, 3000);
    }
});

redisConnection.on("connect", () => console.log("✅ Redis Connected"));
redisConnection.on("error", (err) => console.error("❌ Redis Error:", err.message));
redisConnection.on("reconnecting", () => console.log("🔄 Redis Reconnecting..."));

module.exports = redisConnection;