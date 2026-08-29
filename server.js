const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = {};

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
        roles.push("Clupid");
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
        clupid: {}
    };
}
function resetGameState(room) {

    room.gameStarted = false;
    room.phase = "lobby";

    room.settings = null;

    room.grandmafiaUsed = false;

    room.nightNumber = 1;

    room.clupidUsed = {};
    room.clupidPairs = {};

    room.votes = {};

    resetNightActions(room);

    room.players.forEach(player => {
        player.role = null;
        player.alive = true;
    });
}
/* =========================================================
   PUBLIC PLAYER DATA
========================================================= */

function getPublicPlayers(room) {

    return room.players.map(player => ({
        id: player.id,
        name: player.name,
        alive: player.alive
    }));
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
                room.host
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

        if (
            room.nightActions.mafia[player.id]
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

    /* =========================
       DOCTOR
    ========================= */

    if (player.role === "Doctor") {

        if (
            room.nightActions.doctor[player.id]
        ) {
            return [];
        }

        return room.players
            .filter(p => p.alive)
            .map(p => p.id);
    }

    /* =========================
       DETECTIVE
    ========================= */

    if (player.role === "Detective") {

        if (
            room.nightActions.detective[player.id]
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
   CLUPID TARGETS
========================================================= */

function getClupidTargets(room, player) {

    if (
        !room ||
        !player ||
        !player.alive ||
        player.role !== "Clupid" ||
        room.nightNumber !== 1 ||
        room.clupidUsed[player.id]
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
   LINK CLUPIDS
========================================================= */

function linkClupids(room, a, b) {

    room.clupidPairs[a] = b;
    room.clupidPairs[b] = a;
}

/* =========================================================
   ELIMINATE PLAYER + CLUPID + GODFATHER
========================================================= */

function eliminatePlayerWithClupid(room, player) {

    if (!player || !player.alive) {
        return [];
    }

    const eliminated = [];

    player.alive = false;

    eliminated.push(player);

    /* =========================
       CLUPID
    ========================= */

    const partnerId =
        room.clupidPairs[player.id];

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
                    getPublicPlayers(room),

                /*
                   IMPORTANT:
                   Send hostId during the game too.
                   This allows the client to correctly
                   know who can restart the game.
                */

                hostId:
                    room.host,

                phase:
                    room.phase,

                nightNumber:
                    room.nightNumber,

                grandmafiaUsed:
                    room.grandmafiaUsed,

                clupidUsed:
                    Boolean(
                        room.clupidUsed[player.id]
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

                clupidTargets:
                    getClupidTargets(
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

function checkWinner(roomCode) {

    const room = rooms[roomCode];

    if (
        !room ||
        room.phase === "gameover"
    ) {
        return true;
    }

    const mafiaAlive =
        room.players.filter(
            p =>
                p.alive &&
                isMafiaTeam(p.role)
        );

    const innocentAlive =
        room.players.filter(
            p =>
                p.alive &&
                !isMafiaTeam(p.role)
        );

    /* =========================
       CIVILIANS WIN
    ========================= */

    if (mafiaAlive.length === 0) {

        room.phase = "gameover";

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
                    "The Mafia team has been eliminated!"
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
                    "The Mafia team has taken control!"
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
       CLUPID
    ========================= */

    if (room.nightNumber === 1) {

        const clupids =
            room.players.filter(
                p =>
                    p.alive &&
                    p.role === "Clupid"
            );

        if (
            clupids.some(
                p =>
                    !room.nightActions.clupid[p.id]
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

    const room = rooms[roomCode];

    if (
        !room ||
        room.phase !== "night"
    ) {
        return;
    }

    if (
        allRequiredNightActionsDone(room)
    ) {
        endNight(roomCode);
    }
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

    let babyMafiaCreated = false;

    /* =====================================================
       GRANDMAFIA → BABY MAFIA
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

                target.role =
                    "Baby Mafia";

                babyMafiaCreated = true;

                io.to(target.id).emit(
                    "roleChanged",
                    {
                        role: "Baby Mafia"
                    }
                );

                io.to(grandmafia.id).emit(
                    "grandmafiaResult",
                    {
                        message:
                            `${target.name} became Baby Mafia.`
                    }
                );

                announce(
                    roomCode,
                    `👶 ${target.name} became Baby Mafia!`,
                    "special"
                );
            }
        }

        room.grandmafiaUsed = true;
    }

    /* =====================================================
       CLUPIDS
    ===================================================== */

    if (room.nightNumber === 1) {

        const clupids =
            room.players.filter(
                p =>
                    p.alive &&
                    p.role === "Clupid"
            );

        for (const clupid of clupids) {

            const action =
                room.nightActions.clupid[
                    clupid.id
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
                first.id !== clupid.id &&
                second.id !== clupid.id
            ) {

                linkClupids(
                    room,
                    first.id,
                    second.id
                );

                io.to(clupid.id).emit(
                    "clupidConfirmed",
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
                    eliminatePlayerWithClupid(
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
                eliminatePlayerWithClupid(
                    room,
                    target
                );
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

    if (names.length) {

        announce(
            roomCode,
            `☀️ Morning: ${names.join(", ")} was eliminated.`,
            "danger"
        );

    } else {

        announce(
            roomCode,
            "☀️ Morning: Nobody was eliminated.",
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

            babyMafiaCreated
        }
    );

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

    if (checkWinner(roomCode)) {

        sendGameInformation(roomCode);

        return;
    }

    room.phase = "night";

    room.nightNumber += 1;

    room.votes = {};

    resetNightActions(room);

    announce(
        roomCode,
        `🌙 Night ${room.nightNumber} has begun.`,
        "night"
    );

    sendGameInformation(roomCode);
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
        eliminatePlayerWithClupid(
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

    room.votes = {};

    /* =====================================================
       JESTER WIN
    ===================================================== */

    if (
        eliminatedPlayer.role ===
        "Jester"
    ) {

        room.phase = "gameover";

        announce(
            roomCode,
            `🤡 ${eliminatedPlayer.name} was the Jester and wins!`,
            "special"
        );

        io.to(roomCode).emit(
            "voteResult",
            {
                eliminatedPlayer:
                    eliminatedPlayer.name,

                eliminatedPlayers:
                    names,

                grandmafiaDeath,
                godfatherDeath,

                tie: false
            }
        );

        io.to(roomCode).emit(
            "gameOver",
            {
                winner: "Jester",

                message:
                    "The Jester was voted out and wins the game!"
            }
        );

        return;
    }

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
           CREATE ROOM
        ================================================= */

        socket.on(
            "createRoom",
            playerName => {

                playerName =
                    String(
                        playerName || ""
                    ).trim();

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

                    players: [
                        {
                            id:
                                socket.id,

                            name:
                                playerName,

                            role:
                                null,

                            alive:
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

                    nightNumber:
                        1,

                    clupidUsed:
                        {},

                    clupidPairs:
                        {},

                    nightActions: {
                        mafia: {},
                        grandmafia: {},
                        doctor: {},
                        detective: {},
                        clupid: {}
                    },

                    votes:
                        {}
                };

                socket.join(roomCode);

                socket.emit(
                    "roomCreated",
                    roomCode
                );

                emitLobby(roomCode);

                announce(
                    roomCode,
                    "🏠 Room created. Waiting for players...",
                    "info"
                );
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
                        "Game has already started!"
                    );
                }

                room.players.push(
                    {
                        id:
                            socket.id,

                        name:
                            playerName,

                        role:
                            null,

                        alive:
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
            }
        );

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

                if (
                    room.players.length < 4
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
                    room.players.length
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
                        "You can have at most 1 Clupid!"
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

room.nightNumber = 1;

room.clupidUsed = {};

room.clupidPairs = {};

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
room.players.forEach(player => {
    player.role = null;
    player.alive = true;
});

assignRoles(
    room.players,
    settings
);
                announce(
                    roomCode,
                    "🎭 The game has started! Night 1 begins.",
                    "night"
                );

                sendGameInformation(
                    roomCode
                );
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
                    room.phase !== "night"
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
                    room.phase !== "night"
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
           CLUPID CHOOSE
        ================================================= */

        socket.on(
            "clupidChoose",
            data => {

                const room =
                    rooms[data?.roomCode];

                if (
                    !room ||
                    room.phase !== "night"
                ) {
                    return;
                }

                if (
                    room.nightNumber !== 1
                ) {

                    return socket.emit(
                        "actionError",
                        "Clupid can only choose on Night 1!"
                    );
                }

                const clupid =
                    room.players.find(
                        p =>
                            p.id === socket.id &&
                            p.alive &&
                            p.role === "Clupid"
                    );

                if (!clupid) {

                    return socket.emit(
                        "actionError",
                        "Only the Clupid can use this ability!"
                    );
                }

                if (
                    room.clupidUsed[
                        socket.id
                    ]
                ) {

                    return socket.emit(
                        "actionError",
                        "You already linked the clupids!"
                    );
                }

                const first =
                    room.players.find(
                        p =>
                            p.id ===
                            data.clupid1
                    );

                const second =
                    room.players.find(
                        p =>
                            p.id ===
                            data.clupid2
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

                room.nightActions.clupid[
                    socket.id
                ] = {
                    firstId:
                        first.id,

                    secondId:
                        second.id
                };

                room.clupidUsed[
                    socket.id
                ] = true;

                socket.emit(
                    "clupidConfirmed",
                    `${first.name} ❤️ ${second.name}`
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
                    room.phase !== "night"
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
                    room.phase !== "night"
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

                socket.emit(
                    "detectiveResult",
                    {
                        playerName:
                            target.name,

                        result:
                            isDetectiveMafia(
                                target.role
                            )
                                ? "MAFIA"
                                : "NOT MAFIA"
                    }
                );

                checkNightActions(
                    data.roomCode
                );
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

                    room.players.splice(
                        index,
                        1
                    );

                    /* =========================
                       DELETE EMPTY ROOM
                    ========================= */

                    if (
                        !room.players.length
                    ) {

                        delete rooms[
                            roomCode
                        ];

                        continue;
                    }

                    /* =========================
                       HOST TRANSFER
                    ========================= */

                    if (
                        room.host === socket.id
                    ) {

                        room.host =
                            room.players[0].id;

                        announce(
                            roomCode,
                            `👑 ${room.players[0].name} is now the host.`,
                            "info"
                        );
                    }

                    /* =========================
                       REMOVE STALE REFERENCES
                    ========================= */

                    Object.values(
                        room.nightActions
                    ).forEach(
                        group => {
                            delete group[
                                socket.id
                            ];
                        }
                    );

                    delete room.votes[
                        socket.id
                    ];

                    delete room.clupidUsed[
                        socket.id
                    ];

                    delete room.clupidPairs[
                        socket.id
                    ];

                    /* =========================
                       UPDATE LOBBY
                    ========================= */

                    emitLobby(roomCode);

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