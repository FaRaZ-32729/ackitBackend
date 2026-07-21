const mqtt = require("mqtt");
const {
    getSession,
    markDeviceConnected,
    applyPulseToPending,
} = require("../services/brandConfigureSession");
const { normalizePulseValue } = require("../utils/brandCommandMap");

let client = null;
let isConnecting = false;

function buildBrokerUrl() {
    const host = process.env.MQTT_HOST || "127.0.0.1";
    const port = process.env.MQTT_PORT || "1883";
    const protocol = process.env.MQTT_PROTOCOL || "mqtt";
    return `${protocol}://${host}:${port}`;
}

function buildConnectOptions() {
    const options = {
        clientId: process.env.MQTT_CLIENT_ID || `ackit-backend-${process.env.NODE_ENV || "local"}-${Date.now()}`,
        clean: true,
        reconnectPeriod: Number(process.env.MQTT_RECONNECT_MS || 5000),
        connectTimeout: Number(process.env.MQTT_CONNECT_TIMEOUT_MS || 30000),
    };

    if (process.env.MQTT_USER) {
        options.username = process.env.MQTT_USER;
    }
    if (process.env.MQTT_PASS) {
        options.password = process.env.MQTT_PASS;
    }

    return options;
}

function emitToConfigureRoom(configureId, event, payload) {
    if (!global.io) return;
    global.io.to(`brand:${configureId}`).emit(event, payload);
}

function parseMqttJson(message) {
    const text = message.toString();
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

function handleStatusMessage(configureId, payload) {
    const session = getSession(configureId);
    if (!session) {
        console.warn(`[MQTT] status for unknown configureId ${configureId}`);
        return;
    }

    const status =
        typeof payload === "string"
            ? payload
            : payload?.status || payload?.state || "";

    const connected =
        String(status).toLowerCase() === "connected" ||
        payload === true ||
        payload?.connected === true;

    if (!connected) return;

    markDeviceConnected(configureId);
    emitToConfigureRoom(configureId, "brand:device-connected", {
        configureId,
        deviceConnected: true,
    });
    console.log(`[MQTT] device paired for configureId=${configureId}`);
}

function handleIrMessage(configureId, payload) {
    const session = getSession(configureId);
    if (!session) {
        console.warn(`[MQTT] IR for unknown configureId ${configureId}`);
        return;
    }

    if (!session.pendingField) {
        console.warn(`[MQTT] IR received but no pending field for ${configureId}`);
        emitToConfigureRoom(configureId, "brand:ir-ignored", {
            configureId,
            reason: "No command selected on frontend",
        });
        return;
    }

    const pulseValue = normalizePulseValue(payload);
    if (!pulseValue) {
        emitToConfigureRoom(configureId, "brand:ir-ignored", {
            configureId,
            reason: "Empty IR payload",
        });
        return;
    }

    const result = applyPulseToPending(configureId, pulseValue);
    if (!result) {
        emitToConfigureRoom(configureId, "brand:ir-ignored", {
            configureId,
            reason: "Failed to map IR to pending field",
        });
        return;
    }

    emitToConfigureRoom(configureId, "brand:ir-captured", {
        configureId,
        field: result.applied,
        value: pulseValue,
    });
    console.log(
        `[MQTT] IR saved for ${configureId} → ${result.applied.group}.${result.applied.key}`
    );
    console.log(`[MQTT] Command value: ${pulseValue}`);
}

function handleMqttMessage(topic, message) {
    // Expected:
    //   ackit/configure/{configureId}/status
    //   ackit/configure/{configureId}/ir
    const parts = topic.split("/");
    if (parts.length < 4) return;
    if (parts[0] !== "ackit" || parts[1] !== "configure") return;

    const configureId = parts[2];
    const channel = parts[3];
    const payload = parseMqttJson(message);

    if (channel === "status") {
        handleStatusMessage(configureId, payload);
        return;
    }

    if (channel === "ir") {
        handleIrMessage(configureId, payload);
    }
}

function subscribeBrandTopics(mqttClient) {
    const topics = ["ackit/configure/+/status", "ackit/configure/+/ir"];
    mqttClient.subscribe(topics, (err) => {
        if (err) {
            console.error("MQTT subscribe error:", err.message);
            return;
        }
        console.log(`MQTT subscribed: ${topics.join(", ")}`);
    });
}

function connectMqtt() {
    if (client?.connected) {
        return client;
    }

    if (isConnecting && client) {
        return client;
    }

    const brokerUrl = buildBrokerUrl();
    const options = buildConnectOptions();

    isConnecting = true;
    client = mqtt.connect(brokerUrl, options);

    client.on("connect", () => {
        isConnecting = false;
        console.log(`MQTT connected: ${brokerUrl}`);
        subscribeBrandTopics(client);
    });

    client.on("message", handleMqttMessage);

    client.on("reconnect", () => {
        console.log("MQTT reconnecting...");
    });

    client.on("close", () => {
        console.log("MQTT connection closed");
    });

    client.on("offline", () => {
        console.log("MQTT client offline");
    });

    client.on("error", (error) => {
        isConnecting = false;
        console.error("MQTT connection error:", error.message);
    });

    return client;
}

function getMqttClient() {
    if (!client) {
        return connectMqtt();
    }
    return client;
}

// Publish a saved command to the ESP so it re-transmits it to the physical AC.
// Topic: ackit/configure/{configureId}/command
function publishBrandCommand(configureId, value) {
    const mqttClient = getMqttClient();
    if (!mqttClient) return false;

    const topic = `ackit/configure/${configureId}/command`;
    mqttClient.publish(topic, value);
    console.log(`[MQTT] Apply command -> ${topic}: ${value}`);
    return true;
}

function disconnectMqtt() {
    if (!client) return;

    client.end(false, () => {
        console.log("MQTT disconnected");
    });
    client = null;
    isConnecting = false;
}

module.exports = {
    connectMqtt,
    getMqttClient,
    disconnectMqtt,
    buildBrokerUrl,
    publishBrandCommand,
};
