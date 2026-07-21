/**
 * In-memory pairing sessions for IR brand training.
 * configureId is reserved here until the brand is saved (or session expires).
 */

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

/** @type {Map<string, object>} */
const sessions = new Map();

function emptyDraft() {
    return {
        powerCommands: { on: "", off: "" },
        modes: {
            cool: "",
            heat: "",
            dry: "",
            fanOnly: "",
            smartAuto: "",
        },
        temperatureCommands: {
            sixteen: "",
            seventeen: "",
            eighteen: "",
            nineteen: "",
            twenty: "",
            twentyOne: "",
            twentyTwo: "",
            twentyThree: "",
            twentyFour: "",
            twentyFive: "",
            twentySix: "",
            twentySeven: "",
            twentyEight: "",
            twentyNine: "",
            thirty: "",
        },
        fanSpeedCommands: {
            low: "",
            medium: "",
            high: "",
            ultra: "",
            turbo: "",
        },
    };
}

function createSession(configureId, adminUserId) {
    const session = {
        configureId,
        adminUserId: String(adminUserId),
        deviceConnected: false,
        pendingField: null, // { group, key } e.g. { group: 'powerCommands', key: 'on' }
        draft: emptyDraft(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
    };
    sessions.set(configureId, session);
    return session;
}

function getSession(configureId) {
    const session = sessions.get(configureId);
    if (!session) return null;

    if (Date.now() - session.createdAt > SESSION_TTL_MS) {
        sessions.delete(configureId);
        return null;
    }

    return session;
}

function hasPendingConfigureId(configureId) {
    return Boolean(getSession(configureId));
}

function setPendingField(configureId, pendingField) {
    const session = getSession(configureId);
    if (!session) return null;
    session.pendingField = pendingField;
    session.updatedAt = Date.now();
    return session;
}

function markDeviceConnected(configureId) {
    const session = getSession(configureId);
    if (!session) return null;
    session.deviceConnected = true;
    session.updatedAt = Date.now();
    return session;
}

function applyPulseToPending(configureId, pulseValue) {
    const session = getSession(configureId);
    if (!session || !session.pendingField) return null;

    const { group, key } = session.pendingField;
    if (!session.draft[group] || !(key in session.draft[group])) {
        return null;
    }

    session.draft[group][key] = pulseValue;
    const applied = { ...session.pendingField, value: pulseValue };
    session.pendingField = null;
    session.updatedAt = Date.now();
    return { session, applied };
}

function clearDraftField(configureId, group, key) {
    const session = getSession(configureId);
    if (!session || !session.draft[group] || !(key in session.draft[group])) {
        return null;
    }
    session.draft[group][key] = "";
    session.updatedAt = Date.now();
    return session;
}

function deleteSession(configureId) {
    sessions.delete(configureId);
}

function listPendingConfigureIds() {
    return Array.from(sessions.keys());
}

module.exports = {
    emptyDraft,
    createSession,
    getSession,
    hasPendingConfigureId,
    setPendingField,
    markDeviceConnected,
    applyPulseToPending,
    clearDraftField,
    deleteSession,
    listPendingConfigureIds,
};
