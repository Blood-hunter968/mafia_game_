const socket = io();

/* =========================================================
   GAME SOUNDS
   Put these files inside: public/sounds/
========================================================= */
const gameSounds = {
    button: new Audio("/sounds/button-click.mp3"),
    death: new Audio("/sounds/player-dead.mp3"),
    newRound: new Audio("/sounds/new-round.mp3"),
    last10: new Audio("/sounds/last-10-heartbeat.mp3"),
    turnOver: new Audio("/sounds/turn-over.mp3"),

};

Object.values(gameSounds).forEach(sound => {
    sound.preload = "auto";
});

function playGameSound(sound) {
    if (!sound) return;

    try {
        sound.currentTime = 0;
        const promise = sound.play();
        if (promise) promise.catch(() => {});
    } catch (error) {
        console.warn("Sound error:", error);
    }
}

/*
   Browsers block sound until the user interacts with the page.
   A button click unlocks the audio system without making the
   player hear the game sound effects at once.
*/
let audioUnlocked = false;

function unlockGameAudio() {
    if (audioUnlocked) return;

    const sound = gameSounds.button;
    if (!sound) return;

    try {
        const oldVolume = sound.volume;
        sound.volume = 0;
        const promise = sound.play();

        if (promise) {
            promise.then(() => {
                sound.pause();
                sound.currentTime = 0;
                sound.volume = oldVolume;
                audioUnlocked = true;
            }).catch(() => {
                sound.volume = oldVolume;
            });
        } else {
            sound.pause();
            sound.currentTime = 0;
            sound.volume = oldVolume;
            audioUnlocked = true;
        }
    } catch (error) {
        console.warn("Audio unlock error:", error);
    }
}

/* Sound #1 — every enabled button press */
document.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;

    unlockGameAudio();

    // Home navigation buttons get a guaranteed click sound even if
    // the optional /sounds/button-click.mp3 file is not present.
    if (["createRoom", "joinRoom", "quickStart"].includes(button.id)) {
        playGameSound(gameSounds.button);
        return;
    }

    playGameSound(gameSounds.button);
}, true);

let roomCode = "";
let myRole = "";
let players = [];

let currentPhase = "";
let isHost = false;
let hasVoted = false;
let phaseTimerInterval = null;
let currentPhaseEndsAt = null;
let currentNightTurn = "";
let nightTurnTimerInterval = null;
let currentNightTurnEndsAt = null;
let currentNightNumber = 0;
let detectiveResultMessage = "";
let deathScreenLocked = false;
let gameStats = {
    totalRounds: 0,
    mafiaKills: 0,
    successfulSaves: 0,
    detectiveInvestigations: 0,
    playersVotedOut: 0
};
let allowPeopleToJoin = true;
let pendingRejoinRequestId = null;
let pendingJoinRequests = new Map();

const $ = id => document.getElementById(id);

/* =========================================================
   BASIC UI
========================================================= */

function show(id) {
    const el = $(id);
    if (el) el.style.display = "";
}

function hide(id) {
    const el = $(id);
    if (el) el.style.display = "none";
}

/* =========================================================
   SCREEN CONTROL
========================================================= */

function setScreen(screen) {

    [
        "authScreen",
        "ranksScreen",
        "homeScreen",
        "createRoomScreen",
        "createModeScreen",
        "joinRoomScreen",
        "quickStartScreen",
        "publicMatchesScreen",
        "rejoinScreen",
        "lobby",
        "gameScreen"
    ].forEach(id => hide(id));

    show(screen);
}


/* =========================================================
   REJOIN / HOST APPROVAL UI
   Created here so the existing HTML structure is untouched.
========================================================= */

function ensureRejoinUI() {
    if (!$("rejoinScreen")) {
        const screen = document.createElement("section");
        screen.id = "rejoinScreen";
        screen.style.display = "none";
        screen.innerHTML = `
            <div class="home-container rejoin-card">
                <div class="rejoin-emblem">↻</div>
                <h1>Rejoin Game</h1>
                <p>Reconnect to your old role and player slot.</p>

                <div class="rejoin-input-wrap">
                    <label for="rejoinPlayerName">Your name</label>
                    <input id="rejoinPlayerName" type="text" maxlength="20"
                           placeholder="Enter your name" autocomplete="off">
                </div>

                <div class="rejoin-input-wrap">
                    <label for="rejoinRoomCode">Room code</label>
                    <input id="rejoinRoomCode" type="text" maxlength="6"
                           placeholder="Enter the code" autocomplete="off">
                </div>

                <div id="rejoinStatus" class="rejoin-status"></div>

                <button id="requestRejoinButton" class="rejoin-primary">🔄 JOIN REQUEST</button>
                <button id="backFromRejoin" class="rejoin-secondary">⬅ BACK</button>
            </div>
        `;
        document.body.appendChild(screen);
    }

    if (!$("rejoinHomeButton")) {
        const homeButtons = document.querySelector(".home-buttons");
        if (homeButtons) {
            const button = document.createElement("button");
            button.id = "rejoinHomeButton";
            button.className = "rejoin-home-button";
            button.textContent = "↻ REJOIN GAME";
            homeButtons.appendChild(button);
        }
    }

    $("rejoinHomeButton")?.addEventListener("click", () => {
        playGameSound(gameSounds.button);
        if ($("rejoinPlayerName")) $("rejoinPlayerName").value = "";
        if ($("rejoinRoomCode")) $("rejoinRoomCode").value = "";
        setRejoinStatus("");
        setScreen("rejoinScreen");
        setTimeout(() => $("rejoinPlayerName")?.focus(), 80);
    });

    $("backFromRejoin")?.addEventListener("click", () => {
        playGameSound(gameSounds.button);
        setScreen("homeScreen");
    });

    $("requestRejoinButton")?.addEventListener("click", requestRejoin);
    $("rejoinRoomCode")?.addEventListener("input", e => {
        e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    });
    $("rejoinPlayerName")?.addEventListener("keydown", e => {
        if (e.key === "Enter") requestRejoin();
    });
    $("rejoinRoomCode")?.addEventListener("keydown", e => {
        if (e.key === "Enter") requestRejoin();
    });
}

function setRejoinStatus(message, type = "") {
    const box = $("rejoinStatus");
    if (!box) return;
    box.textContent = message || "";
    box.className = `rejoin-status ${type}`;
}

function requestRejoin() {
    const playerName = String($("rejoinPlayerName")?.value || "").trim();
    const code = String($("rejoinRoomCode")?.value || "").trim().toUpperCase();

    if (!playerName || !code) {
        setRejoinStatus("Enter your name and room code.", "error");
        return;
    }

    pendingRejoinRequestId = null;
    setRejoinStatus("Sending your request to the host…", "waiting");

    socket.emit("requestRejoin", {
        playerName,
        roomCode: code
    });
}

function ensureHostJoinControls() {
    if (!$("hostJoinControl")) {
        const control = document.createElement("div");
        control.id = "hostJoinControl";
        control.className = "host-join-control";
        control.innerHTML = `
            <div class="host-join-label">
                <span class="host-join-dot"></span>
                <div>
                    <strong>Allow people to join</strong>
                    <small>Controls new Rejoin requests</small>
                </div>
            </div>
            <button id="allowPeopleToggle" class="join-toggle" type="button">
                <span class="toggle-knob"></span>
                <span class="toggle-text">YES</span>
            </button>
        `;
        document.body.appendChild(control);
    }

    $("allowPeopleToggle")?.addEventListener("click", () => {
        if (!isHost || !roomCode) return;
        allowPeopleToJoin = !allowPeopleToJoin;
        updateHostJoinControl();
        socket.emit("setAllowPeopleToJoin", {
            roomCode,
            allowed: allowPeopleToJoin
        });
    });

    updateHostJoinControl();
}

function updateHostJoinControl() {
    const control = $("hostJoinControl");
    const toggle = $("allowPeopleToggle");
    if (!control || !toggle) return;

    control.style.display = isHost && Boolean(roomCode) ? "flex" : "none";
    toggle.classList.toggle("off", !allowPeopleToJoin);

    const text = toggle.querySelector(".toggle-text");
    if (text) text.textContent = allowPeopleToJoin ? "YES" : "NO";
}

function showJoinRequestPopup(data) {
    const id = data?.requestId;
    if (!id) return;

    pendingJoinRequests.set(id, data);

    let popup = $("joinRequestPopup");
    if (!popup) {
        popup = document.createElement("div");
        popup.id = "joinRequestPopup";
        popup.className = "join-request-overlay";
        document.body.appendChild(popup);
    }

    popup.innerHTML = `
        <div class="join-request-card">
            <div class="request-icon">↻</div>
            <div class="request-kicker">JOIN REQUEST</div>
            <h2>${escapeHtml(data.playerName || "Player")} ${userBadgeHtml(data.badge)} wants to join</h2>
            <p>${data.reconnecting ? "They are requesting to reconnect to their old slot." : "They are requesting access to the room."}</p>
            <div class="request-code">ROOM ${escapeHtml(data.roomCode || roomCode)}</div>
            <div class="request-actions">
                <button class="request-no" data-request-no="${id}">NO</button>
                <button class="request-yes" data-request-yes="${id}">YES</button>
            </div>
        </div>
    `;
    popup.style.display = "flex";

    popup.querySelector("[data-request-no]")?.addEventListener("click", () => respondJoinRequest(id, false));
    popup.querySelector("[data-request-yes]")?.addEventListener("click", () => respondJoinRequest(id, true));
}

function respondJoinRequest(requestId, approved) {
    if (!roomCode || !isHost) return;
    socket.emit("respondJoinRequest", {
        roomCode,
        requestId,
        approved
    });

    pendingJoinRequests.delete(requestId);

    const popup = $("joinRequestPopup");
    if (popup) popup.style.display = "none";
}

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
    }[char]));
}

/* Host controls are also visible during the game, top-left with the room code. */
function ensureRoomHud() {
    let hud = $("roomHud");
    if (!hud) {
        hud = document.createElement("div");
        hud.id = "roomHud";
        hud.className = "room-hud";
        hud.innerHTML = `
            <div class="room-hud-code">
                <span>ROOM CODE</span>
                <strong id="roomHudCode">-----</strong>
            </div>
            <div id="hostJoinControlInline" class="host-join-control host-join-control-inline">
                <div class="host-join-label">
                    <span class="host-join-dot"></span>
                    <div><strong>Allow people to join</strong><small>New join requests</small></div>
                </div>
                <button id="allowPeopleToggleInline" class="join-toggle" type="button">
                    <span class="toggle-knob"></span>
                    <span class="toggle-text">YES</span>
                </button>
            </div>
        `;
        document.body.appendChild(hud);
    }

    $("allowPeopleToggleInline")?.addEventListener("click", () => {
        if (!isHost || !roomCode) return;
        allowPeopleToJoin = !allowPeopleToJoin;
        updateRoomHud();
        socket.emit("setAllowPeopleToJoin", {
            roomCode,
            allowed: allowPeopleToJoin
        });
    });

    updateRoomHud();
}

function updateRoomHud() {
    const hud = $("roomHud");
    if (!hud) return;

    hud.style.display = roomCode && (currentPhase === "lobby" || currentPhase === "night" || currentPhase === "day") ? "block" : "none";
    const code = $("roomHudCode");
    if (code) code.textContent = roomCode || "-----";

    const inline = $("hostJoinControlInline");
    if (inline) inline.style.display = isHost ? "flex" : "none";

    const toggle = $("allowPeopleToggleInline");
    if (toggle) {
        toggle.classList.toggle("off", !allowPeopleToJoin);
        const text = toggle.querySelector(".toggle-text");
        if (text) text.textContent = allowPeopleToJoin ? "YES" : "NO";
    }
}

ensureRejoinUI();
ensureRoomHud();

/* =========================================================
   ANNOUNCEMENT BOX
========================================================= */

function ensureAnnouncementBox() {
    let box = $("announcementBox");
    if (box) return box;

    box = document.createElement("div");
    box.id = "announcementBox";
    box.innerHTML = `
        <div id="announcementTitle">📢 ANNOUNCEMENT</div>
        <div id="announcementMessage"></div>
    `;

    // Fully styled here so index.html and style.css do NOT need changes.
    Object.assign(box.style, {
        position: "fixed",
        top: "20px",
        left: "50%",
        transform: "translateX(-50%)",
        width: "min(92vw, 620px)",
        padding: "16px 20px",
        borderRadius: "14px",
        background: "rgba(15, 15, 20, 0.97)",
        color: "#fff",
        border: "2px solid rgba(255,255,255,.25)",
        boxShadow: "0 12px 35px rgba(0,0,0,.45)",
        zIndex: "2147483647",
        textAlign: "center",
        fontFamily: "Arial, sans-serif",
        lineHeight: "1.4",
        display: "none",
        pointerEvents: "none"
    });

    const title = box.querySelector("#announcementTitle");
    if (title) {
        Object.assign(title.style, {
            fontWeight: "800",
            fontSize: "15px",
            marginBottom: "6px",
            letterSpacing: ".5px"
        });
    }

    const message = box.querySelector("#announcementMessage");
    if (message) {
        Object.assign(message.style, {
            fontSize: "16px",
            fontWeight: "600",
            wordBreak: "break-word"
        });
    }

    document.body.appendChild(box);
    return box;
}

function announcement(message, type = "info") {
    const box = ensureAnnouncementBox();
    const title = $("announcementTitle");
    const messageElement = $("announcementMessage");

    if (messageElement) messageElement.textContent = String(message || "");

    const styles = {
        info: ["#4da3ff", "📢 ANNOUNCEMENT"],
        success: ["#36d978", "✅ SUCCESS"],
        danger: ["#ff4d5f", "⚠️ ANNOUNCEMENT"],
        night: ["#9b7cff", "🌙 NIGHT"],
        special: ["#ffbd4a", "✨ SPECIAL"],
        restart: ["#38d9c5", "🔄 RESTART"]
    };

    const [borderColor, titleText] = styles[type] || styles.info;
    box.style.borderColor = borderColor;
    if (title) title.textContent = titleText;

    // Use !important so an old CSS rule cannot hide the announcement.
    box.style.setProperty("display", "block", "important");

    clearTimeout(window.announcementTimer);
    window.announcementTimer = setTimeout(() => {
        box.style.setProperty("display", "none", "important");
    }, 6000);
}

/* =========================================================
   SERVER ANNOUNCEMENT
========================================================= */

socket.on("announcement", data => {

    if (!data) return;

    const message = String(data.message || "");

    /* Sound #5 — Mafia/Doctor/Detective/Cupid turn ends */
    if (/(MAFIA|DOCTOR|DETECTIVE|CUPID)\s+turn is over/i.test(message)) {
        playGameSound(gameSounds.turnOver);
    }

    announcement(
        message,
        data.type || "info"
    );
});

/* =========================================================
   CREATE / JOIN SCREENS
========================================================= */

function createRoomScreens() {

    if (!$("createRoomScreen")) {
        const screen = document.createElement("section");
        screen.id = "createRoomScreen";
        screen.style.display = "none";
        screen.innerHTML = `
            <div class="home-container">
                <div class="screen-emblem">🏠</div>
                <h1>Create Room</h1>
                <p>Enter your name first. You will choose the room type next.</p>
                <input id="createPlayerName" type="text" maxlength="30"
                    placeholder="Enter your name" autocomplete="off">
                <button id="confirmCreateRoom">CONTINUE</button>
                <button id="backFromCreate">← BACK</button>
            </div>`;
        document.body.appendChild(screen);
    }

    if (!$("createModeScreen")) {
        const screen = document.createElement("section");
        screen.id = "createModeScreen";
        screen.style.display = "none";
        screen.innerHTML = `
            <div class="home-container mode-choice-container">
                <div class="screen-emblem">🎭</div>
                <h1>Room Type</h1>
                <p>Choose how other players can find your room.</p>
                <div class="mode-choice-grid">
                    <button id="choosePrivateRoom" class="mode-choice">
                        <span class="mode-choice-icon">🔒</span>
                        <strong>PRIVATE</strong>
                        <small>Players join with your room code.</small>
                    </button>
                    <button id="choosePublicRoom" class="mode-choice">
                        <span class="mode-choice-icon">🌍</span>
                        <strong>PUBLIC</strong>
                        <small>Your lobby appears in Quick Start.</small>
                    </button>
                </div>
                <button id="backFromCreateMode" class="secondary-screen-button">← BACK</button>
            </div>`;
        document.body.appendChild(screen);
    }

    if (!$("joinRoomScreen")) {
        const screen = document.createElement("section");
        screen.id = "joinRoomScreen";
        screen.style.display = "none";
        screen.innerHTML = `
            <div class="home-container">
                <div class="screen-emblem">🚪</div>
                <h1>Join Room</h1>
                <p>Enter your name and room code.</p>
                <input id="joinPlayerName" type="text" maxlength="30"
                    placeholder="Enter your name" autocomplete="off">
                <input id="joinRoomCode" type="text" maxlength="10"
                    placeholder="Enter room code" autocomplete="off">
                <button id="confirmJoinRoom">🚪 JOIN ROOM</button>
                <button id="backFromJoin">← BACK</button>
            </div>`;
        document.body.appendChild(screen);
    }

    if (!$("quickStartScreen")) {
        const screen = document.createElement("section");
        screen.id = "quickStartScreen";
        screen.style.display = "none";
        screen.innerHTML = `
            <div class="home-container">
                <div class="screen-emblem">⚡</div>
                <h1>Quick Start</h1>
                <p>Enter your name, then search the public matches.</p>
                <input id="quickStartPlayerName" type="text" maxlength="30"
                    placeholder="Enter your name" autocomplete="off">
                <button id="searchPublicMatches">🔎 SEARCH MATCH</button>
                <button id="backFromQuickStart">← BACK</button>
            </div>`;
        document.body.appendChild(screen);
    }

    if (!$("publicMatchesScreen")) {
        const screen = document.createElement("section");
        screen.id = "publicMatchesScreen";
        screen.style.display = "none";
        screen.innerHTML = `
            <div class="public-matches-shell">
                <div class="public-matches-header">
                    <div>
                        <div class="public-matches-kicker">MAFIA WARS</div>
                        <h1>🌍 PUBLIC MATCHES</h1>
                        <p>Choose the public lobby you want to join.</p>
                    </div>
                    <button id="refreshPublicMatches" class="refresh-match-button" type="button">↻ REFRESH</button>
                </div>
                <div id="publicMatchesList" class="public-matches-list"></div>
                <div id="noPublicMatches" class="no-public-matches">
                    <div class="empty-folder-icon">📂</div>
                    <h2>No public matches yet</h2>
                    <p>Public lobbies will appear here when players create them.</p>
                </div>
                <button id="backFromPublicMatches" class="secondary-screen-button">← BACK</button>
            </div>`;
        document.body.appendChild(screen);
    }

    $("confirmCreateRoom")?.addEventListener("click", createRoom);
    $("createPlayerName")?.addEventListener("keydown", e => {
        if (e.key === "Enter") createRoom();
    });
    $("choosePrivateRoom")?.addEventListener("click", () => createRoomWithVisibility("private"));
    $("choosePublicRoom")?.addEventListener("click", () => createRoomWithVisibility("public"));
    $("backFromCreateMode")?.addEventListener("click", () => {
        setScreen("createRoomScreen");
        setTimeout(() => $("createPlayerName")?.focus(), 50);
    });

    $("confirmJoinRoom")?.addEventListener("click", joinRoom);
    $("joinPlayerName")?.addEventListener("keydown", e => {
        if (e.key === "Enter") $("joinRoomCode")?.focus();
    });
    $("joinRoomCode")?.addEventListener("keydown", e => {
        if (e.key === "Enter") joinRoom();
    });
    $("backFromCreate")?.addEventListener("click", () => setScreen("homeScreen"));
    $("backFromJoin")?.addEventListener("click", () => setScreen("homeScreen"));

    $("searchPublicMatches")?.addEventListener("click", searchPublicMatches);
    $("quickStartPlayerName")?.addEventListener("keydown", e => {
        if (e.key === "Enter") searchPublicMatches();
    });
    $("backFromQuickStart")?.addEventListener("click", () => setScreen("homeScreen"));
    $("refreshPublicMatches")?.addEventListener("click", () => socket.emit("getPublicMatches"));
    $("backFromPublicMatches")?.addEventListener("click", () => setScreen("quickStartScreen"));
}

/* =========================================================
   CREATE ROOM
========================================================= */

function createRoom() {

    const input = $("createPlayerName");
    if (!input) return;

    const name = input.value.trim();

    if (!name) {
        alert("Enter your name!");
        input.focus();
        return;
    }

    window.pendingRoomPlayerName = name;
    setScreen("createModeScreen");
}

function createRoomWithVisibility(visibility) {

    const name = String(window.pendingRoomPlayerName || "").trim();

    if (!name) {
        setScreen("createRoomScreen");
        alert("Enter your name!");
        $("createPlayerName")?.focus();
        return;
    }

    socket.emit("createRoom", {
        playerName: name,
        visibility: visibility === "public" ? "public" : "private"
    });
}

function searchPublicMatches() {

    const input = $("quickStartPlayerName");
    if (!input) return;

    const name = input.value.trim();

    if (!name) {
        alert("Enter your name!");
        input.focus();
        return;
    }

    window.quickStartPlayerName = name;
    setScreen("publicMatchesScreen");
    socket.emit("getPublicMatches");
}

function renderPublicMatches(matches) {

    const list = $("publicMatchesList");
    const empty = $("noPublicMatches");
    if (!list) return;

    list.innerHTML = "";

    if (!Array.isArray(matches) || matches.length === 0) {
        if (empty) empty.style.display = "";
        return;
    }

    if (empty) empty.style.display = "none";

    matches.forEach(match => {

        const folder = document.createElement("article");
        folder.className = "public-match-folder";

        const tab = document.createElement("div");
        tab.className = "public-match-folder-tab";
        tab.textContent = "PUBLIC LOBBY";

        const body = document.createElement("div");
        body.className = "public-match-folder-body";

        const title = document.createElement("h2");
        title.textContent = `Match #${match.roomCode}`;

        const count = document.createElement("div");
        count.className = "public-match-waiting";

        const playerCount = Number(match.playerCount) || 0;
        count.textContent =
            `🟢 ${playerCount} ${playerCount === 1 ? "player" : "players"} waiting`;

        const host = document.createElement("div");
        host.className = "public-match-host";
        host.textContent = `👑 Host: ${match.hostName || "Host"}`;
        appendUserBadge(host, match.hostBadge);

        const joinButton = document.createElement("button");
        joinButton.type = "button";
        joinButton.className = "join-public-match";
        joinButton.textContent = "JOIN MATCH";

        joinButton.addEventListener("click", () => {

            const name = String(window.quickStartPlayerName || "").trim();

            if (!name) {
                setScreen("quickStartScreen");
                alert("Enter your name first!");
                $("quickStartPlayerName")?.focus();
                return;
            }

            socket.emit("joinRoom", {
                playerName: name,
                roomCode: match.roomCode
            });
        });

        body.append(title, count, host, joinButton);
        folder.append(tab, body);
        list.appendChild(folder);
    });
}

socket.on("publicMatches", matches => {
    renderPublicMatches(matches);
});

/* =========================================================
   JOIN ROOM
========================================================= */

function joinRoom() {

    const nameInput =
        $("joinPlayerName");

    const codeInput =
        $("joinRoomCode");

    if (!nameInput || !codeInput)
        return;

    const name =
        nameInput.value.trim();

    const code =
        codeInput.value
            .trim()
            .toUpperCase();

    if (!name) {

        alert("Enter your name!");

        nameInput.focus();

        return;
    }

    if (!code) {

        alert("Enter room code!");

        codeInput.focus();

        return;
    }

    socket.emit(
        "joinRoom",
        {
            playerName: name,
            roomCode: code
        }
    );
}

/* =========================================================
   PLAYER NAME
========================================================= */

function nameOf(id) {

    const player =
        players.find(
            p => p.id === id
        );

    return player
        ? player.name
        : "Unknown";
}

/* =========================================================
   HOST
========================================================= */

function getCurrentHostId() {

    return window.currentHostId || "";
}

/* =========================================================
   HOST UI
========================================================= */

function updateHostUI() {

    const hostSettings =
        $("hostSettings");

    const waiting =
        $("waitingMessage");

    const hostIndicator =
        $("hostIndicator");

    if (isHost) {

        if (hostSettings)
            hostSettings.style.display = "";

        if (waiting)
            waiting.style.display = "none";

        if (hostIndicator)
            hostIndicator.style.display = "";

    } else {

        if (hostSettings)
            hostSettings.style.display = "none";

        if (waiting)
            waiting.style.display = "";

        if (hostIndicator)
            hostIndicator.style.display = "none";
    }

    renderLobbyPlayers();
}

/* =========================================================
   LOBBY PLAYERS
========================================================= */

function renderLobbyPlayers() {

    const list =
        $("playerList");

    if (!list) return;

    /*
       IMPORTANT:
       Clear the list before rendering.
       This prevents duplicate names.
    */

    list.innerHTML = "";

    players
        .filter(player => player.connected !== false)
        .forEach(player => {

        const li =
            document.createElement("li");

        li.className =
            "lobby-player";

        const name =
            document.createElement("span");

        name.textContent =
            player.name;

        appendUserBadge(name, player.badge);

        if (
            player.id ===
            getCurrentHostId()
        ) {

            const crown =
                document.createElement("span");

            crown.className =
                "host-crown";

            crown.textContent =
                "👑 ";

            crown.title =
                "Host";

            name.prepend(crown);
        }

        if (
            player.id ===
            socket.id
        ) {

            const you =
                document.createElement("span");

            you.className =
                "you-label";

            you.textContent =
                " YOU";

            name.appendChild(you);
        }

        li.appendChild(name);

        list.appendChild(li);
    });

    if ($("rolePlayerCount")) {

        $("rolePlayerCount").textContent =
            players.length;
    }

    updateCivilianCount();
}

/* =========================================================
   HOME BUTTONS
========================================================= */

function setupHomeButtons() {

    $("createRoom")?.addEventListener(
        "click",
        () => {

            if ($("createPlayerName"))
                $("createPlayerName").value = "";

            setScreen("createRoomScreen");

            setTimeout(() => {

                $("createPlayerName")?.focus();

            }, 100);
        }
    );

    $("joinRoom")?.addEventListener(
        "click",
        () => {

            if ($("joinPlayerName"))
                $("joinPlayerName").value = "";

            if ($("joinRoomCode"))
                $("joinRoomCode").value = "";

            setScreen("joinRoomScreen");

            setTimeout(() => {

                $("joinPlayerName")?.focus();

            }, 100);
        }
    );

    $("quickStart")?.addEventListener(
        "click",
        () => {
            if ($("quickStartPlayerName"))
                $("quickStartPlayerName").value = "";

            setScreen("quickStartScreen");

            setTimeout(() => {
                $("quickStartPlayerName")?.focus();
            }, 100);
        }
    );
}

function leaveCurrentRoom() {

    if (!roomCode) {
        setScreen("homeScreen");
        return;
    }

    socket.emit("leaveRoom", { roomCode });

    roomCode = "";
    myRole = "";
    players = [];
    currentPhase = "";
    hasVoted = false;
    isHost = false;
    window.currentHostId = "";

    setScreen("homeScreen");
}

function setupLeaveRoomButton() {
    $("leaveRoomButton")?.addEventListener("click", leaveCurrentRoom);
}

/* =========================================================
   ROOM CREATED
========================================================= */

socket.on("roomCreated", code => {

    roomCode = code;
    window.pendingRoomPlayerName = "";

    isHost = true;
    allowPeopleToJoin = true;

    window.currentHostId =
        socket.id;

    updateRoomHud();

    if ($("displayRoomCode")) {

        $("displayRoomCode").textContent =
            code;
    }

    setScreen("lobby");

    updateHostUI();

    announcement(
        "🏠 Room created. Waiting for players...",
        "info"
    );
});

/* =========================================================
   JOINED ROOM
========================================================= */

socket.on("joinedRoom", code => {

    roomCode = code;
    window.pendingRoomPlayerName = "";
    window.quickStartPlayerName = "";

    isHost = false;
    allowPeopleToJoin = true;
    updateRoomHud();

    window.currentHostId = "";

    if ($("displayRoomCode")) {

        $("displayRoomCode").textContent =
            code;
    }

    setScreen("lobby");

    updateHostUI();

    announcement(
        "🚪 You joined the room.",
        "info"
    );
});

/* =========================================================
   PLAYER LIST UPDATE
========================================================= */

socket.on("playerJoined", data => {

    /*
       Server normally sends:
       {
           players: [],
           hostId: ""
       }
    */

    if (Array.isArray(data)) {

        players =
            data.slice();

        window.currentHostId =
            players[0]?.id || "";

    } else {

        players =
            Array.isArray(data?.players)
                ? data.players.slice()
                : [];

        window.currentHostId =
            data?.hostId || "";

        if (data?.allowPeopleToJoin !== undefined) {
            allowPeopleToJoin = data.allowPeopleToJoin !== false;
        }
    }

    isHost =
        socket.id ===
        window.currentHostId;

    updateHostUI();
    updateRoomHud();
});

/* =========================================================
   COPY ROOM CODE
========================================================= */

function setupCopyButton() {

    $("copyRoomCode")?.addEventListener(
        "click",
        async () => {

            try {

                await navigator.clipboard.writeText(
                    roomCode
                );

                $("copyRoomCode").textContent =
                    "COPIED!";

                setTimeout(() => {

                    if ($("copyRoomCode")) {

                        $("copyRoomCode").textContent =
                            "COPY CODE";
                    }

                }, 1200);

            } catch {

                alert(
                    `Room code: ${roomCode}`
                );
            }
        }
    );
}

/* =========================================================
   CIVILIAN COUNT
========================================================= */

function updateCivilianCount() {

    const total =
        players.length;

    const ids = [
        "mafiaCount",
        "godfatherCount",
        "grandmafiaCount",
        "grandmaCount",
        "doctorCount",
        "detectiveCount",
        "jesterCount",
        "loverCount"
    ];

    let used = 0;

    ids.forEach(id => {

        const el = $(id);

        if (el) {

            used +=
                Number(el.value) || 0;
        }
    });

    const civilian =
        $("civilianCount");

    if (civilian) {

        civilian.value =
            Math.max(
                0,
                total - used
            );
    }
}

/* =========================================================
   ROLE INPUTS
========================================================= */

function setupRoleInputs() {

    [
        "mafiaCount",
        "godfatherCount",
        "grandmafiaCount",
        "grandmaCount",
        "doctorCount",
        "detectiveCount",
        "jesterCount",
        "loverCount"
    ].forEach(id => {

        $(id)?.addEventListener(
            "input",
            updateCivilianCount
        );
    });
}

/* =========================================================
   GRANDMA SETTINGS
========================================================= */

function setupGrandmaSettings() {

    $("grandmaYes")?.addEventListener(
        "change",
        () => {

            if ($("grandmaCount")) {

                $("grandmaCount").disabled =
                    false;
            }

            updateCivilianCount();
        }
    );

    $("grandmaNo")?.addEventListener(
        "change",
        () => {

            if ($("grandmaCount")) {

                $("grandmaCount").disabled =
                    true;

                $("grandmaCount").value =
                    0;
            }

            updateCivilianCount();
        }
    );
}

/* =========================================================
   START GAME
========================================================= */

function setupStartGame() {

    $("startGame")?.addEventListener(
        "click",
        () => {

            if (!isHost) {

                alert(
                    "Only the host can start the game!"
                );

                return;
            }

            const startPayload = (
                {
                    roomCode,

                    settings: {

                        mafia:
                            $("mafiaCount")?.value || 0,

                        godfather:
                            $("godfatherCount")?.value || 0,

                        grandmafia:
                            $("grandmafiaCount")?.value || 0,

                        grandma:
                            $("grandmaCount")?.value || 0,

                        grandmaEnabled:
                            $("grandmaYes")?.checked ||
                            false,

                        doctor:
                            $("doctorCount")?.value || 0,

                        detective:
                            $("detectiveCount")?.value || 0,

                        jester:
                            $("jesterCount")?.value || 0,

                        lover:
                            $("loverCount")?.value || 0,

                        civilian:
                            $("civilianCount")?.value || 0
                    }
                }
            );

            socket.emit("startGame", startPayload);
        }
    );
}


/* =========================================================
   DEVICE-SPECIFIC ASSETS
   Mobile/tablet uses square mobile images; laptop/desktop uses wide images.
========================================================= */

function isMobileOrTablet() {
    return window.matchMedia && window.matchMedia("(max-width: 900px)").matches;
}

function getRoleImage(role) {
    const mobile = isMobileOrTablet();
    const roleImages = {
        mafia: mobile ? "/mafia-role.png" : "/mafia-role.png",
        doctor: mobile ? "/doctor-role.png" : "/doctor-role.png",
        detective: mobile ? "/detective-role.png" : "/detective-role.png",
        cupid: mobile ? "/cupid-role.png" : "/cupid-role.png",
        godfather: "/godfather.png",
        grandmafia: "/grandmafia.png",
        grandma: "/grandma.png",
        jester: "/jester.png",
        civilian: "/civilian.png",
        babymafia: mobile ? "/mafia-role.png" : "/mafia-role.png"
    };
    return roleImages[String(role || "").toLowerCase().replace(/\s+/g, "")] || "";
}

function getDeathImage() {
    return isMobileOrTablet() ? "death-mobile.png" : "death-laptop.png";
}

/* =========================================================
   NIGHT ROLE TURN OVERLAY
   Laptop role images + 30-second turn timer.
========================================================= */

function ensureNightTurnOverlay() {
    let overlay = $("nightTurnOverlay");
    if (overlay) return overlay;

    overlay = document.createElement("div");
    overlay.id = "nightTurnOverlay";
    overlay.innerHTML = `
        <div class="night-turn-card">
            <div class="night-turn-title" id="nightTurnTitle">MAFIA TURN</div>
            <div class="night-turn-photo-wrap">
                <img id="nightTurnPhoto" src="" alt="Night role turn">
                <div id="nightTurnTimer" class="night-turn-timer">00:30</div>
            </div>
            <div class="night-turn-subtitle" id="nightTurnSubtitle">MAFIA TEAM IS MAKING A DECISION</div>
        </div>
    `;

    document.body.appendChild(overlay);
    return overlay;
}

function isMyActiveNightTurn(turn) {
    if (currentPhase !== "night") return false;

    // Turn photos are shown to EVERYONE EXCEPT the team/role whose turn it is.
    // Mafia members do not see the Mafia turn photo; non-Mafia players do.
    if (turn === "mafia") {
        return !isMafiaTeamClient(myRole);
    }
    // Doctor does not see the Doctor turn photo.
    if (turn === "doctor") {
        return String(myRole || "").trim().toLowerCase() !== "doctor";
    }
    // Detective does not see the Detective turn photo.
    if (turn === "detective") {
        return String(myRole || "").trim().toLowerCase() !== "detective";
    }
    // Cupid does not see the Cupid turn photo.
    if (turn === "cupid") {
        const role = String(myRole || "").trim().toLowerCase();
        return role !== "cupid" && role !== "cupid";
    }
    return false;
}

let lastNightWarningSecond = -1;
let lastNightTurnKey = "";

/* =========================================================
   LAST-10 SOUND CONTROL
   last-10-heartbeat.mp3 should be about 1 second long.
   It plays once at 10, 9, 8 ... 1 seconds (maximum 10 times).
========================================================= */
let last10SoundStopped = false;

function stopLast10Sound() {
    last10SoundStopped = true;
    const sound = gameSounds.last10;
    if (!sound) return;
    try {
        sound.pause();
        sound.currentTime = 0;
    } catch (error) {
        console.warn("Last-10 sound stop error:", error);
    }
}

function startLast10Sound() {
    last10SoundStopped = false;
    lastNightWarningSecond = -1;
    if (gameSounds.last10) {
        gameSounds.last10.loop = false;
        gameSounds.last10.preload = "auto";
    }
}

function updateNightTurnOverlay(turn, endsAt) {
    currentNightTurn = turn || "";
    currentNightTurnEndsAt = endsAt || null;

    if (nightTurnTimerInterval) {
        clearInterval(nightTurnTimerInterval);
        nightTurnTimerInterval = null;
    }

    const turnKey = `${currentNightTurn}|${currentNightTurnEndsAt || ""}`;

    if (turnKey !== lastNightTurnKey) {
        lastNightTurnKey = turnKey;
        startLast10Sound();
    }

    const overlay = ensureNightTurnOverlay();
    const card = overlay?.querySelector(".night-turn-card");
    const photo = $("nightTurnPhoto");
    const title = $("nightTurnTitle");
    const subtitle = $("nightTurnSubtitle");
    const timer = $("nightTurnTimer");

    const roleData = {
        mafia: {
            title: "MAFIA TURN",
            subtitle: "MAFIA IS MAKING A DECISION",
            image: isMobileOrTablet() ? "/mafia-turn-mobile.png" : "/mafia-turn-laptop.png"
        },
        doctor: {
            title: "DOCTOR TURN",
            subtitle: "DOCTOR IS MAKING A DECISION",
            image: isMobileOrTablet() ? "/doctor-turn-mobile.png" : "/doctor-turn-laptop.png"
        },
        detective: {
            title: "DETECTIVE TURN",
            subtitle: "DETECTIVE IS MAKING A DECISION",
            image: isMobileOrTablet() ? "/detective-turn-mobile.png" : "/detective-turn-laptop.png"
        },
        cupid: {
            title: "CUPID TURN",
            subtitle: "CUPID IS MAKING A DECISION",
            image: isMobileOrTablet() ? "/cupid-turn-mobile.png" : "/cupid-turn-laptop.png"
        }
    };

    const info = roleData[turn];

    // Turn screen visibility: everyone EXCEPT the active role/team sees it.
    // Mafia members do not see Mafia turn; Doctor does not see Doctor turn;
    // Detective does not see Detective turn; Cupid does not see Cupid turn.
    if (!info || currentPhase !== "night" || !endsAt || !isMyActiveNightTurn(turn)) {
        stopLast10Sound();
        overlay.style.display = "none";
        return;
    }

    // Only players outside the active role/team receive the role-turn image and timer.
    {
        if (card) {
            card.className = "night-turn-card night-turn-public-role";
            card.dataset.turn = turn;
        }

        if (photo) {
            photo.style.display = "none";
            photo.removeAttribute("src");
            photo.onerror = () => {
                photo.style.display = "none";
            };
            photo.onload = () => {
                photo.style.display = "block";
            };
            photo.src = info.image;
            photo.alt = info.title;
        }

        if (title) title.textContent = info.title;
        if (subtitle) subtitle.textContent = info.subtitle;
        overlay.style.display = "flex";
    }

    const tick = () => {
        const remaining = Math.max(
            0,
            Number(currentNightTurnEndsAt) - Date.now()
        );
        const totalSeconds = Math.ceil(remaining / 1000);
        const seconds = Math.min(30, totalSeconds);

        if (timer) {
            timer.textContent = `00:${String(seconds).padStart(2, "0")}`;

            if (seconds <= 10 && seconds > 0) {
                timer.classList.add("night-turn-timer-warning");
                timer.classList.add("night-turn-heartbeat");

                /* Sound #4 — one heartbeat/beep for every last-10-second tick */
                if (!last10SoundStopped && lastNightWarningSecond !== seconds) {
                    lastNightWarningSecond = seconds;
                    playGameSound(gameSounds.last10);
                }
            } else {
                timer.classList.remove("night-turn-timer-warning");
                timer.classList.remove("night-turn-heartbeat");
            }
        }

        if (remaining <= 0) {
            stopLast10Sound();
            if (nightTurnTimerInterval) {
                clearInterval(nightTurnTimerInterval);
                nightTurnTimerInterval = null;
            }
        }
    };

    tick();
    nightTurnTimerInterval = setInterval(tick, 100);
}

function hideNightTurnOverlay() {
    stopLast10Sound();
    currentNightTurn = "";
    currentNightTurnEndsAt = null;

    if (nightTurnTimerInterval) {
        clearInterval(nightTurnTimerInterval);
        nightTurnTimerInterval = null;
    }

    const overlay = $("nightTurnOverlay");
    if (overlay) overlay.style.display = "none";
}

/* =========================================================
   ROLE LOGOS
========================================================= */

function updateRoleDisplay(role) {

    const roleText = $("yourRole");
    const roleLogo = $("yourRoleLogo");

    if (!roleText || !roleLogo) return;

    const roleLogos = {
        "Civilian": "civilian.png",
        "Mafia": "mafia-role.png",
        "Godfather": "godfather.png",
        "Grandmafia": "grandmafia.png",
        "Grandma": "grandma.png",
        "Detective": getRoleImage("detective"),
        "Doctor": getRoleImage("doctor"),
        "Jester": "jester.png",
        "Cupid": getRoleImage("cupid"),
        "Baby Mafia": getRoleImage("babymafia")
    };

    const logo = roleLogos[role];

    roleText.textContent = role || "Unknown";

    if (logo) {

        // Use an absolute public path so the role image works from any route.
        roleLogo.src = logo;
        roleLogo.alt = role;
        roleLogo.style.display = "block";
        roleLogo.onerror = () => {
            roleLogo.style.display = "none";
        };

    } else {

        roleLogo.style.display = "none";
    }
}

/* =========================================================
   2-MINUTE PHASE TIMER
========================================================= */

function ensurePhaseTimer() {
    let timer = $("phaseTimer");
    if (timer) return timer;

    const header = document.querySelector(".game-header");
    if (!header) return null;

    timer = document.createElement("div");
    timer.id = "phaseTimer";
    timer.className = "phase-timer";
    timer.textContent = "⏱️ 02:00";

    const phaseTitle = $("phaseTitle");
    if (phaseTitle) {
        phaseTitle.insertAdjacentElement("afterend", timer);
    } else {
        header.appendChild(timer);
    }

    return timer;
}

function updatePhaseTimer(endsAt, phase) {
    currentPhaseEndsAt = endsAt || null;

    if (phaseTimerInterval) {
        clearInterval(phaseTimerInterval);
        phaseTimerInterval = null;
    }

    const timer = ensurePhaseTimer();
    if (!timer) return;

    if (!endsAt || (phase !== "night" && phase !== "day")) {
        timer.style.display = "none";
        return;
    }

    timer.style.display = "inline-block";

    const tick = () => {
        const remaining = Math.max(0, Number(currentPhaseEndsAt) - Date.now());
        const totalSeconds = Math.ceil(remaining / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;

        timer.textContent =
            `⏱️ ${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

        if (totalSeconds <= 10) {
            timer.classList.add("phase-timer-warning");
        } else {
            timer.classList.remove("phase-timer-warning");
        }

        if (remaining <= 0 && phaseTimerInterval) {
            clearInterval(phaseTimerInterval);
            phaseTimerInterval = null;
        }
    };

    tick();
    phaseTimerInterval = setInterval(tick, 250);
}


/* =========================================================
   START GAME ROLE LOGO REVEAL
   5-second countdown -> role logo only -> continue game.
========================================================= */

let roleRevealSequenceActive = false;
let roleRevealTimerInterval = null;
let roleRevealLastPhase = "";
let roleRevealCountdownToken = 0;
let roleRevealShownForGame = false;

function ensureRoleRevealOverlay() {
    let overlay = $("roleRevealOverlay");
    if (overlay) return overlay;

    overlay = document.createElement("div");
    overlay.id = "roleRevealOverlay";
    overlay.innerHTML = `
        <div class="role-reveal-countdown" id="roleRevealCountdown">
            <div class="role-reveal-countdown-label">STARTING GAME</div>
            <div class="role-reveal-countdown-number" id="roleRevealCountdownNumber">5</div>
            <div class="role-reveal-countdown-ready" id="roleRevealCountdownReady">0 PLAYERS ARE READY</div>
            <div class="role-reveal-countdown-line"></div>
        </div>

        <div class="role-logo-stage" id="roleLogoStage" style="display:none;">
            <div class="role-logo-title">YOUR ROLE</div>
            <div class="role-logo-frame">
                <img id="roleRevealImage" src="" alt="Your role" style="display:none;">
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    return overlay;
}

function stopRoleRevealCountdown() {
    if (roleRevealTimerInterval) {
        clearInterval(roleRevealTimerInterval);
        roleRevealTimerInterval = null;
    }
}

function setRolePanelVisible(visible) {
    const panel = document.querySelector(".your-role-panel");
    if (panel) panel.style.visibility = visible ? "visible" : "hidden";
}

function updateRoleRevealImage() {
    const image = $("roleRevealImage");
    if (!image) return;

    const imagePath = getRoleImage(myRole);
    image.onerror = () => {
        image.style.display = "none";
        console.warn("Role image failed to load:", image.src, "role:", myRole);
    };
    image.onload = () => {
        image.style.display = imagePath ? "block" : "none";
    };
    image.src = imagePath || "";
    image.alt = myRole || "Your role";
    image.style.display = imagePath ? "block" : "none";
}

function showRoleLogoOnly() {
    const countdown = $("roleRevealCountdown");
    const stage = $("roleLogoStage");
    if (countdown) countdown.style.display = "none";
    if (stage) stage.style.display = "flex";

    updateRoleRevealImage();
    updateRoleDisplay(myRole);
    setRolePanelVisible(true);

    setTimeout(() => {
        const overlay = $("roleRevealOverlay");
        if (!roleRevealSequenceActive || !overlay) return;
        overlay.classList.add("role-reveal-finished");
        setTimeout(() => {
            if (overlay) {
                overlay.style.display = "none";
                overlay.classList.remove("role-reveal-finished");
            }
            roleRevealSequenceActive = false;
        }, 450);
    }, 5000);
}

function startRoleRevealSequence() {
    if (roleRevealSequenceActive) return;

    roleRevealSequenceActive = true;
    roleRevealShownForGame = true;
    stopRoleRevealCountdown();

    const token = ++roleRevealCountdownToken;
    const overlay = ensureRoleRevealOverlay();
    const countdown = $("roleRevealCountdown");
    const stage = $("roleLogoStage");
    const number = $("roleRevealCountdownNumber");
    const ready = $("roleRevealCountdownReady");

    setRolePanelVisible(false);
    if (countdown) countdown.style.display = "flex";
    if (stage) stage.style.display = "none";

    const count = Array.isArray(players) ? players.length : 0;
    if (ready) {
        ready.textContent = count === 1 ? "1 PLAYER IS READY" : `${count} PLAYERS ARE READY`;
    }

    if (overlay) {
        overlay.classList.remove("role-reveal-finished");
        overlay.style.display = "flex";
    }

    let remaining = 5;

    const runCountdown = () => {
        if (token !== roleRevealCountdownToken) return;

        if (number) {
            number.textContent = String(remaining);
            number.classList.remove("role-countdown-pop");
            void number.offsetWidth;
            number.classList.add("role-countdown-pop");
        }

        if (remaining <= 0) {
            stopRoleRevealCountdown();
            showRoleLogoOnly();
            return;
        }

        remaining -= 1;
    };

    runCountdown();
    roleRevealTimerInterval = setInterval(runCountdown, 1000);
}

function resetRoleRevealSequence() {
    ++roleRevealCountdownToken;
    stopRoleRevealCountdown();
    roleRevealSequenceActive = false;
    roleRevealLastPhase = "";
    roleRevealShownForGame = false;

    const overlay = $("roleRevealOverlay");
    if (overlay) {
        overlay.style.display = "none";
        overlay.classList.remove("role-reveal-finished");
    }
    setRolePanelVisible(true);
}

function handleRoleRevealPhase(phase) {
    if (phase === "lobby" || phase === "gameover" || !phase) {
        resetRoleRevealSequence();
        roleRevealLastPhase = phase;
        return;
    }

    const hasAssignedRole = String(myRole || "").trim().length > 0;

    if (!roleRevealSequenceActive && !roleRevealShownForGame && hasAssignedRole) {
        startRoleRevealSequence();
    } else if (roleRevealSequenceActive && hasAssignedRole) {
        updateRoleRevealImage();
    }

    roleRevealLastPhase = phase;
}

/* =========================================================
   GAME INFORMATION
========================================================= */

socket.on(
    "gameInformation",
    data => {

        if (!data) return;

        roomCode =
            data.roomCode || roomCode;

        myRole =
            data.role || "";

        players =
            Array.isArray(data.players)
                ? data.players.slice()
                : [];

        currentPhase =
            data.phase || "";

        if (data.stats) {
            gameStats = {
                ...gameStats,
                ...data.stats
            };
        }

        allowPeopleToJoin =
            data.allowPeopleToJoin !== false;

        isHost =
            data.hostId === socket.id;

        window.currentHostId =
            data.hostId || "";

        updateHostUI();
        updateRoomHud();

        /*
           DEAD PLAYER MODE:
           As soon as the server tells this client that they are dead,
           lock the supplied death image over the entire game screen.
           This also covers deaths caused by night actions or vote chains.
        */
        if (currentPhase !== "gameover" && currentPhase !== "lobby") {
            keepDeadPlayerOnDeathScreen(data);
        }

        /*
           Reset vote only when entering a new day.
        */

        if (currentPhase === "day") {

            /*
               Don't reset here if the player already
               submitted a vote during this day.
            */
        }

        setScreen("gameScreen");

        // Start the 5-second STARTING GAME screen as soon as the private role is available.
        // The player count comes directly from the current game player list.
        handleRoleRevealPhase(currentPhase);

        updatePhaseTitle(data);
        updatePhaseTimer(data.phaseEndsAt, data.phase);
        updateNightTurnOverlay(data.nightTurn, data.nightTurnEndsAt);

        /*
           The server sends fresh gameInformation after a Detective
           action. Do not let that refresh overwrite the Detective's
           result. Clear the result only when a NEW night starts.
        */
        if (currentPhase === "night") {

            const newNightNumber = Number(data.nightNumber) || 0;

            /*
               Sound #3 — NEW NIGHT / ROUND

               Play only when the night number actually changes.
               This prevents the sound from playing repeatedly
               whenever gameInformation is refreshed.
            */
            if (newNightNumber !== currentNightNumber) {

                currentNightNumber = newNightNumber;

                // Play new-round sound when a new Night begins
                if (newNightNumber > 0) {
                    playGameSound(gameSounds.newRound);
                }

                detectiveResultMessage = "";
                hideDetectiveResultPopup();
                if (typeof hideNightActionPopup === "function") hideNightActionPopup();
            }

        } else {

            currentNightNumber = 0;
            detectiveResultMessage = "";
            hideDetectiveResultPopup();
        }

        updateRoleDisplay(myRole);

        renderGamePlayers();

        renderTargets(data);

        renderSpecialActions(data);

        renderMafiaChat();

        updateActionMessage();

        /*
           START GAME ROLE CARD:
           Run the requested 5-second countdown and flip-card flow
           after the existing game information has been processed.
        */
        watchGameStartForRoleReveal(data);
    }
);

/* =========================================================
   PHASE TITLE
========================================================= */

function updatePhaseTitle(data) {

    const title =
        $("phaseTitle");

    if (!title) return;

    if (data.phase === "night") {

        title.textContent =
            `🌙 NIGHT ${data.nightNumber}`;

    } else if (data.phase === "day") {

        title.textContent =
            "☀️ DAY";

    } else if (
        data.phase === "gameover"
    ) {

        title.textContent =
            "🏆 GAME OVER";

    } else {

        title.textContent =
            "MAFIA WARS";
    }
}

/* =========================================================
   GAME PLAYERS
========================================================= */

function renderGamePlayers() {

    const list =
        $("gamePlayerList");

    if (!list) return;

    list.innerHTML = "";

    players.forEach(player => {

        const li =
            document.createElement("li");

        const name = document.createElement("span");
        name.textContent = player.name;

        if (player.role) {
            const role = document.createElement("span");
            role.className = "visible-player-role";
            role.textContent = ` — ${player.role}`;
            name.appendChild(role);
        }

        li.appendChild(name);

        if (!player.alive) {
            const dead = document.createElement("span");
            dead.textContent = " ☠️";
            li.appendChild(dead);
        }

        if (!player.alive) {

            li.style.opacity =
                "0.45";
        }

        list.appendChild(li);
    });
}

/* =========================================================
   ADD PLAYER OPTION
========================================================= */

function addOption(select, id) {

    if (!select) return;

    const player =
        players.find(
            p => p.id === id
        );

    if (!player) return;

    /*
       Prevent duplicate options.
    */

    if (
        Array.from(select.options)
            .some(option =>
                option.value === id
            )
    ) {
        return;
    }

    const option =
        document.createElement("option");

    option.value =
        id;

    option.textContent =
        player.name;

    select.appendChild(option);
}

/* =========================================================
   TARGETS
========================================================= */

function renderTargets(data) {

    const select =
        $("targetPlayer");

    const button =
        $("confirmAction");

    if (!select || !button)
        return;

    select.innerHTML =
        `<option value="">-- Select a player --</option>`;

    /* =====================================================
       DAY
    ===================================================== */

    if (currentPhase === "day") {

        const alivePlayers =
            players.filter(
                player =>
                    player.alive &&
                    player.id !== socket.id
            );

        select.innerHTML =
            `<option value="">-- Vote for a player --</option>`;

        alivePlayers.forEach(
            player => {

                addOption(
                    select,
                    player.id
                );
            }
        );

        show("targetPlayer");
        show("confirmAction");

        if (hasVoted) {

            button.disabled =
                true;

            button.textContent =
                "✅ VOTE SUBMITTED";

        } else {

            button.disabled =
                false;

            button.textContent =
                "🗳️ VOTE";
        }

        return;
    }

    /* =====================================================
       NIGHT
    ===================================================== */

    button.disabled = false;

if (myRole === "Mafia" ||
    myRole === "Grandmafia" ||
    myRole === "Baby Mafia") {

    button.textContent = "🔪 KILL";

} else if (myRole === "Detective") {

    button.textContent = "🔎 CHECK";

} else if (myRole === "Doctor") {

    button.textContent = "💚 SAVE";

} else {

    button.textContent = "CONFIRM";
}

const targets =
    data.actionTargets || [];

    targets.forEach(
        id => addOption(select, id)
    );

    if (targets.length > 0) {

        show("targetPlayer");
        show("confirmAction");

    } else {

        hide("targetPlayer");
        hide("confirmAction");
    }
}

/* =========================================================
   SPECIAL ACTIONS
========================================================= */

function renderSpecialActions(data) {

    /* =====================================================
       GRANDMAFIA
    ===================================================== */

    if (
        myRole === "Grandmafia" &&
        data.nightNumber === 1 &&
        !data.grandmafiaUsed
    ) {

        show("grandmafiaPanel");
        show("grandmafiaButton");

        const select =
            $("grandmafiaTarget");

        if (select) {

            select.innerHTML =
                `<option value="">-- Choose Baby Mafia --</option>`;

            (
                data.grandmafiaTargets || []
            ).forEach(
                id =>
                    addOption(
                        select,
                        id
                    )
            );
        }

    } else {

        hide("grandmafiaPanel");
        hide("grandmafiaButton");
    }

    /* =====================================================
       CUPID
    ===================================================== */

    if (
        myRole === "Cupid" &&
        data.nightNumber === 1 &&
        !data.cupidUsed
    ) {

        show("loverPanel");
        show("loverButton");

        fillCupidSelect(
            "lover1",
            data.cupidTargets || []
        );

        fillCupidSelect(
            "lover2",
            data.cupidTargets || []
        );

    } else {

        hide("loverPanel");
        hide("loverButton");
    }
}

/* =========================================================
   CUPID SELECT
========================================================= */

function fillCupidSelect(
    id,
    targets
) {

    const select =
        $(id);

    if (!select) return;

    select.innerHTML =
        `<option value="">-- Select Cupid --</option>`;

    targets.forEach(
        targetId =>
            addOption(
                select,
                targetId
            )
    );
}

/* =========================================================
   MAIN ACTION
========================================================= */

function setupMainAction() {

    $("confirmAction")?.addEventListener(
        "click",
        () => {

            const targetId =
                $("targetPlayer")?.value;

            /* =================================================
               DAY VOTE
            ================================================= */

            if (
                currentPhase === "day"
            ) {

                if (hasVoted)
                    return;

                if (!targetId) {

                    alert(
                        "Choose someone to vote for!"
                    );

                    return;
                }

                hasVoted = true;

                socket.emit(
                    "votePlayer",
                    {
                        roomCode,
                        targetId
                    }
                );

                $("confirmAction").disabled =
                    true;

                $("confirmAction").textContent =
                    "🗳️ VOTE";

                if ($("actionMessage")) {

                    $("actionMessage").textContent =
                        `🗳️ You voted for ${nameOf(targetId)}.`;
                }

                return;
            }

            /* =================================================
               NIGHT ACTION
            ================================================= */

            if (
                currentPhase === "night"
            ) {

                if (!targetId) {

                    alert(
                        "Choose a player!"
                    );

                    return;
                }

                if (
                    isMafiaTeamClient(
                        myRole
                    )
                ) {

                    socket.emit(
                        "mafiaChoose",
                        {
                            roomCode,
                            targetId
                        }
                    );

                } else if (
                    myRole === "Doctor"
                ) {

                    socket.emit(
                        "doctorChoose",
                        {
                            roomCode,
                            targetId
                        }
                    );

                } else if (
                    myRole === "Detective"
                ) {

                    socket.emit(
                        "detectiveChoose",
                        {
                            roomCode,
                            targetId
                        }
                    );
                }
            }
        }
    );
}

/* =========================================================
   MAFIA TEAM
========================================================= */

function isMafiaTeamClient(role) {

    return [
        "Mafia",
        "Godfather",
        "Grandmafia",
        "Baby Mafia"
    ].includes(role);
}

/* =========================================================
   GRANDMAFIA BUTTON
========================================================= */

function setupGrandmafia() {

    $("grandmafiaButton")
        ?.addEventListener(
            "click",
            () => {

                const targetId =
                    $("grandmafiaTarget")?.value;

                if (!targetId) {

                    alert(
                        "Choose who becomes Baby Mafia!"
                    );

                    return;
                }

                stopLast10Sound();
                socket.emit(
                    "grandmafiaChoose",
                    {
                        roomCode,
                        targetId
                    }
                );
            }
        );
}

/* =========================================================
   CUPID BUTTON
========================================================= */

function setupCupid() {

    $("loverButton")
        ?.addEventListener(
            "click",
            () => {

                const cupid1 =
                    $("lover1")?.value;

                const cupid2 =
                    $("lover2")?.value;

                if (!cupid1 || !cupid2) {

                    alert(
                        "Choose both cupids!"
                    );

                    return;
                }

                if (
                    cupid1 === cupid2
                ) {

                    alert(
                        "Choose two different players!"
                    );

                    return;
                }

                stopLast10Sound();
                socket.emit(
                    "cupidChoose",
                    {
                        roomCode,
                        cupid1,
                        cupid2
                    }
                );
            }
        );
}

/* =========================================================
   ACTION MESSAGE
========================================================= */

function updateActionMessage() {

    const message =
        $("actionMessage");

    if (!message) return;

    if (
        currentPhase === "night"
    ) {
        if (detectiveResultMessage) {
            message.textContent = detectiveResultMessage;
            return;
        }

        const roleTurnMap = {
            mafia: "Mafia",
            doctor: "Doctor",
            detective: "Detective",
            cupid: "Cupid"
        };

        const activeRole = roleTurnMap[currentNightTurn];

        if (!activeRole) {
            message.textContent = "🌙 Preparing the next night turn...";
        } else if (
            (currentNightTurn === "mafia" && isMafiaTeamClient(myRole)) ||
            (currentNightTurn === "doctor" && myRole === "Doctor") ||
            (currentNightTurn === "detective" && myRole === "Detective") ||
            (currentNightTurn === "cupid" && (myRole === "Cupid" || myRole === "Cupid"))
        ) {
            message.textContent = `🎯 ${activeRole} turn — make your decision.`;
        } else {
            message.textContent = `⏳ ${activeRole} is making a decision...`;
        }

    } else if (
        currentPhase === "day"
    ) {

        if (hasVoted) {

            message.textContent =
                "🗳️ Your vote has been submitted. Waiting for the other players...";

        } else {

            message.textContent =
                "☀️ Discuss and vote for a player.";
        }
    }
}

/* =========================================================
   ACTION CONFIRMED
========================================================= */

socket.on(
    "actionConfirmed",
    name => {

        stopLast10Sound();
        if ($("actionMessage")) {

            $("actionMessage").textContent =
                `✅ Action selected: ${name}`;
        }
    }
);

/* =========================================================
   GRANDMAFIA
========================================================= */

socket.on(
    "grandmafiaSpecialDone",
    () => {

        stopLast10Sound();
        if ($("actionMessage")) {

            $("actionMessage").textContent =
                "👶 Baby Mafia selected!";
        }
    }
);

socket.on(
    "grandmafiaResult",
    data => {

        if ($("actionMessage")) {

            $("actionMessage").textContent =
                "👶 " +
                data.message;
        }
    }
);

/* =========================================================
   CUPID
========================================================= */

socket.on(
    "cupidConfirmed",
    message => {

        stopLast10Sound();
        if ($("actionMessage")) {

            $("actionMessage").textContent =
                "💕 Cupids linked: " +
                message;
        }
    }
);

/* =========================================================
   DETECTIVE RESULT POPUP
   PRIVATE — ONLY THE DETECTIVE RECEIVES THE RESULT
========================================================= */

let detectiveResultPopupTimer = null;

function ensureDetectiveResultPopup() {
    let overlay = $("detectiveResultPopup");
    if (overlay) return overlay;

    overlay = document.createElement("div");
    overlay.id = "detectiveResultPopup";
    overlay.setAttribute("aria-live", "assertive");
    overlay.setAttribute("aria-modal", "true");
    overlay.innerHTML = `
        <div class="detective-result-card">
            <div class="detective-result-scan"></div>

            <div class="detective-result-badge">
                🔎
            </div>

            <div class="detective-result-kicker">
                CASE FILE • NIGHT INVESTIGATION
            </div>

            <div class="detective-result-title">
                INVESTIGATION COMPLETE
            </div>

            <div class="detective-result-divider"></div>

            <div class="detective-result-label">
                SUBJECT
            </div>

            <div class="detective-result-player" id="detectiveResultPlayer">
                Unknown
            </div>

            <div class="detective-result-label">
                MAFIA STATUS
            </div>

            <div class="detective-result-answer" id="detectiveResultAnswer">
                UNKNOWN
            </div>

            <div class="detective-result-footer">
                <span class="detective-result-dot"></span>
                PRIVATE DETECTIVE REPORT
            </div>

            <div class="detective-result-progress">
                <div class="detective-result-progress-bar"></div>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    return overlay;
}

function showDetectiveResultPopup(playerName, result) {
    const overlay = ensureDetectiveResultPopup();
    const player = $("detectiveResultPlayer");
    const answer = $("detectiveResultAnswer");

    clearTimeout(detectiveResultPopupTimer);

    const isMafia = String(result || "").toUpperCase() === "MAFIA";

    if (player) {
        player.textContent = String(playerName || "Unknown");
    }

    if (answer) {
        answer.textContent = isMafia
            ? "🔴 MAFIA — YES"
            : "🟢 MAFIA — NO";

        answer.classList.toggle("detective-result-mafia", isMafia);
        answer.classList.toggle("detective-result-not-mafia", !isMafia);
    }

    overlay.style.display = "flex";

    // Restart the entrance/progress animation cleanly every investigation.
    const card = overlay.querySelector(".detective-result-card");
    const progress = overlay.querySelector(".detective-result-progress-bar");

    if (card) {
        card.classList.remove("detective-result-visible");
        void card.offsetWidth;
        card.classList.add("detective-result-visible");
    }

    if (progress) {
        progress.classList.remove("detective-result-progress-running");
        void progress.offsetWidth;
        progress.classList.add("detective-result-progress-running");
    }

    // The server advances the night turn after the same 3-second window.
    detectiveResultPopupTimer = setTimeout(() => {
        hideDetectiveResultPopup();
    }, 3000);
}

function hideDetectiveResultPopup() {
    clearTimeout(detectiveResultPopupTimer);
    detectiveResultPopupTimer = null;

    const overlay = $("detectiveResultPopup");
    if (overlay) {
        overlay.style.display = "none";
    }
}

/* =========================================================
   DETECTIVE
========================================================= */

socket.on(
    "detectiveResult",
    data => {

        stopLast10Sound();
        detectiveResultMessage =
            `🔎 ${data.playerName}: ${data.result}`;

        if ($("actionMessage")) {
            $("actionMessage").textContent =
                "🔎 Investigation complete. Review your private report.";
        }

        // Prevent another click while the 3-second private report is visible.
        hide("targetPlayer");
        hide("confirmAction");

        showDetectiveResultPopup(
            data?.playerName,
            data?.result
        );
    }
);

/* =========================================================
   ROLE CHANGED
========================================================= */

socket.on(
    "roleChanged",
    data => {

        myRole =
            data.role;

        updateRoleDisplay(data.role);

        if ($("actionMessage")) {

            $("actionMessage").textContent =
                "👶 You are now Baby Mafia! You can kill with the Mafia.";
        }

        renderMafiaChat();
    }
);

/* =========================================================
   DEATH ROLE REVEAL
   Laptop/desktop and mobile/tablet use separate supplied images.
========================================================= */

function ensureDeathRevealOverlay() {
    let overlay = $("deathRevealOverlay");
    if (overlay) return overlay;

    overlay = document.createElement("div");
    overlay.id = "deathRevealOverlay";
    overlay.innerHTML = `
        <div class="death-reveal-card">
            <div class="death-reveal-title">YOU ARE DEATH</div>
            <div class="death-reveal-photo-wrap">
                <img id="deathRevealPhoto" src="" alt="Death reveal">
            </div>
            <div class="death-reveal-names" id="deathRevealNames"></div>
        </div>
    `;
    document.body.appendChild(overlay);

    /*
       The death screen is intentionally NOT closable.
       Once this player is dead, it stays over the game until GAME OVER
       (or the host restarts the game).
    */
    return overlay;
}

function showDeathRevealOverlay(names, eliminatedPlayerIds = []) {
    if (!Array.isArray(names) || !names.length) return;

    /*
       IMPORTANT: the death reveal is PRIVATE.
       Everyone may receive the public death result (and death sound),
       but only the player whose socket ID was eliminated sees this screen.
    */
    if (
        !Array.isArray(eliminatedPlayerIds) ||
        !eliminatedPlayerIds.includes(socket.id)
    ) {
        /*
           If this player was already killed earlier, NEVER hide their
           death screen just because another player was eliminated later.
        */
        if (deathScreenLocked) return;

        hideDeathRevealOverlay();
        return;
    }

    deathScreenLocked = true;

    const overlay = ensureDeathRevealOverlay();
    const photo = $("deathRevealPhoto");
    const nameBox = $("deathRevealNames");
    if (photo) {
        photo.src = getDeathImage();
        photo.alt = "You Are Death";
    }
    if (nameBox) {
        nameBox.textContent = names.join(", ");
    }
    overlay.style.display = "flex";
}

function hideDeathRevealOverlay(force = false) {
    /* Locked death screens can only be closed by GAME OVER/restart. */
    if (deathScreenLocked && !force) return;

    const overlay = $("deathRevealOverlay");
    if (overlay) overlay.style.display = "none";
}

function keepDeadPlayerOnDeathScreen(data) {
    if (!data || data.phase === "gameover" || data.phase === "lobby") {
        return false;
    }

    const me = Array.isArray(data.players)
        ? data.players.find(player => player.id === socket.id)
        : null;

    if (!me || me.alive !== false) {
        return false;
    }

    deathScreenLocked = true;

    const overlay = ensureDeathRevealOverlay();
    const photo = $("deathRevealPhoto");
    const nameBox = $("deathRevealNames");

    if (photo) {
        photo.src = getDeathImage();
        photo.alt = "You Are Death";
    }

    if (nameBox) {
        nameBox.textContent = me.name || "You";
    }

    overlay.style.display = "flex";
    return true;
}

/* =========================================================
   MORNING RESULT
========================================================= */

socket.on(
    "morningResult",
    data => {

        const names =
            Array.isArray(data?.eliminatedPlayers)
                ? data.eliminatedPlayers
                : [];

        const eliminatedPlayerIds =
            Array.isArray(data?.eliminatedPlayerIds)
                ? data.eliminatedPlayerIds
                : [];

        /* Sound #2 — everyone hears that someone died */
        if (names.length) {
            playGameSound(gameSounds.death);
        }

        /* Death screen — ONLY the eliminated player sees it */
        if (names.length) {
            showDeathRevealOverlay(
                names,
                eliminatedPlayerIds
            );
        } else {
            hideDeathRevealOverlay();
        }

        if ($("actionMessage")) {

            if (names.length) {

                $("actionMessage").textContent =
                    "☀️ Eliminated: " +
                    names.join(", ");

            } else {

                $("actionMessage").textContent =
                    "☀️ Nobody was eliminated.";
            }
        }
    }
);

/* =========================================================
   VOTE CONFIRMED
========================================================= */

socket.on(
    "voteConfirmed",
    name => {

        hasVoted = true;

        const button =
            $("confirmAction");

        if (button) {

            button.disabled =
                true;

            button.textContent =
                "🗳️ VOTE";
        }

        if ($("actionMessage")) {

            $("actionMessage").textContent =
                `🗳️ You voted for ${name}. Waiting for everyone else...`;
        }
    }
);

/* =========================================================
   VOTE RESULT
========================================================= */

socket.on(
    "voteResult",
    data => {
        hasVoted = false;

        const eliminated = Array.isArray(data?.eliminatedPlayers)
            ? data.eliminatedPlayers
            : [];

        const eliminatedPlayerIds =
            Array.isArray(data?.eliminatedPlayerIds)
                ? data.eliminatedPlayerIds
                : [];

        /* Sound #2 — everyone hears that someone died */
        if (eliminated.length) {
            playGameSound(gameSounds.death);
        }

        /* Death screen — ONLY the eliminated player sees it */
        if (eliminated.length) {
            showDeathRevealOverlay(
                eliminated,
                eliminatedPlayerIds
            );
        } else {
            hideDeathRevealOverlay();
        }

        const isTie = data?.tie === true;

        if (isTie) {
            const tied = Array.isArray(data?.tiedPlayers)
                ? data.tiedPlayers.join(" and ")
                : "the top players";

            if ($("actionMessage")) {
                $("actionMessage").textContent =
                    `🤝 Vote tied between ${tied}. Nobody was eliminated.`;
            }

            announcement(
                `🤝 Vote tied between ${tied}. Nobody was eliminated.`,
                "info"
            );
        } else if (eliminated.length === 0) {
            if ($("actionMessage")) {
                $("actionMessage").textContent =
                    "🤝 Nobody received a valid vote. Nobody was eliminated.";
            }

            announcement(
                "🤝 Nobody received a valid vote. Nobody was eliminated.",
                "info"
            );
        } else {
            if ($("actionMessage")) {
                $("actionMessage").textContent =
                    `🗳️ ${eliminated.join(", ")} was eliminated by the vote.`;
            }

            announcement(
                `🗳️ ${eliminated.join(", ")} was eliminated by the vote.`,
                "danger"
            );
        }

        hide("targetPlayer");
        hide("confirmAction");
    }
);

/* =========================================================
   PUBLIC CHAT
========================================================= */

function setupPublicChat() {

    $("sendMessage")?.addEventListener(
        "click",
        sendPublic
    );

    $("chatInput")?.addEventListener(
        "keydown",
        e => {

            if (e.key === "Enter") {
                sendPublic();
            }
        }
    );
}

function sendPublic() {

    const input =
        $("chatInput");

    if (!input) return;

    const message =
        input.value.trim();

    if (!message) return;

    socket.emit(
        "sendMessage",
        {
            roomCode,
            message
        }
    );

    input.value = "";
}

/* =========================================================
   PUBLIC CHAT MESSAGE
========================================================= */

socket.on(
    "newMessage",
    data => {

        const container =
            $("chatMessages");

        if (!container) return;

        const div =
            document.createElement("div");

        div.className =
            "chat-message";

        div.textContent =
            `${data.playerName}: ${data.message}`;

        container.appendChild(div);

        container.scrollTop =
            container.scrollHeight;
    }
);

/* =========================================================
   MAFIA CHAT
========================================================= */

function renderMafiaChat() {

    const allowed =
        isMafiaTeamClient(
            myRole
        );

    if (allowed) {

        show("mafiaChatBox");

    } else {

        hide("mafiaChatBox");
    }
}

function setupMafiaChat() {

    $("sendMafiaMessage")
        ?.addEventListener(
            "click",
            sendMafia
        );

    $("mafiaChatInput")
        ?.addEventListener(
            "keydown",
            e => {

                if (e.key === "Enter") {
                    sendMafia();
                }
            }
        );
}

function sendMafia() {

    const input =
        $("mafiaChatInput");

    if (!input) return;

    const message =
        input.value.trim();

    if (!message) return;

    socket.emit(
        "sendMafiaMessage",
        {
            roomCode,
            message
        }
    );

    input.value = "";
}

/* =========================================================
   MAFIA CHAT MESSAGE
========================================================= */

socket.on(
    "newMafiaMessage",
    data => {

        const container =
            $("mafiaChatMessages");

        if (!container) return;

        const div =
            document.createElement("div");

        div.className =
            "chat-message";

        div.textContent =
            `${data.playerName}: ${data.message}`;

        container.appendChild(div);

        container.scrollTop =
            container.scrollHeight;
    }
);

/* =========================================================
   ERRORS
========================================================= */


/* =========================================================
   REJOIN / HOST APPROVAL EVENTS
========================================================= */

socket.on("rejoinPending", data => {
    pendingRejoinRequestId = data?.requestId || null;
    setRejoinStatus(
        data?.message || "Join request sent. Waiting for the host…",
        "waiting"
    );
});

socket.on("joinRequest", data => {
    /*
       The server sends this event only to the current host.
       Do not gate it on the local `isHost` flag: a dead host
       can still be the host, and the full-screen death UI can
       otherwise leave that flag temporarily stale.
    */
    showJoinRequestPopup(data);
});

socket.on("rejoinApproved", data => {
    roomCode = data?.roomCode || roomCode;
    pendingRejoinRequestId = null;
    setRejoinStatus(data?.message || "Approved!", "success");

    isHost = data?.hostId === socket.id || isHost;
    setScreen(data?.phase && data.phase !== "lobby" ? "gameScreen" : "lobby");

    // The server will immediately send lobby/game information.
    announcement(
        "🔄 Rejoin approved. You are back in your old slot.",
        "success"
    );
});

socket.on("rejoinDeclined", data => {
    pendingRejoinRequestId = null;
    setRejoinStatus(
        data?.message || "Your join request was declined.",
        "error"
    );
});

socket.on("rejoinError", message => {
    pendingRejoinRequestId = null;
    setRejoinStatus(message || "Could not send the join request.", "error");
});

socket.on("gameInformation", data => {
    if (data?.stats) {
        gameStats = {
            ...gameStats,
            ...data.stats
        };
    }
});

socket.on(
    "joinError",
    msg => {

        alert(msg);

        if ($("joinRoomScreen")) {

            setScreen(
                "joinRoomScreen"
            );
        }
    }
);

socket.on(
    "gameError",
    msg => {

        alert(msg);
    }
);

socket.on(
    "actionError",
    msg => {

        if (
            currentPhase === "day"
        ) {

            hasVoted = false;

            if ($("confirmAction")) {

                $("confirmAction").disabled =
                    false;

                $("confirmAction").textContent =
                    "🗳️ VOTE";
            }
        }

        alert(msg);
    }
);
/* =========================================================
   GAME OVER EVENT
========================================================= */

socket.on(
    "gameOver",
    data => {

        console.log(
            "🔥 GAME OVER RECEIVED:",
            data
        );

        if (!data) return;

        currentPhase = "gameover";
        resetRoleRevealSequence();
        hideNightTurnOverlay();
        deathScreenLocked = false;
        hideDeathRevealOverlay(true);
        hideDetectiveResultPopup();

        gameStats = {
            ...gameStats,
            ...(data.stats || {})
        };

        showGameOverMenu(
            data.winner,
            data.message,
            gameStats
        );
    }
);
/* =========================================================
   GAME OVER
========================================================= */
function showGameOverMenu(winner, message, stats = gameStats) {

    const overlay = $("gameOverOverlay");
    const messageBox = $("gameOverMessage");
    const winnerLogo = $("winnerLogo");

    let statsBox = $("gameOverStats");
    if (!statsBox && overlay) {
        statsBox = document.createElement("div");
        statsBox.id = "gameOverStats";
        const box = $("gameOverBox");
        if (box) {
            const restartButton = $("restartGame");
            if (restartButton) box.insertBefore(statsBox, restartButton);
            else box.appendChild(statsBox);
        }
    }

    if (!overlay) {
        console.error("gameOverOverlay NOT FOUND!");
        return;
    }

    /* WINNER LOGO */
    if (winnerLogo) {

        if (winner === "Mafia Team") {
            winnerLogo.src = "/mafia-win.png";
        }

        else if (winner === "Jester") {
            winnerLogo.src = "/jester-win.png";
        }

        else if (winner === "Civilians") {
            winnerLogo.src = "/civilian-win.png";
        }
    }

    /* MESSAGE */
    if (messageBox) {
        messageBox.textContent =
            `${winner}: ${message}`;
    }

    if (statsBox) {
        const safeStats = stats || {};
        statsBox.innerHTML = `
            <div class="game-over-stats-title">GAME STATISTICS</div>
            <div class="game-over-stats-grid">
                <div class="game-stat-card"><span>⏱</span><strong>${Number(safeStats.totalRounds || 0)}</strong><small>Total Rounds</small></div>
                <div class="game-stat-card"><span>☠</span><strong>${Number(safeStats.mafiaKills || 0)}</strong><small>Mafia Kills</small></div>
                <div class="game-stat-card"><span>🩺</span><strong>${Number(safeStats.successfulSaves || 0)}</strong><small>Successful Saves</small></div>
                <div class="game-stat-card"><span>🔎</span><strong>${Number(safeStats.detectiveInvestigations || 0)}</strong><small>Investigations</small></div>
                <div class="game-stat-card"><span>🗳</span><strong>${Number(safeStats.playersVotedOut || 0)}</strong><small>Players Voted Out</small></div>
            </div>
        `;
    }

    /* SHOW GAME OVER */
    overlay.style.display = "flex";

    /* RESTART BUTTON */
    if (isHost) {
        show("restartGame");
    } else {
        hide("restartGame");
    }
}

 
/* =========================================================
   RESTART GAME
========================================================= */

function restartGame() {

    if (!roomCode) {

        alert(
            "Room code is missing!"
        );

        return;
    }

    if (!isHost) {

        alert(
            "Only the host can restart the game!"
        );

        return;
    }

    socket.emit(
        "restartGame",
        {
            roomCode
        }
    );
}

function setupRestartButton() {

    $("restartGame")?.addEventListener(
        "click",
        restartGame
    );
}
function setupBackHomeGameOver() {

    $("backHomeGameOver")?.addEventListener(
        "click",
        () => {

            hide("gameOverOverlay");

            roomCode = "";
            myRole = "";
            players = [];
            currentPhase = "";
            resetRoleRevealSequence();
            hasVoted = false;
            isHost = false;
            updatePhaseTimer(null, "");
            hideNightTurnOverlay();
            deathScreenLocked = false;
            hideDeathRevealOverlay(true);

            setScreen("homeScreen");
        }
    );
}
/* =========================================================
   GAME RESTARTED
========================================================= */
socket.on(
    "gameRestarted",
    data => {

        /* =========================
           RESET ROOM DATA
        ========================= */

        players =
            Array.isArray(data.players)
                ? data.players.slice()
                : [];

        roomCode =
            data.roomCode ||
            roomCode;

        window.currentHostId =
            data.hostId || "";

        isHost =
            socket.id ===
            window.currentHostId;

        /* =========================
           RESET OLD GAME STATE
        ========================= */

        myRole = "";

        currentPhase = "lobby";
        resetRoleRevealSequence();

        hasVoted = false;
        updatePhaseTimer(null, "");
        hideNightTurnOverlay();
        deathScreenLocked = false;
        hideDeathRevealOverlay(true);

        /* Clear selected targets/actions */

        if (typeof selectedTarget !== "undefined") {
            selectedTarget = null;
        }

        if (typeof selectedAction !== "undefined") {
            selectedAction = null;
        }

        /* =========================
           RETURN TO LOBBY
        ========================= */
        setScreen("lobby");

/*
   Hide old Game Over screen.
*/

hide("gameOverOverlay");

if ($("gameOverMessage")) {
    $("gameOverMessage").textContent = "";
}

/*
   Hide restart button.
*/

hide("restartGame");       
        
        /* =========================
           UPDATE HOST UI
        ========================= */

        updateHostUI();

        /* =========================
           UPDATE ROOM CODE
        ========================= */

        if ($("displayRoomCode")) {

            $("displayRoomCode").textContent =
                roomCode;
        }

        /* =========================
           CLEAR OLD ANNOUNCEMENT
        ========================= */

        announcement(
            "🔄 Game restarted! Everyone is back in the lobby.",
            "restart"
        );
    }
);
        


/* =========================================================
   SOCKET CONNECT
========================================================= */

socket.on(
    "connect",
    () => {

        console.log(
            "Connected:",
            socket.id
        );

        if (roomCode) {

            isHost =
                socket.id ===
                getCurrentHostId();

            updateHostUI();
        }
    }
);

/* =========================================================
   SOCKET DISCONNECT
========================================================= */

socket.on(
    "disconnect",
    () => {

        console.log(
            "Disconnected from server."
        );
    }
);

/* =========================================================
   LAST-10-SECONDS HEARTBEAT STYLE
========================================================= */
function addNightHeartbeatStyle() {
    if ($("mafiaWarsSoundStyles")) return;

    const style = document.createElement("style");
    style.id = "mafiaWarsSoundStyles";
    style.textContent = `
        .night-turn-timer-warning {
            color: #ff1f1f !important;
            border-color: #ff1f1f !important;
            text-shadow: 0 0 8px rgba(255,0,0,.8), 0 0 18px rgba(255,0,0,.5);
        }

        .night-turn-heartbeat {
            animation: mafiaHeartbeat .8s infinite;
        }

        @keyframes mafiaHeartbeat {
            0% { transform: scale(1); }
            15% { transform: scale(1.15); }
            30% { transform: scale(1); }
            45% { transform: scale(1.10); }
            60% { transform: scale(1); }
            100% { transform: scale(1); }
        }
    `;

    document.head.appendChild(style);
}

/* =========================================================
   INITIALIZE
========================================================= */

document.addEventListener(
    "DOMContentLoaded",
    () => {

        createRoomScreens();

        setupHomeButtons();

        setupCopyButton();

        setupRoleInputs();

        setupGrandmaSettings();

        setupStartGame();

        setupMainAction();

        setupGrandmafia();

        setupCupid();

        setupPublicChat();

        setupMafiaChat();

        setupRestartButton();
        
        setupBackHomeGameOver();

        // NOTE: this was defined but never called, which is why the
        // Leave Room button previously did nothing when clicked.
        setupLeaveRoomButton();

        /*
           Make announcement box immediately.
        */

        ensureAnnouncementBox();
        ensureNightTurnOverlay();
        addNightHeartbeatStyle();

        /*
           Hide it until an announcement happens.
        */

        const box =
            $("announcementBox");

        if (box) {
            box.style.display = "none";
        }

        console.log(
            "Mafia Wars client loaded."
        );
    }

)

socket.on("gameOver", () => {
    currentPhase = "gameover";
});


/* =========================================================
   ACCOUNTS: SIGN UP / LOGIN / SKIP + RANKS
   Added as a separate block so the existing game code is untouched.
========================================================= */

const authState = {
    username: null,     // null = Skip / guest
    token: null,
    entered: false,     // true once the player passed the first screen
    mode: "signup"
};

try {
    authState.token = localStorage.getItem("mafiaWarsToken") || null;
} catch (_) {}

function saveAuthToken(token) {
    authState.token = token || null;
    try {
        if (token) localStorage.setItem("mafiaWarsToken", token);
        else localStorage.removeItem("mafiaWarsToken");
    } catch (_) {}
}

function setAuthMessage(text, type = "") {
    const box = $("authMessage");
    if (!box) return;
    box.textContent = text || "";
    box.className = "auth-message" + (type ? " " + type : "");
}

function setAuthBusy(busy) {
    const button = $("authSubmitBtn");
    if (button) button.disabled = Boolean(busy);
}

function showAuthToast(text) {
    const toast = document.createElement("div");
    toast.className = "auth-toast";
    toast.textContent = text;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4500);
}

function setAccountInfoOpen(open) {
    const info = $("accountInfo");
    const button = $("accountChipButton");
    if (!info || !button) return;

    const canOpen = Boolean(authState.username) && open;
    info.style.display = canOpen ? "" : "none";
    button.textContent = authState.username ? (canOpen ? "−" : "+") : "SIGN IN";
    button.classList.toggle("account-plus", Boolean(authState.username));

    if (canOpen) {
        // Refresh the player's permanent points every time ACCOUNT INFO opens.
        socket.emit("getMyAccountStats");
    }
}

function updateAccountChip() {
    const text = $("accountChipText");
    const name = $("accountInfoName");
    if (!text) return;

    if (authState.username) {
        text.textContent = "👤 Account";
        if (name) {
            name.textContent = authState.username;
            appendUserBadge(name, myBadge);
        }
    } else {
        text.textContent = "👻 Guest";
        if (name) name.textContent = "";
    }

    setAccountInfoOpen(false);
}

function doLogout() {
    socket.emit("logout", { token: authState.token });
    authState.username = null;
    saveAuthToken(null);
    authState.entered = false;
    updateAccountChip();
    showAuthMenu();
    setScreen("authScreen");
}

function showAuthMenu() {
    $("authMenu").style.display = "";
    $("authForm").style.display = "none";
    setAuthMessage("");
}

function showAuthForm(mode) {
    authState.mode = mode;
    $("authMenu").style.display = "none";
    $("authForm").style.display = "";
    $("authFormTitle").textContent = mode === "signup" ? "Sign Up" : "Login";
    $("authSubmitBtn").textContent = mode === "signup" ? "MAKE ACCOUNT" : "LOGIN";
    $("authPassword").setAttribute(
        "autocomplete",
        mode === "signup" ? "new-password" : "current-password"
    );
    $("authUsername").value = "";
    $("authPassword").value = "";
    $("authPassword").type = "password";
    if ($("authPin")) {
        $("authPin").value = "";
        $("authPin").type = "password";
    }
    if ($("authTogglePassword")) {
        $("authTogglePassword").textContent = "👁";
        $("authTogglePassword").title = "Show password";
    }
    setAuthMessage("");
    setAuthBusy(false);
    setTimeout(() => $("authUsername")?.focus(), 60);
}

function submitAuth() {
    const username = $("authUsername").value.trim();
    const password = $("authPassword").value;
    const pin = $("authPin")?.value || "";

    if (!username || !password || !pin) {
        setAuthMessage("Enter your username, password and PIN.", "error");
        return;
    }

    if (authState.mode === "signup" && !/^[A-Za-z0-9_]{3,20}$/.test(username)) {
        setAuthMessage("Username: 3-20 letters, numbers or _ only.", "error");
        return;
    }

    if (authState.mode === "signup" && password.length < 6) {
        setAuthMessage("Password must be at least 6 characters.", "error");
        return;
    }

    if (!/^\d{4,8}$/.test(pin)) {
        setAuthMessage("PIN must be 4-8 digits.", "error");
        return;
    }

    setAuthBusy(true);
    setAuthMessage(authState.mode === "signup" ? "Making your account..." : "Logging in...", "waiting");

    socket.emit(authState.mode === "signup" ? "signUp" : "login", { username, password, pin });
}

/* Fill the name box with the account name (only if it is empty). */
function prefillAccountNames() {
    if (!authState.username) return;

    ["createPlayerName", "joinPlayerName", "quickStartPlayerName", "rejoinPlayerName"]
        .forEach(id => {
            const input = $(id);
            if (input && !input.value.trim()) input.value = authState.username;
        });
}

socket.on("authResult", data => {

    if (!data || !data.ok) {

        // A saved session that is no longer valid (for example after a server restart).
        if (data && data.resume) {
            const hadAccount = Boolean(authState.username);
            saveAuthToken(null);

            if (authState.entered && hadAccount) {
                authState.username = null;
                updateAccountChip();
                showAuthToast("Your login expired. Sign in again to keep saving stats.");
            }
            return;
        }

        setAuthBusy(false);
        setAuthMessage((data && data.error) || "Something went wrong.", "error");
        return;
    }

    if (data.guest) {
        authState.username = null;
        saveAuthToken(null);
    } else {
        authState.username = data.username;
        saveAuthToken(data.token);
    }

    updateAccountChip();
    setAuthBusy(false);

    if (!data.silent) {
        authState.entered = true;
        showAuthMenu();
        setScreen("homeScreen");
        prefillAccountNames();
    }
});

// Log the new socket back in after a reconnect or a page refresh.
socket.on("connect", () => {
    if (authState.token) {
        socket.emit("resumeSession", {
            token: authState.token,
            silent: authState.entered
        });
    }
});

/* ---------- Ranks ---------- */

let ranksCache = [];

function renderRanks(list) {
    const box = $("ranksList");
    const empty = $("ranksEmpty");
    if (!box) return;

    if (Array.isArray(list)) ranksCache = list;

    box.innerHTML = "";

    if (ranksCache.length === 0) {
        if (empty) empty.style.display = "";
        return;
    }

    if (empty) empty.style.display = "none";

    const query = ($("ranksSearch")?.value || "").trim().toLowerCase();
    const shown = ranksCache.filter(entry =>
        !query || String(entry.username).toLowerCase().includes(query)
    );

    if (shown.length === 0) {
        const none = document.createElement("div");
        none.className = "ranks-empty";
        none.textContent = "No players found.";
        box.appendChild(none);
        return;
    }

    shown.forEach(entry => {
        const row = document.createElement("div");
        row.className = "rank-row" + (entry.rank <= 3 ? " rank-top-" + entry.rank : "");

        const position = document.createElement("span");
        position.className = "rank-position";
        position.textContent = "#" + entry.rank;

        const name = document.createElement("span");
        name.className = "rank-name";
        name.textContent = entry.username;
        appendUserBadge(name, entry.badge);

        const details = document.createElement("button");
        details.type = "button";
        details.className = "rank-details-button";
        details.textContent = "DETAILS";
        details.addEventListener("click", () => {
            socket.emit("getPlayerStats", { username: entry.username });
        });

        const points = document.createElement("span");
        points.className = "rank-points";
        points.textContent = `${Number(entry.points) || 0} points`;

        row.append(position, name, points, details);
        box.appendChild(row);
    });
}

socket.on("ranksData", renderRanks);
$("ranksSearch")?.addEventListener("input", () => renderRanks());

socket.on("playerStatsData", data => {
    if (!data || !data.ok) return;

    $("ranksDetailsName").textContent = data.username;
    appendUserBadge($("ranksDetailsName"), data.badge);
    $("statKills").textContent = data.stats.kills || 0;
    $("statSaves").textContent = data.stats.saves || 0;
    $("statDetects").textContent = data.stats.detects || 0;
    $("statCivilianVotes").textContent = data.stats.civilianVotes || 0;
    $("statJesterWins").textContent = data.stats.jesterWins || 0;
    $("statMafiaWins").textContent = data.stats.mafiaWins || 0;
    $("statCivilianWins").textContent = data.stats.civilianWins || 0;

    $("ranksDetailsOverlay").style.display = "";
});

/* ---------- Account points card ---------- */

socket.on("myAccountStatsData", data => {
    if (!data || !data.ok) return;

    const stats = data.stats || {};
    $("accountPointsTotal").textContent = Number(data.points) || 0;
    $("accountStatKills").textContent = Number(stats.kills) || 0;
    $("accountStatSaves").textContent = Number(stats.saves) || 0;
    $("accountStatDetects").textContent = Number(stats.detects) || 0;
    $("accountStatCivilianVotes").textContent = Number(stats.civilianVotes) || 0;
    $("accountStatJesterWins").textContent = Number(stats.jesterWins) || 0;
    $("accountStatMafiaWins").textContent = Number(stats.mafiaWins) || 0;
    $("accountStatCivilianWins").textContent = Number(stats.civilianWins) || 0;
});

/* ---------- Account password / delete security ---------- */

let accountSecurityAction = null;

function openAccountSecurity(action) {
    const overlay = $("accountSecurityOverlay");
    const pin = $("accountSecurityPin");
    const title = $("accountSecurityTitle");
    const text = $("accountSecurityText");
    const message = $("accountSecurityMessage");
    const confirm = $("accountSecurityConfirm");
    if (!overlay || !pin) return;

    accountSecurityAction = action;
    const deleting = action === "delete";
    title.textContent = deleting ? "DELETE ACCOUNT" : "ENTER PIN";
    text.textContent = deleting
        ? "Enter your PIN to permanently delete your account."
        : "Enter your PIN to reveal your password.";
    confirm.textContent = deleting ? "DELETE ACCOUNT" : "SHOW PASSWORD";
    message.textContent = "";
    message.className = "account-security-message";
    pin.value = "";
    overlay.style.display = "flex";
    setTimeout(() => pin.focus(), 50);
}

function closeAccountSecurity() {
    const overlay = $("accountSecurityOverlay");
    if (overlay) overlay.style.display = "none";
    accountSecurityAction = null;
}

function submitAccountSecurity() {
    const pin = $("accountSecurityPin")?.value || "";
    const message = $("accountSecurityMessage");
    if (!/^\d{4,8}$/.test(pin)) {
        if (message) {
            message.textContent = "PIN must be 4-8 digits.";
            message.className = "account-security-message error";
        }
        return;
    }

    if (accountSecurityAction === "delete") {
        socket.emit("deleteMyAccount", { pin });
    } else {
        socket.emit("showMyPassword", { pin });
    }
}

socket.on("showMyPasswordResult", data => {
    if (!data?.ok) {
        const message = $("accountSecurityMessage");
        if (message) {
            message.textContent = data?.error || "Wrong PIN.";
            message.className = "account-security-message error";
        }
        return;
    }

    closeAccountSecurity();
    const password = $("accountPasswordMasked");
    if (password) {
        password.textContent = data.password;
        password.classList.add("account-password-revealed");
    }

    const button = $("accountShowPasswordButton");
    if (button) button.textContent = "🔓 PASSWORD SHOWN";

    setTimeout(() => {
        if (password) {
            password.textContent = "••••••••";
            password.classList.remove("account-password-revealed");
        }
        if (button) button.textContent = "🔒 SHOW PASSWORD";
    }, 10000);
});

socket.on("deleteMyAccountResult", data => {
    if (!data?.ok) {
        const message = $("accountSecurityMessage");
        if (message) {
            message.textContent = data?.error || "Wrong PIN.";
            message.className = "account-security-message error";
        }
        return;
    }

    closeAccountSecurity();
    authState.username = null;
    saveAuthToken(null);
    authState.entered = false;
    updateAccountChip();
    showAuthToast("Your account has been deleted.");
    showAuthMenu();
    setScreen("authScreen");
});

/* ---------- Buttons ---------- */

document.addEventListener("DOMContentLoaded", () => {

    $("authSignUpBtn")?.addEventListener("click", () => showAuthForm("signup"));
    $("authLoginBtn")?.addEventListener("click", () => showAuthForm("login"));
    $("authBackBtn")?.addEventListener("click", showAuthMenu);
    $("authSubmitBtn")?.addEventListener("click", submitAuth);

    $("authSkipBtn")?.addEventListener("click", () => {
        socket.emit("skipAuth");
    });

    ["authUsername", "authPassword", "authPin"].forEach(id => {
        $(id)?.addEventListener("keydown", event => {
            if (event.key === "Enter") submitAuth();
        });
    });

    $("accountChipButton")?.addEventListener("click", () => {
        if (authState.username) {
            // Account player: "+" opens / closes the account info underneath.
            setAccountInfoOpen($("accountInfo").style.display === "none");
            return;
        }

        // Skip player: SIGN IN goes back to the account screen.
        showAuthMenu();
        setScreen("authScreen");
    });

    $("accountLogoutButton")?.addEventListener("click", doLogout);
    $("accountShowPasswordButton")?.addEventListener("click", () => openAccountSecurity("show"));
    $("accountDeleteButton")?.addEventListener("click", () => openAccountSecurity("delete"));
    $("accountSecurityCancel")?.addEventListener("click", closeAccountSecurity);
    $("accountSecurityConfirm")?.addEventListener("click", submitAccountSecurity);
    $("accountSecurityPin")?.addEventListener("keydown", event => {
        if (event.key === "Enter") submitAccountSecurity();
        if (event.key === "Escape") closeAccountSecurity();
    });
    $("accountSecurityOverlay")?.addEventListener("click", event => {
        if (event.target.id === "accountSecurityOverlay") closeAccountSecurity();
    });

    // Show / hide password
    $("authTogglePassword")?.addEventListener("click", () => {
        const input = $("authPassword");
        const button = $("authTogglePassword");
        if (!input || !button) return;

        const show = input.type === "password";
        input.type = show ? "text" : "password";
        button.textContent = show ? "🙈" : "👁";
        button.title = show ? "Hide password" : "Show password";
        button.setAttribute("aria-label", button.title);
        input.focus();
    });

    $("ranksButton")?.addEventListener("click", () => {
        socket.emit("getRanks");
        $("ranksDetailsOverlay").style.display = "none";
        setScreen("ranksScreen");
    });

    $("backFromRanks")?.addEventListener("click", () => setScreen("homeScreen"));
    $("closeRanksDetails")?.addEventListener("click", () => {
        $("ranksDetailsOverlay").style.display = "none";
    });

    $("ranksDetailsOverlay")?.addEventListener("click", event => {
        if (event.target.id === "ranksDetailsOverlay") {
            $("ranksDetailsOverlay").style.display = "none";
        }
    });

    // Account players get their name filled in on the Create / Join / Quick Start / Rejoin pages.
    document.addEventListener("click", event => {
        const button = event.target.closest("button");
        if (!button) return;

        if (["createRoom", "joinRoom", "quickStart", "rejoinHomeButton"].includes(button.id)) {
            setTimeout(prefillAccountNames, 0);
        }
    });

    updateAccountChip();
});


/* =========================================================
   BADGES (Owner / Admin / Member)
   Shown next to names everywhere except once the game starts.
========================================================= */

const BADGE_LABELS = { owner: "Owner", admin: "Admin", member: "Member" };
const BADGE_STORAGE_KEY = "mafiaWarsBadgeKey";
let myBadge = "member";

function normalizeBadge(badge) {
    return BADGE_LABELS[badge] ? badge : "member";
}

function userBadgeHtml(badge) {
    const b = normalizeBadge(badge);
    return `<span class="user-badge ${b}">${BADGE_LABELS[b]}</span>`;
}

function appendUserBadge(element, badge) {
    if (!element) return;
    const b = normalizeBadge(badge);
    const span = document.createElement("span");
    span.className = `user-badge ${b}`;
    span.textContent = BADGE_LABELS[b];
    element.appendChild(span);
}

function isGameScreenOpen() {
    const gameScreen = $("gameScreen");
    return Boolean(gameScreen && gameScreen.style.display !== "none");
}

function setMyBadge(badge) {
    myBadge = normalizeBadge(badge);

    const pill = $("roleSelectBadge");
    if (pill) {
        pill.className = `user-badge ${myBadge}`;
        pill.textContent = BADGE_LABELS[myBadge];
    }

    if ($("questionsOverlay")?.style.display === "flex") renderQuestions();

    // Keep the account box name in sync (without closing the box).
    const accountName = $("accountInfoName");
    if (accountName && typeof authState !== "undefined" && authState.username) {
        accountName.textContent = authState.username;
        appendUserBadge(accountName, myBadge);
    }
}

function applyBadgeKey(key, done) {
    socket.emit("badgeApply", { key }, result => {
        const badge = normalizeBadge(result?.badge);

        try {
            if (badge === "member") localStorage.removeItem(BADGE_STORAGE_KEY);
            else localStorage.setItem(BADGE_STORAGE_KEY, key);
        } catch (error) {}

        setMyBadge(badge);
        if (done) done(badge);
    });
}

// Re-apply the saved key whenever the socket (re)connects.
socket.on("connect", () => {
    let saved = "";
    try { saved = localStorage.getItem(BADGE_STORAGE_KEY) || ""; } catch (error) {}
    if (saved) applyBadgeKey(saved);
});

function openRoleSelection() {
    let overlay = $("roleSelectOverlay");

    if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "roleSelectOverlay";
        overlay.className = "qa-overlay qa-center";
        document.body.appendChild(overlay);
    }

    overlay.innerHTML = `
        <div class="qa-modal">
            <h2>Role selection</h2>
            <p>Enter the owner key or admin key. Any other key gives you the Member role.</p>
            <input id="roleKeyInput" type="password" autocomplete="off" placeholder="Enter key">
            <div id="roleKeyResult" class="qa-note"></div>
            <div class="qa-actions">
                <button id="roleKeyCancel" type="button">CANCEL</button>
                <button id="roleKeyConfirm" type="button">CONFIRM</button>
            </div>
        </div>
    `;
    overlay.style.display = "flex";

    const input = $("roleKeyInput");
    input.focus();

    const close = () => { overlay.style.display = "none"; };

    const confirm = () => {
        applyBadgeKey(input.value, badge => {
            $("roleKeyResult").textContent = `Your role is now ${BADGE_LABELS[badge]}.`;
            setTimeout(close, 900);
        });
    };

    $("roleKeyCancel").addEventListener("click", close);
    $("roleKeyConfirm").addEventListener("click", confirm);
    input.addEventListener("keydown", event => { if (event.key === "Enter") confirm(); });
}

/* =========================================================
   HELP CENTER (Ask Question / Suggestion / Report Bug)
   Players can only see their own requests. Admin/Owner can manage all.
========================================================= */

let questionsData = [];
let openQuestionId = null;
let helpMode = "menu";
let helpType = "question";

function qaTimeAgo(t) {
    const minutes = Math.max(1, Math.round((Date.now() - t) / 60000));
    if (minutes < 60) return `${minutes}m ago`;
    if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
    return `${Math.round(minutes / 1440)}d ago`;
}

function helpTypeLabel(type) {
    return type === "suggestion" ? "💡 SUGGESTION" : type === "bug" ? "🐞 REPORT BUG" : "❓ ASK QUESTION";
}

function helpTypeTitle(type) {
    return type === "suggestion" ? "Suggestion" : type === "bug" ? "Report Bug" : "Ask Question";
}

function canManageHelp() {
    return myBadge === "admin" || myBadge === "owner";
}

function openQuestions(mode = "menu", type = "question") {
    let overlay = $("questionsOverlay");

    if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "questionsOverlay";
        overlay.className = "qa-overlay";
        overlay.innerHTML = `<div class="qa-page" id="helpPage"></div>`;
        document.body.appendChild(overlay);
    }

    helpMode = mode;
    helpType = type;
    openQuestionId = null;
    overlay.style.display = "block";
    socket.emit("questionsGet", list => {
        questionsData = Array.isArray(list) ? list : [];
        renderQuestions();
    });
}

function renderQuestions() {
    const page = $("helpPage");
    if (!page) return;

    const question = questionsData.find(q => q.id === openQuestionId);
    const canManage = canManageHelp();

    if (openQuestionId !== null && !question) openQuestionId = null;

    if (openQuestionId !== null && question) {
        renderHelpThread(page, question);
        return;
    }

    if (helpMode === "menu") {
        page.innerHTML = `
            <div class="qa-top">
                <button id="qaBack" type="button">BACK</button>
                <h2>🆘 HELP</h2>
            </div>
            <div class="qa-help-menu">
                <button class="qa-help-choice" data-help-type="question">❓ ASK QUESTION</button>
                <button class="qa-help-choice" data-help-type="suggestion">💡 SUGGESTION</button>
                <button class="qa-help-choice" data-help-type="bug">🐞 REPORT BUG</button>
                ${canManage ? '<button class="qa-help-choice qa-admin-choice" data-help-type="admin">👑 ADMIN / OWNER HELP CENTER</button>' : ""}
            </div>
            <div class="qa-note">Only the account that submitted a request can see its conversation. Only Admin and Owner can answer.</div>
        `;
        $("qaBack").addEventListener("click", closeQuestions);
        page.querySelectorAll("[data-help-type]").forEach(button => {
            button.addEventListener("click", () => {
                const selected = button.dataset.helpType;
                if (selected === "admin") helpMode = "list";
                else { helpMode = "form"; helpType = selected; }
                renderQuestions();
            });
        });
        return;
    }

    if (helpMode === "form") {
        page.innerHTML = `
            <div class="qa-top">
                <button id="qaBack" type="button">BACK</button>
                <h2>${helpTypeLabel(helpType)}</h2>
            </div>
            <div class="qa-form">
                <div class="qa-note">Your account name will be used automatically.</div>
                <input id="qaTitle" maxlength="80" placeholder="${helpTypeTitle(helpType)} title">
                <textarea id="qaBody" maxlength="500" placeholder="Write your ${helpTypeTitle(helpType).toLowerCase()}..."></textarea>
                <div id="qaFormNote" class="qa-note"></div>
                <button id="qaPost" type="button">SEND</button>
            </div>
            <div class="qa-note">You can edit or delete your own request after sending it.</div>
        `;
        $("qaBack").addEventListener("click", () => { helpMode = "menu"; renderQuestions(); });
        $("qaPost").addEventListener("click", () => {
            if (!authState.username) {
                $("qaFormNote").textContent = "Sign in to an account before using Help.";
                return;
            }
            socket.emit("questionsAsk", { type: helpType, title: $("qaTitle").value, body: $("qaBody").value }, result => {
                if (!result?.ok) {
                    $("qaFormNote").textContent = result?.error || "Could not send your request.";
                    return;
                }
                helpMode = "list";
                socket.emit("questionsGet", list => {
                    questionsData = Array.isArray(list) ? list : [];
                    renderQuestions();
                });
            });
        });
        return;
    }

    const list = questionsData.slice().sort((a, b) => b.t - a.t);
    page.innerHTML = `
        <div class="qa-top">
            <button id="qaBack" type="button">BACK</button>
            <h2>${canManage ? "👑 HELP CENTER" : "🆘 MY HELP"}</h2>
        </div>
        ${canManage ? '<div class="qa-note">Admin and Owner can answer and manage requests. They can edit/delete their own answers.</div>' : ""}
        <div id="qaList"></div>
    `;
    $("qaBack").addEventListener("click", () => { helpMode = "menu"; renderQuestions(); });

    const box = $("qaList");
    if (!list.length) {
        box.innerHTML = '<div class="qa-note">No Help requests yet.</div>';
        return;
    }

    box.innerHTML = list.map(q => `
        <div class="qa-card" data-id="${q.id}">
            <div class="qa-type">${helpTypeLabel(q.type)}</div>
            <h3>${escapeHtml(q.title)}${q.replies?.length ? '<span class="qa-answered">Answered</span>' : ""}</h3>
            <div class="qa-line"><span class="qa-author ${normalizeBadge(q.badge)}">${escapeHtml(q.author)}</span>: ${escapeHtml(q.body)}</div>
            <div class="qa-meta">💬 ${q.replies?.length || 0} · ${qaTimeAgo(q.t)}</div>
            ${canManage ? `<div class="qa-card-actions">
                <button type="button" data-help-action="open" data-id="${q.id}">OPEN</button>
                <button type="button" data-help-action="edit" data-id="${q.id}">✏️ EDIT</button>
                <button type="button" data-help-action="delete" data-id="${q.id}">🗑️ DELETE</button>
            </div>` : ""}
        </div>
    `).join("");

    box.addEventListener("click", event => {
        const action = event.target.closest("[data-help-action]");
        const card = event.target.closest(".qa-card");
        if (!card) return;
        const id = Number(card.dataset.id);
        if (action) {
            const type = action.dataset.helpAction;
            if (type === "open") { openQuestionId = id; renderQuestions(); }
            if (type === "edit") editHelpRequest(id);
            if (type === "delete") deleteHelpRequest(id);
            return;
        }
        openQuestionId = id;
        renderQuestions();
    });
}

function editHelpRequest(id) {
    const q = questionsData.find(item => item.id === id);
    if (!q) return;
    const title = prompt("Edit title:", q.title);
    if (title === null) return;
    const body = prompt("Edit message:", q.body);
    if (body === null) return;
    socket.emit("questionsEdit", { id, title, body }, result => {
        if (!result?.ok) alert(result?.error || "Could not edit the request.");
    });
}

function deleteHelpRequest(id) {
    if (!confirm("Delete this Help request?")) return;
    socket.emit("questionsDelete", { id }, result => {
        if (!result?.ok) alert(result?.error || "Could not delete the request.");
        else if (openQuestionId === id) { openQuestionId = null; renderQuestions(); }
    });
}

function editHelpReply(questionId, replyId, currentText) {
    const text = prompt("Edit your answer:", currentText);
    if (text === null) return;
    socket.emit("questionsReplyEdit", { id: questionId, replyId, text }, result => {
        if (!result?.ok) alert(result?.error || "Could not edit the answer.");
    });
}

function deleteHelpReply(questionId, replyId) {
    if (!confirm("Delete your answer?")) return;
    socket.emit("questionsReplyDelete", { id: questionId, replyId }, result => {
        if (!result?.ok) alert(result?.error || "Could not delete the answer.");
    });
}

function renderHelpThread(page, question) {
    const canManage = canManageHelp();
    page.innerHTML = `
        <div class="qa-top">
            <button id="qaThreadBack" type="button">BACK</button>
            <h2>${helpTypeLabel(question.type)}</h2>
        </div>
        <h3 class="qa-thread-title">${escapeHtml(question.title)}</h3>
        <div class="qa-msg">
            <div><span class="qa-author ${normalizeBadge(question.badge)}">${escapeHtml(question.author)}</span> <span class="qa-time">${qaTimeAgo(question.t)}</span></div>
            <p>${escapeHtml(question.body)}</p>
            ${(question.canEdit || canManage) ? `<div class="qa-message-actions">
                <button id="qaEditRequest" type="button">✏️ EDIT</button>
                <button id="qaDeleteRequest" type="button">🗑️ DELETE</button>
            </div>` : ""}
        </div>
        ${question.replies?.length ? question.replies.map(r => `
            <div class="qa-msg qa-reply">
                <div><span class="qa-author ${normalizeBadge(r.badge)}">${escapeHtml(r.author || (r.badge === "owner" ? "Owner" : "Admin"))}</span> <span class="qa-time">${qaTimeAgo(r.t)}</span></div>
                <p>${escapeHtml(r.text)}</p>
                ${(r.canEdit || r.canDelete) ? `<div class="qa-message-actions">
                    ${r.canEdit ? `<button type="button" data-reply-action="edit" data-reply-id="${r.id}" data-reply-text="${escapeHtml(r.text).replace(/"/g, '&quot;')}">✏️ EDIT</button>` : ""}
                    ${r.canDelete ? `<button type="button" data-reply-action="delete" data-reply-id="${r.id}">🗑️ DELETE</button>` : ""}
                </div>` : ""}
            </div>
        `).join("") : '<div class="qa-note">Waiting for an Admin or Owner answer.</div>'}
        ${canManage ? `<textarea id="qaReplyText" maxlength="500" placeholder="Write your answer"></textarea>
            <div id="qaReplyNote" class="qa-note"></div>
            <button id="qaReplySend" type="button">SEND ANSWER</button>` : ""}
    `;

    $("qaThreadBack").addEventListener("click", () => { openQuestionId = null; renderQuestions(); });
    if (question.canEdit || canManage) {
        $("qaEditRequest")?.addEventListener("click", () => editHelpRequest(question.id));
        $("qaDeleteRequest")?.addEventListener("click", () => deleteHelpRequest(question.id));
    }
    page.querySelectorAll("[data-reply-action]").forEach(button => {
        button.addEventListener("click", () => {
            const action = button.dataset.replyAction;
            const replyId = Number(button.dataset.replyId);
            if (action === "edit") editHelpReply(question.id, replyId, button.dataset.replyText || "");
            if (action === "delete") deleteHelpReply(question.id, replyId);
        });
    });
    if (canManage) {
        $("qaReplySend").addEventListener("click", () => {
            socket.emit("questionsReply", { id: question.id, text: $("qaReplyText").value }, result => {
                if (!result?.ok) $("qaReplyNote").textContent = result?.error || "Could not send the answer.";
                else $("qaReplyText").value = "";
            });
        });
    }
}

function closeQuestions() {
    const overlay = $("questionsOverlay");
    if (overlay) overlay.style.display = "none";
    socket.emit("questionsLeave");
}

socket.on("questionsUpdate", list => {
    questionsData = Array.isArray(list) ? list : [];
    if ($("questionsOverlay")?.style.display === "block") renderQuestions();
});

$("roleSelectButton")?.addEventListener("click", openRoleSelection);
$("askQuestionButton")?.addEventListener("click", () => openQuestions("menu"));


/* =========================================================
   SETTINGS / PREFERENCES
   Saved locally per signed-in account (or guest profile).
   Existing game systems are left untouched.
========================================================= */
const SETTINGS_STORAGE_KEY = "mafiaWarsSettingsV1";
const defaultMafiaSettings = {
    theme: "noir",
    uiEffects: true,
    animations: true,
    reduceMotion: false,
    gameNotifications: true,
    questionNotifications: true,
    rankNotifications: true,
    matchNotifications: true,
    masterVolume: 1,
    soundEffectsVolume: 1,
    notificationSoundsVolume: 1
};

function clampAudioSetting(value, fallback = 1) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

function getAudioSettings() {
    const st = loadMafiaSettings();
    return {
        masterVolume: clampAudioSetting(st.masterVolume),
        soundEffectsVolume: clampAudioSetting(st.soundEffectsVolume),
        notificationSoundsVolume: clampAudioSetting(st.notificationSoundsVolume)
    };
}

function applyAudioSettings() {
    const audio = getAudioSettings();
    const sfxVolume = audio.masterVolume * audio.soundEffectsVolume;

    Object.values(gameSounds).forEach(sound => {
        if (!sound) return;
        sound.volume = sfxVolume;
    });

}

function updateAudioSetting(key, value) {
    const st = loadMafiaSettings();
    st[key] = value;
    saveMafiaSettings(st);
    applyAudioSettings();
    renderSettingsPage(settingsView);
}

// Notification sounds use the existing sound library only. No new sound file is added.
function playNotificationSound(sound = gameSounds.button) {
    if (!sound) return;
    const audio = getAudioSettings();
    const volume = audio.masterVolume * audio.notificationSoundsVolume;
    try {
        sound.currentTime = 0;
        sound.volume = volume;
        const promise = sound.play();
        if (promise) promise.catch(() => {});
    } catch (error) {
        console.warn("Notification sound error:", error);
    }
}

function getSettingsProfileKey() {
    try {
        return authState?.username ? `account:${String(authState.username).toLowerCase()}` : "guest";
    } catch (e) {
        return "guest";
    }
}
function loadMafiaSettings() {
    let all = {};
    try { all = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || "{}"); } catch (e) {}
    const key = getSettingsProfileKey();
    return { ...defaultMafiaSettings, ...(all[key] || {}) };
}
function saveMafiaSettings(next) {
    let all = {};
    try { all = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || "{}"); } catch (e) {}
    all[getSettingsProfileKey()] = { ...defaultMafiaSettings, ...next };
    try { localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(all)); } catch (e) {}
}
function applyMafiaSettings() {
    const st = loadMafiaSettings();
    document.body.classList.toggle("settings-reduce-motion", !!st.reduceMotion);
    document.body.classList.toggle("settings-no-effects", !st.uiEffects);
    document.body.classList.toggle("settings-no-animations", !st.animations);
    document.documentElement.dataset.mafiaTheme = st.theme;
    applyAudioSettings();
}
function updateMafiaSetting(key, value) {
    const st = loadMafiaSettings();
    st[key] = value;
    saveMafiaSettings(st);
    applyMafiaSettings();
    renderSettingsPage(settingsView);
}
function settingsHeader(title, back = true) {
    return `<div class="settings-header">
        ${back ? '<button class="settings-back" id="settingsBack" type="button">← BACK</button>' : ""}
        <h2>${title}</h2>
        <button class="settings-close" id="settingsClose" type="button">✕</button>
    </div>`;
}
let settingsView = "main";

function openSettings(view = "main") {
    const overlay = $("settingsOverlay");
    if (!overlay) return;
    settingsView = view;
    applyMafiaSettings();
    overlay.style.display = "flex";
    renderSettingsPage(view);
}
function closeSettings() {
    const overlay = $("settingsOverlay");
    if (overlay) overlay.style.display = "none";
}
function settingsNav(view) {
    settingsView = view;
    renderSettingsPage(view);
}
function renderSettingsPage(view) {
    const page = $("settingsPage");
    if (!page) return;

    // The existing Account controls live in the home markup. When the Account
    // settings page is closed/re-rendered, put those controls back in their
    // original hidden container so the existing account logic remains intact.
    const accountInfo = $("accountInfo");
    const accountChip = $("accountChip");
    if (accountInfo && accountChip && accountInfo.parentElement !== accountChip) {
        accountChip.appendChild(accountInfo);
        accountInfo.style.display = "none";
    }

    const st = loadMafiaSettings();
    const admin = myBadge === "admin" || myBadge === "owner";

    if (view === "main") {
        page.innerHTML = settingsHeader("⚙️ SETTINGS", false) + `
            <div class="settings-grid">
                <button class="settings-option settings-category" data-settings-view="ranks">
                    <span class="settings-icon">🏆</span><span class="settings-copy"><strong>Ranks & Progress</strong><span>Rank, points, statistics and leaderboard</span></span>
                </button>
                <button class="settings-option settings-category" data-settings-view="notifications">
                    <span class="settings-icon">🔔</span><span class="settings-copy"><strong>Notifications</strong><span>Choose which game updates you receive</span></span>
                </button>
                <button class="settings-option settings-category" data-settings-view="sound">
                    <span class="settings-icon">🔊</span><span class="settings-copy"><strong>Sound Settings</strong><span>Master, sound effects and notification levels</span></span>
                </button>
                <button class="settings-option settings-category" id="settingsRanksOption" type="button">
                    <span class="settings-icon">🏆</span><span class="settings-copy"><strong>Ranks</strong><span>Rank, points, statistics and leaderboard</span></span>
                </button>
                <button class="settings-option settings-category" id="settingsRoleOption" type="button">
                    <span class="settings-icon">🎭</span><span class="settings-copy"><strong>Role Selection</strong><span>Choose and view available game roles</span></span>
                </button>
                <button class="settings-option settings-category" id="settingsHelpOption" type="button">
                    <span class="settings-icon">🆘</span><span class="settings-copy"><strong>Help</strong><span>Ask questions, suggestions and report bugs</span></span>
                </button>
                <button class="settings-option settings-category" data-settings-view="account">
                    <span class="settings-icon">👤</span><span class="settings-copy"><strong>Account</strong><span>Open your existing account controls</span></span>
                </button>

            </div>
        `;
    } else if (view === "ranks") {
        page.innerHTML = settingsHeader("🏆 RANKS & PROGRESS") + `
            <div class="settings-card">
                <h3>🏆 My Rank</h3><p id="settingsMyRank">Loading your rank…</p>
            </div>
            <div class="settings-card">
                <h3>📊 My Points</h3><p id="settingsMyPoints">Loading points…</p>
            </div>
            <div class="settings-card">
                <h3>📈 Statistics</h3>
                <div class="settings-stat-grid" id="settingsStatsGrid"><div class="settings-muted">Loading statistics…</div></div>
            </div>
            <div class="settings-card">
                <h3>🥇 Leaderboard</h3>
                <div id="settingsLeaderboard"><div class="settings-muted">Loading leaderboard…</div></div>
            </div>
        `;
        socket.emit("getRanks");
        if (authState?.username) socket.emit("getPlayerStats", { username: authState.username });
    } else if (view === "appearance") {
        page.innerHTML = settingsHeader("🎨 APPEARANCE") + `
            <div class="settings-card">
                <div class="settings-row"><div><strong>Theme</strong><small>Choose the Mafia Wars visual theme.</small></div>
                    <select id="settingsTheme" class="settings-option" style="padding:10px 14px;">
                        <option value="noir" ${st.theme === "noir" ? "selected" : ""}>Noir</option>
                        <option value="blood" ${st.theme === "blood" ? "selected" : ""}>Blood Red</option>
                    </select>
                </div>
                <div class="settings-row"><div><strong>UI Effects</strong><small>Enable hover, glow and interface effects.</small></div><input class="settings-switch" type="checkbox" data-setting="uiEffects" ${st.uiEffects ? "checked" : ""}></div>
                <div class="settings-row"><div><strong>Animations</strong><small>Enable normal interface transitions.</small></div><input class="settings-switch" type="checkbox" data-setting="animations" ${st.animations ? "checked" : ""}></div>
                <div class="settings-row"><div><strong>Reduce Motion</strong><small>Reduce interface movement and transitions.</small></div><input class="settings-switch" type="checkbox" data-setting="reduceMotion" ${st.reduceMotion ? "checked" : ""}></div>
            </div>
        `;
    } else if (view === "notifications") {
        page.innerHTML = settingsHeader("🔔 NOTIFICATIONS") + `
            <div class="settings-card">
                <div class="settings-row"><div><strong>Game Notifications</strong><small>General game events.</small></div><input class="settings-switch" type="checkbox" data-setting="gameNotifications" ${st.gameNotifications ? "checked" : ""}></div>
                <div class="settings-row"><div><strong>Question Answer Notifications</strong><small>Notify when an Admin/Owner answers your question.</small></div><input class="settings-switch" type="checkbox" data-setting="questionNotifications" ${st.questionNotifications ? "checked" : ""}></div>
                <div class="settings-row"><div><strong>Rank/Points Notifications</strong><small>Rank and points changes.</small></div><input class="settings-switch" type="checkbox" data-setting="rankNotifications" ${st.rankNotifications ? "checked" : ""}></div>
                <div class="settings-row"><div><strong>Match Notifications</strong><small>Matchmaking and room events.</small></div><input class="settings-switch" type="checkbox" data-setting="matchNotifications" ${st.matchNotifications ? "checked" : ""}></div>
            </div>
        `;
    } else if (view === "sound") {
        const pct = value => Math.round(clampAudioSetting(value) * 100);
        page.innerHTML = settingsHeader("🔊 SOUND SETTINGS") + `
            <div class="settings-card sound-settings-card">
                <div class="settings-row sound-setting-row">
                    <div><strong>🔊 Master Volume</strong><small>Controls all game audio and notifications.</small></div>
                    <div class="settings-slider-wrap"><input id="settingsMasterVolume" class="settings-range" type="range" min="0" max="100" step="1" value="${pct(st.masterVolume)}"><span id="settingsMasterVolumeValue" class="settings-value">${pct(st.masterVolume)}%</span></div>
                </div>
                <div class="settings-row sound-setting-row">
                    <div><strong>🔊 Sound Effects</strong><small>Controls the existing 4 game sound effects separately.</small></div>
                    <div class="settings-slider-wrap"><input id="settingsSoundEffectsVolume" class="settings-range" type="range" min="0" max="100" step="1" value="${pct(st.soundEffectsVolume)}"><span id="settingsSoundEffectsVolumeValue" class="settings-value">${pct(st.soundEffectsVolume)}%</span></div>
                </div>
                <div class="settings-row sound-setting-row">
                    <div><strong>🔔 Notification Sounds</strong><small>Controls notification sound volume separately. No new sound is added.</small></div>
                    <div class="settings-slider-wrap"><input id="settingsNotificationSoundsVolume" class="settings-range" type="range" min="0" max="100" step="1" value="${pct(st.notificationSoundsVolume)}"><span id="settingsNotificationSoundsVolumeValue" class="settings-value">${pct(st.notificationSoundsVolume)}%</span></div>
                </div>
            </div>
        `;
        const bindAudioSlider = (id, valueId, key) => {
            const input = $(id), value = $(valueId);
            if (!input) return;
            input.addEventListener("input", () => {
                const n = Number(input.value) / 100;
                if (value) value.textContent = `${Math.round(n * 100)}%`;
                const current = loadMafiaSettings();
                current[key] = n;
                saveMafiaSettings(current);
                applyAudioSettings();
            });
        };
        bindAudioSlider("settingsMasterVolume", "settingsMasterVolumeValue", "masterVolume");
        bindAudioSlider("settingsSoundEffectsVolume", "settingsSoundEffectsVolumeValue", "soundEffectsVolume");
        bindAudioSlider("settingsNotificationSoundsVolume", "settingsNotificationSoundsVolumeValue", "notificationSoundsVolume");
    } else if (view === "account") {
        page.innerHTML = settingsHeader("👤 ACCOUNT") + `
            <div class="settings-card settings-account-card">
                <div id="settingsAccountMount"></div>
            </div>
        `;

        const mount = $("settingsAccountMount");
        const accountInfo = $("accountInfo");
        if (mount && accountInfo && authState?.username) {
            mount.appendChild(accountInfo);
            accountInfo.style.display = "";
            setAccountInfoOpen(true);
        } else if (mount) {
            mount.innerHTML = `
                <h3>👻 Guest</h3>
                <p>Sign in or create an account to use your existing Account controls.</p>
                <div style="margin-top:13px">
                    <button class="settings-action" id="settingsSignIn">🔐 SIGN IN / CREATE ACCOUNT</button>
                </div>
            `;
            $("settingsSignIn")?.addEventListener("click", () => {
                closeSettings();
                showAuthMenu();
                setScreen("authScreen");
            });
        }
    } else if (view === "admin") {
        if (!admin) { settingsNav("main"); return; }
        page.innerHTML = settingsHeader("🛡️ ADMINISTRATION") + `
            <div class="settings-admin-note">Server permission checks are still required. Changing the page in the browser does not grant Admin or Owner access.</div>
            <div class="settings-list settings-admin-grid">
                <button class="settings-option" data-admin-action="players">👥 Player Management</button>
                <button class="settings-option" data-admin-action="reports">🚨 Reports</button>
                <button class="settings-option" data-admin-action="questions">📋 Questions Management</button>
                <button class="settings-option" data-admin-action="answer">💬 Answer Questions</button>
                <button class="settings-option" data-admin-action="ranks">🏆 Rank Management</button>
                <button class="settings-option" data-admin-action="roles">🎭 Role Management</button>
                <button class="settings-option" data-admin-action="game">🎮 Game Management</button>
                <button class="settings-option" data-admin-action="logs">📜 Admin Logs</button>
            </div>
        `;
    }

    page.querySelectorAll("[data-settings-view]").forEach(b => b.addEventListener("click", () => settingsNav(b.dataset.settingsView)));
    page.querySelectorAll("[data-setting]").forEach(b => b.addEventListener("change", () => updateMafiaSetting(b.dataset.setting, b.checked)));
    $("settingsTheme")?.addEventListener("change", e => updateMafiaSetting("theme", e.target.value));
    $("settingsBack")?.addEventListener("click", () => settingsNav("main"));
    $("settingsClose")?.addEventListener("click", closeSettings);

    $("settingsRanksOption")?.addEventListener("click", () => {
        closeSettings();
        socket.emit("getRanks");
        $("ranksDetailsOverlay").style.display = "none";
        setScreen("ranksScreen");
    });
    $("settingsRoleOption")?.addEventListener("click", () => {
        closeSettings();
        openRoleSelection();
    });
    $("settingsHelpOption")?.addEventListener("click", () => {
        closeSettings();
        openQuestions("menu");
    });
    page.querySelectorAll("[data-admin-action]").forEach(b => b.addEventListener("click", () => {
        const action = b.dataset.adminAction;
        if (action === "questions" || action === "answer") {
            closeSettings();
            openQuestions("list");
            return;
        }
        alert(`${b.textContent.trim()} is protected by the server and can be connected to your existing admin tools without changing player controls.`);
    }));
}
applyMafiaSettings();
applyAudioSettings();

$("settingsButton")?.addEventListener("click", () => openSettings("main"));
$("settingsOverlay")?.addEventListener("click", event => {
    if (event.target.id === "settingsOverlay") closeSettings();
});

/* Public Questions List / My Questions enhancements */
const originalRenderQuestions = renderQuestions;
renderQuestions = function() {
    const page = $("helpPage");
    if (!page) return;
    const canManage = canManageHelp();
    const question = questionsData.find(q => q.id === openQuestionId);
    if (openQuestionId !== null && question) {
        renderHelpThread(page, question);
        return;
    }
    if (helpMode === "menu") {
        page.innerHTML = `
            <div class="qa-top"><button id="qaBack" type="button">BACK</button><h2>🆘 HELP CENTER</h2></div>
            <div class="qa-help-menu">
                <button class="qa-help-choice" data-help-type="question">❓ ASK QUESTION</button>
                <button class="qa-help-choice" data-help-type="suggestion">💡 SUGGESTION</button>
                <button class="qa-help-choice" data-help-type="bug">🐞 REPORT BUG</button>
                <button class="qa-help-choice" data-help-type="public">📋 QUESTIONS LIST</button>
                <button class="qa-help-choice" data-help-type="mine">📋 MY QUESTIONS</button>
                ${canManage ? '<button class="qa-help-choice qa-admin-choice" data-help-type="admin">🛡️ ADMIN / OWNER</button>' : ""}
            </div>
            <div class="qa-note">Questions List is readable by players. Only Admin/Owner can answer.</div>
        `;
        $("qaBack").addEventListener("click", closeQuestions);
        page.querySelectorAll("[data-help-type]").forEach(button => button.addEventListener("click", () => {
            const selected = button.dataset.helpType;
            if (selected === "public" || selected === "mine" || selected === "admin") helpMode = selected;
            else { helpMode = "form"; helpType = selected; }
            renderQuestions();
        }));
        return;
    }
    if (helpMode === "public" || helpMode === "mine") {
        const list = (helpMode === "mine" ? questionsData.filter(q => q.isMine) : questionsData)
            .slice().sort((a,b) => b.t-a.t);
        page.innerHTML = `
            <div class="qa-top"><button id="qaBack" type="button">BACK</button><h2>${helpMode === "mine" ? "📋 MY QUESTIONS" : "📋 QUESTIONS LIST"}</h2></div>
            <div class="qa-note">${helpMode === "mine" ? "Only questions submitted by your account are shown." : "Players can read submitted questions and Admin/Owner answers. Players cannot answer or edit other players' questions."}</div>
            <div id="qaList"></div>
        `;
        $("qaBack").addEventListener("click", () => { helpMode = "menu"; renderQuestions(); });
        const box = $("qaList");
        if (!list.length) { box.innerHTML = '<div class="qa-note">No questions to show.</div>'; return; }
        box.innerHTML = list.map(q => `
            <div class="qa-card" data-id="${q.id}">
                <div class="qa-type">${helpTypeLabel(q.type)}</div>
                <h3>${escapeHtml(q.title)}${q.replies?.length ? '<span class="qa-answered">Answered</span>' : ""}</h3>
                <div class="qa-line"><span class="qa-author ${normalizeBadge(q.badge)}">${escapeHtml(q.author)}</span>: ${escapeHtml(q.body)}</div>
                ${(q.replies || []).map(r => `<div class="qa-line qa-reply"><span class="qa-author ${normalizeBadge(r.badge)}">${escapeHtml(r.author)}</span>: ${escapeHtml(r.text)}</div>`).join("")}
            </div>
        `).join("");
        box.addEventListener("click", e => {
            const card = e.target.closest(".qa-card");
            if (card) { openQuestionId = Number(card.dataset.id); renderQuestions(); }
        });
        return;
    }
    // Admin view: use the original management list.
    originalRenderQuestions();
};

/* Re-render settings after login/logout so account-scoped preferences remain correct. */
socket.on("authResult", () => {
    setTimeout(() => applyMafiaSettings(), 0);
});

/* Feed existing rank/stat responses into the Settings > Ranks & Progress page. */
socket.on("ranksData", list => {
    const rankEl = $("settingsMyRank");
    const pointsEl = $("settingsMyPoints");
    const board = $("settingsLeaderboard");
    if (!rankEl && !pointsEl && !board) return;

    const rows = Array.isArray(list) ? list : [];
    const me = authState?.username ? rows.find(x => String(x.username).toLowerCase() === String(authState.username).toLowerCase()) : null;
    if (rankEl) rankEl.textContent = me ? `#${me.rank} — ${me.username}` : "Guest players are not ranked.";
    if (pointsEl) pointsEl.textContent = me ? `${Number(me.points) || 0} points` : "Sign in to see account points.";
    if (board) {
        board.innerHTML = rows.slice(0, 10).map(x =>
            `<div class="settings-row"><div><strong>#${x.rank} ${escapeHtml(x.username)}</strong></div><div class="settings-value">${Number(x.points)||0} pts</div></div>`
        ).join("") || '<div class="settings-muted">No ranked accounts yet.</div>';
    }
});
socket.on("playerStatsData", data => {
    const grid = $("settingsStatsGrid");
    if (!grid || !data?.ok) return;
    const st = data.stats || {};
    grid.innerHTML = [
        ["🔪 Kills", st.kills],
        ["🛡️ Saves", st.saves],
        ["🔎 Detects", st.detects],
        ["🗳️ Correct Votes", st.civilianVotes],
        ["🤡 Jester Wins", st.jesterWins],
        ["☠️ Mafia Wins", st.mafiaWins],
        ["🎉 Civilian Wins", st.civilianWins]
    ].map(([label,value]) => `<div class="settings-stat"><span>${label}</span><strong>${Number(value)||0}</strong></div>`).join("");
});


/* =========================================================
   NIGHT ACTION POPUPS — Mafia / Doctor / Cupid
   Small private popup after the action is completed (the existing
   Detective Yes/No popup is not touched). Only the actor receives it.
========================================================= */

let nightActionPopupTimer = null;

function ensureNightActionPopup() {
    let overlay = $("nightActionPopup");
    if (overlay) return overlay;

    overlay = document.createElement("div");
    overlay.id = "nightActionPopup";
    overlay.setAttribute("aria-live", "polite");
    overlay.innerHTML = `
        <div class="detective-result-card night-action-card">
            <div class="detective-result-scan"></div>

            <div class="detective-result-badge" id="nightActionIcon"></div>

            <div class="detective-result-kicker" id="nightActionKicker"></div>

            <div class="detective-result-title" id="nightActionTitle"></div>

            <div class="detective-result-divider"></div>

            <div class="detective-result-label" id="nightActionLabel"></div>

            <div class="detective-result-player" id="nightActionValue"></div>

            <div class="detective-result-footer">
                <span class="detective-result-dot"></span>
                <span id="nightActionFooter"></span>
            </div>

            <div class="detective-result-progress">
                <div class="detective-result-progress-bar night-action-progress-bar"></div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    return overlay;
}

function hideNightActionPopup() {
    clearTimeout(nightActionPopupTimer);
    nightActionPopupTimer = null;

    const overlay = $("nightActionPopup");
    if (overlay) overlay.style.display = "none";
}

function showNightActionPopup(data) {
    const views = {
        mafia: {
            icon: "🔫",
            kicker: "MAFIA • NIGHT ORDER",
            title: "TARGET LOCKED",
            label: "TARGET",
            value: data?.targetName || "Unknown",
            footer: "PRIVATE MAFIA REPORT"
        },
        doctor: {
            icon: "🩺",
            kicker: "DOCTOR • NIGHT DUTY",
            title: "PATIENT PROTECTED",
            label: "PROTECTING",
            value: data?.targetName || "Unknown",
            footer: "PRIVATE DOCTOR REPORT"
        },
        cupid: {
            icon: "💘",
            kicker: "CUPID • NIGHT MATCH",
            title: "LOVERS LINKED",
            label: "COUPLE",
            value: `${data?.firstName || "?"} ❤️ ${data?.secondName || "?"}`,
            footer: "PRIVATE CUPID REPORT"
        }
    };

    const view = views[data?.kind];
    if (!view) return;

    const overlay = ensureNightActionPopup();

    $("nightActionIcon").textContent = view.icon;
    $("nightActionKicker").textContent = view.kicker;
    $("nightActionTitle").textContent = view.title;
    $("nightActionLabel").textContent = view.label;
    $("nightActionValue").textContent = view.value;
    $("nightActionFooter").textContent = view.footer;

    overlay.dataset.kind = data.kind;
    overlay.style.display = "flex";

    // Restart the entrance + progress animation every time.
    const card = overlay.querySelector(".night-action-card");
    const progress = overlay.querySelector(".night-action-progress-bar");

    if (card) {
        card.classList.remove("detective-result-visible");
        void card.offsetWidth;
        card.classList.add("detective-result-visible");
    }

    if (progress) {
        progress.classList.remove("night-action-progress-running");
        void progress.offsetWidth;
        progress.classList.add("night-action-progress-running");
    }

    clearTimeout(nightActionPopupTimer);
    nightActionPopupTimer = setTimeout(hideNightActionPopup, 2800);
}

socket.on("nightActionPopup", data => {
    stopLast10Sound();
    showNightActionPopup(data);
});
