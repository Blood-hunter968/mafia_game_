const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = {};

/* =========================================================
   ACCOUNTS + PERMANENT RANK STATISTICS
   - Sign Up / Login / Skip (guests can play, but are never ranked)
   - Passwords are hashed with scrypt + a random salt (never plain text)
   - Data is saved in ./data/accounts.json (set DATA_DIR to change it)
========================================================= */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");

const STAT_KEYS = ["kills", "saves", "detects", "civilianVotes", "jesterWins", "mafiaWins", "civilianWins"];

let accountsDb = { users: {} };

try {
    fs.mkdirSync(DATA_DIR, { recursive: true });

    if (fs.existsSync(ACCOUNTS_FILE)) {
        accountsDb = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8"));
    }

    if (!accountsDb || typeof accountsDb.users !== "object") {
        accountsDb = { users: {} };
    }
} catch (error) {
    console.error("Could not load accounts file:", error);
    accountsDb = { users: {} };
}

let accountsSaveTimer = null;

function writeAccountsNow() {
    try {
        const tempFile = ACCOUNTS_FILE + ".tmp";
        fs.writeFileSync(tempFile, JSON.stringify(accountsDb));
        fs.renameSync(tempFile, ACCOUNTS_FILE);
    } catch (error) {
        console.error("Could not save accounts file:", error);
    }
}

function saveAccounts() {
    if (accountsSaveTimer) return;

    accountsSaveTimer = setTimeout(() => {
        accountsSaveTimer = null;
        writeAccountsNow();
    }, 500);
}

function flushAccountsAndExit() {
    if (accountsSaveTimer) {
        clearTimeout(accountsSaveTimer);
        accountsSaveTimer = null;
    }
    writeAccountsNow();
    process.exit(0);
}

process.on("SIGINT", flushAccountsAndExit);
process.on("SIGTERM", flushAccountsAndExit);

const socketAccounts = new Map();   // socket.id -> account key
const accountSessions = new Map();  // session token -> account key

function getSocketAccountKey(socket) {
    return socketAccounts.get(socket.id) || null;
}

function hashPassword(password, salt) {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, 64, (error, derived) => {
            if (error) reject(error);
            else resolve(derived.toString("hex"));
        });
    });
}

function isValidPin(pin) {
    return /^\d{4,8}$/.test(String(pin || ""));
}

function encryptPassword(password, pin, saltHex) {
    const key = crypto.scryptSync(String(pin), Buffer.from(saltHex, "hex"), 32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(String(password), "utf8"), cipher.final()]);
    return {
        iv: iv.toString("hex"),
        tag: cipher.getAuthTag().toString("hex"),
        ciphertext: ciphertext.toString("hex")
    };
}

function decryptPassword(user, pin) {
    if (!user?.passwordEncrypted?.salt || !user.passwordEncrypted.iv || !user.passwordEncrypted.tag || !user.passwordEncrypted.ciphertext) {
        return null;
    }

    const encrypted = user.passwordEncrypted;
    const key = crypto.scryptSync(String(pin), Buffer.from(encrypted.salt, "hex"), 32);
    const decipher = crypto.createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(encrypted.iv, "hex")
    );
    decipher.setAuthTag(Buffer.from(encrypted.tag, "hex"));
    const plaintext = Buffer.concat([
        decipher.update(Buffer.from(encrypted.ciphertext, "hex")),
        decipher.final()
    ]);
    return plaintext.toString("utf8");
}

function isValidUsername(name) {
    return /^[A-Za-z0-9_]{3,20}$/.test(name);
}

function emptyStats() {
    return { kills: 0, saves: 0, detects: 0, civilianVotes: 0, jesterWins: 0, mafiaWins: 0, civilianWins: 0 };
}

/* Points per action: 1 kill = 3, 1 save = 2, 1 detective check = 2,
   1 Jester win = 4, 1 civilian correct Mafia vote = 1,
   1 Mafia team win = 5, 1 Civilian team win = 4. */
const POINT_VALUES = { kills: 3, saves: 2, detects: 2, jesterWins: 4, civilianVotes: 1, mafiaWins: 5, civilianWins: 4 };

function totalStats(stats) {
    return STAT_KEYS.reduce(
        (sum, key) => sum + (Number(stats?.[key]) || 0) * (POINT_VALUES[key] || 0),
        0
    );
}

/* Adds +1 to one stat of an ACCOUNT player. Skip players are ignored. */
function recordStat(player, stat) {
    if (!player || !player.account) return;
    if (!STAT_KEYS.includes(stat)) return;

    const user = accountsDb.users[player.account];
    if (!user) return;

    user.stats = user.stats || emptyStats();
    user.stats[stat] = (Number(user.stats[stat]) || 0) + 1;
    saveAccounts();
}

/* Saves the socket's current badge on its account (shown on the Ranks screen). */
function syncAccountBadge(socket, force) {
    const key = socketAccounts.get(socket.id);
    const user = key ? accountsDb.users[key] : null;
    if (!user) return;

    const badge = socket.badge || "member";
    if (!force && badge === "member") return;

    if ((user.badge || "member") !== badge) {
        user.badge = badge;
        saveAccounts();
    }
}

/* Names only. Accounts only. Skip players never appear here. */
function getRanksList() {
    return Object.values(accountsDb.users)
        .map(user => ({
            username: user.username,
            badge: user.badge || "member",
            total: totalStats(user.stats)
        }))
        .sort((a, b) =>
            b.total - a.total ||
            a.username.localeCompare(b.username)
        )
        .slice(0, 100)
        .map((user, index) => ({
            rank: index + 1,
            username: user.username,
            badge: user.badge,
            points: user.total
        }));
}

function loginSocket(socket, accountKey, silent) {
    const user = accountsDb.users[accountKey];
    if (!user) return false;

    socketAccounts.set(socket.id, accountKey);
    syncAccountBadge(socket, false);

    const token = crypto.randomBytes(24).toString("hex");
    accountSessions.set(token, accountKey);

    socket.emit("authResult", {
        ok: true,
        guest: false,
        username: user.username,
        token,
        silent: Boolean(silent)
    });

    return true;
}

/* =========================================================
   PUBLIC MATCHMAKING
========================================================= */

function getPublicMatches() {
    return Object.entries(rooms)
        .filter(([roomCode, room]) =>
            room &&
            room.visibility === "public" &&
            room.phase === "lobby" &&
            !room.gameStarted &&
            room.players.some(player => player.connected !== false)
        )
        .map(([roomCode, room]) => {
            const connectedPlayers = room.players.filter(player => player.connected !== false);
            return {
                roomCode,
                playerCount: connectedPlayers.length,
                hostName: connectedPlayers.find(player => player.id === room.host)?.name || connectedPlayers[0]?.name || "Host",
                hostBadge: getBadgeOf(connectedPlayers.find(player => player.id === room.host)?.id || connectedPlayers[0]?.id)
            };
        })
        .sort((a, b) => b.playerCount - a.playerCount);
}

function emitPublicMatches() {
    io.emit("publicMatches", getPublicMatches());
}

/* =========================================================
   2-MINUTE PHASE TIMER
========================================================= */

const PHASE_TIME_LIMIT = 2 * 60 * 1000;
const NIGHT_TURN_TIME_LIMIT = 30 * 1000;

// After the LAST night turn is over, the server waits this long (the
// turn-over sound plays during it) and only THEN checks who died.
const DEATH_CHECK_DELAY_MS = 3000;

// A dead Doctor/Detective still gets a hidden night turn. It ends after a
// random time inside this range so nobody can time it to spot the dead role.
const HIDDEN_TURN_MIN_MS = 4000;
const HIDDEN_TURN_MAX_MS = 27000;

function clearPhaseTimer(room) {
    if (!room) return;

    if (room.phaseTimer) {
        clearTimeout(room.phaseTimer);
        room.phaseTimer = null;
    }

    room.phaseEndsAt = null;
}

function startPhaseTimer(roomCode) {
    const room = rooms[roomCode];
    if (!room || (room.phase !== "night" && room.phase !== "day")) return;

    clearPhaseTimer(room);
    room.phaseEndsAt = Date.now() + PHASE_TIME_LIMIT;

    room.phaseTimer = setTimeout(() => {
        const currentRoom = rooms[roomCode];
        if (!currentRoom) return;

        currentRoom.phaseTimer = null;

        if (currentRoom.phase === "night") {
            announce(roomCode, "⏰ 2 minutes are over. Night is ending even if someone did not choose an action.", "info");
            endNight(roomCode);
        } else if (currentRoom.phase === "day") {
            announce(roomCode, "⏰ 2 minutes are over. Voting is ending even if someone did not vote.", "info");
            endVoting(roomCode);
        }
    }, PHASE_TIME_LIMIT);
}


/* =========================================================
   SEQUENTIAL NIGHT ROLE TURNS
   Mafia -> Doctor -> Detective -> Cupid
   Each active role gets 30 seconds.
========================================================= */

const NIGHT_TURN_ORDER = [
    "mafia",
    "doctor",
    "detective",
    "cupid"
];

function clearNightTurnTimer(room) {
    if (!room) return;

    if (room.nightTurnTimer) {
        clearTimeout(room.nightTurnTimer);
        room.nightTurnTimer = null;
    }

    if (room.nightEndTimer) {
        clearTimeout(room.nightEndTimer);
        room.nightEndTimer = null;
    }

    if (room.nightTransitionTimer) {
        clearTimeout(room.nightTransitionTimer);
        room.nightTransitionTimer = null;
    }

    room.nightTurnEndsAt = null;
}

function hasLivingRoleForTurn(room, turn) {
    if (!room) return false;

    if (turn === "mafia") {
        return room.players.some(
            p => p.alive && p.connected !== false && isMafiaTeam(p.role)
        );
    }

    if (turn === "doctor") {
        return room.players.some(
            p => p.alive && p.connected !== false && p.role === "Doctor"
        );
    }

    if (turn === "detective") {
        return room.players.some(
            p => p.alive && p.connected !== false && p.role === "Detective"
        );
    }

    if (turn === "cupid") {
        return room.nightNumber === 1 && room.players.some(
            p => p.alive && p.connected !== false && p.role === "Cupid"
        );
    }

    return false;
}

/*
   Hidden turns: if the Doctor / Detective exists in this game but is dead
   (or disconnected), their turn STILL happens so the turn order never
   changes. Nobody is told, and the length is random.
*/
function hasHiddenTurn(room, turn) {
    if (!room) return false;

    if (turn === "doctor") {
        return room.players.some(p => p.role === "Doctor");
    }

    if (turn === "detective") {
        return room.players.some(p => p.role === "Detective");
    }

    return false;
}

function randomHiddenTurnMs() {
    // Sometimes run the full length, like a living player who is slow.
    if (Math.random() < 0.15) return NIGHT_TURN_TIME_LIMIT;

    return Math.round(
        HIDDEN_TURN_MIN_MS +
        Math.random() * (HIDDEN_TURN_MAX_MS - HIDDEN_TURN_MIN_MS)
    );
}

function nightTurnName(turn) {
    return {
        mafia: "MAFIA",
        doctor: "DOCTOR",
        detective: "DETECTIVE",
        cupid: "CUPID"
    }[turn] || "NIGHT";
}

/* =========================================================
   TURN-OVER TRANSITION
   "<ROLE> turn is over" popup -> wait 3 seconds -> next turn.
   (Mafia -> Doctor, Doctor -> Detective, Detective -> next.)
   For the LAST turn, startNightTurn() already waits 3 seconds
   before checking who died, so no extra wait is added there.
========================================================= */

const TURN_TRANSITION_DELAY_MS = 3000;

function finishNightTurnThenAdvance(roomCode) {
    const room = rooms[roomCode];
    if (!room || room.phase !== "night") return;

    // Already waiting between two turns - never run twice.
    if (room.nightTransitionTimer) return;

    const finishedTurn = room.nightTurn;
    const nextIndex = room.nightTurnIndex + 1;

    // Stops the finished turn's timer and its countdown.
    clearNightTurnTimer(room);

    announce(
        roomCode,
        `⏰ ${nightTurnName(finishedTurn)} turn is over.`,
        "info"
    );

    // Is there another turn after this one?
    let upcoming = nextIndex;
    while (
        upcoming < NIGHT_TURN_ORDER.length &&
        !hasLivingRoleForTurn(room, NIGHT_TURN_ORDER[upcoming]) &&
        !hasHiddenTurn(room, NIGHT_TURN_ORDER[upcoming])
    ) {
        upcoming += 1;
    }

    // That was the last turn: startNightTurn() adds its own 3-second wait.
    if (upcoming >= NIGHT_TURN_ORDER.length) {
        startNightTurn(roomCode, nextIndex);
        return;
    }

    // Between turns nobody can act, and the turn overlay is hidden.
    room.nightTurn = null;
    room.hiddenNightTurn = false;
    sendGameInformation(roomCode);

    room.nightTransitionTimer = setTimeout(() => {
        const currentRoom = rooms[roomCode];
        if (!currentRoom) return;

        currentRoom.nightTransitionTimer = null;

        if (currentRoom.phase !== "night") return;

        startNightTurn(roomCode, nextIndex);
    }, TURN_TRANSITION_DELAY_MS);
}

function startNightTurn(roomCode, requestedIndex = 0) {
    const room = rooms[roomCode];
    if (!room || room.phase !== "night") return;

    clearNightTurnTimer(room);

    let index = requestedIndex;
    while (
        index < NIGHT_TURN_ORDER.length &&
        !hasLivingRoleForTurn(room, NIGHT_TURN_ORDER[index]) &&
        !hasHiddenTurn(room, NIGHT_TURN_ORDER[index])
    ) {
        index += 1;
    }

    if (index >= NIGHT_TURN_ORDER.length) {
        room.nightTurn = null;
        room.nightTurnIndex = NIGHT_TURN_ORDER.length;
        room.nightTurnEndsAt = null;
        room.hiddenNightTurn = false;

        sendGameInformation(roomCode);

        /*
           Last night turn finished -> turn-over sound (played by every
           client) -> wait 3 seconds -> THEN check whether someone died.
           endNight() sends the morning result, and the death sound is only
           played by the clients when that result contains a death.
        */
        room.nightEndTimer = setTimeout(() => {
            const currentRoom = rooms[roomCode];
            if (!currentRoom) return;

            currentRoom.nightEndTimer = null;

            if (currentRoom.phase !== "night") return;

            endNight(roomCode);
        }, DEATH_CHECK_DELAY_MS);

        return;
    }

    room.nightTurnIndex = index;
    room.nightTurn = NIGHT_TURN_ORDER[index];

    // Everybody always SEES the normal 30-second turn timer. A hidden
    // (dead Doctor/Detective) turn simply ends early at a random moment,
    // exactly like a living player who finished quickly.
    room.hiddenNightTurn = !hasLivingRoleForTurn(room, room.nightTurn);
    room.nightTurnEndsAt = Date.now() + NIGHT_TURN_TIME_LIMIT;

    const turnLengthMs = room.hiddenNightTurn
        ? randomHiddenTurnMs()
        : NIGHT_TURN_TIME_LIMIT;

    room.nightTurnTimer = setTimeout(() => {
        const currentRoom = rooms[roomCode];
        if (!currentRoom || currentRoom.phase !== "night") return;

        currentRoom.nightTurnTimer = null;
        currentRoom.nightTurnEndsAt = null;

        finishNightTurnThenAdvance(roomCode);
    }, turnLengthMs);

    announce(
        roomCode,
        `🌙 ${nightTurnName(room.nightTurn)} turn has begun.`,
        "night"
    );

    sendGameInformation(roomCode);
}

function currentTurnActionsDone(room) {
    if (!room || room.phase !== "night") return false;

    // A hidden (dead Doctor/Detective) turn only ends on its random timer.
    if (room.hiddenNightTurn) return false;

    const turn = room.nightTurn;

    if (turn === "mafia") {
        const mafia = room.players.filter(
            p => p.alive && p.connected !== false && isMafiaTeam(p.role)
        );

        if (mafia.some(p => !room.nightActions.mafia[p.id])) {
            return false;
        }

        if (
            room.nightNumber === 1 &&
            !room.grandmafiaUsed
        ) {
            const grandmas = room.players.filter(
                p => p.alive && p.role === "Grandmafia"
            );

            if (grandmas.some(
                p => !room.nightActions.grandmafia[p.id]
            )) {
                return false;
            }
        }

        return true;
    }

    if (turn === "doctor") {
        const doctors = room.players.filter(
            p => p.alive && p.connected !== false && p.role === "Doctor"
        );
        return !doctors.some(
            p => !room.nightActions.doctor[p.id]
        );
    }

    if (turn === "detective") {
        const detectives = room.players.filter(
            p => p.alive && p.connected !== false && p.role === "Detective"
        );
        return !detectives.some(
            p => !room.nightActions.detective[p.id]
        );
    }

    if (turn === "cupid") {
        const cupids = room.players.filter(
            p => p.alive && p.connected !== false && p.role === "Cupid"
        );
        return !cupids.some(
            p => !room.nightActions.cupid[p.id]
        );
    }

    return true;
}

function checkNightTurnActions(roomCode) {
    const room = rooms[roomCode];
    if (!room || room.phase !== "night") return;

    /*
       The active night turn finishes immediately once the
       required action(s) for that turn have been submitted.
       If an action is not submitted, the existing 30-second
       timeout in startNightTurn() still ends the turn.
    */
    if (!currentTurnActionsDone(room)) return;

    // Already in the 3-second wait between two turns.
    if (room.nightTransitionTimer) return;

    finishNightTurnThenAdvance(roomCode);
}

/* =========================================================
   ROOM CODE
========================================================= */

function generateRoomCode() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let code = "";

    for (let i = 0; i < 5; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }

    return code;
}

function makeRoom() {
    let code = generateRoomCode();

    while (rooms[code]) {
        code = generateRoomCode();
    }

    return code;
}

/* =========================================================
   SHUFFLE
========================================================= */

function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));

        [array[i], array[j]] =
            [array[j], array[i]];
    }

    return array;
}

/* =========================================================
   MAFIA TEAM
========================================================= */

function isMafiaTeam(role) {
    return [
        "Mafia",
        "Godfather",
        "Grandmafia",
        "Baby Mafia"
    ].includes(role);
}

/*
   Detective rules:
   Godfather = NOT MAFIA
   Mafia = MAFIA
   Grandmafia = MAFIA
   Baby Mafia = MAFIA
*/

function isDetectiveMafia(role) {
    return [
        "Mafia",
        "Grandmafia",
        "Baby Mafia"
    ].includes(role);
}

/* =========================================================
   ANNOUNCEMENT
========================================================= */

function announce(roomCode, message, type = "info") {
    if (!rooms[roomCode]) return;

    io.to(roomCode).emit(
        "announcement",
        {
            message,
            type,
            time: Date.now()
        }
    );
}

/* =========================================================
   ASSIGN ROLES
========================================================= */

function assignRoles(players, settings) {

    const roles = [];

    for (let i = 0; i < settings.mafia; i++) {
        roles.push("Mafia");
    }

    for (let i = 0; i < settings.godfather; i++) {
        roles.push("Godfather");
    }

    for (let i = 0; i < settings.grandmafia; i++) {
        roles.push("Grandmafia");
    }

    for (let i = 0; i < settings.grandma; i++) {
        roles.push("Grandma");
    }

    for (let i = 0; i < settings.doctor; i++) {
        roles.push("Doctor");
    }

    for (let i = 0; i < settings.detective; i++) {
        roles.push("Detective");
    }

    for (let i = 0; i < settings.jester; i++) {
        roles.push("Jester");
    }

    for (let i = 0; i < settings.lover; i++) {
        roles.push("Cupid");
    }

    for (let i = 0; i < settings.civilian; i++) {
        roles.push("Civilian");
    }

    shuffle(roles);

    players.forEach((player, index) => {

        player.role =
            roles[index] || "Civilian";

        player.alive = true;
    });
}

/* =========================================================
   NIGHT ACTION RESET
========================================================= */

function resetNightActions(room) {

    room.nightActions = {
        mafia: {},
        grandmafia: {},
        doctor: {},
        detective: {},
        cupid: {}
    };
}
function resetGameState(room) {

    room.gameStarted = false;
    room.phase = "lobby";

    room.settings = null;

    room.grandmafiaUsed = false;
    room.grandmafiaTarget = null;

    room.nightNumber = 1;

    room.stats = {
        totalRounds: 0,
        mafiaKills: 0,
        successfulSaves: 0,
        detectiveInvestigations: 0,
        playersVotedOut: 0
    };

    room.cupidUsed = {};
    room.cupidPairs = {};

    room.votes = {};

    clearNightTurnTimer(room);
    room.nightTurn = null;
    room.nightTurnIndex = 0;
    room.hiddenNightTurn = false;

    resetNightActions(room);

    room.players.forEach(player => {
        player.role = null;
        player.alive = true;
    });
}
/* =========================================================
   PUBLIC PLAYER DATA
========================================================= */

function getPublicPlayers(room, viewer) {

    const viewerIsMafia = Boolean(
        viewer && isMafiaTeam(viewer.role)
    );

    return room.players
        .filter(player => player.connected !== false)
        .map(player => {
            const visibleRole =
                viewer &&
                (player.id === viewer.id ||
                 (viewerIsMafia && isMafiaTeam(player.role)))
                    ? player.role
                    : null;

            return {
                id: player.id,
                name: player.name,
                badge: getBadgeOf(player.id),
                alive: player.alive,
                role: visibleRole,
                connected: true
            };
        });
}

/* =========================================================
   LOBBY UPDATE
========================================================= */

function emitLobby(roomCode) {

    const room = rooms[roomCode];

    if (!room) return;

    io.to(roomCode).emit(
        "playerJoined",
        {
            players:
                getPublicPlayers(room),

            hostId:
                room.host,

            allowPeopleToJoin:
                room.allowPeopleToJoin !== false,

            roomCode
        }
    );
}

/* =========================================================
   ACTION TARGETS
========================================================= */

function getActionTargets(room, player) {

    if (
        !room ||
        !player ||
        !player.alive ||
        room.phase !== "night"
    ) {
        return [];
    }

    /* =========================
       MAFIA
    ========================= */

    if (isMafiaTeam(player.role)) {

        if (room.nightTurn !== "mafia") {
            return [];
        }

        if (
            room.nightActions.mafia[player.id]
        ) {
            return [];
        }

        return room.players
            .filter(p =>
                p.alive &&
                p.connected !== false &&
                p.id !== player.id &&
                !isMafiaTeam(p.role)
            )
            .map(p => p.id);
    }

    /* =========================
       DOCTOR
    ========================= */

    if (player.role === "Doctor") {

        if (room.nightTurn !== "doctor") {
            return [];
        }

        if (
            room.nightActions.doctor[player.id]
        ) {
            return [];
        }

        return room.players
            .filter(p => p.alive && p.connected !== false)
            .map(p => p.id);
    }

    /* =========================
       DETECTIVE
    ========================= */

    if (player.role === "Detective") {

        if (room.nightTurn !== "detective") {
            return [];
        }

        if (
            room.nightActions.detective[player.id]
        ) {
            return [];
        }

        return room.players
            .filter(p =>
                p.alive &&
                p.connected !== false &&
                p.id !== player.id
            )
            .map(p => p.id);
    }

    return [];
}

/* =========================================================
   GRANDMAFIA TARGETS
========================================================= */

function getGrandmafiaTargets(room, player) {

    if (
        !room ||
        !player ||
        !player.alive ||
        player.role !== "Grandmafia" ||
        room.nightTurn !== "mafia" ||
        room.nightNumber !== 1 ||
        room.grandmafiaUsed ||
        room.nightActions.grandmafia[player.id]
    ) {
        return [];
    }

    return room.players
        .filter(p =>
            p.alive &&
            p.id !== player.id &&
            !isMafiaTeam(p.role)
        )
        .map(p => p.id);
}

/* =========================================================
   CUPID TARGETS
========================================================= */

function getCupidTargets(room, player) {

    if (
        !room ||
        !player ||
        !player.alive ||
        player.role !== "Cupid" ||
        room.nightTurn !== "cupid" ||
        room.nightNumber !== 1 ||
        room.cupidUsed[player.id]
    ) {
        return [];
    }

    return room.players
        .filter(p =>
            p.alive &&
            p.id !== player.id
        )
        .map(p => p.id);
}

/* =========================================================
   LINK CUPIDS
========================================================= */

function linkCupids(room, a, b) {

    room.cupidPairs[a] = b;
    room.cupidPairs[b] = a;
}

/* =========================================================
   ELIMINATE PLAYER + CUPID + GODFATHER
========================================================= */

function eliminatePlayerWithCupid(room, player) {

    if (!player || !player.alive) {
        return [];
    }

    const eliminated = [];

    player.alive = false;

    eliminated.push(player);

    /* =========================
       CUPID
    ========================= */

    const partnerId =
        room.cupidPairs[player.id];

    if (partnerId) {

        const partner =
            room.players.find(
                p => p.id === partnerId
            );

        if (
            partner &&
            partner.alive
        ) {

            partner.alive = false;

            eliminated.push(partner);
        }
    }

    /* =========================
       GODFATHER
       If Godfather dies,
       entire Mafia team dies.
    ========================= */

    if (
        eliminated.some(
            p => p.role === "Godfather"
        )
    ) {

        room.players.forEach(player => {

            if (
                player.alive &&
                isMafiaTeam(player.role)
            ) {

                player.alive = false;

                if (
                    !eliminated.some(
                        x => x.id === player.id
                    )
                ) {

                    eliminated.push(player);
                }
            }
        });
    }

    /* =====================================================
       GRANDMAFIA DEATH → ACTIVATE BABY MAFIA

       Grandmafia only selects the future Baby Mafia on
       Night 1. The selected player keeps their original
       role while Grandmafia is alive.

       When Grandmafia dies, the selected living player
       becomes Baby Mafia.
    ===================================================== */

    if (
        eliminated.some(
            p => p.role === "Grandmafia"
        )
    ) {

        const babyMafia =
            room.players.find(
                p =>
                    p.id === room.grandmafiaTarget &&
                    p.alive
            );

        if (babyMafia) {

            babyMafia.role = "Baby Mafia";

            io.to(babyMafia.id).emit(
                "roleChanged",
                {
                    role: "Baby Mafia"
                }
            );

        }

        room.grandmafiaTarget = null;
    }

    return eliminated;
}

/* =========================================================
   SEND GAME INFORMATION
========================================================= */

function sendGameInformation(roomCode) {

    const room = rooms[roomCode];

    if (!room) return;

    room.players.forEach(player => {

        io.to(player.id).emit(
            "gameInformation",
            {
                roomCode,

                role:
                    player.role,

                players:
                    getPublicPlayers(room, player),

                /*
                   IMPORTANT:
                   Send hostId during the game too.
                   This allows the client to correctly
                   know who can restart the game.
                */

                hostId:
                    room.host,

                allowPeopleToJoin:
                    room.allowPeopleToJoin !== false,

                stats:
                    room.stats || {
                        totalRounds: 0,
                        mafiaKills: 0,
                        successfulSaves: 0,
                        detectiveInvestigations: 0,
                        playersVotedOut: 0
                    },

                phase:
                    room.phase,

                phaseEndsAt:
                    room.phaseEndsAt,

                nightTurn:
                    room.nightTurn,

                nightTurnEndsAt:
                    room.nightTurnEndsAt,

                nightTurnIndex:
                    room.nightTurnIndex,

                nightNumber:
                    room.nightNumber,

                grandmafiaUsed:
                    room.grandmafiaUsed,

                cupidUsed:
                    Boolean(
                        room.cupidUsed[player.id]
                    ),

                doctorUsed:
                    Boolean(
                        room.nightActions.doctor[player.id]
                    ),

                detectiveUsed:
                    Boolean(
                        room.nightActions.detective[player.id]
                    ),

                actionTargets:
                    getActionTargets(
                        room,
                        player
                    ),

                grandmafiaTargets:
                    getGrandmafiaTargets(
                        room,
                        player
                    ),

                cupidTargets:
                    getCupidTargets(
                        room,
                        player
                    )
            }
        );
    });
}

/* =========================================================
   WINNER CHECK
========================================================= */

/*
   A player only counts as alive for win-condition purposes
   when they are both alive AND connected.

   IMPORTANT:
   This does not change the player's actual `alive` state.
   It only prevents dead/disconnected slots from keeping a
   game running when calculating the winner.
*/
function isCountedAlive(player) {
    return Boolean(
        player &&
        player.alive &&
        player.connected !== false
    );
}

/* Team-win points (account players only, alive or dead).
   "mafia"     -> every Mafia-team member (Mafia, Godfather, Grandmafia, Baby Mafia)
   "civilians" -> everyone NOT on the Mafia team and NOT the Jester
   Called once per game (checkWinner sets phase = "gameover" first). */
function awardTeamWin(room, team) {
    room.players.forEach(p => {
        if (!p || !p.role) return;
        if (team === "mafia" && isMafiaTeam(p.role)) {
            recordStat(p, "mafiaWins");
        } else if (team === "civilians" && !isMafiaTeam(p.role) && p.role !== "Jester") {
            recordStat(p, "civilianWins");
        }
    });
}

function checkWinner(roomCode) {

    const room = rooms[roomCode];

    if (
        !room ||
        room.phase === "gameover"
    ) {
        return true;
    }

    /* =====================================================
       JESTER WIN

       The Jester wins immediately if they are eliminated
       for ANY reason: daytime vote, night kill, Cupid
       chain, or another existing elimination mechanic.

       This check MUST happen before Mafia/Civilian wins.
    ===================================================== */

    const deadJester =
        room.players.find(
            p =>
                p.role === "Jester" &&
                !p.alive
        );

    if (deadJester) {

        room.phase = "gameover";

        // Permanent stat: Jester win.
        recordStat(deadJester, "jesterWins");

        announce(
            roomCode,
            `🤡 ${deadJester.name} was the Jester and wins!`,
            "special"
        );

        io.to(roomCode).emit(
            "gameOver",
            {
                winner: "Jester",
                message:
                    "The Jester was eliminated and wins the game!",
                stats: room.stats
            }
        );

        return true;
    }

    const mafiaAlive =
        room.players.filter(
            p =>
                isCountedAlive(p) &&
                isMafiaTeam(p.role)
        );

    const innocentAlive =
        room.players.filter(
            p =>
                isCountedAlive(p) &&
                !isMafiaTeam(p.role)
        );

    /* =========================
       CIVILIANS WIN
    ========================= */

    if (mafiaAlive.length === 0) {

        room.phase = "gameover";

        // Permanent stat: Civilian team win (everyone except Mafia team + Jester).
        awardTeamWin(room, "civilians");

        announce(
            roomCode,
            "🎉 The Mafia team has been eliminated!",
            "success"
        );

        io.to(roomCode).emit(
            "gameOver",
            {
                winner: "Civilians",
                message:
                    "The Mafia team has been eliminated!",
                stats: room.stats
            }
        );

        return true;
    }

    /* =========================
       MAFIA WINS
    ========================= */

    if (
        mafiaAlive.length >=
        innocentAlive.length
    ) {

        room.phase = "gameover";

        // Permanent stat: Mafia team win (every Mafia-team member).
        awardTeamWin(room, "mafia");

        announce(
            roomCode,
            "☠️ The Mafia team has taken control!",
            "danger"
        );

        io.to(roomCode).emit(
            "gameOver",
            {
                winner: "Mafia Team",
                message:
                    "The Mafia team has taken control!",
                stats: room.stats
            }
        );

        return true;
    }

    return false;
}

/* =========================================================
   NIGHT ACTION CHECK
========================================================= */

function allRequiredNightActionsDone(room) {

    /* =========================
       MAFIA
    ========================= */

    const mafia =
        room.players.filter(
            p =>
                p.alive &&
                isMafiaTeam(p.role)
        );

    if (
        mafia.some(
            p =>
                !room.nightActions.mafia[p.id]
        )
    ) {
        return false;
    }

    /* =========================
       DOCTOR
    ========================= */

    const doctors =
        room.players.filter(
            p =>
                p.alive &&
                p.role === "Doctor"
        );

    if (
        doctors.some(
            p =>
                !room.nightActions.doctor[p.id]
        )
    ) {
        return false;
    }

    /* =========================
       DETECTIVE
    ========================= */

    const detectives =
        room.players.filter(
            p =>
                p.alive &&
                p.role === "Detective"
        );

    if (
        detectives.some(
            p =>
                !room.nightActions.detective[p.id]
        )
    ) {
        return false;
    }

    /* =========================
       GRANDMAFIA
    ========================= */

    if (
        room.nightNumber === 1 &&
        !room.grandmafiaUsed
    ) {

        const grandmas =
            room.players.filter(
                p =>
                    p.alive &&
                    p.role === "Grandmafia"
            );

        if (
            grandmas.some(
                p =>
                    !room.nightActions.grandmafia[p.id]
            )
        ) {
            return false;
        }
    }

    /* =========================
       CUPID
    ========================= */

    if (room.nightNumber === 1) {

        const cupids =
            room.players.filter(
                p =>
                    p.alive &&
                    p.role === "Cupid"
            );

        if (
            cupids.some(
                p =>
                    !room.nightActions.cupid[p.id]
            )
        ) {
            return false;
        }
    }

    return true;
}

/* =========================================================
   CHECK NIGHT ACTIONS
========================================================= */

function checkNightActions(roomCode) {
    checkNightTurnActions(roomCode);
}

/* =========================================================
   END NIGHT
========================================================= */

function endNight(roomCode) {

    const room = rooms[roomCode];

    if (
        !room ||
        room.phase !== "night"
    ) {
        return;
    }

    clearPhaseTimer(room);
    clearNightTurnTimer(room);
    room.nightTurn = null;
    room.nightTurnIndex = 0;

    let babyMafiaCreated = false;

    /* =====================================================
       GRANDMAFIA → BABY MAFIA

       On Night 1, Grandmafia only SELECTS a player.
       The selected player keeps their original role while
       Grandmafia is alive. The role changes to Baby Mafia
       only when Grandmafia is later eliminated.
    ===================================================== */

    if (
        room.nightNumber === 1 &&
        !room.grandmafiaUsed
    ) {

        const grandmas =
            room.players.filter(
                p =>
                    p.alive &&
                    p.role === "Grandmafia"
            );

        for (const grandmafia of grandmas) {

            const target =
                room.players.find(
                    p =>
                        p.id ===
                        room.nightActions.grandmafia[
                            grandmafia.id
                        ]
                );

            if (
                target &&
                target.alive &&
                !isMafiaTeam(target.role)
            ) {

                // IMPORTANT: do NOT change the role yet.
                room.grandmafiaTarget = target.id;

                io.to(grandmafia.id).emit(
                    "grandmafiaResult",
                    {
                        message:
                            `${target.name} has been selected as the future Baby Mafia.`
                    }
                );
            }
        }

        room.grandmafiaUsed = true;
    }

    /* =====================================================
       CUPIDS
    ===================================================== */

    if (room.nightNumber === 1) {

        const cupids =
            room.players.filter(
                p =>
                    p.alive &&
                    p.role === "Cupid"
            );

        for (const cupid of cupids) {

            const action =
                room.nightActions.cupid[
                    cupid.id
                ];

            if (!action) continue;

            const first =
                room.players.find(
                    p =>
                        p.id === action.firstId
                );

            const second =
                room.players.find(
                    p =>
                        p.id === action.secondId
                );

            if (
                first &&
                second &&
                first.alive &&
                second.alive &&
                first.id !== second.id &&
                first.id !== cupid.id &&
                second.id !== cupid.id
            ) {

                linkCupids(
                    room,
                    first.id,
                    second.id
                );

                io.to(cupid.id).emit(
                    "cupidConfirmed",
                    `${first.name} ❤️ ${second.name}`
                );
            }
        }
    }

    /* =====================================================
       MAFIA VOTES
    ===================================================== */

    const mafiaVotes = {};

    Object.entries(
        room.nightActions.mafia
    ).forEach(
        ([attackerId, targetId]) => {

            if (!mafiaVotes[targetId]) {
                mafiaVotes[targetId] = [];
            }

            mafiaVotes[targetId].push(
                attackerId
            );
        }
    );

    let mafiaTarget = null;
    let highest = 0;

    Object.entries(
        mafiaVotes
    ).forEach(
        ([targetId, attackers]) => {

            if (
                attackers.length >
                highest
            ) {

                highest =
                    attackers.length;

                mafiaTarget =
                    targetId;
            }
        }
    );

    /* =====================================================
       DOCTOR PROTECTION
    ===================================================== */

    const protectedPlayers =
        new Set(
            Object.values(
                room.nightActions.doctor
            )
        );

    let eliminatedPlayers = [];

    const doctorSavedTarget =
        Boolean(mafiaTarget && protectedPlayers.has(mafiaTarget));

    if (doctorSavedTarget) {
        room.stats.successfulSaves += 1;

        // Permanent stat: every Doctor who protected the attacked player.
        Object.entries(room.nightActions.doctor).forEach(([doctorId, protectedId]) => {
            if (protectedId === mafiaTarget) {
                recordStat(
                    room.players.find(p => p.id === doctorId),
                    "saves"
                );
            }
        });
    }

    /* =====================================================
       MAFIA ATTACK
    ===================================================== */

    if (mafiaTarget) {

        const target =
            room.players.find(
                p =>
                    p.id === mafiaTarget
            );

        /* =========================
           GRANDMA REFLECT
        ========================= */

        if (
            target &&
            target.alive &&
            target.role === "Grandma"
        ) {

            const attacker =
                room.players.find(
                    p =>
                        p.id ===
                        (
                            mafiaVotes[
                                mafiaTarget
                            ] || []
                        )[0]
                );

            if (
                attacker &&
                attacker.alive
            ) {

                eliminatedPlayers =
                    eliminatePlayerWithCupid(
                        room,
                        attacker
                    );
            }

        }

        /* =========================
           NORMAL ATTACK
        ========================= */

        else if (
            target &&
            target.alive &&
            !isMafiaTeam(target.role) &&
            !protectedPlayers.has(mafiaTarget)
        ) {

            eliminatedPlayers =
                eliminatePlayerWithCupid(
                    room,
                    target
                );

            if (eliminatedPlayers.length) {
                room.stats.mafiaKills += 1;

                // Permanent stat: every Mafia who voted for this kill.
                (mafiaVotes[mafiaTarget] || []).forEach(attackerId => {
                    recordStat(
                        room.players.find(p => p.id === attackerId),
                        "kills"
                    );
                });
            }
        }
    }

    /* =====================================================
       CHECK WINNER
    ===================================================== */

    if (checkWinner(roomCode)) {

        sendGameInformation(roomCode);

        return;
    }

    /* =====================================================
       DAY
    ===================================================== */

    room.phase = "day";

    room.votes = {};

    resetNightActions(room);

    const names =
        eliminatedPlayers.map(
            p => p.name
        );

    if (doctorSavedTarget) {

        announce(
            roomCode,
            "☀️ The doctor saved someone. Nobody died tonight.",
            "success"
        );

    } else if (names.length) {

        announce(
            roomCode,
            `☀️ ${names.join(", ")} died. The doctor did not save the person.`,
            "danger"
        );

    } else {

        announce(
            roomCode,
            "☀️ Nobody died tonight.",
            "info"
        );
    }

    io.to(roomCode).emit(
        "morningResult",
        {
            eliminatedPlayer:
                names[0] || null,

            eliminatedPlayers:
                names,

            eliminatedPlayerIds:
                eliminatedPlayers.map(p => p.id),

            doctorSaved: doctorSavedTarget,

            mafiaTargetName:
                mafiaTarget
                    ? room.players.find(p => p.id === mafiaTarget)?.name || null
                    : null,

            babyMafiaCreated
        }
    );

    startPhaseTimer(roomCode);
    sendGameInformation(roomCode);
}

/* =========================================================
   START NEXT NIGHT
========================================================= */

function startNextNight(roomCode) {

    const room = rooms[roomCode];

    if (
        !room ||
        room.phase === "gameover"
    ) {
        return;
    }

    clearPhaseTimer(room);
    clearNightTurnTimer(room);

    if (checkWinner(roomCode)) {

        sendGameInformation(roomCode);

        return;
    }

    room.phase = "night";

    room.nightNumber += 1;

    // A "round" is each night/day cycle. Night 1 is counted
    // when the game starts below; later nights are counted here.
    room.stats = room.stats || {
        totalRounds: 0,
        mafiaKills: 0,
        successfulSaves: 0,
        detectiveInvestigations: 0,
        playersVotedOut: 0
    };
    room.stats.totalRounds += 1;

    room.votes = {};

    resetNightActions(room);

    announce(
        roomCode,
        `🌙 Night ${room.nightNumber} has begun.`,
        "night"
    );

    room.nightTurn = null;
    room.nightTurnIndex = 0;
    room.nightTurnEndsAt = null;

    startNightTurn(roomCode, 0);
}

/* =========================================================
   END VOTING
========================================================= */

function endVoting(roomCode) {

    const room = rooms[roomCode];

    if (
        !room ||
        room.phase !== "day"
    ) {
        return;
    }

    clearPhaseTimer(room);

    const voteCounts = {};

    for (
        const [voterId, targetId]
        of Object.entries(room.votes)
    ) {

        const voter =
            room.players.find(
                p => p.id === voterId
            );

        const target =
            room.players.find(
                p => p.id === targetId
            );

        if (
            !voter ||
            !voter.alive ||
            !target ||
            !target.alive
        ) {
            continue;
        }

        voteCounts[targetId] =
            (voteCounts[targetId] || 0) + 1;
    }

    /* =====================================================
       NO VALID VOTES
    ===================================================== */

    if (
        !Object.keys(voteCounts).length
    ) {

        room.votes = {};

        io.to(roomCode).emit(
            "voteResult",
            {
                eliminatedPlayer: null,
                eliminatedPlayers: [],
                eliminatedPlayerIds: [],
                grandmafiaDeath: false,
                godfatherDeath: false,
                tie: false
            }
        );

        announce(
            roomCode,
            "🤝 Nobody received a valid vote. Nobody was eliminated.",
            "info"
        );

        startNextNight(roomCode);

        return;
    }

    /* =====================================================
       FIND TOP VOTES
    ===================================================== */

    const highestVotes =
        Math.max(
            ...Object.values(voteCounts)
        );

    const topCandidates =
        Object.entries(voteCounts)
            .filter(
                ([, number]) =>
                    number === highestVotes
            )
            .map(
                ([id]) => id
            );

    /* =====================================================
       TIE
    ===================================================== */

    if (
        topCandidates.length > 1
    ) {

        const tiedNames =
            topCandidates.map(
                id =>
                    room.players.find(
                        p => p.id === id
                    )?.name ||
                    "Unknown"
            );

        room.votes = {};

        io.to(roomCode).emit(
            "voteResult",
            {
                eliminatedPlayer: null,
                eliminatedPlayers: [],
                grandmafiaDeath: false,
                godfatherDeath: false,
                tie: true,
                tiedPlayers:
                    tiedNames,
                votes:
                    highestVotes
            }
        );

        announce(
            roomCode,
            `🤝 Vote tied! ${tiedNames.join(" and ")} received ${highestVotes} vote${highestVotes === 1 ? "" : "s"}. Nobody was eliminated.`,
            "info"
        );

        startNextNight(roomCode);

        return;
    }

    /* =====================================================
       ELIMINATE
    ===================================================== */

    const eliminatedPlayer =
        room.players.find(
            p =>
                p.id ===
                topCandidates[0]
        );

    if (
        !eliminatedPlayer ||
        !eliminatedPlayer.alive
    ) {

        room.votes = {};

        startNextNight(roomCode);

        return;
    }

    const eliminatedPlayers =
        eliminatePlayerWithCupid(
            room,
            eliminatedPlayer
        );

    const godfatherDeath =
        eliminatedPlayers.some(
            p =>
                p.role === "Godfather"
        );

    const grandmafiaDeath =
        eliminatedPlayers.some(
            p =>
                p.role === "Grandmafia"
        );

    const names =
        eliminatedPlayers.map(
            p => p.name
        );

    if (eliminatedPlayers.length) {
        room.stats.playersVotedOut += 1;
    }

    room.votes = {};

    /* =====================================================
       NORMAL VOTE RESULT
    ===================================================== */

    io.to(roomCode).emit(
        "voteResult",
        {
            eliminatedPlayer:
                eliminatedPlayer.name,

            eliminatedPlayers:
                names,

            eliminatedPlayerIds:
                eliminatedPlayers.map(p => p.id),

            grandmafiaDeath,
            godfatherDeath,

            tie: false
        }
    );

    announce(
        roomCode,
        `🗳️ ${names.join(", ")} was eliminated by the vote.`,
        "danger"
    );

    /* =====================================================
       WINNER
    ===================================================== */

    if (checkWinner(roomCode)) {

        sendGameInformation(roomCode);

        return;
    }

    startNextNight(roomCode);
}



/* =========================================================
   REJOIN / HOST APPROVAL HELPERS
========================================================= */

function makeJoinRequestId() {
    return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function migratePlayerReferences(room, oldId, newId) {
    if (!room || oldId === newId) return;

    // Night action maps
    Object.values(room.nightActions || {}).forEach(group => {
        if (Object.prototype.hasOwnProperty.call(group, oldId)) {
            group[newId] = group[oldId];
            delete group[oldId];
        }

        Object.keys(group).forEach(key => {
            if (group[key] === oldId) group[key] = newId;
        });
    });

    // Votes
    if (room.votes && Object.prototype.hasOwnProperty.call(room.votes, oldId)) {
        room.votes[newId] = room.votes[oldId];
        delete room.votes[oldId];
    }
    Object.keys(room.votes || {}).forEach(key => {
        if (room.votes[key] === oldId) room.votes[key] = newId;
    });

    // Cupid maps
    if (room.cupidUsed && Object.prototype.hasOwnProperty.call(room.cupidUsed, oldId)) {
        room.cupidUsed[newId] = room.cupidUsed[oldId];
        delete room.cupidUsed[oldId];
    }
    if (room.cupidPairs && Object.prototype.hasOwnProperty.call(room.cupidPairs, oldId)) {
        room.cupidPairs[newId] = room.cupidPairs[oldId];
        delete room.cupidPairs[oldId];
    }
    Object.keys(room.cupidPairs || {}).forEach(key => {
        if (room.cupidPairs[key] === oldId) room.cupidPairs[key] = newId;
    });

    if (room.grandmafiaTarget === oldId) {
        room.grandmafiaTarget = newId;
    }

    if (room.host === oldId) {
        room.host = newId;
    }
}

function emitHostJoinRequest(roomCode, request) {
    const room = rooms[roomCode];
    if (!room) return;

    /*
       Host status is independent of the player's alive state.
       A dead host must still receive and answer rejoin requests.
       We only need an active socket connection here.
    */
    const host = room.players.find(p => p.id === room.host);
    if (!host || host.connected === false) return;

    io.to(host.id).emit("joinRequest", {
        requestId: request.requestId,
        playerName: request.playerName,
        badge: getBadgeOf(request.socketId),
        roomCode,
        reconnecting: Boolean(request.oldPlayerId),
        message: `${request.playerName} wants to join`
    });
}

/* =========================================================
   BADGES (Owner / Admin / Member) + QUESTIONS
   - Badge is stored on the socket, so it cannot be faked by the browser
   - Questions are saved in ./data/questions.json (same DATA_DIR as accounts)
========================================================= */

const OWNER_BADGE_KEY = "Pakistan@143";
const ADMIN_BADGE_KEY = "Saudi_arabia@968";
const QUESTIONS_FILE = path.join(DATA_DIR, "questions.json");
const QUESTIONS_WATCHERS = "qa:watchers";

function getBadgeOf(socketId) {
    return io.sockets.sockets.get(socketId)?.badge || "member";
}

let questionsDb = [];

try {
    if (fs.existsSync(QUESTIONS_FILE)) {
        const parsed = JSON.parse(fs.readFileSync(QUESTIONS_FILE, "utf8"));
        if (Array.isArray(parsed)) questionsDb = parsed;
    }
} catch (error) {
    console.error("Could not load questions file:", error);
    questionsDb = [];
}

if (!questionsDb.length) {
    questionsDb.push({
        id: 1,
        pinned: true,
        title: "Your Questions!",
        author: "Owner",
        badge: "owner",
        body: "Feel free to post your questions here. Only the owner can reply.",
        t: Date.now(),
        replies: []
    });
}

let questionsSaveTimer = null;

function writeQuestionsNow() {
    try {
        const tempFile = QUESTIONS_FILE + ".tmp";
        fs.writeFileSync(tempFile, JSON.stringify(questionsDb));
        fs.renameSync(tempFile, QUESTIONS_FILE);
    } catch (error) {
        console.error("Could not save questions file:", error);
    }
}

function saveQuestions() {
    if (questionsSaveTimer) return;
    questionsSaveTimer = setTimeout(() => {
        questionsSaveTimer = null;
        writeQuestionsNow();
    }, 300);
}

function sanitizeQuestionForSocket(question, socket) {
    const accountKey = socketAccounts.get(socket.id) || null;
    const canManage = socket.badge === "admin" || socket.badge === "owner";
    const ownRequest = Boolean(accountKey && question.authorAccountKey === accountKey);
    return {
        id: question.id,
        pinned: Boolean(question.pinned),
        type: question.type || "question",
        title: question.title,
        author: question.author,
        badge: question.badge || "member",
        body: question.body,
        t: question.t,
        isMine: ownRequest,
        replies: (Array.isArray(question.replies) ? question.replies : []).map(r => ({
            id: r.id || 0,
            text: r.text,
            t: r.t,
            badge: r.badge || "owner",
            author: r.author || (r.badge === "owner" ? "Owner" : "Admin"),
            canEdit: canManage && r.badge === socket.badge && (r.authorAccountKey ? r.authorAccountKey === accountKey : r.authorSocketId === socket.id),
            canDelete: canManage && r.badge === socket.badge && (r.authorAccountKey ? r.authorAccountKey === accountKey : r.authorSocketId === socket.id)
        })),
        canEdit: canManage || ownRequest,
        canDelete: canManage || ownRequest
    };
}

function emitQuestionsUpdate() {
    for (const [socketId, client] of io.sockets.sockets) {
        if (!client.rooms.has(QUESTIONS_WATCHERS)) continue;
        const visible = questionsDb
            .map(q => sanitizeQuestionForSocket(q, client));
        client.emit("questionsUpdate", visible);
    }
}

/* =========================================================
   SOCKET CONNECTION
========================================================= */

io.on(
    "connection",
    socket => {

        console.log(
            "Player connected:",
            socket.id
        );

        /* =================================================
           BADGES + HELP CENTER
        ================================================= */

        socket.badge = "member";

        socket.on("badgeApply", (data, callback) => {
            const key = String(data?.key ?? "");
            socket.badge =
                key === OWNER_BADGE_KEY ? "owner" :
                key === ADMIN_BADGE_KEY ? "admin" :
                "member";

            syncAccountBadge(socket, true);
            if (typeof callback === "function") callback({ badge: socket.badge });
        });

        socket.on("questionsGet", callback => {
            socket.join(QUESTIONS_WATCHERS);
            const accountKey = socketAccounts.get(socket.id) || null;
            const canManage = socket.badge === "admin" || socket.badge === "owner";

            // Questions List is public to signed-in players; the server still
            // marks ownership so the client can provide a separate My Questions view.
            const visible = questionsDb
                .map(q => sanitizeQuestionForSocket(q, socket));

            if (typeof callback === "function") callback(visible);
        });

        socket.on("questionsLeave", () => {
            socket.leave(QUESTIONS_WATCHERS);
        });

        socket.on("questionsAsk", (data, callback) => {
            const reply = result => {
                if (typeof callback === "function") callback(result);
            };

            const accountKey = socketAccounts.get(socket.id) || null;
            if (!accountKey || !accountsDb.users[accountKey]) {
                return reply({ ok: false, error: "Sign in to an account before using Help." });
            }

            const type = ["question", "suggestion", "bug"].includes(String(data?.type)) ? String(data.type) : "question";
            const title = String(data?.title || "").trim().slice(0, 80);
            const body = String(data?.body || "").trim().slice(0, 500);

            if (!title || !body) return reply({ ok: false, error: "Fill in the title and details." });
            if (Date.now() - (socket.lastQuestionAt || 0) < 5000) {
                return reply({ ok: false, error: "Please wait a few seconds before sending again." });
            }
            socket.lastQuestionAt = Date.now();

            const user = accountsDb.users[accountKey];
            questionsDb.push({
                id: Date.now() + Math.floor(Math.random() * 1000),
                pinned: false,
                type,
                title,
                author: user.username,
                authorAccountKey: accountKey,
                badge: socket.badge || "member",
                body,
                t: Date.now(),
                replies: []
            });

            if (questionsDb.length > 500) {
                const oldest = questionsDb.findIndex(q => !q.pinned);
                if (oldest !== -1) questionsDb.splice(oldest, 1);
            }

            saveQuestions();
            emitQuestionsUpdate();
            reply({ ok: true });
        });

        socket.on("questionsEdit", (data, callback) => {
            const reply = result => { if (typeof callback === "function") callback(result); };
            const question = questionsDb.find(q => q.id === Number(data?.id));
            if (!question) return reply({ ok: false, error: "Request not found." });

            const accountKey = socketAccounts.get(socket.id) || null;
            const canManage = socket.badge === "admin" || socket.badge === "owner";
            const isOwner = accountKey && question.authorAccountKey === accountKey;
            if (!canManage && !isOwner) return reply({ ok: false, error: "You can only edit your own request." });
            if (question.pinned) return reply({ ok: false, error: "This Help item cannot be edited." });

            const title = String(data?.title || "").trim().slice(0, 80);
            const body = String(data?.body || "").trim().slice(0, 500);
            if (!title || !body) return reply({ ok: false, error: "Fill in the title and details." });

            question.title = title;
            question.body = body;
            question.editedAt = Date.now();
            saveQuestions();
            emitQuestionsUpdate();
            reply({ ok: true });
        });

        socket.on("questionsDelete", (data, callback) => {
            const reply = result => { if (typeof callback === "function") callback(result); };
            const index = questionsDb.findIndex(q => q.id === Number(data?.id));
            if (index === -1) return reply({ ok: false, error: "Request not found." });

            const question = questionsDb[index];
            const accountKey = socketAccounts.get(socket.id) || null;
            const canManage = socket.badge === "admin" || socket.badge === "owner";
            const isOwner = accountKey && question.authorAccountKey === accountKey;
            if (!canManage && !isOwner) return reply({ ok: false, error: "You can only delete your own request." });
            if (question.pinned) return reply({ ok: false, error: "This Help item cannot be deleted." });

            questionsDb.splice(index, 1);
            saveQuestions();
            emitQuestionsUpdate();
            reply({ ok: true });
        });

        socket.on("questionsReply", (data, callback) => {
            const reply = result => { if (typeof callback === "function") callback(result); };
            if (socket.badge !== "admin" && socket.badge !== "owner") {
                return reply({ ok: false, error: "Only Admin and Owner can answer." });
            }

            const question = questionsDb.find(q => q.id === Number(data?.id));
            const text = String(data?.text || "").trim().slice(0, 500);
            if (!question || !text) return reply({ ok: false, error: "Write an answer first." });

            const accountKey = socketAccounts.get(socket.id) || null;
            question.replies = Array.isArray(question.replies) ? question.replies : [];
            question.replies.push({
                id: Date.now() + Math.floor(Math.random() * 1000),
                text,
                t: Date.now(),
                badge: socket.badge,
                author: accountKey && accountsDb.users[accountKey] ? accountsDb.users[accountKey].username : (socket.badge === "owner" ? "Owner" : "Admin"),
                authorAccountKey: accountKey,
                authorSocketId: socket.id
            });

            saveQuestions();
            emitQuestionsUpdate();
            reply({ ok: true });
        });

        socket.on("questionsReplyEdit", (data, callback) => {
            const reply = result => { if (typeof callback === "function") callback(result); };
            const question = questionsDb.find(q => q.id === Number(data?.id));
            const replyId = Number(data?.replyId);
            const item = question?.replies?.find(r => r.id === replyId);
            const text = String(data?.text || "").trim().slice(0, 500);
            if (!question || !item || !text) return reply({ ok: false, error: "Answer not found." });
            if (socket.badge !== item.badge || (item.authorAccountKey && item.authorAccountKey !== (socketAccounts.get(socket.id) || null))) {
                return reply({ ok: false, error: "You can only edit your own answer." });
            }
            if (!item.authorAccountKey && item.authorSocketId !== socket.id) {
                return reply({ ok: false, error: "You can only edit your own answer." });
            }
            item.text = text;
            item.editedAt = Date.now();
            saveQuestions();
            emitQuestionsUpdate();
            reply({ ok: true });
        });

        socket.on("questionsReplyDelete", (data, callback) => {
            const reply = result => { if (typeof callback === "function") callback(result); };
            const question = questionsDb.find(q => q.id === Number(data?.id));
            const replyId = Number(data?.replyId);
            if (!question || !Array.isArray(question.replies)) return reply({ ok: false, error: "Answer not found." });
            const index = question.replies.findIndex(r => r.id === replyId);
            if (index === -1) return reply({ ok: false, error: "Answer not found." });
            const item = question.replies[index];
            if (socket.badge !== item.badge || (item.authorAccountKey && item.authorAccountKey !== (socketAccounts.get(socket.id) || null))) {
                return reply({ ok: false, error: "You can only delete your own answer." });
            }
            if (!item.authorAccountKey && item.authorSocketId !== socket.id) {
                return reply({ ok: false, error: "You can only delete your own answer." });
            }
            question.replies.splice(index, 1);
            saveQuestions();
            emitQuestionsUpdate();
            reply({ ok: true });
        });

        /* =================================================
           ACCOUNTS: SIGN UP / LOGIN / SKIP / RANKS
        ================================================= */

        socket.on("signUp", async data => {
            try {
                const username = String(data?.username || "").trim();
                const password = String(data?.password || "");
                const pin = String(data?.pin || "");

                if (!isValidUsername(username)) {
                    return socket.emit("authResult", {
                        ok: false,
                        error: "Username must be 3-20 letters, numbers or _ only."
                    });
                }

                if (password.length < 6 || password.length > 72) {
                    return socket.emit("authResult", {
                        ok: false,
                        error: "Password must be 6-72 characters."
                    });
                }

                if (!isValidPin(pin)) {
                    return socket.emit("authResult", {
                        ok: false,
                        error: "PIN must be 4-8 digits."
                    });
                }

                const key = username.toLowerCase();

                if (accountsDb.users[key]) {
                    return socket.emit("authResult", {
                        ok: false,
                        error: "That username is already taken."
                    });
                }

                const salt = crypto.randomBytes(16).toString("hex");
                const hash = await hashPassword(password, salt);
                const pinSalt = crypto.randomBytes(16).toString("hex");
                const pinHash = await hashPassword(pin, pinSalt);
                const passwordEncrypted = {
                    salt: pinSalt,
                    ...encryptPassword(password, pin, pinSalt)
                };

                // Check again: someone may have taken it while hashing.
                if (accountsDb.users[key]) {
                    return socket.emit("authResult", {
                        ok: false,
                        error: "That username is already taken."
                    });
                }

                accountsDb.users[key] = {
                    username,
                    salt,
                    hash,
                    pinSalt,
                    pinHash,
                    passwordEncrypted,
                    created: Date.now(),
                    stats: emptyStats()
                };

                saveAccounts();
                loginSocket(socket, key, false);
            } catch (error) {
                console.error("signUp error:", error);
                socket.emit("authResult", {
                    ok: false,
                    error: "Something went wrong. Try again."
                });
            }
        });

        socket.on("login", async data => {
            try {
                const now = Date.now();

                if (socket.data.authLockUntil && now < socket.data.authLockUntil) {
                    return socket.emit("authResult", {
                        ok: false,
                        error: "Too many wrong attempts. Wait 30 seconds."
                    });
                }

                const username = String(data?.username || "").trim();
                const password = String(data?.password || "");
                const pin = String(data?.pin || "");
                const key = username.toLowerCase();
                const user = accountsDb.users[key];

                let validPassword = false;
                let validPin = false;

                if (user && password.length <= 72) {
                    const attempt = await hashPassword(password, user.salt);
                    const a = Buffer.from(attempt, "hex");
                    const b = Buffer.from(user.hash, "hex");
                    validPassword = a.length === b.length && crypto.timingSafeEqual(a, b);
                } else {
                    // Same amount of work for unknown users.
                    await hashPassword(password.slice(0, 72), "0000000000000000");
                }

                if (user && isValidPin(pin)) {
                    if (user.pinHash && user.pinSalt) {
                        const pinAttempt = await hashPassword(pin, user.pinSalt);
                        const a = Buffer.from(pinAttempt, "hex");
                        const b = Buffer.from(user.pinHash, "hex");
                        validPin = a.length === b.length && crypto.timingSafeEqual(a, b);
                    } else if (validPassword) {
                        // Backwards-compatible migration for accounts created before PIN support.
                        user.pinSalt = crypto.randomBytes(16).toString("hex");
                        user.pinHash = await hashPassword(pin, user.pinSalt);
                        user.passwordEncrypted = {
                            salt: user.pinSalt,
                            ...encryptPassword(password, pin, user.pinSalt)
                        };
                        saveAccounts();
                        validPin = true;
                    }
                }

                if (!validPassword || !validPin) {
                    socket.data.authFails = (socket.data.authFails || 0) + 1;

                    if (socket.data.authFails >= 5) {
                        socket.data.authFails = 0;
                        socket.data.authLockUntil = Date.now() + 30000;
                    }

                    return socket.emit("authResult", {
                        ok: false,
                        error: !validPassword ? "Wrong username or password." : "Wrong PIN."
                    });
                }

                socket.data.authFails = 0;
                loginSocket(socket, key, false);
            } catch (error) {
                console.error("login error:", error);
                socket.emit("authResult", {
                    ok: false,
                    error: "Something went wrong. Try again."
                });
            }
        });

        socket.on("resumeSession", data => {
            const token = String(data?.token || "");
            const key = accountSessions.get(token);

            if (!key || !accountsDb.users[key]) {
                return socket.emit("authResult", {
                    ok: false,
                    resume: true,
                    error: ""
                });
            }

            socketAccounts.set(socket.id, key);
            syncAccountBadge(socket, false);

            socket.emit("authResult", {
                ok: true,
                guest: false,
                username: accountsDb.users[key].username,
                token,
                silent: Boolean(data?.silent)
            });
        });

        socket.on("skipAuth", () => {
            socketAccounts.delete(socket.id);

            socket.emit("authResult", {
                ok: true,
                guest: true,
                username: null,
                silent: false
            });
        });

        socket.on("logout", data => {
            const token = String(data?.token || "");
            if (token) accountSessions.delete(token);
            socketAccounts.delete(socket.id);
        });

        socket.on("getRanks", () => {
            socket.emit("ranksData", getRanksList());
        });

        socket.on("getPlayerStats", data => {
            const key = String(data?.username || "").trim().toLowerCase();
            const user = accountsDb.users[key];

            if (!user) {
                return socket.emit("playerStatsData", { ok: false });
            }

            socket.emit("playerStatsData", {
                ok: true,
                username: user.username,
                badge: user.badge || "member",
                points: totalStats(user.stats),
                stats: { ...emptyStats(), ...(user.stats || {}) }
            });
        });

        /* Current signed-in player's own points/statistics for ACCOUNT INFO. */
        socket.on("getMyAccountStats", () => {
            const key = getSocketAccountKey(socket);
            const user = key ? accountsDb.users[key] : null;

            if (!user) {
                return socket.emit("myAccountStatsData", { ok: false });
            }

            socket.emit("myAccountStatsData", {
                ok: true,
                points: totalStats(user.stats),
                stats: { ...emptyStats(), ...(user.stats || {}) }
            });
        });

        /* Password reveal: the PIN is checked server-side before the password is decrypted. */
        socket.on("showMyPassword", async data => {
            try {
                const key = getSocketAccountKey(socket);
                const user = key ? accountsDb.users[key] : null;
                const pin = String(data?.pin || "");

                if (!user || !isValidPin(pin)) {
                    return socket.emit("showMyPasswordResult", { ok: false, error: "Wrong PIN." });
                }

                if (!user.pinHash || !user.pinSalt) {
                    return socket.emit("showMyPasswordResult", { ok: false, error: "This account needs to be signed in again with a PIN." });
                }

                const attempt = await hashPassword(pin, user.pinSalt);
                const a = Buffer.from(attempt, "hex");
                const b = Buffer.from(user.pinHash, "hex");
                const valid = a.length === b.length && crypto.timingSafeEqual(a, b);

                if (!valid) {
                    return socket.emit("showMyPasswordResult", { ok: false, error: "Wrong PIN." });
                }

                let password = null;
                try {
                    password = decryptPassword(user, pin);
                } catch (_) {
                    password = null;
                }

                if (!password) {
                    return socket.emit("showMyPasswordResult", { ok: false, error: "Password is not available for this account yet. Log in once with your PIN to secure it." });
                }

                socket.emit("showMyPasswordResult", { ok: true, password });
            } catch (error) {
                console.error("showMyPassword error:", error);
                socket.emit("showMyPasswordResult", { ok: false, error: "Could not show the password." });
            }
        });

        socket.on("deleteMyAccount", async data => {
            try {
                const key = getSocketAccountKey(socket);
                const user = key ? accountsDb.users[key] : null;
                const pin = String(data?.pin || "");

                if (!user || !isValidPin(pin) || !user.pinHash || !user.pinSalt) {
                    return socket.emit("deleteMyAccountResult", { ok: false, error: "Wrong PIN." });
                }

                const attempt = await hashPassword(pin, user.pinSalt);
                const a = Buffer.from(attempt, "hex");
                const b = Buffer.from(user.pinHash, "hex");
                const valid = a.length === b.length && crypto.timingSafeEqual(a, b);

                if (!valid) {
                    return socket.emit("deleteMyAccountResult", { ok: false, error: "Wrong PIN." });
                }

                // Remove this account from any current room player records without deleting the player.
                for (const room of Object.values(rooms)) {
                    if (!room?.players) continue;
                    for (const player of room.players) {
                        if (player.account === key) player.account = null;
                    }
                }

                for (const [token, accountKey] of accountSessions.entries()) {
                    if (accountKey === key) accountSessions.delete(token);
                }

                delete accountsDb.users[key];
                socketAccounts.delete(socket.id);
                saveAccounts();

                socket.emit("deleteMyAccountResult", { ok: true });
            } catch (error) {
                console.error("deleteMyAccount error:", error);
                socket.emit("deleteMyAccountResult", { ok: false, error: "Could not delete the account." });
            }
        });

        socket.on("disconnect", () => {
            socketAccounts.delete(socket.id);
        });


        /* =================================================
           CREATE ROOM
        ================================================= */

        socket.on(
            "createRoom",
            data => {

                const playerName =
                    String(
                        typeof data === "string"
                            ? data
                            : data?.playerName || ""
                    ).trim();

                const visibility =
                    String(
                        typeof data === "string"
                            ? "private"
                            : data?.visibility || "private"
                    ).toLowerCase() === "public"
                        ? "public"
                        : "private";

                if (!playerName) {

                    return socket.emit(
                        "joinError",
                        "Enter your name!"
                    );
                }

                const roomCode =
                    makeRoom();

                rooms[roomCode] = {

                    host:
                        socket.id,

                    visibility,

                    // Rejoin / host approval controls.
                    allowPeopleToJoin: true,
                    pendingJoinRequests: {},

                    hiddenNightTurn: false,
                    nightEndTimer: null,

                    // Live game statistics.
                    stats: {
                        totalRounds: 0,
                        mafiaKills: 0,
                        successfulSaves: 0,
                        detectiveInvestigations: 0,
                        playersVotedOut: 0
                    },

                    players: [
                        {
                            id:
                                socket.id,

                            account:
                                getSocketAccountKey(socket),

                            name:
                                playerName,

                            role:
                                null,

                            alive:
                                true,

                            connected:
                                true
                        }
                    ],

                    gameStarted:
                        false,

                    phase:
                        "lobby",

                    settings:
                        null,

                    grandmafiaUsed:
                        false,

                    grandmafiaTarget:
                        null,

                    nightNumber:
                        1,

                    cupidUsed:
                        {},

                    cupidPairs:
                        {},

                    nightActions: {
                        mafia: {},
                        grandmafia: {},
                        doctor: {},
                        detective: {},
                        cupid: {}
                    },

                    votes:
                        {},

                    phaseTimer:
                        null,

                    phaseEndsAt:
                        null,

                    nightTurnTimer:
                        null,

                    nightTurnEndsAt:
                        null,

                    nightTurn:
                        null,

                    nightTurnIndex:
                        0
                };

                socket.join(roomCode);

                socket.emit(
                    "roomCreated",
                    roomCode
                );

                emitLobby(roomCode);

                announce(
                    roomCode,
                    visibility === "public"
                        ? "🌍 Public match created. Waiting for players..."
                        : "🏠 Private room created. Waiting for players...",
                    "info"
                );

                emitPublicMatches();
            }
        );

        /* =================================================
           JOIN ROOM
        ================================================= */

        socket.on(
            "joinRoom",
            data => {

                const playerName =
                    String(
                        data?.playerName || ""
                    ).trim();

                const roomCode =
                    String(
                        data?.roomCode || ""
                    )
                    .trim()
                    .toUpperCase();

                if (!playerName) {

                    return socket.emit(
                        "joinError",
                        "Enter your name!"
                    );
                }

                if (!roomCode) {

                    return socket.emit(
                        "joinError",
                        "Enter room code!"
                    );
                }

                const room =
                    rooms[roomCode];

                if (!room) {

                    return socket.emit(
                        "joinError",
                        "Room does not exist!"
                    );
                }

                if (room.gameStarted) {

                    return socket.emit(
                        "joinError",
                        "Game has already started. Use Rejoin to request access from the host."
                    );
                }

                if (room.allowPeopleToJoin === false) {
                    return socket.emit(
                        "joinError",
                        "The host is not allowing new players to join right now."
                    );
                }

                room.players.push(
                    {
                        id:
                            socket.id,

                        account:
                            getSocketAccountKey(socket),

                        name:
                            playerName,

                        role:
                            null,

                        alive:
                            true,

                        connected:
                            true
                    }
                );

                socket.join(roomCode);

                socket.emit(
                    "joinedRoom",
                    roomCode
                );

                emitLobby(roomCode);

                announce(
                    roomCode,
                    `👤 ${playerName} joined the room.`,
                    "info"
                );

                emitPublicMatches();
            }
        );


        /* =================================================
           REJOIN REQUEST
        ================================================= */

        socket.on("requestRejoin", data => {
            const playerName = String(data?.playerName || "").trim();
            const roomCode = String(data?.roomCode || "").trim().toUpperCase();

            if (!playerName || !roomCode) {
                return socket.emit("rejoinError", "Enter your name and room code.");
            }

            const room = rooms[roomCode];
            if (!room) {
                return socket.emit("rejoinError", "Room does not exist.");
            }

            if (room.allowPeopleToJoin === false) {
                return socket.emit("rejoinError", "The host is not allowing people to join right now.");
            }

            const oldPlayer = room.players.find(
                p => p.name.toLowerCase() === playerName.toLowerCase()
            );

            if (!oldPlayer) {
                return socket.emit(
                    "rejoinError",
                    "No disconnected player with that name was found in this room."
                );
            }

            if (oldPlayer.connected !== false) {
                return socket.emit("rejoinError", "That player is already connected.");
            }

            room.pendingJoinRequests = room.pendingJoinRequests || {};

            // Replace an older request from the same socket/name.
            const requestId = makeJoinRequestId();
            room.pendingJoinRequests[requestId] = {
                requestId,
                socketId: socket.id,
                playerName,
                roomCode,
                oldPlayerId: oldPlayer.id,
                createdAt: Date.now()
            };

            socket.emit("rejoinPending", {
                requestId,
                message: "Join request sent to the host."
            });

            emitHostJoinRequest(roomCode, room.pendingJoinRequests[requestId]);
        });

        /* =================================================
           HOST APPROVES / DECLINES REJOIN
        ================================================= */

        socket.on("respondJoinRequest", data => {
            const roomCode = String(data?.roomCode || "").trim().toUpperCase();
            const requestId = String(data?.requestId || "");
            const approved = Boolean(data?.approved);
            const room = rooms[roomCode];

            if (!room || room.host !== socket.id) return;

            const request = room.pendingJoinRequests?.[requestId];
            if (!request) return;

            delete room.pendingJoinRequests[requestId];

            const requester = io.sockets.sockets.get(request.socketId);

            if (!approved) {
                if (requester) {
                    requester.emit("rejoinDeclined", {
                        message: "Your join request was declined by the host."
                    });
                }
                return;
            }

            const oldPlayer = room.players.find(p => p.id === request.oldPlayerId);
            if (!oldPlayer || oldPlayer.connected !== false) {
                if (requester) {
                    requester.emit("rejoinDeclined", {
                        message: "That old player slot is no longer available."
                    });
                }
                return;
            }

            if (!requester) return;

            const oldId = oldPlayer.id;
            oldPlayer.id = requester.id;
            oldPlayer.connected = true;
            oldPlayer.name = request.playerName;

            migratePlayerReferences(room, oldId, requester.id);

            requester.join(roomCode);

            requester.emit("rejoinApproved", {
                roomCode,
                phase: room.phase,
                hostId: room.host,
                message: "The host approved your request. Welcome back."
            });

            announce(
                roomCode,
                `🔄 ${oldPlayer.name} rejoined the room.`,
                "success"
            );

            if (room.phase === "lobby") {
                emitLobby(roomCode);
            } else {
                sendGameInformation(roomCode);
            }

            emitPublicMatches();
        });

        /* =================================================
           HOST JOIN TOGGLE
        ================================================= */

        socket.on("setAllowPeopleToJoin", data => {
            const roomCode = String(data?.roomCode || "").trim().toUpperCase();
            const room = rooms[roomCode];

            if (!room || room.host !== socket.id) return;

            room.allowPeopleToJoin = Boolean(data?.allowed);

            // Close outstanding requests when the host switches joining off.
            if (!room.allowPeopleToJoin && room.pendingJoinRequests) {
                Object.values(room.pendingJoinRequests).forEach(request => {
                    const requester = io.sockets.sockets.get(request.socketId);
                    requester?.emit("rejoinDeclined", {
                        message: "The host has closed joining for this room."
                    });
                });
                room.pendingJoinRequests = {};
            }

            emitLobby(roomCode);
            sendGameInformation(roomCode);
            emitPublicMatches();
        });

        /* =================================================
           PUBLIC MATCH LIST
        ================================================= */

        socket.on("getPublicMatches", () => {
            socket.emit("publicMatches", getPublicMatches());
        });

        /* =================================================
           LEAVE ROOM
        ================================================= */

        socket.on("leaveRoom", data => {
            const code = String(data?.roomCode || "").trim().toUpperCase();
            const room = rooms[code];
            if (!room) return;

            const index = room.players.findIndex(
                player => player.id === socket.id
            );

            if (index === -1) return;

            if (room.gameStarted && room.phase !== "lobby") {
                return socket.emit(
                    "gameError",
                    "You cannot leave while the game is in progress."
                );
            }

            const leavingPlayer = room.players[index];
            room.players.splice(index, 1);
            socket.leave(code);

            if (!room.players.length) {
                delete rooms[code];
                emitPublicMatches();
                return;
            }

            if (room.host === socket.id) {
                room.host = room.players[0].id;
                announce(
                    code,
                    `👑 ${room.players[0].name} is now the host.`,
                    "info"
                );
            }

            emitLobby(code);
            announce(
                code,
                `🚪 ${leavingPlayer.name} left the room.`,
                "info"
            );
            emitPublicMatches();
        });

        /* =================================================
           START GAME
        ================================================= */

        socket.on(
            "startGame",
            data => {

                const roomCode =
                    String(
                        data?.roomCode || ""
                    ).toUpperCase();

                const room =
                    rooms[roomCode];

                if (!room) return;

                if (
                    room.host !== socket.id
                ) {

                    return socket.emit(
                        "gameError",
                        "Only the host can start the game!"
                    );
                }

                const connectedPlayerCount = room.players.filter(
                    player => player.connected !== false
                ).length;

                if (
                    connectedPlayerCount < 4
                ) {

                    return socket.emit(
                        "gameError",
                        "You need at least 4 players!"
                    );
                }

                const input =
                    data.settings || {};

                const settings = {

                    mafia:
                        Number(input.mafia) || 0,

                    godfather:
                        Number(input.godfather) || 0,

                    grandmafia:
                        Number(input.grandmafia) || 0,

                    grandma:
                        Number(input.grandma) || 0,

                    doctor:
                        Number(input.doctor) || 0,

                    detective:
                        Number(input.detective) || 0,

                    jester:
                        Number(input.jester) || 0,

                    lover:
                        Number(input.lover) || 0,

                    civilian:
                        Number(input.civilian) || 0,

                    grandmaEnabled:
                        Boolean(
                            input.grandmaEnabled
                        )
                };

                if (
                    !settings.grandmaEnabled
                ) {
                    settings.grandma = 0;
                }

                const total =
                    settings.mafia +
                    settings.godfather +
                    settings.grandmafia +
                    settings.grandma +
                    settings.doctor +
                    settings.detective +
                    settings.jester +
                    settings.lover +
                    settings.civilian;

                if (
                    total !==
                    connectedPlayerCount
                ) {

                    return socket.emit(
                        "gameError",
                        "Role numbers must equal player count!"
                    );
                }

                if (
                    settings.jester > 1
                ) {

                    return socket.emit(
                        "gameError",
                        "You can have at most 1 Jester!"
                    );
                }

                if (
                    settings.lover > 1
                ) {

                    return socket.emit(
                        "gameError",
                        "You can have at most 1 Cupid!"
                    );
                }

                if (
                    settings.mafia +
                    settings.godfather +
                    settings.grandmafia <
                    1
                ) {

                    return socket.emit(
                        "gameError",
                        "You need at least one Mafia, Godfather, or Grandmafia!"
                    );
                }

/* =========================
   START COMPLETELY NEW GAME
========================= */

room.settings = settings;

room.gameStarted = true;

room.phase = "night";

room.grandmafiaUsed = false;
room.grandmafiaTarget = null;

room.nightNumber = 1;

// Reset statistics for a brand-new game.
room.stats = {
    totalRounds: 1,
    mafiaKills: 0,
    successfulSaves: 0,
    detectiveInvestigations: 0,
    playersVotedOut: 0
};

room.cupidUsed = {};

room.cupidPairs = {};

room.votes = {};

resetNightActions(room);

/* =========================
   CLEAR OLD PLAYER STATE
========================= */

room.players.forEach(player => {
    player.role = null;
    player.alive = true;
});

/* =========================
   ASSIGN NEW ROLES
========================= */

assignRoles(
    room.players,
    settings
);

                emitPublicMatches();

                announce(
                    roomCode,
                    "🎭 The game has started! Night 1 begins.",
                    "night"
                );

                room.nightTurn = null;
                room.nightTurnIndex = 0;
                room.nightTurnEndsAt = null;

                startNightTurn(roomCode, 0);
            }
        );

        /* =================================================
           MAFIA CHOOSE
        ================================================= */

        socket.on(
            "mafiaChoose",
            data => {

                const room =
                    rooms[data?.roomCode];

                if (
                    !room ||
                    room.phase !== "night" ||
                    room.nightTurn !== "mafia"
                ) {
                    return;
                }

                const attacker =
                    room.players.find(
                        p =>
                            p.id === socket.id &&
                            p.alive &&
                            isMafiaTeam(p.role)
                    );

                if (!attacker) {

                    return socket.emit(
                        "actionError",
                        "You are not Mafia!"
                    );
                }

                if (
                    room.nightActions.mafia[
                        socket.id
                    ]
                ) {

                    return socket.emit(
                        "actionError",
                        "You already selected a target!"
                    );
                }

                const target =
                    room.players.find(
                        p =>
                            p.id ===
                            data.targetId
                    );

                if (
                    !target ||
                    !target.alive ||
                    target.id === socket.id ||
                    isMafiaTeam(target.role)
                ) {

                    return socket.emit(
                        "actionError",
                        "You cannot attack that player."
                    );
                }

                room.nightActions.mafia[
                    socket.id
                ] =
                    target.id;

                socket.emit(
                    "actionConfirmed",
                    target.name
                );

                // Small private popup for the Mafia member who just chose.
                socket.emit(
                    "nightActionPopup",
                    {
                        kind: "mafia",
                        targetName: target.name
                    }
                );

                checkNightActions(
                    data.roomCode
                );
            }
        );

        /* =================================================
           GRANDMAFIA CHOOSE
        ================================================= */

        socket.on(
            "grandmafiaChoose",
            data => {

                const room =
                    rooms[data?.roomCode];

                if (
                    !room ||
                    room.phase !== "night" ||
                    room.nightTurn !== "mafia"
                ) {
                    return;
                }

                if (
                    room.nightNumber !== 1
                ) {

                    return socket.emit(
                        "actionError",
                        "This ability is only available on Night 1!"
                    );
                }

                if (
                    room.grandmafiaUsed
                ) {

                    return socket.emit(
                        "actionError",
                        "The Baby Mafia ability has already been used!"
                    );
                }

                const grandmafia =
                    room.players.find(
                        p =>
                            p.id === socket.id &&
                            p.alive &&
                            p.role === "Grandmafia"
                    );

                if (!grandmafia) {

                    return socket.emit(
                        "actionError",
                        "Only Grandmafia can use this ability!"
                    );
                }

                if (
                    room.nightActions.grandmafia[
                        socket.id
                    ]
                ) {

                    return socket.emit(
                        "actionError",
                        "You already selected a Baby Mafia!"
                    );
                }

                const target =
                    room.players.find(
                        p =>
                            p.id ===
                            data.targetId
                    );

                if (
                    !target ||
                    !target.alive ||
                    target.id === socket.id ||
                    isMafiaTeam(target.role)
                ) {

                    return socket.emit(
                        "actionError",
                        "Choose a living non-Mafia player!"
                    );
                }

                room.nightActions.grandmafia[
                    socket.id
                ] =
                    target.id;

                socket.emit(
                    "grandmafiaSpecialDone"
                );

                checkNightActions(
                    data.roomCode
                );
            }
        );

        /* =================================================
           CUPID CHOOSE
        ================================================= */

        socket.on(
            "cupidChoose",
            data => {

                const room =
                    rooms[data?.roomCode];

                if (
                    !room ||
                    room.phase !== "night" ||
                    room.nightTurn !== "cupid"
                ) {
                    return;
                }

                if (
                    room.nightNumber !== 1
                ) {

                    return socket.emit(
                        "actionError",
                        "Cupid can only choose on Night 1!"
                    );
                }

                const cupid =
                    room.players.find(
                        p =>
                            p.id === socket.id &&
                            p.alive &&
                            p.role === "Cupid"
                    );

                if (!cupid) {

                    return socket.emit(
                        "actionError",
                        "Only the Cupid can use this ability!"
                    );
                }

                if (
                    room.cupidUsed[
                        socket.id
                    ]
                ) {

                    return socket.emit(
                        "actionError",
                        "You already linked the cupids!"
                    );
                }

                const first =
                    room.players.find(
                        p =>
                            p.id ===
                            data.cupid1
                    );

                const second =
                    room.players.find(
                        p =>
                            p.id ===
                            data.cupid2
                    );

                if (
                    !first ||
                    !second
                ) {

                    return socket.emit(
                        "actionError",
                        "Choose two players!"
                    );
                }

                if (
                    !first.alive ||
                    !second.alive
                ) {

                    return socket.emit(
                        "actionError",
                        "Both players must be alive!"
                    );
                }

                if (
                    first.id === second.id
                ) {

                    return socket.emit(
                        "actionError",
                        "Choose two different players!"
                    );
                }

                if (
                    first.id === socket.id ||
                    second.id === socket.id
                ) {

                    return socket.emit(
                        "actionError",
                        "Choose two other players!"
                    );
                }

                room.nightActions.cupid[
                    socket.id
                ] = {
                    firstId:
                        first.id,

                    secondId:
                        second.id
                };

                room.cupidUsed[
                    socket.id
                ] = true;

                socket.emit(
                    "cupidConfirmed",
                    `${first.name} ❤️ ${second.name}`
                );

                // Small private popup for the Cupid/Lover.
                socket.emit(
                    "nightActionPopup",
                    {
                        kind: "cupid",
                        firstName: first.name,
                        secondName: second.name
                    }
                );

                checkNightActions(
                    data.roomCode
                );
            }
        );

        /* =================================================
           DOCTOR CHOOSE
        ================================================= */

        socket.on(
            "doctorChoose",
            data => {

                const room =
                    rooms[data?.roomCode];

                if (
                    !room ||
                    room.phase !== "night" ||
                    room.nightTurn !== "doctor"
                ) {
                    return;
                }

                const doctor =
                    room.players.find(
                        p =>
                            p.id === socket.id &&
                            p.alive &&
                            p.role === "Doctor"
                    );

                if (!doctor) {

                    return socket.emit(
                        "actionError",
                        "You are not the Doctor!"
                    );
                }

                if (
                    room.nightActions.doctor[
                        socket.id
                    ]
                ) {

                    return socket.emit(
                        "actionError",
                        "You already chose this night!"
                    );
                }

                const target =
                    room.players.find(
                        p =>
                            p.id ===
                            data.targetId
                    );

                if (
                    !target ||
                    !target.alive
                ) {

                    return socket.emit(
                        "actionError",
                        "Choose a living player!"
                    );
                }

                room.nightActions.doctor[
                    socket.id
                ] =
                    target.id;

                socket.emit(
                    "actionConfirmed",
                    target.name
                );

                // Small private popup for the Doctor.
                socket.emit(
                    "nightActionPopup",
                    {
                        kind: "doctor",
                        targetName: target.name
                    }
                );

                checkNightActions(
                    data.roomCode
                );
            }
        );

        /* =================================================
           DETECTIVE CHOOSE
        ================================================= */

        socket.on(
            "detectiveChoose",
            data => {

                const room =
                    rooms[data?.roomCode];

                if (
                    !room ||
                    room.phase !== "night" ||
                    room.nightTurn !== "detective"
                ) {
                    return;
                }

                const detective =
                    room.players.find(
                        p =>
                            p.id === socket.id &&
                            p.alive &&
                            p.role === "Detective"
                    );

                if (!detective) {

                    return socket.emit(
                        "actionError",
                        "You are not the Detective!"
                    );
                }

                if (
                    room.nightActions.detective[
                        socket.id
                    ]
                ) {

                    return socket.emit(
                        "actionError",
                        "You already investigated this night!"
                    );
                }

                const target =
                    room.players.find(
                        p =>
                            p.id ===
                            data.targetId
                    );

                if (
                    !target ||
                    !target.alive ||
                    target.id === socket.id
                ) {

                    return socket.emit(
                        "actionError",
                        "Choose another living player!"
                    );
                }

                room.nightActions.detective[
                    socket.id
                ] =
                    target.id;

                room.stats.detectiveInvestigations += 1;

                const detectiveFoundMafia = isDetectiveMafia(target.role);

                // Permanent stat: only a CORRECT Detective Mafia result earns points.
                if (detectiveFoundMafia) {
                    recordStat(detective, "detects");
                }

                socket.emit(
                    "detectiveResult",
                    {
                        playerName:
                            target.name,

                        result:
                            detectiveFoundMafia
                                ? "MAFIA"
                                : "NOT MAFIA",

                        // The client can show the night outcome
                        // alongside the private Detective result.
                        doctorWillSave:
                            Boolean(
                                room.nightActions.doctor &&
                                Object.values(room.nightActions.doctor).includes(target.id)
                            )
                    }
                );

                /*
                   Detective result delay:
                   The Detective gets 3 seconds to read the result.
                   The night turn continues automatically afterwards.
                   No other player receives the private result.
                */
                clearNightTurnTimer(room);

                room.nightTurnTimer = setTimeout(() => {
                    const currentRoom = rooms[data.roomCode];

                    if (
                        !currentRoom ||
                        currentRoom.phase !== "night" ||
                        currentRoom.nightTurn !== "detective"
                    ) {
                        return;
                    }

                    currentRoom.nightTurnTimer = null;

                    checkNightActions(
                        data.roomCode
                    );
                }, 3000);
            }
        );

        /* =================================================
           VOTE
        ================================================= */

        socket.on(
            "votePlayer",
            data => {

                const room =
                    rooms[data?.roomCode];

                if (
                    !room ||
                    room.phase !== "day"
                ) {
                    return;
                }

                const voter =
                    room.players.find(
                        p =>
                            p.id === socket.id
                    );

                if (
                    !voter ||
                    !voter.alive
                ) {
                    return;
                }

                const target =
                    room.players.find(
                        p =>
                            p.id ===
                            data.targetId
                    );

                if (
                    !target ||
                    !target.alive ||
                    target.id === voter.id
                ) {
                    return;
                }

                if (
                    room.votes[
                        socket.id
                    ]
                ) {

                    return socket.emit(
                        "actionError",
                        "You already voted!"
                    );
                }

                room.votes[
                    socket.id
                ] =
                    target.id;

                // Permanent stat: a Civilian voting for a Mafia member (correct vote).
                if (voter.role === "Civilian" && isMafiaTeam(target.role)) {
                    recordStat(voter, "civilianVotes");
                }

                socket.emit(
                    "voteConfirmed",
                    target.name
                );

                const aliveCount =
                    room.players.filter(
                        p => p.alive
                    ).length;

                const validVoteCount =
                    Object.keys(
                        room.votes
                    ).filter(
                        id =>
                            room.players.some(
                                p =>
                                    p.id === id &&
                                    p.alive
                            )
                    ).length;

                if (
                    validVoteCount >=
                    aliveCount
                ) {

                    endVoting(
                        data.roomCode
                    );
                }
            }
        );

        /* =================================================
           PUBLIC CHAT
        ================================================= */

        socket.on(
            "sendMessage",
            data => {

                const room =
                    rooms[data?.roomCode];

                if (!room) return;

                const player =
                    room.players.find(
                        p =>
                            p.id === socket.id
                    );

                if (
                    !player ||
                    !player.alive
                ) {
                    return;
                }

                const message =
                    String(
                        data.message || ""
                    )
                    .trim()
                    .substring(0, 200);

                if (!message) return;

                io.to(
                    data.roomCode
                ).emit(
                    "newMessage",
                    {
                        playerName:
                            player.name,

                        message
                    }
                );
            }
        );

        /* =================================================
           MAFIA CHAT
        ================================================= */

        socket.on(
            "sendMafiaMessage",
            data => {

                const room =
                    rooms[data?.roomCode];

                if (!room) return;

                const sender =
                    room.players.find(
                        p =>
                            p.id === socket.id &&
                            p.alive &&
                            isMafiaTeam(p.role)
                    );

                if (!sender) return;

                const message =
                    String(
                        data.message || ""
                    )
                    .trim()
                    .substring(0, 200);

                if (!message) return;

                room.players.forEach(
                    player => {

                        if (
                            player.alive &&
                            isMafiaTeam(
                                player.role
                            )
                        ) {

                            io.to(
                                player.id
                            ).emit(
                                "newMafiaMessage",
                                {
                                    playerName:
                                        sender.name,

                                    message
                                }
                            );
                        }
                    }
                );
            }
        );

        /* =================================================
           RESTART GAME
        ================================================= */

        socket.on(
            "restartGame",
            data => {

                const roomCode =
                    String(
                        data?.roomCode || ""
                    )
                    .trim()
                    .toUpperCase();

                const room =
                    rooms[roomCode];

                if (!room) {

                    return socket.emit(
                        "gameError",
                        "Room no longer exists!"
                    );
                }

                /* =========================
                   HOST CHECK
                ========================= */

                if (
                    room.host !== socket.id
                ) {

                    return socket.emit(
                        "gameError",
                        "Only the host can restart!"
                    );
                }

                /* =========================
                   GAMEOVER CHECK
                ========================= */

                if (
                    room.phase !== "gameover"
                ) {

                    return socket.emit(
                        "gameError",
                        "The game is not over yet!"
                    );
                }
             /* =========================
                 RESET GAME COMPLETELY
                ========================= */
                
                resetGameState(room);

                /* =========================
                   UPDATE LOBBY
                ========================= */

                emitLobby(roomCode);

                /* =========================
                   TELL EVERYONE
                ========================= */

                io.to(roomCode).emit(
                    "gameRestarted",
                    {
                        players:
                            getPublicPlayers(
                                room
                            ),

                        hostId:
                            room.host,

                        roomCode
                    }
                );

                announce(
                    roomCode,
                    "🔄 Game restarted! Everyone is back in the lobby.",
                    "restart"
                );
            }
        );

        /* =================================================
           DISCONNECT
        ================================================= */

        socket.on(
            "disconnect",
            () => {

                console.log(
                    "Player disconnected:",
                    socket.id
                );

                for (
                    const roomCode
                    of Object.keys(rooms)
                ) {

                    const room =
                        rooms[roomCode];

                    const index =
                        room.players.findIndex(
                            p =>
                                p.id === socket.id
                        );

                    if (
                        index === -1
                    ) {
                        continue;
                    }

                    const disconnected =
                        room.players[index];

                    // Preserve the player object so Rejoin can restore the
                    // exact role/alive state and all game references.
                    disconnected.connected = false;

                    /* =========================
                       HOST TRANSFER
                    ========================= */

                    if (
                        room.host === socket.id
                    ) {

                        const newHost =
                            room.players.find(
                                p => p.connected !== false
                            );

                        if (newHost) {
                            room.host = newHost.id;

                            announce(
                                roomCode,
                                `👑 ${newHost.name} is now the host.`,
                                "info"
                            );
                        }
                    }

                    /* =========================
                       KEEP GAME REFERENCES
                       The disconnected player's old id is
                       intentionally preserved until rejoin.
                    ========================= */

                    announce(
                        roomCode,
                        `📡 ${disconnected.name} disconnected and can rejoin from the Home screen.`,
                        "danger"
                    );


                    /* =========================
                       CHECK WINNER AFTER DISCONNECT
                    ========================= */

                    const connectedPlayers =
                        room.players.filter(p => p.connected !== false);

                    if (
                        connectedPlayers.length &&
                        room.gameStarted &&
                        room.phase !== "lobby" &&
                        checkWinner(roomCode)
                    ) {
                        clearPhaseTimer(room);
                        sendGameInformation(roomCode);
                        continue;
                    }

                    /* =========================
                       UPDATE LOBBY
                    ========================= */

                    emitLobby(roomCode);
                    emitPublicMatches();

                    /* =========================
                       GAME UPDATE
                    ========================= */

                    if (
                        room.gameStarted &&
                        room.phase !== "lobby"
                    ) {

                        sendGameInformation(
                            roomCode
                        );

                        if (
                            room.phase === "night"
                        ) {

                            checkNightActions(
                                roomCode
                            );
                        }

                        if (
                            room.phase === "day"
                        ) {

                            const aliveIds =
                                new Set(
                                    room.players
                                        .filter(
                                            p =>
                                                p.alive
                                        )
                                        .map(
                                            p =>
                                                p.id
                                        )
                                );

                            const validVoteCount =
                                Object.keys(
                                    room.votes
                                ).filter(
                                    id =>
                                        aliveIds.has(
                                            id
                                        )
                                ).length;

                            if (
                                validVoteCount >=
                                aliveIds.size
                            ) {

                                endVoting(
                                    roomCode
                                );
                            }
                        }

                        if (
                            room.phase !==
                            "gameover"
                        ) {

                            checkWinner(
                                roomCode
                            );
                        }
                    }
                }
            }
        );
    }
);

/* =========================================================
   SERVER START
========================================================= */

const PORT = process.env.PORT || 2001;

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Mafia Wars is running on port ${PORT}`);
});
