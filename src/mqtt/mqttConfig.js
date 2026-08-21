const mqtt = require("mqtt");
const Device = require("../models/deviceModel");
const DeviceCurrent = require("../models/deviceCurrentModel");
const {
    getSession,
    markDeviceConnected,
    applyPulseToPending,
} = require("../services/brandConfigureSession");
const {
    normalizePulseValue,
    brandDocumentToCommandsMap,
} = require("../utils/brandCommandMap");

let client = null;
let isConnecting = false;

/** Avoid flooding ESP with the same brand pack on every heartbeat */
const lastCommandPushAt = new Map();
const COMMAND_PUSH_COOLDOWN_MS = 45000;

/** deviceId → true after ESP posts state/temp following an online transition */
const espStateSyncedAfterOnline = new Map();

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

function normalizeStatusValue(payload) {
    if (typeof payload === "string") return payload.toLowerCase().trim();
    if (payload === true) return "online";
    if (payload?.connected === true) return "online";
    return String(payload?.status || payload?.state || "")
        .toLowerCase()
        .trim();
}

function handleStatusMessage(configureId, payload) {
    const session = getSession(configureId);
    if (!session) {
        console.warn(`[MQTT] status for unknown configureId ${configureId}`);
        return;
    }

    const status = normalizeStatusValue(payload);
    const connected = status === "connected" || status === "online";

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

function publishBrandCommandsToDevice(device) {
    const mqttClient = getMqttClient();
    if (!mqttClient?.connected) {
        console.warn(
            `[MQTT] cannot push brand commands for ${device.deviceId}: broker offline`
        );
        return false;
    }

    const brand = device.brand;
    if (!brand || !brand._id) {
        console.warn(
            `[MQTT] device ${device.deviceId} has no brand — skip command sync`
        );
        return false;
    }

    const commands = brandDocumentToCommandsMap(brand);
    const entries = Object.entries(commands);
    const commandCount = entries.length;
    if (commandCount === 0) {
        console.warn(
            `[MQTT] brand "${brand.brandName}" has no decoded commands for ${device.deviceId}`
        );
        return false;
    }

    const now = Date.now();
    const last = lastCommandPushAt.get(device.deviceId) || 0;
    if (now - last < COMMAND_PUSH_COOLDOWN_MS) {
        return false;
    }
    lastCommandPushAt.set(device.deviceId, now);

    const itemTopic = `ackit/device/${device.deviceId}/command`;

    // 1) begin
    mqttClient.publish(
        itemTopic,
        JSON.stringify({
            action: "begin",
            deviceId: device.deviceId,
            brandId: String(brand._id),
            brandName: brand.brandName,
            count: commandCount,
        })
    );
    console.log(
        `[MQTT] brand sync BEGIN -> ${itemTopic} (brand=${brand.brandName}, count=${commandCount})`
    );
    console.log(`[MQTT] command keys: ${entries.map(([k]) => k).join(", ")}`);

    // 2) one MQTT message per command (fits ESP PubSubClient buffer)
    entries.forEach(([key, value], index) => {
        const item = JSON.stringify({
            action: "item",
            index: index + 1,
            key,
            value,
        });
        mqttClient.publish(itemTopic, item);
        console.log(
            `[MQTT] command ${index + 1}/${commandCount} -> ${key} (${String(value).length} chars)`
        );
    });

    // 3) end — ESP saves to flash + ACKs
    mqttClient.publish(
        itemTopic,
        JSON.stringify({
            action: "end",
            deviceId: device.deviceId,
            count: commandCount,
        })
    );
    console.log(
        `[MQTT] brand sync END -> ${itemTopic} (awaiting ESP configured ACK)`
    );

    return true;
}

async function handleDeviceStatusMessage(deviceId, payload) {
    const normalizedId = String(deviceId || "")
        .trim()
        .toUpperCase();

    if (!/^[A-Z0-9]{6}$/.test(normalizedId)) {
        console.warn(`[MQTT] invalid deviceId in status topic: ${deviceId}`);
        return;
    }

    const status = normalizeStatusValue(payload);
    let nextStatus = null;

    if (status === "online" || status === "connected") {
        nextStatus = "online";
    } else if (status === "offline" || status === "disconnected") {
        nextStatus = "offline";
    } else {
        console.warn(
            `[MQTT] ignored device status for ${normalizedId}: ${status || "(empty)"}`
        );
        return;
    }

    try {
        const device = await Device.findOne({ deviceId: normalizedId }).populate(
            "brand"
        );

        if (!device) {
            console.warn(
                `[MQTT] no device found for deviceId=${normalizedId} (status=${nextStatus})`
            );
            return;
        }

        const becameOnline =
            nextStatus === "online" && device.status !== "online";

        if (becameOnline) {
            espStateSyncedAfterOnline.delete(normalizedId);
        }

        if (device.status !== nextStatus) {
            device.status = nextStatus;
            await device.save();
        }

        console.log(
            `[MQTT] device ${normalizedId} (${device.deviceName}) status -> ${nextStatus}`
        );

        if (global.io) {
            global.io.emit("device:status", {
                id: String(device._id),
                deviceId: device.deviceId,
                status: device.status,
                configure: device.configure,
            });
        }

        // Only on transition to online (not every retained/heartbeat online publish)
        if (becameOnline) {
            // First-time (or not-yet-synced) devices receive full brand IR pack
            if (device.configure === false) {
                publishBrandCommandsToDevice(device);
            }

            const remoteMode = device.remote || "unlock";
            const desiredState =
                device.state === "on" || device.state === "off"
                    ? device.state
                    : null;
            const desiredTemp =
                device.temperature != null ? device.temperature : null;

            if (remoteMode === "lock") {
                // LOCKED: dashboard/DB is source of truth.
                // Offline physical-remote drift must be discarded — push desired to ESP+AC.
                publishDeviceRemoteMode(device.deviceId, {
                    remote: "lock",
                    state: desiredState,
                    temperature: desiredTemp,
                });

                const pendingDeviceId = device.deviceId;
                const pendingMongoId = String(device._id);
                setTimeout(async () => {
                    try {
                        const fresh = await Device.findById(pendingMongoId);
                        if (!fresh || fresh.remote !== "lock") return;

                        const applyState =
                            fresh.state === "on" || fresh.state === "off"
                                ? fresh.state
                                : "off";
                        publishDeviceApplyCommand(fresh.deviceId, {
                            key:
                                applyState === "on" ? "power.on" : "power.off",
                            state: applyState,
                            temperature:
                                applyState === "on" ? fresh.temperature : null,
                        });
                        if (fresh.pendingControl) {
                            fresh.pendingControl = false;
                            await fresh.save();
                        }
                        console.log(
                            `[MQTT] lock reconnect apply for ${pendingDeviceId}: ${applyState} / ${fresh.temperature}`
                        );
                    } catch (err) {
                        console.error(
                            `[MQTT] lock reconnect apply failed:`,
                            err.message
                        );
                    }
                }, 2500);
            } else {
                // UNLOCK / SUPERLOCK: physical/offline remote changes are SoT.
                // Sync mode only — do NOT push DB state/temp (would wipe ESP flash).
                publishDeviceRemoteMode(device.deviceId, {
                    remote: remoteMode,
                    state: null,
                    temperature: null,
                });

                // Dashboard changes while ESP was offline (pendingControl).
                // Delay so ESP can first publish its flash state/temp.
                if (device.pendingControl) {
                    const pendingDeviceId = device.deviceId;
                    const pendingMongoId = String(device._id);
                    setTimeout(async () => {
                        try {
                            const fresh = await Device.findById(pendingMongoId);
                            if (!fresh || !fresh.pendingControl) return;

                            if (espStateSyncedAfterOnline.has(pendingDeviceId)) {
                                fresh.pendingControl = false;
                                await fresh.save();
                                console.log(
                                    `[MQTT] skipped pending control for ${pendingDeviceId} — ESP already reported physical state`
                                );
                                return;
                            }

                            const applyState =
                                fresh.state === "on" || fresh.state === "off"
                                    ? fresh.state
                                    : "off";
                            publishDeviceApplyCommand(fresh.deviceId, {
                                key:
                                    applyState === "on"
                                        ? "power.on"
                                        : "power.off",
                                state: applyState,
                                temperature:
                                    applyState === "on"
                                        ? fresh.temperature
                                        : null,
                            });
                            fresh.pendingControl = false;
                            await fresh.save();
                            console.log(
                                `[MQTT] applied pending control for ${pendingDeviceId}: ${applyState} / ${fresh.temperature}`
                            );
                        } catch (err) {
                            console.error(
                                `[MQTT] pending control apply failed:`,
                                err.message
                            );
                        }
                    }, 3000);
                }
            }
        }
    } catch (error) {
        console.error(
            `[MQTT] failed to update device ${normalizedId}:`,
            error.message
        );
    }
}

async function handleDeviceConfiguredMessage(deviceId, payload) {
    const normalizedId = String(deviceId || "")
        .trim()
        .toUpperCase();

    if (!/^[A-Z0-9]{6}$/.test(normalizedId)) {
        console.warn(`[MQTT] invalid deviceId in configured topic: ${deviceId}`);
        return;
    }

    const status = normalizeStatusValue(payload);
    const ok =
        status === "configured" ||
        status === "ok" ||
        status === "success" ||
        payload?.configured === true ||
        payload?.success === true;

    if (!ok) {
        console.warn(
            `[MQTT] ignored configured payload for ${normalizedId}:`,
            payload
        );
        return;
    }

    try {
        const device = await Device.findOneAndUpdate(
            { deviceId: normalizedId },
            { $set: { configure: true } },
            { new: true }
        );

        if (!device) {
            console.warn(
                `[MQTT] configured ACK for unknown deviceId=${normalizedId}`
            );
            return;
        }

        lastCommandPushAt.delete(normalizedId);
        console.log(
            `[MQTT] device ${normalizedId} configure=true (brand commands saved on ESP)`
        );

        if (global.io) {
            global.io.emit("device:configured", {
                id: String(device._id),
                deviceId: device.deviceId,
                configure: true,
            });
        }
    } catch (error) {
        console.error(
            `[MQTT] failed to mark device ${normalizedId} configured:`,
            error.message
        );
    }
}

/**
 * Ask ESP to apply a stored IR command key (e.g. power.on / power.off).
 * Topic: ackit/device/{deviceId}/control
 */
function publishDeviceApplyCommand(deviceId, { key, state, temperature }) {
    const mqttClient = getMqttClient();
    if (!mqttClient?.connected) return false;

    const normalizedId = String(deviceId || "")
        .trim()
        .toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(normalizedId) || !key) return false;

    const topic = `ackit/device/${normalizedId}/control`;
    const payload = JSON.stringify({
        action: "apply",
        key,
        state: state || null,
        temperature:
            temperature == null || Number.isNaN(Number(temperature))
                ? null
                : Number(temperature),
    });

    mqttClient.publish(topic, payload);
    console.log(
        `[MQTT] apply -> ${topic} key=${key} state=${state || "-"} temp=${
            temperature == null ? "-" : temperature
        }`
    );
    return true;
}

/**
 * Sync lock mode + dashboard desired state/temp to the ESP.
 * Topic: ackit/device/{deviceId}/control  action=set_remote
 */
function publishDeviceRemoteMode(deviceId, { remote, state, temperature }) {
    const mqttClient = getMqttClient();
    if (!mqttClient?.connected) return false;

    const normalizedId = String(deviceId || "")
        .trim()
        .toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(normalizedId)) return false;

    const mode = ["unlock", "lock", "superlock"].includes(remote)
        ? remote
        : "unlock";

    const topic = `ackit/device/${normalizedId}/control`;
    const payload = JSON.stringify({
        action: "set_remote",
        remote: mode,
        state: state === "on" || state === "off" ? state : null,
        temperature:
            temperature == null || Number.isNaN(Number(temperature))
                ? null
                : Number(temperature),
    });

    mqttClient.publish(topic, payload);
    console.log(
        `[MQTT] set_remote -> ${topic} remote=${mode} state=${state || "-"} temp=${
            temperature == null ? "-" : temperature
        }`
    );
    return true;
}

/**
 * Tell ESP to run a scheduled event phase (start | end).
 * Topic: ackit/device/{deviceId}/control  action=event
 *
 * Payload example:
 * {
 *   action: "event",
 *   phase: "start",
 *   eventAction: "ON",
 *   temperature: 24,
 *   remote: "lock",
 *   eventId: "...",
 *   name: "Morning"
 * }
 */
function publishDeviceEvent(deviceId, {
    phase,
    eventAction,
    temperature,
    remote,
    eventId,
    name,
}) {
    const mqttClient = getMqttClient();
    if (!mqttClient?.connected) return false;

    const normalizedId = String(deviceId || "")
        .trim()
        .toUpperCase();
    if (!/^[A-Z0-9]{6}$/.test(normalizedId)) return false;

    const normalizedPhase = phase === "end" ? "end" : "start";
    const normalizedAction =
        String(eventAction || "").toUpperCase() === "OFF" ? "OFF" : "ON";
    const mode = ["unlock", "lock", "superlock"].includes(remote)
        ? remote
        : normalizedAction === "OFF"
          ? "lock"
          : "unlock";

    const topic = `ackit/device/${normalizedId}/control`;
    const payload = JSON.stringify({
        action: "event",
        phase: normalizedPhase,
        eventAction: normalizedAction,
        remote: mode,
        temperature:
            temperature == null || Number.isNaN(Number(temperature))
                ? null
                : Number(temperature),
        eventId: eventId ? String(eventId) : null,
        name: name ? String(name) : null,
    });

    mqttClient.publish(topic, payload);
    console.log(
        `[MQTT] event -> ${topic} phase=${normalizedPhase} action=${normalizedAction} remote=${mode} temp=${
            temperature == null ? "-" : temperature
        }`
    );
    return true;
}

async function handleDeviceStateMessage(deviceId, payload) {
    const normalizedId = String(deviceId || "")
        .trim()
        .toUpperCase();

    if (!/^[A-Z0-9]{6}$/.test(normalizedId)) {
        console.warn(`[MQTT] invalid deviceId in state topic: ${deviceId}`);
        return;
    }

    const raw =
        typeof payload === "string"
            ? payload.toLowerCase().trim()
            : String(payload?.state || payload?.status || "")
                  .toLowerCase()
                  .trim();

    let nextState = null;
    if (raw === "on" || raw === "off") nextState = raw;

    let nextTemperature = null;
    const tempRaw =
        typeof payload === "object" && payload
            ? Number(payload.temperature)
            : NaN;
    if (Number.isFinite(tempRaw) && tempRaw >= 16 && tempRaw <= 30) {
        nextTemperature = Math.round(tempRaw);
    }

    let nextCurrent = null;
    const currentRaw =
        typeof payload === "object" && payload
            ? Number(payload.current)
            : NaN;
    if (Number.isFinite(currentRaw) && currentRaw >= 0 && currentRaw < 100) {
        nextCurrent = Number(currentRaw.toFixed(3));
    }

    let nextVentTemperature = null;
    const ventRaw =
        typeof payload === "object" && payload
            ? Number(payload.ventTemperature)
            : NaN;
    if (Number.isFinite(ventRaw) && ventRaw > -40 && ventRaw < 85) {
        nextVentTemperature = Number(ventRaw.toFixed(2));
    }

    let nextAlert = null;
    const alertRaw =
        typeof payload === "object" && payload
            ? String(payload.alert || "")
                  .toLowerCase()
                  .trim()
            : "";
    if (alertRaw === "temp_high" || alertRaw === "temp_ok") {
        nextAlert = alertRaw;
    }

    if (
        !nextState &&
        nextTemperature == null &&
        nextCurrent == null &&
        nextVentTemperature == null &&
        !nextAlert
    ) {
        console.warn(
            `[MQTT] ignored device state for ${normalizedId}:`,
            payload
        );
        return;
    }

    try {
        const device = await Device.findOne({ deviceId: normalizedId });
        if (!device) {
            console.warn(
                `[MQTT] state report for unknown deviceId=${normalizedId}`
            );
            return;
        }

        const updates = {};
        if (nextState) updates.state = nextState;
        if (nextTemperature != null) updates.temperature = nextTemperature;

        // While remote-locked, dashboard desired is source of truth.
        // Reject physical-remote drift and re-push lock + apply to ESP.
        if (
            device.remote === "lock" &&
            (nextState || nextTemperature != null)
        ) {
            const desiredState =
                device.state === "on" || device.state === "off" ? device.state : null;
            const desiredTemp =
                typeof device.temperature === "number"
                    ? device.temperature
                    : null;
            const stateDrift =
                nextState && desiredState && nextState !== desiredState;
            const tempDrift =
                nextTemperature != null &&
                desiredTemp != null &&
                Number(nextTemperature) !== Number(desiredTemp);

            if (stateDrift || tempDrift) {
                console.warn(
                    `[MQTT] locked device ${normalizedId} reported drift ` +
                        `(got ${nextState || "-"}/${nextTemperature ?? "-"}, ` +
                        `desired ${desiredState || "-"}/${desiredTemp ?? "-"}) — rejecting + re-applying`
                );
                publishDeviceRemoteMode(device.deviceId, {
                    remote: "lock",
                    state: desiredState,
                    temperature: desiredTemp,
                });
                if (desiredState) {
                    publishDeviceApplyCommand(device.deviceId, {
                        key: desiredState === "on" ? "power.on" : "power.off",
                        state: desiredState,
                        temperature:
                            desiredState === "on" ? desiredTemp : null,
                    });
                }
                return;
            }
        }

        // Physical AC report from ESP (incl. after offline remote changes)
        if (nextState || nextTemperature != null) {
            espStateSyncedAfterOnline.set(normalizedId, true);
            // Device flash/remote is source of truth — drop stale dashboard pending
            // (but never while locked — pending must still apply)
            if (device.pendingControl && device.remote !== "lock") {
                updates.pendingControl = false;
            }
        }

    // Only accept current from dedicated ESP average publishes: {"current": ...}
    // Ignore current bundled with state/temp (reconnect / retained state sync).
    const isCurrentOnlyTelemetry =
        nextCurrent != null &&
        !nextState &&
        nextTemperature == null &&
        nextVentTemperature == null &&
        !nextAlert &&
        typeof payload === "object" &&
        payload != null;

    if (isCurrentOnlyTelemetry) {
        const voltage = Number(device.voltage) || 230;
        updates.current = nextCurrent;
        // Power (kW) = voltage (V) × current (A) / 1000
        updates.powerConsumption = Number(
            ((nextCurrent * voltage) / 1000).toFixed(3)
        );

        DeviceCurrent.create({
            device: device._id,
            current: nextCurrent,
            timestamp: new Date(),
        }).catch((err) => {
            console.warn(
                `[MQTT] DeviceCurrent save failed for ${normalizedId}:`,
                err.message
            );
        });
    }

        if (nextVentTemperature != null) {
            updates.ventTemperature = nextVentTemperature;
        }

        if (nextAlert === "temp_high") {
            const setTemp =
                typeof payload === "object" && payload
                    ? Number(payload.setTemperature)
                    : NaN;
            const resolvedSet = Number.isFinite(setTemp)
                ? setTemp
                : device.temperature;
            const vent =
                nextVentTemperature != null
                    ? nextVentTemperature
                    : device.ventTemperature;
            updates.health = "faulty";
            updates.healthAlert =
                vent != null
                    ? `Vent ${vent}°C above set ${resolvedSet}°C for 15+ min`
                    : `Vent temperature above set ${resolvedSet}°C for 15+ min`;
        } else if (nextAlert === "temp_ok") {
            updates.health = "healthy";
            updates.healthAlert = "";
        }

        Object.assign(device, updates);
        await device.save();

        console.log(
            `[MQTT] device ${normalizedId} (${device.deviceName}) ->`,
            updates
        );

        if (global.io) {
            global.io.emit("device:state", {
                id: String(device._id),
                deviceId: device.deviceId,
                state: device.state,
                isOn: device.state === "on",
                temperature: device.temperature,
                current: device.current,
                voltage: device.voltage,
                powerConsumption: device.powerConsumption,
                ventTemperature: device.ventTemperature,
                health: device.health,
                healthAlert: device.healthAlert || "",
                hasFault: device.health === "faulty",
            });

            if (nextAlert) {
                global.io.emit("device:alert", {
                    id: String(device._id),
                    deviceId: device.deviceId,
                    deviceName: device.deviceName,
                    alert: nextAlert,
                    ventTemperature: device.ventTemperature,
                    setTemperature:
                        typeof payload === "object" && payload
                            ? Number(payload.setTemperature) ||
                              device.temperature
                            : device.temperature,
                    health: device.health,
                    healthAlert: device.healthAlert || "",
                    hasFault: device.health === "faulty",
                    message:
                        nextAlert === "temp_high"
                            ? device.healthAlert ||
                              `${device.deviceName}: vent temperature fault`
                            : `${device.deviceName}: vent temperature back to normal`,
                });
            }
        }
    } catch (error) {
        console.error(
            `[MQTT] failed to update state for ${normalizedId}:`,
            error.message
        );
    }
}

function handleMqttMessage(topic, message) {
    // Expected:
    //   ackit/configure/{configureId}/status
    //   ackit/configure/{configureId}/ir
    //   ackit/device/{deviceId}/status
    //   ackit/device/{deviceId}/configured
    const parts = topic.split("/");
    if (parts.length < 4) return;
    if (parts[0] !== "ackit") return;

    const payload = parseMqttJson(message);

    if (parts[1] === "configure") {
        const configureId = parts[2];
        const channel = parts[3];

        if (channel === "status") {
            handleStatusMessage(configureId, payload);
            return;
        }

        if (channel === "ir") {
            handleIrMessage(configureId, payload);
        }
        return;
    }

    if (parts[1] === "device") {
        const deviceId = parts[2];
        const channel = parts[3];

        if (channel === "status") {
            void handleDeviceStatusMessage(deviceId, payload);
            return;
        }

        if (channel === "configured") {
            void handleDeviceConfiguredMessage(deviceId, payload);
            return;
        }

        if (channel === "state") {
            void handleDeviceStateMessage(deviceId, payload);
        }
    }
}

function subscribeBrandTopics(mqttClient) {
    const topics = [
        "ackit/configure/+/status",
        "ackit/configure/+/ir",
        "ackit/device/+/status",
        "ackit/device/+/configured",
        "ackit/device/+/state",
    ];
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
    publishBrandCommandsToDevice,
    publishDeviceApplyCommand,
    publishDeviceRemoteMode,
    publishDeviceEvent,
};
