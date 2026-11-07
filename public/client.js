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
        duckMicForSound(sound);
        const promise = sound.play();
        if (promise) promise.catch(() => {});
    } catch (error) {
        console.warn("Sound error:", error);
    }
}

/*
   Without this, a game sound effect (like the death sound) plays out of
   your speakers, your own microphone picks it up, and it gets re-sent
   live over voice chat to everyone else — arriving garbled/echoey on top
   of the same sound they already played locally. To stop that, we briefly
   disable your outgoing mic track for the duration of the sound effect,
   then restore it (unless you had already muted yourself on purpose).
*/
function duckMicForSound(sound) {
    if (!voiceEnabled || !voiceLocalStream || voiceMuted) return;

    const tracks = voiceLocalStream.getAudioTracks();
    if (!tracks.length) return;

    tracks.forEach(track => { track.enabled = false; });

    let restored = false;
    const restore = () => {
        if (restored) return;
        restored = true;
        if (!voiceMuted) tracks.forEach(track => { track.enabled = true; });
    };

    sound.addEventListener("ended", restore, { once: true });
    sound.addEventListener("pause", restore, { once: true });

    // Fallback in case 'ended'/'pause' never fire for some reason -
    // never leave the mic muted longer than the sound could possibly run.
    const fallbackMs = (isFinite(sound.duration) && sound.duration > 0 ? sound.duration * 1000 : 3000) + 300;
    setTimeout(restore, fallbackMs);
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
        playEventSound("buttonClick", gameSounds.button);
        return;
    }

    playEventSound("buttonClick", gameSounds.button);
}, true);

let roomCode = "";
let myRole = "";
let players = [];

/* Voice chat permission state (sent by the server). */
let voiceChatAllowedSetting = true;
let detectiveCheckAnnounceSetting = true;
let voicePlayerIds = [];
let voicePermitted = true;
let voiceAutoDisabled = false;
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
            <h2>${tierNameHtml(data.playerName || "Player", data.tier)} ${userBadgeHtml(data.badge)} wants to join</h2>
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
        playEventSound("turnOver", gameSounds.turnOver);
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
            `🟢 ${playerCount}${match.maxPlayers ? " / " + match.maxPlayers : ""} ${playerCount === 1 ? "player" : "players"} waiting`;

        const host = document.createElement("div");
        host.className = "public-match-host";
        host.textContent = "👑 Host: ";
        host.appendChild(tierNameNode(match.hostName || "Host", match.hostTier));
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

    ensureVoiceHostSetting();
    ensureDetectiveHostSetting();
    updateVoiceHostButton();
    ensureSoundboardHostSection();

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

        setTierName(name, player.name, player.tier);
        /* Full-body character (not cropped) with the host's crown on top of its head. */
        const avatarWrap =
            document.createElement("span");

        avatarWrap.className =
            "lobby-avatar-wrap";

        avatarWrap.appendChild(avatarNode(player.look, 40, false));

        name.insertBefore(avatarWrap, name.firstChild);

        appendUserBadge(name, player.badge);

        if (
            player.id ===
            getCurrentHostId()
        ) {

            const crown =
                document.createElement("span");

            crown.className =
                "host-crown host-crown-head";

            crown.textContent =
                "👑";

            crown.title =
                "Host";

            avatarWrap.appendChild(crown);
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
        li.appendChild(makeViewAccountButton(player));

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

    // Stop the mic and tear down any peer connections so voice chat doesn't
    // keep running (and the mic doesn't stay hot) after leaving the room.
    disableVoice();
    const voicePanel = $("voiceChatPanel");
    if (voicePanel) voicePanel.style.display = "none";

    roomCode = "";
    myRole = "";
    players = [];
    currentPhase = "";
    hasVoted = false;
    isHost = false;
    window.currentHostId = "";

    hideJoinLoading();
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
    ensureVoicePanel();
    $("voiceChatPanel")?.style && ($("voiceChatPanel").style.display = "block");
    setTimeout(() => enableVoice(), 250);

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
    showJoinLoading(code);
    ensureVoicePanel();
    $("voiceChatPanel")?.style && ($("voiceChatPanel").style.display = "block");
    setTimeout(() => enableVoice(), 250);

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

    readVoiceSettings(Array.isArray(data) ? null : data);

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
        "loverCount",
        "bodyguardCount",
        "vigilanteCount",
        "sheriffCount",
        "mayorCount",
        "escortCount",
        "framerCount",
        "mediumCount",
        "executionerCount",
        "amnesiacCount"
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
        "loverCount",
        "bodyguardCount",
        "vigilanteCount",
        "sheriffCount",
        "mayorCount",
        "escortCount",
        "framerCount",
        "mediumCount",
        "executionerCount",
        "amnesiacCount"
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
                            $("civilianCount")?.value || 0,
                        bodyguard: $("bodyguardCount")?.value || 0,
                        vigilante: $("vigilanteCount")?.value || 0,
                        sheriff: $("sheriffCount")?.value || 0,
                        mayor: $("mayorCount")?.value || 0,
                        escort: $("escortCount")?.value || 0,
                        framer: $("framerCount")?.value || 0,
                        medium: $("mediumCount")?.value || 0,
                        executioner: $("executionerCount")?.value || 0,
                        amnesiac: $("amnesiacCount")?.value || 0
                    }
                }
            );

            if (voiceChatAllowedSetting) {
                // Allow Voice Chat = YES -> the host picks up to 5 voice players first.
                openVoicePicker("start", startPayload);
            } else {
                startPayload.voice = { allowed: false, players: [] };
                socket.emit("startGame", startPayload);
            }
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
        mafia: mobile ? "/images/roles/mafia-role.png" : "/images/roles/mafia-role.png",
        doctor: mobile ? "/images/roles/doctor-role.png" : "/images/roles/doctor-role.png",
        detective: mobile ? "/images/roles/detective-role.png" : "/images/roles/detective-role.png",
        cupid: mobile ? "/images/roles/cupid-role.png" : "/images/roles/cupid-role.png",
        godfather: "/images/roles/godfather.png",
        grandmafia: "/images/roles/grandmafia.png",
        grandma: "/images/roles/grandma.png",
        jester: "/images/roles/jester.png",
        civilian: "/images/roles/civilian.png",
        babymafia: mobile ? "/images/roles/mafia-role.png" : "/images/roles/mafia-role.png",
        bodyguard: "/images/roles/bodyguard.png",
        vigilante: "/images/roles/vigilante.png",
        sheriff: "/images/roles/sheriff.png",
        mayor: "/images/roles/mayor.png",
        escort: "/images/roles/escort.png",
        framer: "/images/roles/framer.png",
        medium: "/images/roles/medium.png",
        executioner: "/images/roles/executioner.png",
        amnesiac: "/images/roles/amnesiac.png"
    };
    return roleImages[String(role || "").toLowerCase().replace(/\s+/g, "")] || "";
}

function getDeathImage() {
    return isMobileOrTablet() ? "/images/mobile/death-mobile.png" : "/images/laptop/death-laptop.png";
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
    if (window.MW_EXTRA_TURN_ROLES && window.MW_EXTRA_TURN_ROLES[turn]) {
        return window.MW_EXTRA_TURN_ROLES[turn] !== myRole;
    }

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
    if (typeof stopSlotSound === "function") stopSlotSound("last10");   // also stop a sound the player picked for this moment
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
            image: window.mwTurnImage("mafia")
        },
        doctor: {
            title: "DOCTOR TURN",
            subtitle: "DOCTOR IS MAKING A DECISION",
            image: window.mwTurnImage("doctor")
        },
        detective: {
            title: "DETECTIVE TURN",
            subtitle: "DETECTIVE IS MAKING A DECISION",
            image: window.mwTurnImage("detective")
        },
        cupid: {
            title: "CUPID TURN",
            subtitle: "CUPID IS MAKING A DECISION",
            image: window.mwTurnImage("cupid")
        }
    ,
        escort: { title: "ESCORT TURN", subtitle: "ESCORT IS MAKING A DECISION", image: window.mwTurnImage("escort") },
        bodyguard: { title: "BODYGUARD TURN", subtitle: "BODYGUARD IS MAKING A DECISION", image: window.mwTurnImage("bodyguard") },
        sheriff: { title: "SHERIFF TURN", subtitle: "SHERIFF IS MAKING A DECISION", image: window.mwTurnImage("sheriff") },
        vigilante: { title: "VIGILANTE TURN", subtitle: "VIGILANTE IS MAKING A DECISION", image: window.mwTurnImage("vigilante") }
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
        const seconds = Math.min(180, totalSeconds);

        if (timer) {
            timer.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

            if (seconds <= 10 && seconds > 0) {
                timer.classList.add("night-turn-timer-warning");
                timer.classList.add("night-turn-heartbeat");

                /* Sound #4 — one heartbeat/beep for every last-10-second tick */
                if (!last10SoundStopped && lastNightWarningSecond !== seconds) {
                    lastNightWarningSecond = seconds;
                    playEventSound("last10", gameSounds.last10);
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

/* =========================================================
   LOADING IMAGES  (start-game loading + join-room loading)
   Put the pictures in  public/images/loading/  (public/images/ also works).
   Names:  mafia-loding   civilian-loding   neutral-loding   join-loding
   ("-loading" spelling works too).  Extensions: jpg jpeg png webp
========================================================= */

const mwxLoadingImageCache = {};

function mwxLoadingImageCandidates(name) {
    const names = [`${name}-loding`, `${name}-loading`];
    const exts = ["jpg", "jpeg", "png", "webp", "JPG", "PNG"];
    const dirs = ["/images/loading/", "/images/", "/images/backgrounds/"];
    const list = [];
    dirs.forEach(d => names.forEach(n => exts.forEach(e => list.push(`${d}${n}.${e}`))));
    return list;
}

function mwxResolveLoadingImage(name, overlay) {
    if (mwxLoadingImageCache[name]) {
        overlay.style.setProperty("--mwx-team-loading-image", `url("${mwxLoadingImageCache[name]}")`);
        return;
    }
    const candidates = mwxLoadingImageCandidates(name);
    let i = 0;
    const tryNext = () => {
        if (i >= candidates.length) return;
        const url = candidates[i++];
        const img = new Image();
        img.onload = () => {
            mwxLoadingImageCache[name] = url;
            if (overlay.dataset.team === name) {
                overlay.style.setProperty("--mwx-team-loading-image", `url("${url}")`);
            }
        };
        img.onerror = tryNext;
        img.src = url;
    };
    tryNext();
}

function setTeamLoadingTheme(role) {
    const overlay = $("roleRevealOverlay") || (typeof ensureRoleRevealOverlay === "function" ? ensureRoleRevealOverlay() : null);
    if (!overlay) return;
    const mafiaRoles = ["Mafia", "Godfather", "Grandmafia", "Baby Mafia"];
    const neutralRoles = ["Jester", "Executioner", "Amnesiac"];
    const team = mafiaRoles.includes(String(role)) ? "mafia" : neutralRoles.includes(String(role)) ? "neutral" : "civilian";
    if (overlay.dataset.team === team && overlay.style.getPropertyValue("--mwx-team-loading-image")) return;
    overlay.dataset.team = team;
    mwxResolveLoadingImage(team, overlay);
}

/* =========================================================
   JOIN ROOM LOADING SCREEN  (image: join-loding)
   Shows 0% -> 100% after you join a room, then opens the lobby.
========================================================= */

let joinLoadingTimer = null;

function ensureJoinLoadingOverlay() {
    let overlay = $("joinLoadingOverlay");
    if (overlay) return overlay;

    overlay = document.createElement("div");
    overlay.id = "joinLoadingOverlay";
    overlay.dataset.team = "join";
    overlay.innerHTML = `
        <div class="mwx-loadbox">
            <div class="mwx-load-ready" id="joinLoadingRoom">JOINING ROOM</div>
            <div class="mwx-load-row">
                <div class="mwx-load-label">LOADING</div>
                <div class="mwx-load-percent" id="joinLoadingPercent">0%</div>
            </div>
            <div class="mwx-load-bar"><div class="mwx-load-fill" id="joinLoadingFill"></div></div>
        </div>
    `;
    document.body.appendChild(overlay);
    return overlay;
}

function showJoinLoading(code) {
    const LOAD_MS = 3000;
    const overlay = ensureJoinLoadingOverlay();
    const percent = $("joinLoadingPercent");
    const fill = $("joinLoadingFill");
    const room = $("joinLoadingRoom");

    if (joinLoadingTimer) clearInterval(joinLoadingTimer);

    if (room) room.textContent = code ? `JOINING ROOM ${code}` : "JOINING ROOM";
    if (percent) percent.textContent = "0%";
    if (fill) fill.style.width = "0%";

    mwxResolveLoadingImage("join", overlay);
    overlay.classList.remove("join-loading-done");
    overlay.style.display = "flex";

    const startedAt = Date.now();
    joinLoadingTimer = setInterval(() => {
        const pct = Math.min(100, Math.floor(((Date.now() - startedAt) / LOAD_MS) * 100));
        if (percent) percent.textContent = pct + "%";
        if (fill) fill.style.width = pct + "%";

        if (pct >= 100) {
            clearInterval(joinLoadingTimer);
            joinLoadingTimer = null;
            overlay.classList.add("join-loading-done");
            setTimeout(() => {
                if (!joinLoadingTimer) overlay.style.display = "none";
            }, 450);
        }
    }, 50);
}

function hideJoinLoading() {
    if (joinLoadingTimer) { clearInterval(joinLoadingTimer); joinLoadingTimer = null; }
    const overlay = $("joinLoadingOverlay");
    if (overlay) overlay.style.display = "none";
}

function updateRoleDisplay(role) {

    setTeamLoadingTheme(role);
    const roleText = $("yourRole");
    const roleLogo = $("yourRoleLogo");

    if (!roleText || !roleLogo) return;

    const roleLogos = {
        "Civilian": "/images/roles/civilian.png",
        "Mafia": "/images/roles/mafia-role.png",
        "Godfather": "/images/roles/godfather.png",
        "Grandmafia": "/images/roles/grandmafia.png",
        "Grandma": "/images/roles/grandma.png",
        "Detective": getRoleImage("detective"),
        "Doctor": getRoleImage("doctor"),
        "Jester": "/images/roles/jester.png",
        "Cupid": getRoleImage("cupid"),
        "Baby Mafia": getRoleImage("babymafia"),
        "Bodyguard": getRoleImage("bodyguard"),
        "Vigilante": getRoleImage("vigilante"),
        "Sheriff": getRoleImage("sheriff"),
        "Mayor": getRoleImage("mayor"),
        "Escort": getRoleImage("escort"),
        "Framer": getRoleImage("framer"),
        "Medium": getRoleImage("medium"),
        "Executioner": getRoleImage("executioner"),
        "Amnesiac": getRoleImage("amnesiac")
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
    overlay.classList.add("mwx-team-loading");
    overlay.innerHTML = `
        <div class="role-reveal-countdown mwx-loadbox" id="roleRevealCountdown">
            <div class="mwx-load-ready" id="roleRevealCountdownReady">0 PLAYERS ARE READY</div>
            <div class="mwx-load-row">
                <div class="mwx-load-label">LOADING</div>
                <div class="mwx-load-percent" id="roleRevealCountdownNumber">0%</div>
            </div>
            <div class="mwx-load-bar"><div class="mwx-load-fill" id="mwxLoadFill"></div></div>
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
    const ov = $("roleRevealOverlay");
    if (ov) ov.classList.remove("mwx-loading-phase");

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
    setTeamLoadingTheme(myRole);
    if (overlay) overlay.classList.add("mwx-loading-phase");
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

    const LOAD_MS = 5000;
    const startedAt = Date.now();
    const fill = $("mwxLoadFill");
    if (number) number.textContent = "0%";
    if (fill) fill.style.width = "0%";

    const runCountdown = () => {
        if (token !== roleRevealCountdownToken) return;

        const pct = Math.min(100, Math.floor(((Date.now() - startedAt) / LOAD_MS) * 100));

        if (number) number.textContent = pct + "%";
        if (fill) fill.style.width = pct + "%";

        if (pct >= 100) {
            stopRoleRevealCountdown();
            showRoleLogoOnly();
        }
    };

    runCountdown();
    roleRevealTimerInterval = setInterval(runCountdown, 50);
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
        /* Team loading screen first (see MWLoading), then the normal role reveal. */
        if (window.MWLoading) {
            if (!window.MWLoading.isPending()) window.MWLoading.beforeMatch(startRoleRevealSequence);
        } else {
            startRoleRevealSequence();
        }
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

        readVoiceSettings(data);

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
                    playEventSound("roundStart", gameSounds.newRound);
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
        if (typeof watchGameStartForRoleReveal === "function") watchGameStartForRoleReveal(data);
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
        setTierName(name, player.name, player.tier);
        name.insertBefore(avatarNode(player.look, 30, true), name.firstChild);

        if (player.role) {
            const role = document.createElement("span");
            role.className = "visible-player-role";
            role.textContent = ` — ${player.role}`;
            name.appendChild(role);
        }

        if (window.MW_EXEC_TARGET_ID && player.id === window.MW_EXEC_TARGET_ID) {
            const tag = document.createElement("span");
            tag.className = "exec-target-tag";
            tag.textContent = " 🎯 TARGET";
            tag.style.cssText = "color:#ffd27a;font-weight:900;margin-left:6px;font-size:12px;letter-spacing:1px";
            name.appendChild(tag);
        }

        li.appendChild(name);

        if (!player.alive) {
            const dead = document.createElement("span");
            dead.textContent = " ☠️";
            li.appendChild(dead);
        }

        li.appendChild(makeViewAccountButton(player));

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
        tierPrefix(player.tier) + player.name;

    select.appendChild(option);
}

/* =========================================================
   TARGETS
========================================================= */

function amIDead() {
    const me = Array.isArray(players)
        ? players.find(player => player.id === socket.id)
        : null;
    return Boolean(me && me.alive === false);
}

function renderTargets(data) {

    const select =
        $("targetPlayer");

    const button =
        $("confirmAction");

    if (!select || !button)
        return;

    /* Dead players cannot vote or use any action - hide the controls. */
    if (amIDead()) {
        hide("targetPlayer");
        hide("confirmAction");
        return;
    }

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

if ((myRole === "Mafia" ||
    myRole === "Grandmafia" ||
    myRole === "Baby Mafia" ||
    myRole === "Framer") && currentNightTurn !== "framer") {

    button.textContent = "🔪 KILL";

} else if (myRole === "Detective") {

    button.textContent = "🔎 CHECK";

} else if (myRole === "Doctor") {
    button.textContent = "💚 SAVE";
} else if (window.MW_ACTION_TEXT && window.MW_ACTION_TEXT[myRole]) {
    button.textContent = window.MW_ACTION_TEXT[myRole].button;
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

            if (amIDead()) return;

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
                    window.MW_EXTRA_TURN_ROLES &&
                    window.MW_EXTRA_TURN_ROLES[currentNightTurn] === myRole
                ) {
                    socket.emit(
                        "roleChoose",
                        {
                            roomCode,
                            targetId
                        }
                    );
                } else if (
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
        "Baby Mafia",
        "Framer"
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

    if (amIDead()) {
        message.textContent =
            "☠️ You are dead. Just watch the game - you cannot vote or act.";
        return;
    }

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
            cupid: "Cupid",
            escort: "Escort",
            framer: "Framer",
            bodyguard: "Bodyguard",
            sheriff: "Sheriff",
            vigilante: "Vigilante"
        };
        const activeRole = roleTurnMap[currentNightTurn];

        if (!activeRole) {
            message.textContent = "🌙 Preparing the next night turn...";
        } else if (
            (currentNightTurn === "mafia" && isMafiaTeamClient(myRole)) ||
            (currentNightTurn === "doctor" && myRole === "Doctor") ||
            (currentNightTurn === "detective" && myRole === "Detective") ||
            (currentNightTurn === "cupid" && (myRole === "Cupid" || myRole === "Cupid")) ||
            (window.MW_EXTRA_TURN_ROLES && window.MW_EXTRA_TURN_ROLES[currentNightTurn] === myRole)
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
                (data.role === "Baby Mafia"
                    ? "👶 You are now Baby Mafia! You can kill with the Mafia."
                    : `🎭 You are now the ${data.role}!`);
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
        setTierName(nameBox, me.name || "You", me.tier);
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
            playEventSound("playerDeath", gameSounds.death);
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
            playEventSound("playerDeath", gameSounds.death);
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

/* Chat bubble used by the Public chat and the Mafia chat (same look as the lobby chat).
   Your messages are red bubbles on the right, everyone else's are dark bubbles on the left. */
function chatAddBubble(container, data) {
    if (!container || !data) return;

    const mine = data.fromId ? data.fromId === socket.id : false;

    const row = document.createElement("div");
    row.className = "lc-msg " + (mine ? "lc-me" : "lc-them");

    const meta = document.createElement("div");
    meta.className = "lc-meta";

    const name = document.createElement("span");
    name.className = "lc-name";
    name.textContent = (data.fromId && data.fromId === window.currentHostId ? "👑 " : "") +
        (mine ? "You" : String(data.playerName || "Player").slice(0, 24));

    const time = document.createElement("span");
    time.className = "lc-time";
    time.textContent = data.time ? lcTimeText(data.time) : "";

    meta.append(name, time);

    const text = document.createElement("div");
    text.className = "lc-text";
    text.textContent = String(data.message || "");

    row.append(meta, text);
    container.appendChild(row);

    while (container.children.length > 120) container.firstElementChild.remove();

    container.scrollTop = container.scrollHeight;
}

socket.on("newMessage", data => chatAddBubble($("chatMessages"), data));

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

socket.on("newMafiaMessage", data => chatAddBubble($("mafiaChatMessages"), data));

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
    ensureVoicePanel();
    $("voiceChatPanel")?.style && ($("voiceChatPanel").style.display = "block");
    setTimeout(() => enableVoice(), 250);
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
/* Neutral roles that can win the match alone. */
const NEUTRAL_WINNERS = ["Jester", "Executioner", "Amnesiac", "Neutral Team", "Neutral"];
const NEUTRAL_WIN_IMAGE = "/images/wins/jester-win.png";

function isNeutralWinner(winner) {
    return NEUTRAL_WINNERS.includes(String(winner || ""));
}

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
            winnerLogo.src = "/images/wins/mafia-win.png";
        }

        /* Every neutral role (Jester, Executioner, Amnesiac...) shares ONE
           "Neutral Team" win picture. Change the file name here to use your new image. */
        else if (isNeutralWinner(winner)) {
            winnerLogo.src = NEUTRAL_WIN_IMAGE;
        }
        else if (winner === "Civilians") {
            winnerLogo.src = "/images/wins/civilian-win.png";
        }
    }

    /* MESSAGE */
    if (messageBox) {
        if (isNeutralWinner(winner)) {
            /* Neutral roles: the headline says "Neutral Team", the line under it says which role won. */
            messageBox.textContent = "";

            const headline = document.createElement("div");
            headline.className = "game-over-neutral-title";
            headline.textContent = "🃏 Neutral Team has won the match";

            const detail = document.createElement("div");
            detail.className = "game-over-neutral-detail";
            detail.textContent = message || "";

            messageBox.append(headline, detail);
        } else {
            messageBox.textContent =
                `${winner}: ${message}`;
        }
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
   WEBRTC VOICE CHAT - CLIENT
   Real peer-to-peer browser audio with Socket.IO signaling.
========================================================= */

let voiceEnabled = false;
let voiceMuted = false;
let voiceLocalStream = null;
let voiceMicInputStream = null;
let voiceAudioContext = null;
let voiceMicGainNode = null;
let voiceGroup = "none";
let voicePeers = [];
const voiceConnections = new Map();
const voiceVolumes = new Map();
// Players YOU muted on your own side only. Nobody else is affected.
const voiceMutedPeers = new Set();
// Tracks each peer's REAL WebRTC connection state (not just "who should be
// in this channel"), so the UI can show whether audio is actually flowing
// instead of just showing the name and looking connected regardless.
const voiceConnectionStates = new Map();
const voiceIceQueues = new Map();
const voiceOfferLocks = new Map();
const voiceReconnectTimers = new Map();
// Offers (and ICE candidates) that arrive before our own mic/voice is ready
// get stashed here instead of being silently dropped, then replayed once
// enableVoice() finishes. This is what fixes peers never hearing each other.
const voicePendingOffers = new Map();
let voiceAudioUnlocked = false;

const VOICE_ICE_SERVERS = [
    { urls: "stun:stun.relay.metered.ca:80" },
    {
        urls: "turn:global.relay.metered.ca:80",
        username: "8b3ac6aa5def01abdfbceb26",
        credential: "RzFLuKDnnSxZUkWn"
    },
    {
        urls: "turn:global.relay.metered.ca:80?transport=tcp",
        username: "8b3ac6aa5def01abdfbceb26",
        credential: "RzFLuKDnnSxZUkWn"
    },
    {
        urls: "turn:global.relay.metered.ca:443",
        username: "8b3ac6aa5def01abdfbceb26",
        credential: "RzFLuKDnnSxZUkWn"
    },
    {
        urls: "turns:global.relay.metered.ca:443?transport=tcp",
        username: "8b3ac6aa5def01abdfbceb26",
        credential: "RzFLuKDnnSxZUkWn"
    }
];

function ensureVoicePanel() {
    if ($("voiceChatPanel")) return;

    const panel = document.createElement("div");
    panel.id = "voiceChatPanel";
    panel.innerHTML = `
        <div class="voice-header">
            <div>
                <div class="voice-title">🎙️ VOICE CHAT</div>
                <div id="voiceStatus" class="voice-status">Voice is off</div>
            </div>
            <button id="voiceCollapseButton" class="voice-icon-button" type="button">−</button>
        </div>
        <div id="voiceBody" class="voice-body">
            <button id="voiceEnableButton" class="voice-enable-button" type="button">🎙️ ENABLE VOICE</button>
            <div id="voiceError" class="voice-error"></div>
            <div id="voiceParticipants" class="voice-participants"></div>
            <div class="voice-controls">
                <button id="voiceMuteButton" class="voice-control-button" type="button" disabled>🎤 UNMUTE</button>
                <button id="voiceSpeakerButton" class="voice-control-button" type="button">🔊 SPEAKER</button>
                <button id="voiceMusicButton" class="voice-control-button" type="button">🎵 MUSIC</button>
                <button id="voiceReconnectButton" class="voice-control-button" type="button">🔄 RECONNECT</button>
            </div>
            <div id="voiceSpeakerPanel" class="voice-speaker-panel" style="display:none;"></div>
            <div id="voiceMusicPanel" class="voice-speaker-panel voice-music-panel" style="display:none;">
                <div class="vm-row">
                    <span id="voiceMusicSong" class="vm-song">🎵 Music</span>
                    <button id="voiceMusicToggle" class="vm-toggle" type="button">ON</button>
                </div>
                <div class="vm-row">
                    <span class="vm-label">🔊 Volume</span>
                    <input id="voiceMusicVolume" type="range" min="0" max="100" step="1" value="50" aria-label="Music volume">
                    <span id="voiceMusicVolumeText" class="vm-pct">50%</span>
                </div>
                <div class="vm-row">
                    <span class="vm-label">🔁 Loop song</span>
                    <span class="mw-yesno">
                        <label><input type="radio" name="voiceMusicLoop" data-music-loop="yes"> Yes</label>
                        <label><input type="radio" name="voiceMusicLoop" data-music-loop="no"> No</label>
                    </span>
                </div>
            </div>
        </div>
    `;

    panel.style.display = "none";
    document.body.appendChild(panel);

    $("voiceEnableButton")?.addEventListener("click", enableVoice);
    $("voiceMuteButton")?.addEventListener("click", toggleVoiceMute);
    $("voiceReconnectButton")?.addEventListener("click", reconnectVoice);
    $("voiceSpeakerButton")?.addEventListener("click", toggleSpeakerPanel);
    $("voiceMusicButton")?.addEventListener("click", toggleMusicPanel);
    $("voiceMusicToggle")?.addEventListener("click", () => {
        setMusicSetting("musicOn", !loadMafiaSettings().musicOn);
    });
    $("voiceMusicVolume")?.addEventListener("input", event => {
        setMusicSetting("musicVolume", Number(event.target.value) / 100);
    });
    panel.querySelectorAll("input[name='voiceMusicLoop']").forEach(input => {
        input.addEventListener("change", () => setMusicSetting("musicLoop", input.dataset.musicLoop === "yes"));
    });
    // The bottom-right music box would sit underneath this panel, so it hides
    // while the voice panel is on screen (music lives in the Music button instead).
    try {
        new MutationObserver(() => syncMusicDock()).observe(panel, { attributes: true, attributeFilter: ["style"] });
    } catch (_) { /* ignore */ }
    syncMusicDock();
    updateMusicControl();
    $("voiceCollapseButton")?.addEventListener("click", () => {
        const body = $("voiceBody");
        const button = $("voiceCollapseButton");
        if (!body || !button) return;
        const collapsed = body.style.display === "none";
        body.style.display = collapsed ? "block" : "none";
        button.textContent = collapsed ? "−" : "+";
    });
}

function setVoiceError(message) {
    ensureVoicePanel();
    const el = $("voiceError");
    if (el) el.textContent = message || "";
}

function setVoiceStatus(text, active = false) {
    ensureVoicePanel();
    const el = $("voiceStatus");
    if (el) {
        el.textContent = text;
        el.classList.toggle("voice-live", active);
    }
}

function isVoiceRoomScreen() {
    return Boolean(roomCode) && currentPhase !== "";
}

async function enableVoice() {
    ensureVoicePanel();
    setVoiceError("");

    if (!voicePermitted) {
        setVoiceError("Voice chat is not available for you right now.");
        return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setVoiceError("Your browser does not support microphone voice chat.");
        return;
    }

    if (!window.isSecureContext && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") {
        setVoiceError("Voice requires HTTPS (or localhost). Open the game using https://.");
        return;
    }

    try {
        if (!voiceLocalStream) {
            voiceMicInputStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                },
                video: false
            });

            // Route the microphone through a gain node so Microphone Volume
            // changes the audio actually sent to the other players.
            try {
                const AudioContextClass = window.AudioContext || window.webkitAudioContext;
                if (AudioContextClass) {
                    voiceAudioContext = new AudioContextClass();
                    const source = voiceAudioContext.createMediaStreamSource(voiceMicInputStream);
                    voiceMicGainNode = voiceAudioContext.createGain();
                    voiceMicGainNode.gain.value = getAudioSettings().microphoneVolume;
                    const destination = voiceAudioContext.createMediaStreamDestination();
                    source.connect(voiceMicGainNode);
                    voiceMicGainNode.connect(destination);
                    voiceLocalStream = destination.stream;
                } else {
                    voiceLocalStream = voiceMicInputStream;
                }
            } catch (audioError) {
                console.warn("Microphone gain setup failed; using direct microphone stream.", audioError);
                voiceLocalStream = voiceMicInputStream;
            }
        }

        voiceAudioUnlocked = true;
        voiceEnabled = true;
        voiceMuted = !!getAudioSettings().microphoneMuted;
        if (voiceLocalStream) {
            voiceLocalStream.getAudioTracks().forEach(track => { track.enabled = !voiceMuted; });
        }
        applyAudioSettings();
        updateVoiceControls();
        setVoiceStatus("LIVE • waiting for players...", true);
        // Replay any offers a faster peer sent us before our mic was ready,
        // instead of leaving them dropped forever.
        processPendingVoiceOffers();
        socket.emit("voiceRequestState");
    } catch (error) {
        console.error("Voice microphone error:", error);
        setVoiceError(
            error?.name === "NotAllowedError"
                ? "Microphone permission was blocked. Allow microphone access and try again."
                : "Could not access your microphone."
        );
        setVoiceStatus("Voice is off", false);
    }
}

function updateVoiceControls() {
    ensureVoicePanel();
    const enable = $("voiceEnableButton");
    const mute = $("voiceMuteButton");
    if (enable) {
        enable.disabled = voiceEnabled || !voicePermitted;
        enable.textContent = voiceEnabled ? "🎙️ VOICE ENABLED" : "🎙️ ENABLE VOICE";
    }
    if (mute) {
        mute.disabled = !voiceEnabled;
        mute.textContent = voiceMuted ? "🎤 UNMUTE" : "🔇 MUTE";
    }
}

function toggleVoiceMute() {
    if (!voiceLocalStream) return;
    voiceMuted = !voiceMuted;
    voiceLocalStream.getAudioTracks().forEach(track => {
        track.enabled = !voiceMuted;
    });
    updateVoiceControls();
}

// Manually tears down and rebuilds every peer connection in the current
// voice group. This was referenced by the RECONNECT button but never
// actually defined anywhere, which crashed the page with a ReferenceError
// the moment the voice panel was first created.
function reconnectVoice() {
    if (!voiceEnabled || !voiceLocalStream) {
        setVoiceError("Enable voice first, then try reconnecting.");
        return;
    }
    setVoiceError("");
    closeAllVoicePeers();
    voicePendingOffers.clear();
    setVoiceStatus("Reconnecting...", false);
    socket.emit("voiceRequestState");
}

function closeVoicePeer(peerId) {
    const pc = voiceConnections.get(peerId);
    if (pc) {
        try { pc.onicecandidate = null; pc.ontrack = null; pc.onconnectionstatechange = null; pc.close(); } catch (_) {}
        voiceConnections.delete(peerId);
    }
    voiceIceQueues.delete(peerId);
    voiceOfferLocks.delete(peerId);
    voicePendingOffers.delete(peerId);
    voiceConnectionStates.delete(peerId);
    const timer = voiceReconnectTimers.get(peerId);
    if (timer) clearTimeout(timer);
    voiceReconnectTimers.delete(peerId);
    const audio = document.getElementById(`voice-audio-${CSS.escape(peerId)}`);
    if (audio) { try { audio.pause(); } catch (_) {} audio.srcObject = null; audio.remove(); }
}

function closeAllVoicePeers() {
    for (const peerId of Array.from(voiceConnections.keys())) closeVoicePeer(peerId);
}

function disableVoice() {
    closeAllVoicePeers();
    if (voiceLocalStream) {
        voiceLocalStream.getTracks().forEach(track => track.stop());
        voiceLocalStream = null;
    }
    if (voiceMicInputStream && voiceMicInputStream !== voiceLocalStream) {
        voiceMicInputStream.getTracks().forEach(track => track.stop());
    }
    voiceMicInputStream = null;
    voiceMicGainNode = null;
    if (voiceAudioContext) {
        try { voiceAudioContext.close(); } catch (_) {}
        voiceAudioContext = null;
    }
    voiceEnabled = false;
    voiceMuted = false;
    voiceGroup = "none";
    voicePeers = [];
    voicePendingOffers.clear();
    renderVoiceParticipants();
    updateVoiceControls();
    setVoiceStatus("Voice is off", false);
}

function createVoicePeer(peer) {
    if (!voiceEnabled || !voiceLocalStream || !peer?.id) return null;
    if (voiceConnections.has(peer.id)) return voiceConnections.get(peer.id);
    const pc = new RTCPeerConnection({ iceServers: VOICE_ICE_SERVERS });
    voiceConnections.set(peer.id, pc);
    voiceIceQueues.set(peer.id, voiceIceQueues.get(peer.id) || []);
    voiceLocalStream.getTracks().forEach(track => pc.addTrack(track, voiceLocalStream));
    pc.onicecandidate = event => {
        if (event.candidate && roomCode) socket.emit("voiceIceCandidate", { roomCode, targetId: peer.id, candidate: event.candidate });
    };
    pc.ontrack = event => {
        console.log(`[voice] received remote audio track from ${peer.name || peer.id}`);
        let audio = document.getElementById(`voice-audio-${CSS.escape(peer.id)}`);
        if (!audio) {
            audio = document.createElement("audio");
            audio.id = `voice-audio-${CSS.escape(peer.id)}`;
            audio.autoplay = true; audio.playsInline = true; audio.setAttribute("playsinline", ""); audio.style.display = "none";
            document.body.appendChild(audio);
        }
        audio.srcObject = event.streams[0] || new MediaStream([event.track]);
        const audioSettings = getAudioSettings();
        const individual = voiceVolumes.has(peer.id) ? voiceVolumes.get(peer.id) : 1;
        audio.volume = audioSettings.masterVolume * audioSettings.speakerVolume * individual;
        audio.muted = voiceMutedPeers.has(peer.id);
        const play = () => audio.play().then(() => { voiceAudioUnlocked = true; }).catch(error => {
            console.warn(`[voice] audio.play() blocked for ${peer.name || peer.id}:`, error?.name || error);
        });
        play();
        if (!voiceAudioUnlocked) {
            const unlock = () => play();
            document.addEventListener("click", unlock, { once: true });
            document.addEventListener("keydown", unlock, { once: true });
            document.addEventListener("touchstart", unlock, { once: true });
        }
    };
    pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        console.log(`[voice] connection to ${peer.name || peer.id}: ${state}`);
        voiceConnectionStates.set(peer.id, state);
        renderVoiceParticipants();
        if (state === "connected") { setVoiceStatus(`LIVE • ${voiceGroup.toUpperCase()}`, true); return; }
        if (["failed", "disconnected"].includes(state)) {
            const stillWanted = voicePeers.some(p => p.id === peer.id);
            if (!stillWanted || !voiceEnabled) return;
            if (state === "failed") { try { pc.restartIce(); } catch (_) {} }
            if (!voiceReconnectTimers.has(peer.id)) {
                const timer = setTimeout(() => {
                    voiceReconnectTimers.delete(peer.id);
                    if (!voiceEnabled || !voicePeers.some(p => p.id === peer.id)) return;
                    closeVoicePeer(peer.id);
                    updateVoicePeers(voicePeers).catch(err => console.error("Voice reconnect error:", err));
                }, 1200);
                voiceReconnectTimers.set(peer.id, timer);
            }
        }
    };
    return pc;
}

async function makeVoiceOffer(peer) {
    const pc = createVoicePeer(peer);
    if (!pc || voiceOfferLocks.get(peer.id)) return;
    voiceOfferLocks.set(peer.id, true);
    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit("voiceOffer", { roomCode, targetId: peer.id, offer: pc.localDescription });
    } catch (error) {
        console.error("Voice offer error:", error);
        closeVoicePeer(peer.id);
    } finally { voiceOfferLocks.delete(peer.id); }
}

async function updateVoicePeers(peers) {
    if (!voiceEnabled || !voiceLocalStream) return;

    const wanted = new Map((Array.isArray(peers) ? peers : []).map(p => [p.id, p]));

    for (const existingId of Array.from(voiceConnections.keys())) {
        if (!wanted.has(existingId)) closeVoicePeer(existingId);
    }

    for (const peer of wanted.values()) {
        if (voiceConnections.has(peer.id)) continue;

        // Only the lexicographically smaller socket ID creates the offer.
        // This guarantees exactly one WebRTC connection per pair.
        if (String(socket.id) < String(peer.id)) {
            await makeVoiceOffer(peer);
        } else {
            createVoicePeer(peer);
        }
    }

    renderVoiceParticipants();
}

function renderVoiceParticipants() {
    ensureVoicePanel();
    const container = $("voiceParticipants");
    if (!container) return;

    if (!voicePeers.length) {
        container.innerHTML = '<div class="voice-empty">No one is in your current voice channel.</div>';
        return;
    }

    container.innerHTML = "";

    voicePeers.forEach(peer => {
        const row = document.createElement("div");
        row.className = "voice-participant";
        row.dataset.peerId = peer.id;

        const name = document.createElement("div");
        name.className = "voice-player-name";
        name.textContent = peer.name || "Player";
        if (!isGameScreenOpen()) appendUserBadge(name, peer.badge);

        // Real WebRTC state for this peer, not just "they're in my channel".
        // This is what tells you whether audio can actually flow.
        const stateLabel = document.createElement("div");
        stateLabel.className = "voice-player-state";
        const rawState = voiceConnectionStates.get(peer.id) || "connecting";
        const stateText = {
            connected: "🟢 Connected",
            connecting: "🟡 Connecting…",
            new: "🟡 Connecting…",
            disconnected: "🟠 Reconnecting…",
            failed: "🔴 Failed",
            closed: "⚪ Closed"
        }[rawState] || `🟡 ${rawState}`;
        stateLabel.textContent = stateText;
        stateLabel.style.fontSize = "0.8em";
        stateLabel.style.opacity = "0.8";

        row.append(name, stateLabel);
        container.appendChild(row);
    });

    // Keep the Speaker menu in step with who is in the channel.
    renderSpeakerPanel();
}

/* =========================================================
   SPEAKER MENU
   Choose which player to mute (only for you) and set each
   player's volume. Rows are updated IN PLACE, so the slider
   never resets while you are dragging it.
========================================================= */

function toggleSpeakerPanel() {
    const panel = $("voiceSpeakerPanel");
    if (!panel) return;

    const open = panel.style.display === "none";
    panel.style.display = open ? "" : "none";
    $("voiceSpeakerButton")?.classList.toggle("voice-control-active", open);

    if (open) {
        const musicPanel = $("voiceMusicPanel");
        if (musicPanel && musicPanel.style.display !== "none") toggleMusicPanel();   // one menu at a time
        renderSpeakerPanel(true);
    }
}

function toggleMusicPanel() {
    const panel = $("voiceMusicPanel");
    if (!panel) return;

    const open = panel.style.display === "none";
    panel.style.display = open ? "" : "none";
    $("voiceMusicButton")?.classList.toggle("voice-control-active", open);

    if (open) {
        const speakerPanel = $("voiceSpeakerPanel");
        if (speakerPanel && speakerPanel.style.display !== "none") toggleSpeakerPanel();   // one menu at a time
        updateMusicControl();
    }
}

function applyPeerAudio(peerId) {
    const audio = document.getElementById(`voice-audio-${CSS.escape(peerId)}`);
    if (!audio) return;

    const audioSettings = getAudioSettings();
    const individual = voiceVolumes.has(peerId) ? voiceVolumes.get(peerId) : 1;
    audio.volume = audioSettings.masterVolume * audioSettings.speakerVolume * individual;
    audio.muted = voiceMutedPeers.has(peerId);
}

function renderSpeakerPanel(force = false) {
    const panel = $("voiceSpeakerPanel");
    if (!panel || panel.style.display === "none") return;

    const signature = voicePeers.map(p => p.id).join("|");

    // Same players as before -> only refresh names, do not rebuild the sliders.
    if (!force && panel.dataset.signature === signature) {
        voicePeers.forEach(peer => {
            const nameEl = panel.querySelector(`[data-speaker-name="${CSS.escape(peer.id)}"]`);
            if (nameEl) {
                nameEl.textContent = peer.name || "Player";
                if (!isGameScreenOpen()) appendUserBadge(nameEl, peer.badge);
            }
        });
        return;
    }

    panel.dataset.signature = signature;
    panel.innerHTML = "";

    if (!voicePeers.length) {
        panel.innerHTML = '<div class="voice-empty">No one is in your current voice channel.</div>';
        return;
    }

    voicePeers.forEach(peer => {
        const row = document.createElement("div");
        row.className = "speaker-row";

        const top = document.createElement("div");
        top.className = "speaker-row-top";

        const name = document.createElement("div");
        name.className = "speaker-name";
        name.dataset.speakerName = peer.id;
        name.textContent = peer.name || "Player";
        if (!isGameScreenOpen()) appendUserBadge(name, peer.badge);

        const muteButton = document.createElement("button");
        muteButton.type = "button";
        muteButton.className = "speaker-mute";

        const slider = document.createElement("input");
        slider.type = "range";
        slider.className = "speaker-slider";
        slider.min = "0";
        slider.max = "100";
        slider.step = "1";
        slider.value = String(Math.round((voiceVolumes.has(peer.id) ? voiceVolumes.get(peer.id) : 1) * 100));
        slider.title = `Volume for ${peer.name || "player"}`;

        const percent = document.createElement("span");
        percent.className = "speaker-percent";

        const refreshLabels = () => {
            const muted = voiceMutedPeers.has(peer.id);
            muteButton.textContent = muted ? "🔇 UNMUTE" : "🔊 MUTE";
            muteButton.classList.toggle("is-muted", muted);
            slider.disabled = muted;
            row.classList.toggle("is-muted", muted);
            percent.textContent = muted ? "muted" : `${slider.value}%`;
        };

        slider.addEventListener("input", () => {
            voiceVolumes.set(peer.id, Number(slider.value) / 100);
            applyPeerAudio(peer.id);
            refreshLabels();
        });

        muteButton.addEventListener("click", () => {
            if (voiceMutedPeers.has(peer.id)) voiceMutedPeers.delete(peer.id);
            else voiceMutedPeers.add(peer.id);

            applyPeerAudio(peer.id);
            refreshLabels();
        });

        refreshLabels();

        top.append(name, muteButton);

        const sliderLine = document.createElement("div");
        sliderLine.className = "speaker-slider-line";
        sliderLine.append(slider, percent);

        row.append(top, sliderLine);
        panel.appendChild(row);
    });
}

async function flushVoiceIceCandidates(peerId, pc) {
    const queued = voiceIceQueues.get(peerId) || [];
    voiceIceQueues.set(peerId, []);
    for (const candidate of queued) {
        try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (error) { console.error("Queued voice ICE error:", error); }
    }
}

socket.on("voiceState", async data => {
    if (!data) return;

    /*
       Voice permission from the server:
       - the host turned Allow Voice Chat OFF, or
       - this player was not one of the (max 5) players the host picked.
       In both cases the mic is released and no voice connections exist.
    */
    voicePermitted = data.enabled !== false;

    if (!voicePermitted) {
        if (voiceEnabled) {
            voiceAutoDisabled = true;
            disableVoice();
        }

        voiceGroup = "none";
        voicePeers = [];

        ensureVoicePanel();
        const lockedPanel = $("voiceChatPanel");
        if (lockedPanel) lockedPanel.style.display = "block";

        setVoiceStatus(
            data.chatAllowed === false
                ? "Voice chat is turned off by the host"
                : "Voice chat is only for players picked by the host",
            false
        );
        setVoiceError("");
        renderVoiceParticipants();
        updateVoiceControls();
        updateVoiceHostButton();
        return;
    }

    // Permission came back (or the host turned voice on): reconnect the mic.
    if (voiceAutoDisabled && !voiceEnabled) {
        voiceAutoDisabled = false;
        setTimeout(() => enableVoice(), 250);
    }

    voiceGroup = data.group || "none";
    voicePeers = Array.isArray(data.peers)
        ? data.peers.filter(peer => peer && peer.connected !== false)
        : [];

    // A crashed/disconnected player is removed from the server's peer list.
    // updateVoicePeers() immediately tears down that old WebRTC connection.
    if (voiceEnabled) {
        updateVoicePeers(voicePeers).catch(error => console.error("Voice peer update error:", error));
    }

    ensureVoicePanel();
    const voicePanel = $("voiceChatPanel");
    if (voicePanel) voicePanel.style.display = "block";
    updateVoiceHostButton();
    updateVoiceControls();

    if (!voiceEnabled) {
        setVoiceStatus(
            voiceGroup === "silent" || voiceGroup === "none"
                ? "No active voice channel"
                : "Voice is off • click Enable Voice",
            false
        );
        renderVoiceParticipants();
        return;
    }

    if (voiceGroup === "silent" || voiceGroup === "none") {
        closeAllVoicePeers();
        setVoiceStatus("No active voice channel", false);
        renderVoiceParticipants();
        return;
    }

    setVoiceStatus(`LIVE • ${voiceGroup.toUpperCase()}`, true);
    processPendingVoiceOffers();
    await updateVoicePeers(voicePeers);
});

async function handleVoiceOffer(data) {
    const peer = voicePeers.find(p => p.id === data.fromId) || { id: data.fromId, name: data.fromName || "Player" };
    const pc = createVoicePeer(peer);
    if (!pc) return;

    try {
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        await flushVoiceIceCandidates(data.fromId, pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("voiceAnswer", {
            roomCode,
            targetId: data.fromId,
            answer: pc.localDescription
        });
    } catch (error) {
        console.error("Voice answer error:", error);
    }
}

function processPendingVoiceOffers() {
    if (!voiceEnabled || !voiceLocalStream) return;
    for (const [peerId, data] of Array.from(voicePendingOffers.entries())) {
        voicePendingOffers.delete(peerId);
        handleVoiceOffer(data).catch(error => console.error("Voice pending offer error:", error));
    }
}

socket.on("voiceOffer", data => {
    if (!data?.fromId || !data?.offer) return;

    // If our mic isn't ready yet (getUserMedia still pending, or voice not
    // enabled locally), don't drop the offer - a faster peer's offer used to
    // vanish here, leaving both sides silently stuck with no audio. Queue it
    // and replay it as soon as enableVoice() finishes.
    if (!voiceEnabled || !voiceLocalStream) {
        voicePendingOffers.set(data.fromId, data);
        return;
    }

    handleVoiceOffer(data).catch(error => console.error("Voice offer error:", error));
});

socket.on("voiceAnswer", async data => {
    if (!voiceEnabled || !data?.fromId || !data?.answer) return;
    const pc = voiceConnections.get(data.fromId);
    if (!pc) return;
    try {
        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        await flushVoiceIceCandidates(data.fromId, pc);
    } catch (error) {
        console.error("Voice remote answer error:", error);
    }
});

socket.on("voiceIceCandidate", async data => {
    if (!data?.fromId || !data?.candidate) return;
    const peerId = data.fromId;
    const pc = voiceConnections.get(peerId);
    // Queue whenever there's no connection yet OR it has no remote
    // description yet - a candidate that arrives before we've processed the
    // matching offer (e.g. while our mic is still initializing) used to be
    // silently discarded here instead of queued.
    if (!pc || !pc.remoteDescription) {
        const queue = voiceIceQueues.get(peerId) || [];
        queue.push(data.candidate);
        voiceIceQueues.set(peerId, queue);
        return;
    }
    try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (error) { console.error("Voice ICE error:", error); }
});

socket.on("connect", () => {
    if (roomCode) socket.emit("voiceRequestState");
});

socket.on("disconnect", () => {
    closeAllVoicePeers();
});

// Hook into room/game UI without replacing any existing handlers.
const originalVoiceInit = document.addEventListener;
document.addEventListener("DOMContentLoaded", () => {
    ensureVoicePanel();
    updateVoiceControls();
});

socket.on("gameOver", () => {
    currentPhase = "gameover";
    socket.emit("voiceRequestState");
});

socket.on("gameRestarted", () => {
    closeAllVoicePeers();
    socket.emit("voiceRequestState");
});

window.addEventListener("beforeunload", () => {
    try { closeAllVoicePeers(); } catch (_) {}
    if (voiceLocalStream) voiceLocalStream.getTracks().forEach(track => track.stop());
});


/* =========================================================
   ACCOUNTS: LOGIN / SKIP + RANKS (accounts are made by the Owner)
   Added as a separate block so the existing game code is untouched.
========================================================= */

const authState = {
    username: null,     // null = Skip / guest (original username, never changes)
    displayName: null,  // the name other players see
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
            setTierName(name, authState.username, myTierKey);
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
    mode = "login";   // accounts are made by the Owner now, so there is only Login
    authState.mode = mode;
    ensureAuthExtras();
    if ($("authForgotBox")) $("authForgotBox").style.display = "none";
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

    if (!/^\d{4,8}$/.test(pin)) {
        setAuthMessage("PIN must be 4-8 digits.", "error");
        return;
    }

    setAuthBusy(true);
    setAuthMessage("Logging in...", "waiting");

    socket.emit("login", { username, password, pin });
}

/* Fill the name box with the account name (only if it is empty). */
function prefillAccountNames() {
    if (!authState.username) return;

    ["createPlayerName", "joinPlayerName", "quickStartPlayerName", "rejoinPlayerName"]
        .forEach(id => {
            const input = $(id);
            if (input && !input.value.trim()) input.value = authState.displayName || authState.username;
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
        authState.displayName = null;
        saveAuthToken(null);
    } else {
        authState.username = data.username;
        authState.displayName = data.displayName || data.username;
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
        !query ||
        String(entry.username).toLowerCase().includes(query) ||
        String(entry.displayName || "").toLowerCase().includes(query)
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
        setTierName(name, entry.displayName || entry.username, entry.tier);
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

    setTierName($("ranksDetailsName"), data.displayName || data.username, data.tier);
    showDetailsAvatar(data.look);
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
        setTierName(accountName, authState.username, myTierKey);
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
    speakerVolume: 1,
    microphoneVolume: 1,
    microphoneMuted: false,
    soundEffectsVolume: 1,
    notificationSoundsVolume: 1,
    musicOn: true,
    musicVolume: 0.5,
    musicInMatch: true,
    musicLoop: true
};

function clampAudioSetting(value, fallback = 1) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

function getAudioSettings() {
    const st = loadMafiaSettings();
    return {
        masterVolume: clampAudioSetting(st.masterVolume),
        speakerVolume: clampAudioSetting(st.speakerVolume),
        microphoneVolume: clampAudioSetting(st.microphoneVolume),
        microphoneMuted: !!st.microphoneMuted,
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

    document.querySelectorAll('audio[id^="voice-audio-"]').forEach(el => {
        const peerId = el.id.replace(/^voice-audio-/, "");
        const individual = voiceVolumes.has(peerId) ? voiceVolumes.get(peerId) : 1;
        el.volume = audio.masterVolume * audio.speakerVolume * individual;
    });

    if (voiceMicGainNode) {
        voiceMicGainNode.gain.value = audio.microphoneMuted ? 0 : audio.microphoneVolume;
    }

    // Music follows the Master volume too.
    if (typeof applyMusicVolume === "function") applyMusicVolume();
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
/* ---------- Theme logo swap (White theme uses its own logo) ---------- */
const MAIN_LOGO_FILE = "mafia-wars-main-logo.png";
const WHITE_LOGO_FILE = "mafia-wars-white-logo.png";
function applyThemeLogos(theme) {
    const useWhite = theme === "white";
    const customLogo = (typeof getEquippedLogoUrl === "function") ? getEquippedLogoUrl() : null;
    document.querySelectorAll('img[data-mw-logo], img[src$="' + MAIN_LOGO_FILE + '"], img[src$="' + WHITE_LOGO_FILE + '"]').forEach(img => {
        img.dataset.mwLogo = "1";
        const wanted = customLogo || (useWhite ? WHITE_LOGO_FILE : MAIN_LOGO_FILE);
        if (img.getAttribute("src") === wanted) return;
        // if the chosen logo file is missing, quietly fall back to the original logo
        img.onerror = () => { img.onerror = null; img.setAttribute("src", MAIN_LOGO_FILE); };
        img.setAttribute("src", wanted);
    });
}

function applyMafiaSettings() {
    const st = loadMafiaSettings();
    document.body.classList.toggle("settings-reduce-motion", !!st.reduceMotion);
    document.body.classList.toggle("settings-no-effects", !st.uiEffects);
    document.body.classList.toggle("settings-no-animations", !st.animations);
    document.documentElement.dataset.mafiaTheme = st.theme;
    applyThemeLogos(st.theme);
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
                    <div><strong>🔊 Master Volume</strong><small>Controls all game audio, notifications and other players' voices.</small></div>
                    <div class="settings-slider-wrap"><input id="settingsMasterVolume" class="settings-range" type="range" min="0" max="100" step="1" value="${pct(st.masterVolume)}"><span id="settingsMasterVolumeValue" class="settings-value">${pct(st.masterVolume)}%</span></div>
                </div>
                <div class="settings-row sound-setting-row">
                    <div><strong>🎧 Speaker Volume</strong><small>Controls the volume of other players' voices.</small></div>
                    <div class="settings-slider-wrap"><input id="settingsSpeakerVolume" class="settings-range" type="range" min="0" max="100" step="1" value="${pct(st.speakerVolume)}"><span id="settingsSpeakerVolumeValue" class="settings-value">${pct(st.speakerVolume)}%</span></div>
                </div>
                <div class="settings-row sound-setting-row">
                    <div><strong>🎤 Microphone Volume</strong><small>Controls how loud your voice is sent to other players.</small></div>
                    <div class="settings-slider-wrap"><input id="settingsMicrophoneVolume" class="settings-range" type="range" min="0" max="100" step="1" value="${pct(st.microphoneVolume)}"><span id="settingsMicrophoneVolumeValue" class="settings-value">${pct(st.microphoneVolume)}%</span></div>
                </div>
                <div class="settings-row">
                    <div><strong>🔇 Mute Microphone</strong><small>Other players will not hear you while muted.</small></div>
                    <input id="settingsMicrophoneMuted" class="settings-switch" type="checkbox" ${st.microphoneMuted ? "checked" : ""}>
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
        bindAudioSlider("settingsSpeakerVolume", "settingsSpeakerVolumeValue", "speakerVolume");
        bindAudioSlider("settingsMicrophoneVolume", "settingsMicrophoneVolumeValue", "microphoneVolume");
        bindAudioSlider("settingsSoundEffectsVolume", "settingsSoundEffectsVolumeValue", "soundEffectsVolume");
        bindAudioSlider("settingsNotificationSoundsVolume", "settingsNotificationSoundsVolumeValue", "notificationSoundsVolume");
        $("settingsMicrophoneMuted")?.addEventListener("change", event => {
            const current = loadMafiaSettings();
            current.microphoneMuted = !!event.target.checked;
            saveMafiaSettings(current);
            voiceMuted = current.microphoneMuted;
            if (voiceLocalStream) {
                voiceLocalStream.getAudioTracks().forEach(track => { track.enabled = !voiceMuted; });
            }
            applyAudioSettings();
            updateVoiceControls();
        });
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
                <p>Sign in to use your account controls.</p>
                <p>Want to make an account? <a href="https://discord.gg/rkzb2eBZz" target="_blank" rel="noopener noreferrer">Join our Discord server!</a></p>
                <div style="margin-top:13px">
                    <button class="settings-action" id="settingsSignIn">🔐 SIGN IN</button>
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
            `<div class="settings-row"><div><strong>#${x.rank} ${tierNameHtml(x.username, x.tier)}</strong></div><div class="settings-value">${Number(x.points)||0} pts</div></div>`
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

    const view = views[data?.kind] || (window.MW_POPUP_VIEW && window.MW_POPUP_VIEW(data));
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


/* =========================================================
   PROGRESSION: RANK TAGS, DETAILS, INVENTORY, LEVEL UP,
   CUSTOM SOUNDS, CUSTOM WALLPAPERS, APPEARANCE
   Added as a separate block so the existing game code is untouched.
   Rank / level / unlock checks are done by the SERVER; this block
   only displays them and sends the player's choices.
========================================================= */

/* Name colors + symbols for each point rank (edit colors here). */
const TIER_INFO = {
    red:     { name: "Red",     symbol: "🔴", color: "#ff4d4d", min: 150 },
    gold:    { name: "Gold",    symbol: "🟡", color: "#ffd23f", min: 200 },
    diamond: { name: "Diamond", symbol: "💎", color: "#4fd8ff", min: 300 },
    elite:   { name: "Elite",   symbol: "⚔️", color: "#c3cde0", min: 400 },
    legend:  { name: "Legend",  symbol: "👑", color: "#c77dff", min: 500 }
};
const TIER_ORDER = ["red", "gold", "diamond", "elite", "legend"];

const SOUND_EVENT_LABELS = {
    buttonClick: "Button Click",
    roundStart: "Round Start",
    turnStart: "Turn Start",
    turnOver: "Turn Over",
    votingStart: "Voting Start",
    last10: "Last 10 Seconds",
    gameEnd: "Game End",
    playerDeath: "Player Death"
};

var myProgress = null;      // latest progress sent by the server
var myTierKey = null;       // rank tag currently shown next to my name
var pendingLevelUps = [];
var inventoryTab = "character";
var inventoryMessage = "";

function getTierInfo(key) {
    return TIER_INFO[key] || null;
}

function tierPrefix(key) {
    const tier = getTierInfo(key);
    return tier ? `${tier.symbol} ` : "";
}

/* Colored username with the rank symbol beside it. No [RED] / [GOLD] text. */
function tierNameNode(name, key) {
    const span = document.createElement("span");
    span.className = "tier-name";
    const tier = getTierInfo(key);

    if (tier) {
        span.style.color = tier.color;
        span.textContent = `${tier.symbol} ${name}`;
    } else {
        span.textContent = name;
    }

    return span;
}

function setTierName(element, name, key) {
    if (!element) return;
    element.textContent = "";
    element.appendChild(tierNameNode(name, key));
}

function tierNameHtml(name, key) {
    const tier = getTierInfo(key);
    if (!tier) return escapeHtml(name);
    return `<span class="tier-name" style="color:${tier.color}">${tier.symbol} ${escapeHtml(name)}</span>`;
}

/* ---------- CSS for everything in this block ---------- */

(function injectProgressionCss() {
    if (document.getElementById("progressionCss")) return;
    const style = document.createElement("style");
    style.id = "progressionCss";
    style.textContent = `
        .tier-name { font-weight: 700; }
        body.has-custom-wallpaper {
            background-image: var(--custom-wallpaper) !important;
            background-size: cover !important;
            background-position: center !important;
            background-attachment: fixed !important;
        }
        .inv-tabs { display: flex; flex-wrap: wrap; gap: 8px; margin: 4px 0 14px; }
        .inv-tab { padding: 9px 14px; border-radius: 10px; border: 1px solid rgba(255,255,255,.18); background: rgba(255,255,255,.06); color: inherit; cursor: pointer; font: inherit; }
        .inv-tab.active { background: rgba(255,255,255,.2); border-color: rgba(255,255,255,.5); font-weight: 700; }
        .inv-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,.08); }
        .inv-row:last-child { border-bottom: 0; }
        .inv-row small { display: block; opacity: .7; margin-top: 2px; }
        .inv-actions { display: flex; gap: 8px; flex-wrap: wrap; }
        .inv-btn { padding: 7px 12px; border-radius: 9px; border: 1px solid rgba(255,255,255,.25); background: rgba(255,255,255,.08); color: inherit; cursor: pointer; font: inherit; font-size: .9em; }
        .inv-btn.primary { background: rgba(255,255,255,.22); font-weight: 700; }
        .inv-btn.danger { border-color: rgba(255,90,90,.6); }
        .inv-btn:disabled { opacity: .5; cursor: default; }
        .inv-locked { opacity: .55; }
        .inv-message { margin-top: 10px; min-height: 1.2em; font-size: .92em; }
        .inv-form { display: grid; gap: 8px; margin-bottom: 12px; }
        .inv-form input, .inv-form select { padding: 9px 10px; border-radius: 9px; border: 1px solid rgba(255,255,255,.25); background: rgba(0,0,0,.25); color: inherit; font: inherit; }
        .inv-thumb { width: 84px; height: 52px; border-radius: 8px; background-size: cover; background-position: center; border: 1px solid rgba(255,255,255,.25); flex: none; }
        .level-bar { height: 14px; border-radius: 8px; background: rgba(255,255,255,.12); overflow: hidden; margin: 8px 0; }
        .level-bar-fill { height: 100%; background: linear-gradient(90deg, #ffb300, #ff5a36); border-radius: 8px; transition: width .4s; }
        .tier-overlay, .levelup-overlay { position: fixed; inset: 0; z-index: 100000; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.72); padding: 16px; }
        .tier-card, .levelup-card { width: min(440px, 100%); max-height: 90vh; overflow: auto; border-radius: 16px; padding: 22px; background: rgba(18,18,24,.98); color: #fff; border: 1px solid rgba(255,255,255,.18); box-shadow: 0 20px 60px rgba(0,0,0,.6); }
        .tier-card h2, .levelup-card h2 { margin: 0 0 12px; }
        .tier-fact { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0; border-bottom: 1px solid rgba(255,255,255,.08); }
        .tier-preview { font-size: 1.6em; text-align: center; padding: 14px 0; }
        .tier-mock { margin: 6px 0; padding: 8px 12px; border-radius: 9px; background: rgba(255,255,255,.07); display: flex; justify-content: space-between; gap: 10px; }
        .tier-mock-label { opacity: .6; font-size: .8em; margin-top: 10px; }
        .tier-swatch { display: inline-block; width: 14px; height: 14px; border-radius: 50%; vertical-align: middle; margin-right: 6px; border: 1px solid rgba(255,255,255,.4); }
        .levelup-card { text-align: center; }
        .levelup-title { font-size: 2em; font-weight: 800; margin: 6px 0; }
        .levelup-reward { margin-top: 14px; padding: 12px; border-radius: 12px; background: rgba(255,255,255,.08); }
        .theme-choice { display: flex; gap: 10px; flex-wrap: wrap; }
        .theme-choice .inv-btn.active { background: rgba(255,255,255,.28); border-color: #fff; font-weight: 700; }
    `;
    document.head.appendChild(style);
})();

/* ---------- Load / refresh my progress from the server ---------- */

function requestMyProgress() {
    if (authState?.username) socket.emit("getMyProgress");
}

function refreshOwnTierName() {
    const name = $("accountInfoName");
    if (name && authState?.username) {
        setTierName(name, authState.username, myTierKey);
        appendUserBadge(name, myBadge);
    }
}

socket.on("myProgressData", data => {
    if (!data || !data.ok) {
        myProgress = null;
        myTierKey = null;
        applyWallpaper();
        return;
    }

    myProgress = data;
    myTierKey = data.shownTier || null;

    if (Array.isArray(data.levelUps) && data.levelUps.length) {
        pendingLevelUps.push(...data.levelUps);
    }

    applyWallpaper();
    refreshOwnTierName();

    if (progressSettingsOpen && ["inventory", "levelup", "ranks"].includes(settingsView)) {
        renderSettingsPage(settingsView);
    }

    maybeShowLevelUps();
});

socket.on("authResult", data => {
    if (data?.ok && !data.guest) {
        setTimeout(requestMyProgress, 300);
    } else {
        myProgress = null;
        myTierKey = null;
        applyWallpaper();
    }
});

/* Points / XP change when a game ends, so refresh then. */
socket.on("gameOver", () => {
    setTimeout(requestMyProgress, 1500);
    playEventSound("gameEnd");
});

/* ---------- Details popup for a rank tag ---------- */

function openTierDetails(key) {
    const tier = getTierInfo(key);
    if (!tier) return;

    const username = authState?.username || "Blood_Hunter";
    const preview = tierNameHtml(username, key);

    let overlay = $("tierDetailsOverlay");
    if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "tierDetailsOverlay";
        overlay.className = "tier-overlay";
        document.body.appendChild(overlay);
        overlay.addEventListener("click", event => {
            if (event.target === overlay || event.target.closest("[data-tier-close]")) overlay.style.display = "none";
        });
    }

    overlay.innerHTML = `
        <div class="tier-card">
            <h2>📋 ${tier.symbol} ${escapeHtml(tier.name)} Rank</h2>
            <div class="tier-fact"><span>Rank name</span><strong>${escapeHtml(tier.name)}</strong></div>
            <div class="tier-fact"><span>Shop price</span><strong>${tierPriceText(key)}</strong></div>
            <div class="tier-fact"><span>Rank symbol</span><strong>${tier.symbol}</strong></div>
            <div class="tier-fact"><span>Name color</span><strong><span class="tier-swatch" style="background:${tier.color}"></span>${tier.color.toUpperCase()}</strong></div>
            <div class="tier-preview">${preview}</div>
            <div class="tier-mock-label">How it looks in the game</div>
            <div class="tier-mock"><span>Lobby / player list</span><span>${preview}</span></div>
            <div class="tier-mock"><span>Leaderboard</span><span>#1 ${preview}</span></div>
            <div class="tier-mock"><span>Game screen</span><span>${preview}</span></div>
            <div style="margin-top:14px;text-align:right"><button class="inv-btn primary" type="button" data-tier-close="1">CLOSE</button></div>
        </div>
    `;
    overlay.style.display = "flex";
}

/* ---------- Level-up popup ---------- */

function maybeShowLevelUps() {
    if (!pendingLevelUps.length) return;
    if (currentPhase === "night" || currentPhase === "day") return;   // never interrupt a running game
    if ($("levelUpOverlay")?.style.display === "flex") return;

    const item = pendingLevelUps.shift();
    let overlay = $("levelUpOverlay");

    if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "levelUpOverlay";
        overlay.className = "levelup-overlay";
        document.body.appendChild(overlay);
        overlay.addEventListener("click", event => {
            if (event.target === overlay || event.target.closest("[data-levelup-close]")) {
                overlay.style.display = "none";
                setTimeout(maybeShowLevelUps, 200);
            }
        });
    }

    overlay.innerHTML = `
        <div class="levelup-card">
            <div class="levelup-title">🎉 LEVEL UP!</div>
            <p>You reached Level ${Number(item.level) || 0}!</p>
            ${item.reward ? `<div class="levelup-reward">🔓 New reward unlocked!<br><strong>${escapeHtml(item.reward.icon)} ${escapeHtml(item.reward.name)}</strong></div>` : ""}
            <div style="margin-top:16px"><button class="inv-btn primary" type="button" data-levelup-close="1">AWESOME</button></div>
        </div>
    `;
    overlay.style.display = "flex";
}
setInterval(maybeShowLevelUps, 3000);

/* ---------- Custom sounds (played only on the owner's device) ---------- */

function getEquippedSoundUrl(event) {
    const p = myProgress;
    if (!p || !p.equipped || !authState?.username) return null;
    const id = p.equipped.sounds?.[event];
    const item = id ? (p.sounds || []).find(s => s.id === id) : null;
    return item ? item.url : null;
}

/* One sound per game moment ("slot"): when the same moment fires again (every button click,
   every last-10 tick) the previous one is stopped first, so long sounds never pile up. */
const slotAudio = {};

function stopSlotSound(slot) {
    const old = slotAudio[slot];
    if (!old) return;
    try { old.audio.pause(); clearTimeout(old.timer); } catch (_) {}
    delete slotAudio[slot];
}

function playCustomSound(url, slot) {
    try {
        if (slot) stopSlotSound(slot);
        const audio = new Audio(url);
        const settings = getAudioSettings();
        audio.volume = settings.masterVolume * settings.soundEffectsVolume;
        const promise = audio.play();
        if (promise) promise.catch(() => {});
        // Hard 5-second limit, even if a longer file somehow got through.
        const timer = setTimeout(() => { try { audio.pause(); } catch (_) {} }, 5000);
        if (slot) slotAudio[slot] = { audio, timer };
    } catch (error) {
        console.warn("Custom sound error:", error);
    }
}

/* Plays the player's chosen sound for this event, otherwise the normal game sound. */
function playEventSound(event, fallback) {
    const shopSound = (typeof getEquippedShopSound === "function") ? getEquippedShopSound(event) : null;
    if (shopSound) {
        playShopSound(shopSound, event);
        return;
    }
    const url = getEquippedSoundUrl(event);
    if (url) {
        playCustomSound(url, event);
        return;
    }
    if (fallback) playGameSound(fallback);
}

function isMyRoleTurn(turn) {
    const role = String(myRole || "").trim().toLowerCase();
    if (turn === "mafia") return isMafiaTeamClient(myRole);
    if (turn === "doctor") return role === "doctor";
    if (turn === "detective") return role === "detective";
    if (turn === "cupid") return role === "cupid";
    if (window.MW_EXTRA_TURN_ROLES && window.MW_EXTRA_TURN_ROLES[turn]) return window.MW_EXTRA_TURN_ROLES[turn].toLowerCase() === role;
    return false;
}

let soundWatchPhase = "";
let soundWatchTurnKey = "";

socket.on("gameInformation", data => {
    if (!data) return;

    const phase = data.phase || "";

    if (phase === "day" && soundWatchPhase && soundWatchPhase !== "day") {
        playEventSound("votingStart");
    }

    if (phase === "night" && data.nightTurn) {
        const key = `${data.nightNumber}:${data.nightTurn}`;
        if (key !== soundWatchTurnKey) {
            soundWatchTurnKey = key;
            if (isMyRoleTurn(data.nightTurn)) playEventSound("turnStart");
        }
    } else if (phase !== "night") {
        soundWatchTurnKey = "";
    }

    soundWatchPhase = phase;
});

/* ---------- Custom wallpaper ---------- */

function getEquippedWallpaperUrl() {
    const p = myProgress;
    if (!p || !p.equipped || !authState?.username) return null;
    const item = p.equipped.wallpaper ? (p.wallpapers || []).find(w => w.id === p.equipped.wallpaper) : null;
    return item ? item.url : null;
}

function applyWallpaper() {
    const value = (typeof getEquippedWallpaperValue === "function") ? getEquippedWallpaperValue() : null;
    document.body.classList.toggle("has-custom-wallpaper", Boolean(value));
    if (value) document.body.style.setProperty("--custom-wallpaper", value);
    else document.body.style.removeProperty("--custom-wallpaper");
    if (typeof applyThemeLogos === "function") applyThemeLogos(loadMafiaSettings().theme);
}

/* ---------- Settings pages: Inventory, Level Up, Appearance ---------- */

var progressSettingsOpen = false;
let progressDelegationInstalled = false;

const originalOpenSettings = openSettings;
openSettings = function(view = "main") {
    progressSettingsOpen = true;
    requestMyProgress();
    originalOpenSettings(view);
};

const originalCloseSettings = closeSettings;
closeSettings = function() {
    progressSettingsOpen = false;
    originalCloseSettings();
};

function inventoryGuestHtml() {
    return `<div class="settings-card"><h3>👻 Guest</h3><p>Sign in or create an account to earn points, ranks and unlock your Inventory.</p></div>`;
}

function renderUploadedSoundsTab(p) {
    return "";
}

function renderUploadedWallpapersTab(p) {
    return "";
}

function renderRewardsTab(p) {
    const rows = (p.rewards || []).map(r => `<div class="inv-row"><div><strong>${escapeHtml(r.icon)} ${escapeHtml(r.name)}</strong><small>Level ${r.level} reward</small></div></div>`).join("")
        || `<div class="settings-muted">Level rewards you unlock will appear here.</div>`;
    return `<div class="settings-card"><h3>✨ Rewards & Future Unlocks</h3>${rows}</div>`;
}

function renderLevelUpPage(page) {
    let body;

    if (!authState?.username) {
        body = inventoryGuestHtml();
    } else if (!myProgress) {
        body = `<div class="settings-card"><p class="settings-muted">Loading your level…</p></div>`;
    } else {
        const p = myProgress;
        const percent = p.xpNeeded ? Math.min(100, Math.round((p.xpIntoLevel / p.xpNeeded) * 100)) : 100;
        const tierInfo = getTierInfo(p.shownTier);
        const upcoming = (p.upcomingRewards || []).map(r => `<div class="inv-row"><div><strong>${escapeHtml(r.icon)} ${escapeHtml(r.name)}</strong><small>Reaches at Level ${r.level}</small></div></div>`).join("")
            || `<div class="settings-muted">No more rewards planned yet.</div>`;

        body = `
            <div class="settings-card">
                <h3>⬆️ Level ${p.level}</h3>
                <div class="level-bar"><div class="level-bar-fill" style="width:${percent}%"></div></div>
                <div class="settings-row"><div><strong>XP</strong></div><div class="settings-value">${p.xpIntoLevel} / ${p.xpNeeded || "MAX"}</div></div>
                <div class="settings-row"><div><strong>XP needed for next level</strong></div><div class="settings-value">${p.xpNeeded ? p.xpNeeded - p.xpIntoLevel : 0}</div></div>
                <div class="settings-row"><div><strong>Next level</strong></div><div class="settings-value">${p.nextLevel ? "Level " + p.nextLevel : "Max level"}</div></div>
            </div>
            <div class="settings-card"><h3>🎁 Upcoming Rewards</h3>${upcoming}</div>
            <div class="settings-card">
                <div class="settings-row"><div><strong>Current points</strong></div><div class="settings-value">${p.points}</div></div>
                <div class="settings-row"><div><strong>Current rank</strong></div><div class="settings-value">${tierInfo ? tierNameHtml(p.username, p.shownTier) : "No rank yet"}</div></div>
                <small class="settings-muted">Levels use XP and are separate from your point rank.</small>
            </div>`;
    }

    page.innerHTML = settingsHeader("⬆️ LEVEL UP") + body;
}

function renderAppearancePage(page) {
    const st = loadMafiaSettings();
    const white = st.theme === "white";

    page.innerHTML = settingsHeader("🎨 APPEARANCE") + `
        <div class="settings-card">
            <h3>Theme</h3>
            <div class="theme-choice">
                <button class="inv-btn ${white ? "" : "active"}" type="button" data-theme-pick="noir">🌙 Dark Theme</button>
                <button class="inv-btn ${white ? "active" : ""}" type="button" data-theme-pick="white">☀️ White Theme</button>
            </div>
            <small class="settings-muted">Dark keeps the current Mafia Wars look. White uses the blue / white UI.</small>
        </div>
        <div class="settings-card">
            <div class="settings-row"><div><strong>UI Effects</strong><small>Enable hover, glow and interface effects.</small></div><input class="settings-switch" type="checkbox" data-setting="uiEffects" ${st.uiEffects ? "checked" : ""}></div>
            <div class="settings-row"><div><strong>Animations</strong><small>Enable normal interface transitions.</small></div><input class="settings-switch" type="checkbox" data-setting="animations" ${st.animations ? "checked" : ""}></div>
            <div class="settings-row"><div><strong>Reduce Motion</strong><small>Reduce interface movement and transitions.</small></div><input class="settings-switch" type="checkbox" data-setting="reduceMotion" ${st.reduceMotion ? "checked" : ""}></div>
        </div>
    `;

    page.querySelectorAll("[data-theme-pick]").forEach(button =>
        button.addEventListener("click", () => updateMafiaSetting("theme", button.dataset.themePick))
    );
    page.querySelectorAll("[data-setting]").forEach(input =>
        input.addEventListener("change", () => updateMafiaSetting(input.dataset.setting, input.checked))
    );
}

/* Extra cards inside Ranks & Progress: Level Up button + rank list with Details. */
function addRankProgressCards(page) {
    const anchor = $("settingsMyPoints")?.closest(".settings-card");
    if (!anchor) return;

    const username = authState?.username || "Blood_Hunter";
    const tierRows = TIER_ORDER.map(key => {
        const tier = TIER_INFO[key];
        const reached = myProgress ? (myProgress.unlockedTiers || []).includes(key) : false;
        return `<div class="inv-row ${reached ? "" : "inv-locked"}">
            <div>${tierNameHtml(username, key)}<small>${reached ? "✅ owned" : "🛍️ " + tierPriceText(key) + " in the Shop"}</small></div>
            <div class="inv-actions"><button class="inv-btn" type="button" data-inv="tier-details" data-key="${key}">Details</button></div>
        </div>`;
    }).join("");

    anchor.insertAdjacentHTML("afterend", `
        <div class="settings-card">
            <button class="settings-option settings-category" type="button" data-inv="open-levelup" style="width:100%">
                <span class="settings-icon">⬆️</span><span class="settings-copy"><strong>Level Up</strong><span>${myProgress ? "Level " + myProgress.level : "Level, XP and rewards"}</span></span>
            </button>
        </div>
        <div class="settings-card"><h3>🏅 Rank Tags</h3>${tierRows}</div>
    `);
}

const originalRenderSettingsPage = renderSettingsPage;
renderSettingsPage = function(view) {
    const page = $("settingsPage");
    if (!page) return originalRenderSettingsPage(view);

    if (!progressDelegationInstalled) {
        progressDelegationInstalled = true;
        page.addEventListener("click", handleProgressClick);
    }

    if (view === "inventory" || view === "levelup" || view === "appearance") {
        // Keep the existing Account controls safe (same rule the original page follows).
        const accountInfo = $("accountInfo");
        const accountChip = $("accountChip");
        if (accountInfo && accountChip && accountInfo.parentElement !== accountChip) {
            accountChip.appendChild(accountInfo);
            accountInfo.style.display = "none";
        }

        if (view === "inventory") renderInventoryPage(page);
        else if (view === "levelup") renderLevelUpPage(page);
        else renderAppearancePage(page);

        $("settingsBack")?.addEventListener("click", () => settingsNav(view === "levelup" ? "ranks" : "main"));
        $("settingsClose")?.addEventListener("click", closeSettings);
        return;
    }

    originalRenderSettingsPage(view);

    if (view === "main") {
        const grid = page.querySelector(".settings-grid");
        if (grid) {
            const add = (icon, title, text, target) => {
                const button = document.createElement("button");
                button.type = "button";
                button.className = "settings-option settings-category";
                button.innerHTML = `<span class="settings-icon">${icon}</span><span class="settings-copy"><strong>${title}</strong><span>${text}</span></span>`;
                button.addEventListener("click", () => settingsNav(target));
                grid.appendChild(button);
            };
            add("🛍️", "Shop", "Spend points on items, tags, wallpapers, sounds and logos", "rewards");
            add("🎒", "Inventory", "Equip your character, tags, sounds, wallpapers and logos", "inventory");
            add("🎨", "Appearance", "Dark or White theme", "appearance");
            if (myBadge === "owner") add("💰", "Shop Management", "Owner: set the price of any shop item", "shopadmin");
        }
    } else if (view === "ranks") {
        addRankProgressCards(page);
    }
};

function inventoryNotice(text) {
    inventoryMessage = text || "";
    const box = $("invMessage");
    if (box) box.textContent = inventoryMessage;
}

function getAudioDuration(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const audio = new Audio();
        audio.preload = "metadata";
        const finish = (fn, value) => { URL.revokeObjectURL(url); fn(value); };
        audio.onloadedmetadata = () => {
            if (Number.isFinite(audio.duration)) finish(resolve, audio.duration);
            else finish(reject, new Error("Could not read the sound length."));
        };
        audio.onerror = () => finish(reject, new Error("Your browser can't play this file."));
        audio.src = url;
    });
}

function inventoryEmit(eventName, payload, successText) {
    socket.emit(eventName, payload, result => {
        inventoryNotice(result?.ok ? (successText || "Done.") : (result?.error || "Something went wrong."));
    });
}

async function handleProgressClick(event) {
    const target = event.target.closest("[data-inv]");
    if (!target) return;

    const action = target.dataset.inv;

    if (action === "tab") {
        inventoryTab = target.dataset.key;
        inventoryMessage = "";
        renderSettingsPage("inventory");
    } else if (action === "tier-details") {
        openTierDetails(target.dataset.key);
    } else if (action === "open-levelup") {
        settingsNav("levelup");
    } else if (action === "equip-tier") {
        inventoryEmit("equipTier", { tier: target.dataset.key }, "Rank tag updated.");
    } else if (action === "play-sound") {
        playCustomSound(target.dataset.url);
    } else if (action === "equip-sound") {
        inventoryEmit("equipSound", { id: target.dataset.id, equip: target.dataset.equip === "1" }, "Sound updated.");
    } else if (action === "delete-sound") {
        inventoryEmit("deleteSound", { id: target.dataset.id }, "Sound deleted.");
    } else if (action === "equip-wallpaper") {
        inventoryEmit("equipWallpaper", { id: target.dataset.id || null }, "Wallpaper updated.");
    } else if (action === "delete-wallpaper") {
        inventoryEmit("deleteWallpaper", { id: target.dataset.id }, "Wallpaper deleted.");
    } else if (action === "upload-sound") {
        const file = $("invSoundFile")?.files?.[0];
        if (!file) return inventoryNotice("Choose a sound file first.");
        if (file.size > 1200 * 1024) return inventoryNotice("That file is too large. Use a short clip.");

        try {
            const duration = await getAudioDuration(file);
            if (duration > 5.05) return inventoryNotice(`Sound is ${duration.toFixed(1)}s. Maximum is 5 seconds.`);
        } catch (error) {
            return inventoryNotice(error.message || "Could not read this sound.");
        }

        inventoryNotice("Uploading…");
        inventoryEmit("uploadSound", {
            name: $("invSoundName")?.value || "",
            event: $("invSoundEvent")?.value || "",
            bytes: await file.arrayBuffer()
        }, "Sound added.");
    } else if (action === "upload-wallpaper") {
        const file = $("invWallpaperFile")?.files?.[0];
        if (!file) return inventoryNotice("Choose an image first.");
        if (file.size > 4 * 1024 * 1024) return inventoryNotice("Image is too large (4 MB max).");

        inventoryNotice("Uploading…");
        inventoryEmit("uploadWallpaper", {
            name: $("invWallpaperName")?.value || "",
            bytes: await file.arrayBuffer()
        }, "Wallpaper added.");
    }
}

/* If the page was reloaded while signed in, authResult will load progress. */
if (authState?.username) setTimeout(requestMyProgress, 500);


/* =========================================================
   SHOP (buy) + INVENTORY (equip) + CHARACTER + OWNER PRICES
   - The SERVER decides prices, balance and ownership. This block only
     shows them and sends the player's choices.
   - Avatar art, prices and names all come from the server catalog, so
     new items are added in server.js only (one line each).
========================================================= */

const DEFAULT_LOOK = { face: "face_basic", tone: null, hair: null, shirt: "shirt_basic", suit: null, pants: "pants_basic", shoes: "shoes_basic", hat: null, mask: null, accessory: null };
const OPTIONAL_SLOTS = ["tone", "hair", "suit", "hat", "mask", "accessory"];

var shopCatalog = null;                 // { items, categories, slots, ... } from the server
var shopItemMap = new Map();
var shopGroup = "character";            // Shop tab: character | tag | wallpaper | sound
var shopSlot = "face";                  // Shop: which character category is open
var shopCharacterStyle = "current";      // current | minecraft
var minecraftSkinSelection = null;        // skin being tried on in the shop
const MINECRAFT_SKINS = [
    ["clownpierce", "ClownPierce"], ["flamefrags", "FlameFrags"], ["gloden king", "Golden King"],
    ["jaden_man", "Jaden Man"], ["jamatop", "Jamatop"], ["mafia", "Mafia"], ["manepear", "ManePear"],
    ["minetech", "MineTech"], ["ninja", "Ninja"], ["parrot", "Parrot"], ["parrotx2 king", "ParrotX2 King"],
    ["spoke", "Spoke"], ["steve", "Steve"], ["technoblade", "Technoblade"], ["theobalthebird", "TheobaldTheBird"],
    ["warroir", "Warrior"], ["wemmbu tech", "Wemmbu Tech"], ["wemmbu", "Wemmbu"], ["wifize", "Wifize"], ["wizerd", "Wizard"]
];
var shopPreviewLook = null;             // "Try on" preview (never saved)
var shopMessage = "";
var inventorySlot = "face";             // Inventory: which character category is open
var shopAdminCat = "tag";               // Owner panel: which category is open
var shopAdminMessage = "";

/* ---------- Catalog ---------- */

function loadShopCatalog() {
    socket.emit("getShopCatalog", result => {
        if (!result || !result.ok) return;
        shopCatalog = result;
        shopItemMap = new Map(result.items.map(item => [item.id, item]));
        hydrateAvatars(document);
        applyWallpaper();
        rerenderShopPages();
    });
}

if (socket.connected) loadShopCatalog();
socket.on("connect", loadShopCatalog);

socket.on("shopPricesUpdated", data => {
    if (!data || !data.prices || !shopCatalog) return;
    shopCatalog.items.forEach(item => {
        if (data.prices[item.id] !== undefined) item.price = data.prices[item.id];
    });
    if (progressSettingsOpen && settingsView === "rewards") renderSettingsPage("rewards");
});

function shopItem(id) {
    return id ? (shopItemMap.get(id) || null) : null;
}

function shopOwned(id) {
    const item = shopItem(id);
    if (!item) return false;
    return item.free || (myProgress?.ownedItems || []).includes(id);
}

function shopItemsIn(cat) {
    return (shopCatalog?.items || []).filter(item => item.cat === cat);
}

function shopCategory(key) {
    return (shopCatalog?.categories || []).find(c => c.key === key) || { key, label: key, icon: "" };
}

function rerenderShopPages() {
    if (progressSettingsOpen && ["inventory", "rewards"].includes(settingsView)) renderSettingsPage(settingsView);
}

/* ---------- Avatar (SVG body parts + emoji items) ---------- */

function avatarLayer(item) {
    if (!item) return "";
    if (item.art) return item.art;
    if (item.emoji) {
        const e = item.emoji;
        return `<text x="${e.x}" y="${e.y}" font-size="${e.s}" text-anchor="middle">${e.t}</text>`;
    }
    return "";
}

/* Roblox-style 3D block: a light top face + a dark side face drawn next to a front face. */
function blockEdges(x, y, w, h, d, sideOnly) {
    d = d || 4;
    const top = sideOnly ? "" : `<polygon points="${x},${y} ${x + w},${y} ${x + w + d},${y - d} ${x + d},${y - d}" fill="#fff" opacity=".24"/>`;
    const side = `<polygon points="${x + w},${y} ${x + w + d},${y - d} ${x + w + d},${y + h - d} ${x + w},${y + h}" fill="#000" opacity=".32"/>`;
    return top + side;
}

function avatarMarkup(look, bust) {
    const wear = Object.assign({}, DEFAULT_LOOK, look || {});
    const face = shopItem(wear.face) || shopItem("face_basic");
    // A bought Skin Tone (shop -> Skin Tones) overrides the face's own skin color.
    const tone = shopItem(wear.tone);
    const skin = (tone && tone.skin) || (face && face.skin) || "#f1c27d";

    const parts = [
        avatarLayer(shopItem(wear.pants) || shopItem("pants_basic")),
        blockEdges(31, 96, 17, 36, 4) + blockEdges(52, 96, 17, 36, 4),
        avatarLayer(shopItem(wear.shoes) || shopItem("shoes_basic")),
        blockEdges(50, 130, 21, 9, 3, true),
        `<rect x="17" y="62" width="11" height="40" rx="2" fill="${skin}"/><rect x="72" y="62" width="11" height="40" rx="2" fill="${skin}"/><rect x="44" y="50" width="12" height="14" fill="${skin}"/>`,
        avatarLayer(shopItem(wear.shirt) || shopItem("shirt_basic")),
        avatarLayer(shopItem(wear.suit)),
        `<rect x="28" y="60" width="5" height="42" fill="#fff" opacity=".12"/><rect x="66" y="60" width="6" height="42" fill="#000" opacity=".22"/>` +
            blockEdges(71, 62, 14, 24, 4) + blockEdges(15, 62, 14, 24, 4) + blockEdges(72, 86, 11, 16, 4, true),
        `<rect x="30" y="16" width="40" height="40" rx="5" fill="${skin}"/>` + blockEdges(30, 16, 40, 40, 5),
        avatarLayer(face),
        avatarLayer(shopItem(wear.hair)),
        avatarLayer(shopItem(wear.mask)),
        avatarLayer(shopItem(wear.accessory)),
        avatarLayer(shopItem(wear.hat))
    ];

    const viewBox = bust ? "8 -4 84 88" : "0 -8 100 148";

    /* Minecraft style: show the skin picture instead of the normal character.
       If the picture cannot load, the normal character is shown instead. */
    if (wear.minecraft) {
        const src = "/skins/" + encodeURIComponent(String(wear.minecraft)) + ".png";
        const box = bust ? 'x="8" y="-4" width="84" height="88" preserveAspectRatio="xMidYMin slice"' : 'x="0" y="-8" width="100" height="148" preserveAspectRatio="xMidYMid meet"';
        return `<svg viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><g class="mc-fallback" style="display:none">${parts.join("")}</g><image href="${src}" ${box} style="image-rendering:pixelated" onerror="var g=this.parentNode.querySelector('.mc-fallback');if(g)g.style.display='';this.remove()"/></svg>`;
    }

    return `<svg viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${parts.join("")}</svg>`;
}

/* A small avatar element for lists (lobby, player list, details). */
function avatarNode(look, size, bust) {
    const span = document.createElement("span");
    span.className = "mw-avatar";
    span.style.width = size + "px";
    span.style.height = Math.round(bust ? size * 88 / 84 : size * 148 / 100) + "px";
    span.dataset.look = JSON.stringify(look || null);
    span.dataset.bust = bust ? "1" : "";
    if (shopCatalog) span.innerHTML = avatarMarkup(look, bust);
    return span;
}

function hydrateAvatars(root) {
    if (!shopCatalog) return;
    (root || document).querySelectorAll(".mw-avatar").forEach(el => {
        if (el.dataset.look === undefined) return;
        let look = null;
        try { look = JSON.parse(el.dataset.look); } catch (_) { /* default look */ }
        el.innerHTML = avatarMarkup(look, el.dataset.bust === "1");
    });
}

function avatarHtml(look, size, bust) {
    const height = Math.round(bust ? size * 88 / 84 : size * 148 / 100);
    return `<span class="mw-avatar" data-look="${escapeHtml(JSON.stringify(look || null))}" data-bust="${bust ? "1" : ""}" style="width:${size}px;height:${height}px">${shopCatalog ? avatarMarkup(look, bust) : ""}</span>`;
}

/* Big character picture inside the Ranks -> Details popup. */
function showDetailsAvatar(look) {
    const nameEl = $("ranksDetailsName");
    if (!nameEl || !nameEl.parentElement) return;

    let box = $("ranksDetailsAvatar");
    if (!box) {
        box = document.createElement("div");
        box.id = "ranksDetailsAvatar";
        box.style.cssText = "display:flex;justify-content:center;margin:6px 0 10px";
        nameEl.parentElement.insertBefore(box, nameEl);
    }
    box.innerHTML = avatarHtml(look, 120, false);
}

function tierPriceText(key) {
    const item = shopItem("tag_" + key);
    return item ? "💰 " + Number(item.price).toLocaleString() : "—";
}

function myLook() {
    return Object.assign({}, DEFAULT_LOOK, myProgress?.look || {});
}

/* The normal character without the Minecraft skin (used when previewing normal items). */
function myNormalLook() {
    const look = myLook();
    delete look.minecraft;
    return look;
}

var inventoryCharView = null;   // Inventory -> Character: "current" | "minecraft" (null = whatever is equipped)

/* ---------- Built-in shop sounds (WebAudio, no files needed) ---------- */

var shopAudioCtx = null;

function shopAudio() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!shopAudioCtx) shopAudioCtx = new Ctx();
    if (shopAudioCtx.state === "suspended") shopAudioCtx.resume();
    return shopAudioCtx;
}

function synthTone(ctx, vol, o) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const t0 = ctx.currentTime + (o.at || 0);
    osc.type = o.type || "sine";
    osc.frequency.setValueAtTime(o.f0, t0);
    if (o.f1) osc.frequency.exponentialRampToValueAtTime(o.f1, t0 + o.dur);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, (o.gain || 0.3) * vol), t0 + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + o.dur + 0.05);
}

function synthNoise(ctx, vol, o) {
    const length = Math.floor(ctx.sampleRate * o.dur);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length);

    const source = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    source.buffer = buffer;
    filter.type = "lowpass";
    filter.frequency.value = o.cutoff || 3000;
    gain.gain.value = (o.gain || 0.6) * vol;
    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(ctx.currentTime + (o.at || 0));
}

const SHOP_SYNTH = {
    snd_chime: (c, v) => {
        synthTone(c, v, { f0: 880, dur: 0.9, gain: 0.35 });
        synthTone(c, v, { f0: 1320, at: 0.12, dur: 1.0, gain: 0.3 });
    },
    snd_coin: (c, v) => {
        synthTone(c, v, { type: "square", f0: 988, dur: 0.1, gain: 0.18 });
        synthTone(c, v, { type: "square", f0: 1319, at: 0.09, dur: 0.45, gain: 0.18 });
    },
    snd_horn: (c, v) => {
        synthTone(c, v, { type: "sawtooth", f0: 220, dur: 0.7, gain: 0.22 });
        synthTone(c, v, { type: "sawtooth", f0: 277, dur: 0.7, gain: 0.22 });
    },
    snd_heartbeat: (c, v) => {
        [0, 0.28, 1.0, 1.28].forEach((at, i) => synthTone(c, v, { f0: i % 2 ? 55 : 70, f1: 38, at, dur: 0.22, gain: 0.9 }));
    },
    snd_bell: (c, v) => {
        synthTone(c, v, { f0: 392, dur: 2.2, gain: 0.35 });
        synthTone(c, v, { f0: 588, dur: 1.6, gain: 0.18 });
        synthTone(c, v, { f0: 1046, dur: 1.0, gain: 0.1 });
    },
    snd_siren: (c, v) => {
        [0, 0.6, 1.2].forEach((at, i) => synthTone(c, v, { type: "triangle", f0: i % 2 ? 950 : 620, f1: i % 2 ? 620 : 950, at, dur: 0.6, gain: 0.25 }));
    },
    snd_gunshot: (c, v) => {
        synthNoise(c, v, { dur: 0.28, cutoff: 5000, gain: 0.9 });
        synthTone(c, v, { f0: 140, f1: 40, dur: 0.25, gain: 0.8 });
    }
};

/* The game's ORIGINAL sounds. Players can pick these for any moment too
   (for example use the Button Click sound for a new round). */
const DEFAULT_SOUND_ITEMS = [
    { id: "def_button",   cat: "sound", name: "Button Click",    icon: "🖱️", url: "/sounds/button-click.mp3",       original: "buttonClick" },
    { id: "def_death",    cat: "sound", name: "Player Dead",     icon: "💀", url: "/sounds/player-dead.mp3",        original: "playerDeath" },
    { id: "def_newround", cat: "sound", name: "New Round",       icon: "🌙", url: "/sounds/new-round.mp3",          original: "roundStart" },
    { id: "def_last10",   cat: "sound", name: "Last 10 Seconds", icon: "⏱️", url: "/sounds/last-10-heartbeat.mp3",  original: "last10" },
    { id: "def_turnover", cat: "sound", name: "Turn Over",       icon: "🔔", url: "/sounds/turn-over.mp3",          original: "turnOver" }
];

function defaultSoundItem(id) {
    return DEFAULT_SOUND_ITEMS.find(item => item.id === id) || null;
}

function playShopSound(item, slot) {
    if (!item) return;
    if (item.url) { playCustomSound(item.url, slot); return; }

    const synth = SHOP_SYNTH[item.id];
    const ctx = synth ? shopAudio() : null;
    if (!ctx) return;

    try {
        const settings = getAudioSettings();
        synth(ctx, Math.min(1, settings.masterVolume * settings.soundEffectsVolume));
    } catch (error) {
        console.warn("Shop sound error:", error);
    }
}

function getEquippedShopSound(event) {
    if (!myProgress || !authState?.username) return null;
    const id = myProgress.equipped?.sounds?.[event];
    if (id && String(id).startsWith("def_")) return defaultSoundItem(id);   // original game sounds need no purchase
    const item = id && String(id).startsWith("snd_") ? shopItem(id) : null;
    return item && shopOwned(item.id) ? item : null;
}

/* ---------- Wallpaper (uploaded images OR bought gradients/images) ---------- */

function getEquippedWallpaperValue() {
    const p = myProgress;
    if (!p || !p.equipped || !authState?.username || !p.equipped.wallpaper) return null;

    const id = p.equipped.wallpaper;
    const upload = (p.wallpapers || []).find(w => w.id === id);
    if (upload) return `url("${upload.url}")`;

    const item = shopItem(id);
    if (item && shopOwned(id)) return item.css ? item.css : (item.url ? `url("${item.url}")` : null);

    return null;
}

function getEquippedLogoUrl() {
    const p = myProgress;
    if (!p || !p.equipped || !authState?.username || !p.equipped.logo) return null;
    const item = shopItem(p.equipped.logo);
    return item && item.cat === "logo" && shopOwned(item.id) && item.url ? item.url : null;
}

/* ---------- Small messages ---------- */

function shopNotice(text) {
    shopMessage = text || "";
    const box = $("shopMessage");
    if (box) box.textContent = shopMessage;
}

function showShopToast(text) {
    let toast = $("shopToast");
    if (!toast) {
        toast = document.createElement("div");
        toast.id = "shopToast";
        document.body.appendChild(toast);
    }
    toast.textContent = text;
    toast.classList.add("show");
    clearTimeout(showShopToast.timer);
    showShopToast.timer = setTimeout(() => toast.classList.remove("show"), 5000);
}

socket.on("shopReward", data => {
    if (!data) return;
    showShopToast(`💰 +${data.earned} shop points (${data.won ? "win" : "loss"})`);
    setTimeout(requestMyProgress, 800);
});

/* ---------- "Where should this sound play?" popup (right after buying a sound) ---------- */

const SOUND_EVENT_HINTS = {
    buttonClick: "You press any button",
    last10: "The last 10 seconds of a turn",
    roundStart: "A new round begins",
    turnStart: "The next turn starts",
    turnOver: "A turn ends",
    votingStart: "Voting begins",
    gameEnd: "The game is over",
    playerDeath: "A player dies"
};

/* editMode = true  -> opened from the ✏️ Edit button (can be used again and again; boxes show where it plays now)
   editMode = false -> opened right after buying.
   Works for bought sounds AND the game's original sounds. */
function openSoundEventPopup(item, editMode) {
    closeSoundEventPopup();
    const events = (myProgress?.soundEvents && myProgress.soundEvents.length) ? myProgress.soundEvents : Object.keys(SOUND_EVENT_LABELS);
    const equipped = myProgress?.equipped?.sounds || {};
    // An original sound that nobody replaced is still playing on its own moment, so show that box ticked.
    const isOn = ev => equipped[ev] === item.id || (Boolean(item.original) && item.original === ev && !equipped[ev]);

    const overlay = document.createElement("div");
    overlay.id = "soundEventPopup";
    overlay.className = "mw-modal-overlay";
    overlay.innerHTML = `
        <div class="mw-modal" role="dialog" aria-modal="true">
            <h3>${escapeHtml(item.icon || "🔊")} ${editMode ? "Edit " + escapeHtml(item.name) : escapeHtml(item.name) + " is yours!"}</h3>
            <p class="settings-muted">${editMode ? "Choose where this sound plays. You can change it any time." : "When should this sound play? Pick one or more."}</p>
            <div class="mw-modal-list">
                ${events.map(ev => `
                    <label class="mw-modal-option">
                        <input type="checkbox" value="${ev}" ${editMode && isOn(ev) ? "checked" : ""}>
                        <span><strong>${escapeHtml(SOUND_EVENT_LABELS[ev] || ev)}</strong><small>${escapeHtml(SOUND_EVENT_HINTS[ev] || "")}${equipped[ev] && equipped[ev] !== item.id ? " · now: " + escapeHtml((shopItem(equipped[ev]) || defaultSoundItem(equipped[ev]) || {}).name || "another sound") : ""}</small></span>
                    </label>`).join("")}
            </div>
            <div class="mw-modal-message" id="soundEventPopupMsg"></div>
            <div class="mw-modal-actions">
                <button class="inv-btn" type="button" data-popup="play">▶ Play</button>
                <button class="inv-btn" type="button" data-popup="later">Later</button>
                <button class="inv-btn primary" type="button" data-popup="save">Save</button>
            </div>
        </div>`;

    overlay.addEventListener("click", event => {
        if (event.target === overlay) return closeSoundEventPopup();
        const btn = event.target.closest("[data-popup]");
        if (!btn) return;

        if (btn.dataset.popup === "play") {
            playShopSound(item);
        } else if (btn.dataset.popup === "later") {
            closeSoundEventPopup();
        } else if (btn.dataset.popup === "save") {
            const chosen = Array.from(overlay.querySelectorAll("input[type=checkbox]:checked")).map(box => box.value);
            const msg = overlay.querySelector("#soundEventPopupMsg");
            if (!chosen.length && !editMode) { msg.textContent = "Pick at least one moment, or press Later."; return; }

            btn.disabled = true;
            // One call sets exactly where this sound plays (anything unticked is removed from this sound).
            socket.emit("setSoundEvents", { id: item.id, events: chosen }, result => {
                if (!result?.ok) { msg.textContent = result?.error || "Could not save."; btn.disabled = false; return; }
                closeSoundEventPopup();
                const text = chosen.length ? `🔊 ${item.name} will play on: ${chosen.map(ev => SOUND_EVENT_LABELS[ev] || ev).join(", ")}.` : `🔊 ${item.name} is not used on any moment now.`;
                if (typeof shopNotice === "function") shopNotice(text);
                if (typeof inventoryNotice === "function") inventoryNotice(text);
                showShopToast(`🔊 ${item.name} saved`);
            });
        }
    });

    document.body.appendChild(overlay);
}

function closeSoundEventPopup() {
    const old = document.getElementById("soundEventPopup");
    if (old) old.remove();
}

/* ---------- Details popup for wallpapers and logos (big picture) ---------- */

function openItemDetailsPopup(item) {
    if (!item) return;
    closeItemDetailsPopup();

    const owned = shopOwned(item.id);
    const isLogo = item.cat === "logo";
    const active = myProgress?.equipped?.[isLogo ? "logo" : "wallpaper"] === item.id;
    const status = item.free ? "Default" : (active ? "✅ Equipped" : (owned ? "✅ Owned" : "Not owned yet"));

    const overlay = document.createElement("div");
    overlay.id = "itemDetailsPopup";
    overlay.className = "mw-modal-overlay";
    overlay.innerHTML = `
        <div class="mw-modal mw-modal-wide" role="dialog" aria-modal="true">
            <h3>${isLogo ? "📛" : "🖼️"} ${escapeHtml(item.name)}</h3>
            <div class="mw-detail-img ${isLogo ? "logo" : "wall"}">${shopImageHtml(item, isLogo ? "contain" : "cover")}</div>
            <p class="mw-detail-meta"><span>${escapeHtml(isLogo ? "Logo" : "Wallpaper")}</span><span>${priceLabel(item)}</span><span>${status}</span></p>
            <div class="mw-modal-actions"><button class="inv-btn primary" type="button" data-popup="close">Close</button></div>
        </div>`;

    overlay.addEventListener("click", event => {
        if (event.target === overlay || event.target.closest("[data-popup='close']")) closeItemDetailsPopup();
    });

    document.body.appendChild(overlay);

    // If the picture can't be loaded, say exactly which file the page asked for.
    if (item.url) {
        const probe = new Image();
        probe.onerror = () => {
            const note = document.createElement("p");
            note.className = "mw-modal-message";
            note.textContent = `Picture not found: ${item.url}  (put your file in the "public" folder at that path, then refresh with Ctrl+F5)`;
            const meta = overlay.querySelector(".mw-detail-meta");
            if (meta) meta.after(note);
        };
        probe.src = item.url;
    }
}

function closeItemDetailsPopup() {
    const old = document.getElementById("itemDetailsPopup");
    if (old) old.remove();
}

document.addEventListener("keydown", event => {
    if (event.key === "Escape") { closeItemDetailsPopup(); closeSoundEventPopup(); }
});

/* ---------- CSS ---------- */

(function injectShopCss() {
    if (document.getElementById("shopCss")) return;
    const style = document.createElement("style");
    style.id = "shopCss";
    style.textContent = `
        .mw-avatar { display: inline-block; vertical-align: middle; flex: none; margin-right: 6px; line-height: 0; }
        .mw-avatar svg { width: 100%; height: 100%; display: block; overflow: visible; }
        .shop-wallet { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
        .shop-wallet strong { font-size: 1.5em; }
        .shop-chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 4px 0 12px; }
        .shop-chip { padding: 6px 11px; border-radius: 999px; border: 1px solid rgba(255,255,255,.2); background: rgba(255,255,255,.06); color: inherit; cursor: pointer; font: inherit; font-size: .88em; }
        .shop-chip.active { background: rgba(255,255,255,.22); border-color: rgba(255,255,255,.55); font-weight: 700; }
        .shop-preview { display: flex; align-items: center; justify-content: center; gap: 16px; padding: 10px 0 4px; flex-wrap: wrap; }
        .shop-preview .mw-avatar { margin: 0; }
        .shop-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(138px, 1fr)); gap: 10px; }
        .shop-card { display: flex; flex-direction: column; align-items: center; gap: 4px; text-align: center; padding: 10px 8px; border-radius: 12px; border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.05); }
        .shop-card.owned { border-color: rgba(90,220,140,.55); }
        .shop-card.equipped { border-color: rgba(255,210,63,.8); box-shadow: 0 0 0 1px rgba(255,210,63,.45) inset; }
        .shop-thumb { width: 100%; height: 92px; display: flex; align-items: center; justify-content: center; border-radius: 9px; overflow: hidden; background: rgba(0,0,0,.28); font-size: 1.05em; padding: 4px; box-sizing: border-box; }
        .shop-thumb .mw-avatar { margin: 0; }
        .shop-thumb.wall { padding: 0; background-size: cover; background-position: center; }
        .shop-thumb.sound { font-size: 2.2em; }
        .shop-card small { opacity: .75; }
        .shop-price { font-weight: 700; }
        .shop-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: center; margin-top: 2px; }
        .shop-message { margin-top: 10px; min-height: 1.2em; font-size: .92em; }
        .shop-admin-row { display: grid; grid-template-columns: 1fr auto; gap: 6px 10px; align-items: center; padding: 9px 0; border-bottom: 1px solid rgba(255,255,255,.08); }
        .shop-admin-row:last-child { border-bottom: 0; }
        .shop-admin-row input[type=number] { width: 110px; padding: 7px 9px; border-radius: 8px; border: 1px solid rgba(255,255,255,.25); background: rgba(0,0,0,.25); color: inherit; font: inherit; }
        .shop-admin-controls { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
        .shop-thumb.wall, .shop-thumb.logo { padding: 0; }
        .shop-thumb.logo { padding: 6px; }
        .shop-img { width: 100%; height: 100%; display: block; }
        .shop-img.cover { object-fit: cover; }
        .shop-img.contain { object-fit: contain; }
        .shop-img-missing { font-size: 2em; opacity: .5; }
        .shop-img-css { width: 100%; height: 100%; background-size: cover; background-position: center; }
        .mw-modal-overlay { position: fixed; inset: 0; z-index: 100002; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(0,0,0,.72); }
        .mw-modal { width: min(420px, 100%); max-height: 90vh; overflow: auto; padding: 18px; border-radius: 14px; background: #120a0a; color: #f3e9e9; border: 1px solid rgba(255,60,60,.55); box-shadow: 0 16px 50px rgba(0,0,0,.7), 0 0 24px rgba(200,0,0,.25); }
        .mw-modal h3 { margin: 0 0 6px; }
        .mw-modal-wide { width: min(640px, 100%); }
        .mw-detail-img { width: 100%; border-radius: 12px; overflow: hidden; background: rgba(0,0,0,.4); border: 1px solid rgba(255,255,255,.12); display: flex; align-items: center; justify-content: center; margin: 10px 0; }
        .mw-detail-img.wall { aspect-ratio: 16 / 9; }
        .mw-detail-img.logo { height: min(52vh, 380px); padding: 12px; box-sizing: border-box; }
        .mw-detail-img .shop-img { width: 100%; height: 100%; }
        .mw-detail-img .shop-img-missing { font-size: 4em; }
        .mw-detail-meta { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin: 6px 0; opacity: .9; }
        .mw-modal-list { display: flex; flex-direction: column; gap: 6px; margin: 12px 0 8px; }
        .mw-modal-option { display: flex; align-items: center; gap: 10px; padding: 9px 11px; border-radius: 10px; border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.05); cursor: pointer; }
        .mw-modal-option:hover { border-color: rgba(255,80,80,.6); }
        .mw-modal-option input { width: 18px; height: 18px; accent-color: #c1121f; flex: none; }
        .mw-modal-option small { display: block; opacity: .7; }
        .mw-modal-message { min-height: 1.2em; font-size: .9em; color: #ff8a8a; }
        .mw-modal-actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; margin-top: 8px; }
        #shopToast { position: fixed; left: 50%; bottom: 26px; transform: translate(-50%, 30px); opacity: 0; pointer-events: none; z-index: 100001; padding: 11px 18px; border-radius: 12px; background: rgba(18,18,24,.96); color: #fff; border: 1px solid rgba(255,210,63,.6); box-shadow: 0 10px 30px rgba(0,0,0,.5); transition: opacity .3s, transform .3s; max-width: 92vw; text-align: center; }
        #shopToast.show { opacity: 1; transform: translate(-50%, 0); }
    `;
    document.head.appendChild(style);
})();

/* ---------- Shop page ---------- */

function priceLabel(item) {
    return item.free ? "Free" : `💰 ${Number(item.price).toLocaleString()}`;
}

/* Picture for wallpapers / logos. If your image file is not in public/ yet, a placeholder shows. */
function shopImageHtml(item, fit) {
    if (item.css) return `<div class="shop-img-css" style="background-image:${item.css}"></div>`;
    const url = escapeHtml(item.url || "");
    const placeholder = item.cat === "logo" ? "📛" : "🖼️";
    return `<img class="shop-img ${fit}" src="${url}" alt="${escapeHtml(item.name)}" loading="lazy" onerror="this.outerHTML='<span class=&quot;shop-img-missing&quot;>${placeholder}</span>'">`;
}

function shopBuyButton(item, signedIn, wallet) {
    if (item.free) return `<small>Default</small>`;
    if (shopOwned(item.id)) return `<span class="shop-price">✅ Owned</span>`;
    if (!signedIn) return `<button class="inv-btn" type="button" disabled>Sign in to buy</button>`;
    const afford = wallet >= item.price;
    return `<button class="inv-btn ${afford ? "primary" : ""}" type="button" data-inv="shop-buy" data-id="${item.id}" ${afford ? "" : "disabled"}>${afford ? "Buy" : "Need " + (item.price - wallet)} · ${Number(item.price).toLocaleString()}</button>`;
}

function renderShopCard(item, signedIn, wallet, username, previewBase) {
    const owned = shopOwned(item.id);
    let thumb = "";
    let extra = "";

    if (item.cat === "tag") {
        thumb = `<div class="shop-thumb">${tierNameHtml(username, item.tier)}</div>`;
        extra = `<button class="inv-btn" type="button" data-inv="tier-details" data-key="${item.tier}">Details</button>`;
    } else if (item.cat === "wallpaper") {
        thumb = `<div class="shop-thumb wall">${shopImageHtml(item, "cover")}</div>`;
        extra = `<button class="inv-btn" type="button" data-inv="shop-details" data-id="${item.id}">Details</button>`;
    } else if (item.cat === "logo") {
        thumb = `<div class="shop-thumb logo">${shopImageHtml(item, "contain")}</div>`;
        extra = `<button class="inv-btn" type="button" data-inv="shop-details" data-id="${item.id}">Details</button>`;
    } else if (item.cat === "sound") {
        thumb = `<div class="shop-thumb sound">${escapeHtml(item.icon || "🔊")}</div>`;
        extra = `<button class="inv-btn" type="button" data-inv="shop-play" data-id="${item.id}">▶ Play</button>`;
    } else {
        const look = Object.assign({}, previewBase, { [item.cat]: item.id });
        thumb = `<div class="shop-thumb">${avatarHtml(look, 58, false)}</div>`;
        extra = `<button class="inv-btn" type="button" data-inv="shop-preview" data-id="${item.id}">Try on</button>`;
    }

    return `<div class="shop-card ${owned ? "owned" : ""}">
        ${thumb}
        <strong>${escapeHtml(item.name)}</strong>
        <small>${priceLabel(item)}</small>
        <div class="shop-actions">${extra}${shopBuyButton(item, signedIn, wallet)}</div>
    </div>`;
}

function renderRewardsShopPage(page) {
    const signedIn = Boolean(authState?.username);
    const groups = [["character", "👤 Character"], ["music", "🎵 Music"], ["tag", "🏷️ Name Tags"], ["wallpaper", "🖼️ Wallpapers"], ["sound", "🔊 Sounds"], ["logo", "📛 Logos"]];
    const wallet = signedIn ? (myProgress?.shopPoints || 0) : 0;
    const username = authState?.username || "Player";

    let body = "";

    if (!shopCatalog) {
        body = `<div class="settings-card"><p class="settings-muted">Loading the shop…</p></div>`;
    } else {
        const previewBase = shopPreviewLook || myNormalLook();
        let items;
        let top = "";

        if (shopGroup === "character") {
            const slots = (shopCatalog.categories || []).filter(c => c.group === "character" && c.key !== "accessory");
            if (!slots.some(c => c.key === shopSlot)) shopSlot = slots[0]?.key || "face";
            const styleSwitch = `<div class="shop-style-switch"><button class="shop-chip ${shopCharacterStyle === "current" ? "active" : ""}" type="button" data-inv="shop-character-style" data-style="current">Current Style</button><button class="shop-chip ${shopCharacterStyle === "minecraft" ? "active" : ""}" type="button" data-inv="shop-character-style" data-style="minecraft">Minecraft Style</button></div>`;
            if (shopCharacterStyle === "minecraft") {
                const selectedSkin = mcSkinList().find(([file]) => file === minecraftSkinSelection);
                const selectedPreview = selectedSkin ? `<div class="minecraft-selected-preview"><img src="/skins/${encodeURIComponent(selectedSkin[0])}.png" alt="${escapeHtml(selectedSkin[1])} preview" onerror="this.style.display='none';this.nextElementSibling.style.display='block'"><span style="display:none">🧍</span><div><strong>${escapeHtml(selectedSkin[1])}</strong><br><small class="settings-muted">Try-on preview only; not purchased or equipped.</small></div><button class="inv-btn" type="button" data-inv="minecraft-skin-reset">Reset preview</button></div>` : `<div class="minecraft-selected-preview"><div class="minecraft-skin-placeholder">🧍</div><div><strong>Minecraft Character</strong><br><small class="settings-muted">Select Try On to preview a skin. Add images under public/skins/.</small></div></div>`;
                top = `${styleSwitch}<div class="settings-card"><div class="shop-preview">${selectedPreview}</div></div><div class="shop-chips"><button class="shop-chip active" type="button" disabled>🧍 Skin</button></div>`;
                const ownedMinecraftSkins = new Set(myProgress?.ownedMinecraftSkins || []);
                const skinCards = mcSkinList().filter(([file, , , enabled]) => enabled || ownedMinecraftSkins.has(file)).map(([file, name, skinPrice]) => {
                    const owned = ownedMinecraftSkins.has(file);
                    const equipped = myProgress?.equippedMinecraftSkin === file;
                    const price = skinPrice;
                    return `<div class="shop-card ${minecraftSkinSelection === file ? "owned" : ""}"><div class="shop-thumb minecraft-skin-thumb"><img src="/skins/${encodeURIComponent(file)}.png" alt="${escapeHtml(name)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='block'"><span style="display:none">🧍</span></div><strong>${escapeHtml(name)}</strong><small>${equipped ? "Equipped" : owned ? "Owned" : `🪙 ${price} points`}</small><div class="shop-actions"><button class="inv-btn" type="button" data-inv="minecraft-skin-try" data-file="${escapeHtml(file)}">${minecraftSkinSelection === file ? "Trying on" : "Try On"}</button>${owned ? `<button class="inv-btn ${equipped ? "" : "primary"}" type="button" data-inv="minecraft-skin-equip" data-file="${escapeHtml(file)}" ${equipped ? "disabled" : ""}>${equipped ? "Equipped" : "Equip"}</button>` : `<button class="inv-btn primary" type="button" data-inv="minecraft-skin-buy" data-file="${escapeHtml(file)}">Buy · ${price}</button>`}</div></div>`;
                }).join("");
                body = `${top}<div class="settings-card"><div class="shop-grid">${skinCards}</div></div>`;
            } else {
            top = `${styleSwitch}` + `
                <div class="settings-card">
                    <div class="shop-preview">
                        ${avatarHtml(previewBase, 96, false)}
                        <div>
                            <strong>Preview</strong><br><small class="settings-muted">${shopPreviewLook ? "Trying on an item (not saved)." : "This is your current character."}</small><br>
                            ${shopPreviewLook ? `<button class="inv-btn" type="button" data-inv="shop-preview-reset" style="margin-top:8px">Reset preview</button>` : ""}
                        </div>
                    </div>
                </div>
                <div class="shop-chips">${slots.map(c => `<button class="shop-chip ${shopSlot === c.key ? "active" : ""}" type="button" data-inv="shop-slot" data-key="${c.key}">${c.icon} ${c.label}</button>`).join("")}</div>`;
            items = shopItemsIn(shopSlot).filter(it => it.enabled !== false || shopOwned(it.id));
            const cards = items.map(item => renderShopCard(item, signedIn, wallet, username, previewBase)).join("") || `<div class="settings-muted">Nothing here yet.</div>`;
            body = `${top}<div class="settings-card"><div class="shop-grid">${cards}</div></div>`;
            }
        } else {
            items = shopItemsIn(shopGroup).filter(it => it.enabled !== false || shopOwned(it.id));
        }

        if (shopGroup !== "character") {
            const cards = shopGroup === "music"
                ? renderMusicShopCards(signedIn, wallet)
                : (items.map(item => renderShopCard(item, signedIn, wallet, username, previewBase)).join("") || `<div class="settings-muted">Nothing here yet.</div>`);
            const musicNote = shopGroup === "music"
                ? `<small class="settings-muted" style="display:block;margin-top:10px">Songs you buy stay yours forever. Choose your song in Inventory → Music.</small>`
                : "";
            body = `${top}<div class="settings-card"><div class="shop-grid">${cards}</div>${musicNote}</div>`;
        }
    }

    page.innerHTML = settingsHeader("🛍️ SHOP") + `
        <div class="settings-card">
            <div class="shop-wallet">
                <div><small class="settings-muted">Your shop points</small><br><strong>💰 ${signedIn ? wallet.toLocaleString() : "—"}</strong></div>
                <small class="settings-muted">Earn +${shopCatalog?.winPoints ?? 20} shop points for a win and +${shopCatalog?.losePoints ?? 10} for a loss.<br>Spending shop points never lowers your rank.</small>
            </div>
            ${signedIn ? "" : `<p class="settings-muted" style="margin-top:8px">👻 Guests can look around. Sign in or create an account to earn points and buy items.</p>`}
        </div>
        <div class="inv-tabs">${groups.map(([key, label]) => `<button class="inv-tab ${shopGroup === key ? "active" : ""}" type="button" data-inv="shop-group" data-key="${key}">${label}</button>`).join("")}</div>
        ${body}
        <div class="shop-message" id="shopMessage">${escapeHtml(shopMessage)}</div>
    `;
}

/* ---------- Inventory pages ---------- */

function renderTagsTab(p) {
    const username = authState.username;
    const auto = p.equippedTier === "auto";
    const none = p.equippedTier === "none";
    const owned = TIER_ORDER.filter(key => (p.unlockedTiers || []).includes(key));

    const rows = owned.map(key => {
        const tier = TIER_INFO[key];
        const equipped = p.equippedTier === key;
        return `
            <div class="inv-row">
                <div>${tierNameHtml(username, key)}<small>${tier.name} tag</small></div>
                <div class="inv-actions">
                    <button class="inv-btn" type="button" data-inv="tier-details" data-key="${key}">Details</button>
                    <button class="inv-btn ${equipped ? "" : "primary"}" type="button" data-inv="equip-tier" data-key="${key}" ${equipped ? "disabled" : ""}>${equipped ? "Equipped" : "Equip"}</button>
                </div>
            </div>`;
    }).join("") || `<div class="settings-muted" style="padding:8px 0">You don't own any name tags yet. Buy one in 🛍️ Shop.</div>`;

    return `
        <div class="settings-card">
            <h3>🏷️ Name Tags</h3>
            <div class="inv-row">
                <div><strong>Automatic</strong><small>Always show my highest owned tag</small></div>
                <div class="inv-actions"><button class="inv-btn ${auto ? "" : "primary"}" type="button" data-inv="equip-tier" data-key="auto" ${auto ? "disabled" : ""}>${auto ? "Equipped" : "Equip"}</button></div>
            </div>
            ${rows}
            <div class="inv-row">
                <div><strong>No tag</strong><small>Show my plain username</small></div>
                <div class="inv-actions"><button class="inv-btn ${none ? "" : "primary"}" type="button" data-inv="equip-tier" data-key="none" ${none ? "disabled" : ""}>${none ? "Equipped" : "Equip"}</button></div>
            </div>
        </div>`;
}

function renderCharacterTab(p) {
    if (!shopCatalog) return `<div class="settings-card"><p class="settings-muted">Loading your character…</p></div>`;

    const slots = (shopCatalog.categories || []).filter(c => c.group === "character" && c.key !== "accessory");
    if (!slots.some(c => c.key === inventorySlot)) inventorySlot = slots[0]?.key || "face";

    const look = myLook();

    /* Normal character <-> Minecraft style switch */
    const charView = inventoryCharView || p.characterStyle || "current";
    const styleSwitch = `<div class="shop-style-switch"><button class="shop-chip ${charView === "current" ? "active" : ""}" type="button" data-inv="inv-char-style" data-style="current">👤 Normal Character</button><button class="shop-chip ${charView === "minecraft" ? "active" : ""}" type="button" data-inv="inv-char-style" data-style="minecraft">⛏️ Minecraft Style</button></div>`;

    if (charView === "minecraft") {
        const ownedSkins = new Set(p.ownedMinecraftSkins || []);
        const usingMc = p.characterStyle === "minecraft";
        const skinCards = mcSkinList().filter(([file]) => ownedSkins.has(file)).map(([file, name]) => {
            const equipped = usingMc && p.equippedMinecraftSkin === file;
            return `<div class="shop-card ${equipped ? "equipped" : ""}"><div class="shop-thumb minecraft-skin-thumb"><img src="/skins/${encodeURIComponent(file)}.png" alt="${escapeHtml(name)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='block'"><span style="display:none">🧍</span></div><strong>${escapeHtml(name)}</strong><small>${equipped ? "Equipped" : "Owned"}</small><div class="shop-actions"><button class="inv-btn ${equipped ? "" : "primary"}" type="button" data-inv="inv-mc-equip" data-file="${escapeHtml(file)}" ${equipped ? "disabled" : ""}>${equipped ? "Equipped" : "Equip"}</button></div></div>`;
        }).join("");
        const mcHint = skinCards ? `<small class="settings-muted">With a Minecraft skin, hairstyles, shirts, suits, pants, hats and masks are not used. Switch back to Normal Character to use them again.</small>` : `<p class="settings-muted">You don't own any Minecraft skins yet. Visit 🛍️ Shop → Character → Minecraft Style to buy one.</p>`;
        return `
        <div class="settings-card">
            <div class="shop-preview">${avatarHtml(look, 110, false)}<div><strong>${escapeHtml(authState.username)}</strong><br><small class="settings-muted">This is how other players see you.</small></div></div>
        </div>
        ${styleSwitch}
        <div class="settings-card">${skinCards ? `<div class="shop-grid">${skinCards}</div>` : ""}${mcHint}</div>`;
    }

    const items = shopItemsIn(inventorySlot).filter(item => shopOwned(item.id));
    const optional = OPTIONAL_SLOTS.includes(inventorySlot);

    const cards = [];

    if (optional) {
        const active = !look[inventorySlot];
        cards.push(`<div class="shop-card ${active ? "equipped" : ""}">
            <div class="shop-thumb">${avatarHtml(Object.assign({}, look, { [inventorySlot]: null }), 58, false)}</div>
            <strong>None</strong><small>Take it off</small>
            <div class="shop-actions"><button class="inv-btn ${active ? "" : "primary"}" type="button" data-inv="equip-char" data-slot="${inventorySlot}" data-id="" ${active ? "disabled" : ""}>${active ? "Equipped" : "Equip"}</button></div>
        </div>`);
    }

    items.forEach(item => {
        const active = look[inventorySlot] === item.id;
        cards.push(`<div class="shop-card ${active ? "equipped" : ""}">
            <div class="shop-thumb">${avatarHtml(Object.assign({}, look, { [inventorySlot]: item.id }), 58, false)}</div>
            <strong>${escapeHtml(item.name)}</strong><small>${item.free ? "Default" : "Owned"}</small>
            <div class="shop-actions"><button class="inv-btn ${active ? "" : "primary"}" type="button" data-inv="equip-char" data-slot="${inventorySlot}" data-id="${item.id}" ${active ? "disabled" : ""}>${active ? "Equipped" : "Equip"}</button></div>
        </div>`);
    });

    const hint = items.filter(item => !item.free).length ? "" : `<p class="settings-muted" style="margin-top:10px">You haven't bought anything in this category yet. Visit 🛍️ Shop to get some.</p>`;

    return `
        <div class="settings-card">
            <div class="shop-preview">${avatarHtml(look, 110, false)}<div><strong>${escapeHtml(authState.username)}</strong><br><small class="settings-muted">This is how other players see you.</small></div></div>
        </div>
        ${styleSwitch}
        <div class="shop-chips">${slots.map(c => `<button class="shop-chip ${inventorySlot === c.key ? "active" : ""}" type="button" data-inv="inv-slot" data-key="${c.key}">${c.icon} ${c.label}</button>`).join("")}</div>
        <div class="settings-card"><div class="shop-grid">${cards.join("")}</div>${hint}</div>`;
}

function themeDefaultCards(kind, p) {
    const white = loadMafiaSettings().theme === "white";
    const custom = kind === "logo" ? p.equipped?.logo : p.equipped?.wallpaper;
    const items = [
        { theme: "noir", label: "Dark", img: kind === "logo" ? MAIN_LOGO_FILE : "/images/backgrounds/background.png" },
        { theme: "white", label: "White", img: kind === "logo" ? WHITE_LOGO_FILE : "/images/backgrounds/background-white.png" }
    ];
    return items.map(it => {
        const on = !custom && (white ? "white" : "noir") === it.theme;
        const title = kind === "logo" ? `Default logo (${it.label})` : `Default wallpaper (${it.label})`;
        const thumb = kind === "logo"
            ? `<div class="shop-thumb logo"><img class="shop-img contain" src="${it.img}" alt="${title}"></div>`
            : `<div class="shop-thumb"><div style="width:100%;height:100%;min-height:90px;background:url('${it.img}') center/cover no-repeat;border-radius:8px"></div></div>`;
        return `<div class="shop-card ${on ? "equipped" : ""}">
            ${thumb}
            <strong>${title}</strong><small>${it.label} theme</small>
            <div class="shop-actions"><button class="inv-btn ${on ? "" : "primary"}" type="button" data-inv="pick-theme" data-theme="${it.theme}" data-clear="${kind}" ${on ? "disabled" : ""}>${on ? "Equipped" : "Use"}</button></div>
        </div>`;
    }).join("");
}

function renderSoundsTab(p) {
    let shopPart = `<div class="settings-card"><p class="settings-muted">Loading…</p></div>`;

    if (shopCatalog) {
        const events = p.soundEvents || [];
        const owned = shopItemsIn("sound").filter(item => shopOwned(item.id));
        const rows = owned.map(item => {
            const active = events.filter(ev => p.equipped?.sounds?.[ev] === item.id);
            return `
                <div class="inv-row">
                    <div><strong>${escapeHtml(item.icon || "🔊")} ${escapeHtml(item.name)}</strong><small>${active.length ? "✅ Active on: " + active.map(ev => SOUND_EVENT_LABELS[ev] || ev).join(", ") : "Not used yet"}</small></div>
                    <div class="inv-actions">
                        <button class="inv-btn" type="button" data-inv="shop-play" data-id="${item.id}">▶ Play</button>
                        <button class="inv-btn primary" type="button" data-inv="edit-sound" data-id="${item.id}">✏️ Edit</button>
                    </div>
                </div>`;
        }).join("") || `<div class="settings-muted">You haven't bought any sounds yet. Visit 🛍️ Shop.</div>`;

        shopPart = `<div class="settings-card"><h3>🔊 My Sounds</h3>${rows}<small class="settings-muted">Press ✏️ Edit to choose where a sound plays. You can change it any time. Only you hear your sounds.</small></div>`;
    }

    const soundEquip = p.equipped?.sounds || {};
    const defaultPart = `<div class="settings-card"><h3>🔊 Default Sounds</h3>${DEFAULT_SOUND_ITEMS.map(item => {
        const moments = (p.soundEvents || []).filter(ev => soundEquip[ev] === item.id || (item.original === ev && !soundEquip[ev]));
        const status = moments.length ? "✅ Plays on: " + moments.map(ev => SOUND_EVENT_LABELS[ev] || ev).join(", ") : "Not used right now";
        return `<div class="inv-row"><div><strong>${escapeHtml(item.icon)} ${escapeHtml(item.name)}</strong><small>Built-in game sound · ${escapeHtml(status)}</small></div><div class="inv-actions"><button class="inv-btn" type="button" data-inv="play-sound" data-url="${item.url}">▶ Play</button><button class="inv-btn primary" type="button" data-inv="edit-sound" data-id="${item.id}">✏️ Edit</button></div></div>`;
    }).join("")}</div>`;

    return defaultPart + shopPart;
}

function renderWallpapersTab(p) {
    let shopPart = `<div class="settings-card"><p class="settings-muted">Loading…</p></div>`;

    if (shopCatalog) {
        const active = p.equipped?.wallpaper || null;
        const owned = shopItemsIn("wallpaper").filter(item => shopOwned(item.id));
        const rows = owned.map(item => {
            const on = active === item.id;
            const bg = item.css ? item.css : `url('${escapeHtml(item.url || "")}')`;
            return `
                <div class="inv-row">
                    <div style="display:flex;gap:10px;align-items:center"><div class="inv-thumb" style="background-image:${bg};background-size:cover;background-position:center"></div><div><strong>${escapeHtml(item.name)}</strong><small>${on ? "✅ active" : "Owned"}</small></div></div>
                    <div class="inv-actions"><button class="inv-btn ${on ? "" : "primary"}" type="button" data-inv="equip-wallpaper" data-id="${on ? "" : item.id}">${on ? "Use default" : "Equip"}</button></div>
                </div>`;
        }).join("") || `<div class="settings-muted">You haven't bought any wallpapers yet. Visit 🛍️ Shop.</div>`;

        shopPart = `<div class="settings-card"><h3>🖼️ My Wallpapers</h3>${rows}</div>`;
    }

    return `<div class="settings-card"><h3>🖼️ Default Wallpapers</h3><div class="shop-grid">${themeDefaultCards("wallpaper", p)}</div></div>` + shopPart;
}

function renderLogosTab(p) {
    if (!shopCatalog) return `<div class="settings-card"><p class="settings-muted">Loading…</p></div>`;

    const active = p.equipped?.logo || null;
    const owned = shopItemsIn("logo").filter(item => shopOwned(item.id));

    const cards = [themeDefaultCards("logo", p)];

    owned.forEach(item => {
        const on = active === item.id;
        cards.push(`<div class="shop-card ${on ? "equipped" : "owned"}">
            <div class="shop-thumb logo">${shopImageHtml(item, "contain")}</div>
            <strong>${escapeHtml(item.name)}</strong><small>${on ? "✅ active" : "Owned"}</small>
            <div class="shop-actions"><button class="inv-btn ${on ? "" : "primary"}" type="button" data-inv="equip-logo" data-id="${item.id}" ${on ? "disabled" : ""}>${on ? "Equipped" : "Equip"}</button></div>
        </div>`);
    });

    const hint = owned.length ? "" : `<p class="settings-muted" style="margin-top:10px">You haven't bought any logos yet. Visit 🛍️ Shop → 📛 Logos.</p>`;

    return `<div class="settings-card"><h3>📛 My Logos</h3><div class="shop-grid">${cards.join("")}</div>${hint}<small class="settings-muted">Your equipped logo replaces the Mafia Wars logo on your screen.</small></div>`;
}

function renderInventoryPage(page) {
    const tabs = [["character", "👤 Character"], ["tags", "🏷️ Tags"], ["sounds", "🔊 Sounds"], ["wallpapers", "🖼️ Wallpapers"], ["logos", "📛 Logos"], ["music", "🎵 Music"], ["skins", "⛏️ Minecraft Skins"], ["rewards", "🏅 Medals"]];
    if (!tabs.some(([key]) => key === inventoryTab)) inventoryTab = "character";

    let body;

    if (!authState?.username) {
        body = inventoryGuestHtml();
    } else if (!myProgress) {
        body = `<div class="settings-card"><p class="settings-muted">Loading your inventory…</p></div>`;
    } else if (inventoryTab === "sounds") {
        body = renderSoundsTab(myProgress);
    } else if (inventoryTab === "wallpapers") {
        body = renderWallpapersTab(myProgress);
    } else if (inventoryTab === "logos") {
        body = renderLogosTab(myProgress);
    } else if (inventoryTab === "music") {
        body = renderMusicTab(myProgress);
    } else if (inventoryTab === "skins") {
        body = renderSkinsTab(myProgress);
    } else if (inventoryTab === "rewards") {
        body = renderRewardsTab(myProgress);
    } else if (inventoryTab === "tags") {
        body = renderTagsTab(myProgress);
    } else {
        body = renderCharacterTab(myProgress);
    }

    page.innerHTML = settingsHeader("🎒 INVENTORY") + `
        <div class="inv-tabs">${tabs.map(([key, label]) => `<button class="inv-tab ${inventoryTab === key ? "active" : ""}" type="button" data-inv="tab" data-key="${key}">${label}</button>`).join("")}</div>
        ${body}
        <div class="inv-message" id="invMessage">${escapeHtml(inventoryMessage)}</div>
    `;
}

/* ---------- Owner: Shop Management ---------- */

function renderShopAdminPage(page) {
    const isOwner = myBadge === "owner";

    if (!isOwner) {
        page.innerHTML = settingsHeader("💰 SHOP MANAGEMENT") + `<div class="settings-card"><p>Only the Owner can manage shop prices.</p></div>`;
        return;
    }

    if (!shopCatalog) {
        page.innerHTML = settingsHeader("💰 SHOP MANAGEMENT") + `<div class="settings-card"><p class="settings-muted">Loading…</p></div>`;
        return;
    }

    const cats = shopCatalog.categories;
    if (!cats.some(c => c.key === shopAdminCat)) shopAdminCat = cats[0].key;

    const rows = shopItemsIn(shopAdminCat).filter(item => !item.free).map(item => `
        <div class="shop-admin-row">
            <div><strong>${escapeHtml(item.name)}</strong><br><small class="settings-muted" id="adminNow_${item.id}">Current price: ${Number(item.price).toLocaleString()} points</small></div>
            <div class="shop-admin-controls">
                <input type="number" min="0" max="1000000" step="1" id="adminPrice_${item.id}" value="${item.price}">
                <button class="inv-btn primary" type="button" data-inv="admin-save" data-id="${item.id}">Save</button>
                <button class="inv-btn" type="button" data-inv="admin-reset" data-id="${item.id}">Reset</button>
            </div>
        </div>`).join("") || `<div class="settings-muted">No priced items in this category.</div>`;

    page.innerHTML = settingsHeader("💰 SHOP MANAGEMENT") + `
        <div class="settings-admin-note">Changes apply immediately for every player. Items players already bought stay theirs. The server re-checks that you are the signed-in Owner.</div>
        <div class="settings-card">
            <div class="settings-row"><div><strong>Category</strong></div>
                <select id="adminCat" class="inv-btn" data-inv="admin-cat">${cats.map(c => `<option value="${c.key}" ${c.key === shopAdminCat ? "selected" : ""}>${c.icon} ${c.label}</option>`).join("")}</select>
            </div>
        </div>
        <div class="settings-card">${rows}</div>
        <div class="shop-message" id="shopAdminMessage">${escapeHtml(shopAdminMessage)}</div>
    `;
}

function shopAdminNotice(text) {
    shopAdminMessage = text || "";
    const box = $("shopAdminMessage");
    if (box) box.textContent = shopAdminMessage;
}

/* ---------- Click / change handling for the new pages ---------- */

function handleShopClick(event) {
    const target = event.target.closest("[data-inv]");
    if (!target) return;
    const action = target.dataset.inv;

    if (action === "shop-character-style") {
        shopCharacterStyle = target.dataset.style === "minecraft" ? "minecraft" : "current";
        shopPreviewLook = null;
        if (shopCharacterStyle === "current") minecraftSkinSelection = null;
        shopMessage = "";
        renderSettingsPage("rewards");
    } else if (action === "minecraft-skin-try") {
        minecraftSkinSelection = target.dataset.file || null;
        shopMessage = minecraftSkinSelection ? "Skin preview selected. This does not purchase or equip the skin." : "";
        renderSettingsPage("rewards");
    } else if (action === "minecraft-skin-reset") {
        minecraftSkinSelection = null;
        renderSettingsPage("rewards");
    } else if (action === "minecraft-skin-buy") {
        target.disabled = true;
        socket.emit("minecraftSkinBuy", { file: target.dataset.file }, result => {
            shopNotice(result?.ok ? `✅ Purchased ${result.name}! You can equip it now.` : (result?.error || "Could not buy this skin."));
            if (result?.ok) { minecraftSkinSelection = target.dataset.file; inventoryCharView = null; }
            else target.disabled = false;
            renderSettingsPage("rewards");
        });
    } else if (action === "minecraft-skin-equip") {
        socket.emit("minecraftSkinEquip", { file: target.dataset.file }, result => {
            shopNotice(result?.ok ? "✅ Minecraft skin equipped." : (result?.error || "Could not equip skin."));
            if (result?.ok) { minecraftSkinSelection = target.dataset.file; inventoryCharView = null; }
            renderSettingsPage("rewards");
        });
    } else if (action === "shop-group") {
        shopGroup = target.dataset.key;
        shopMessage = "";
        renderSettingsPage("rewards");
    } else if (action === "shop-slot") {
        shopSlot = target.dataset.key;
        renderSettingsPage("rewards");
    } else if (action === "shop-preview") {
        const item = shopItem(target.dataset.id);
        if (item) shopPreviewLook = Object.assign({}, myLook(), { [item.cat]: item.id });
        renderSettingsPage("rewards");
    } else if (action === "shop-preview-reset") {
        shopPreviewLook = null;
        renderSettingsPage("rewards");
    } else if (action === "shop-details") {
        openItemDetailsPopup(shopItem(target.dataset.id));
    } else if (action === "shop-play") {
        playShopSound(shopItem(target.dataset.id));
    } else if (action === "shop-buy") {
        target.disabled = true;
        socket.emit("shopBuy", { id: target.dataset.id }, result => {
            const item = shopItem(target.dataset.id);
            shopNotice(result?.ok
                ? `✅ Bought ${item ? item.name : "item"}! Open Inventory to equip it.`
                : (result?.error || "Could not buy that item."));
            if (!result?.ok) target.disabled = false;
            // A new sound: ask right away which game event it should play on.
            if (result?.ok && item && item.cat === "sound") openSoundEventPopup(item);
        });
    } else if (action === "inv-slot") {
        inventorySlot = target.dataset.key;
        renderSettingsPage("inventory");
    } else if (action === "pick-theme") {
        updateMafiaSetting("theme", target.dataset.theme);
        if (target.dataset.clear === "wallpaper") inventoryEmit("equipWallpaper", { id: null }, "Wallpaper updated.");
        else if (target.dataset.clear === "logo") inventoryEmit("equipLogo", { id: null }, "Logo updated.");
        else renderSettingsPage("inventory");
    } else if (action === "equip-logo") {
        inventoryEmit("equipLogo", { id: target.dataset.id || null }, "Logo updated.");
    } else if (action === "inv-char-style") {
        if (target.dataset.style === "minecraft") {
            inventoryCharView = "minecraft";
            const file = myProgress?.equippedMinecraftSkin;
            if (file && (myProgress.ownedMinecraftSkins || []).includes(file)) {
                inventoryEmit("characterStyleSet", { style: "minecraft", file }, "Minecraft style on.");
            } else {
                renderSettingsPage("inventory");
            }
        } else {
            inventoryCharView = "current";
            inventoryEmit("characterStyleSet", { style: "current" }, "Normal character on.");
        }
    } else if (action === "inv-mc-equip") {
        inventoryCharView = "minecraft";
        inventoryEmit("characterStyleSet", { style: "minecraft", file: target.dataset.file }, "Minecraft skin equipped.");
    } else if (action === "equip-char") {
        inventoryEmit("equipCharacter", { slot: target.dataset.slot, id: target.dataset.id || null }, "Character updated.");
    } else if (action === "edit-sound") {
        openSoundEventPopup(shopItem(target.dataset.id) || defaultSoundItem(target.dataset.id), true);
    } else if (action === "equip-shop-sound") {
        const equip = target.dataset.equip === "1";
        const select = $("invEvt_" + target.dataset.id);
        let eventName = select ? select.value : "";

        if (!equip) {
            // Stop: remove it from every event it is active on.
            const events = (myProgress?.soundEvents || []).filter(ev => myProgress.equipped?.sounds?.[ev] === target.dataset.id);
            events.forEach(ev => socket.emit("equipShopSound", { id: target.dataset.id, event: ev, equip: false }));
            inventoryNotice("Sound removed from all events.");
            return;
        }

        inventoryEmit("equipShopSound", { id: target.dataset.id, event: eventName, equip: true }, "Sound updated.");
    } else if (action === "admin-save") {
        const id = target.dataset.id;
        const price = Number($("adminPrice_" + id)?.value);
        socket.emit("ownerSetPrice", { id, price }, result => {
            shopAdminNotice(result?.ok ? `✅ Saved. New price: ${Number(result.price).toLocaleString()} points.` : (result?.error || "Could not save."));
            if (result?.ok) {
                const now = $("adminNow_" + id);
                if (now) now.textContent = `Current price: ${Number(result.price).toLocaleString()} points`;
            }
        });
    } else if (action === "admin-reset") {
        const id = target.dataset.id;
        socket.emit("ownerSetPrice", { id, reset: true }, result => {
            shopAdminNotice(result?.ok ? "✅ Price reset to the default." : (result?.error || "Could not reset."));
            if (result?.ok) {
                const input = $("adminPrice_" + id);
                if (input) input.value = result.price;
                const now = $("adminNow_" + id);
                if (now) now.textContent = `Current price: ${Number(result.price).toLocaleString()} points`;
            }
        });
    }
}

function handleShopChange(event) {
    const target = event.target.closest("[data-inv='admin-cat']");
    if (!target) return;
    shopAdminCat = target.value;
    renderSettingsPage("shopadmin");
}

var shopListenersInstalled = false;
const renderSettingsPageBeforeShop = renderSettingsPage;

renderSettingsPage = function(view) {
    const page = $("settingsPage");

    if (view === "main") shopPreviewLook = null;

    if (page && !shopListenersInstalled) {
        shopListenersInstalled = true;
        page.addEventListener("click", handleShopClick);
        page.addEventListener("change", handleShopChange);
    }

    if (page && (view === "rewards" || view === "shopadmin")) {
        // Keep the existing Account controls safe (same rule the other pages follow).
        const accountInfo = $("accountInfo");
        const accountChip = $("accountChip");
        if (accountInfo && accountChip && accountInfo.parentElement !== accountChip) {
            accountChip.appendChild(accountInfo);
            accountInfo.style.display = "none";
        }

        if (!shopCatalog) loadShopCatalog();

        if (view === "rewards") renderRewardsShopPage(page);
        else renderShopAdminPage(page);

        $("settingsBack")?.addEventListener("click", () => settingsNav("main"));
        $("settingsClose")?.addEventListener("click", closeSettings);
        return;
    }

    renderSettingsPageBeforeShop(view);
};

/* Refresh the shop / inventory when the server sends new points or items. */
socket.on("myProgressData", () => {
    hydrateAvatars(document);
    if (progressSettingsOpen && settingsView === "rewards") renderSettingsPage("rewards");
});


/* =========================================================
   VOICE CHAT — HOST CONTROLS
   - Allow Voice Chat: YES / NO (host settings)
   - Host picks up to 5 voice-chat players (the server enforces the limit)
========================================================= */

const MAX_VOICE_PLAYERS_CLIENT = Infinity; // no limit

/* Styles for the voice picker and night popups live in style.css. */
function ensureMafiaVoiceUiStyles() {}

function readVoiceSettings(data) {
    if (!data) return;

    readSoundboardSettings(data);

    if (data.voiceChatAllowed !== undefined) {
        voiceChatAllowedSetting = data.voiceChatAllowed !== false;
    }

    if (data.detectiveCheckAnnounce !== undefined) {
        detectiveCheckAnnounceSetting = data.detectiveCheckAnnounce !== false;
    }

    if (Array.isArray(data.voicePlayerIds)) {
        voicePlayerIds = data.voicePlayerIds.slice();
    }
}

/* "Allow Voice Chat: YES / NO" inside the host's Role Settings (index.html). */
function ensureVoiceHostSetting() {
    if (!isHost) return;

    let box = $("voiceAllowSetting");

    if (!box) {
        const hostSettings = $("hostSettings");
        if (!hostSettings) return;

        box = document.createElement("div");
        box.id = "voiceAllowSetting";
        box.className = "grandma-setting voice-allow-setting";
        box.innerHTML = `
            <p>🎙️ Allow Voice Chat</p>
            <label><input type="radio" name="voiceAllowChoice" id="voiceAllowYes"> Yes</label>
            <label><input type="radio" name="voiceAllowChoice" id="voiceAllowNo"> No</label>
            <small id="voiceAllowHint" class="voice-allow-hint"></small>
        `;

        const heading = hostSettings.querySelector("h2");
        if (heading && heading.nextSibling) {
            hostSettings.insertBefore(box, heading.nextSibling);
        } else {
            hostSettings.insertBefore(box, hostSettings.firstChild);
        }
    }

    if (!box.dataset.bound) {
        box.dataset.bound = "1";

        const send = allowed => {
            voiceChatAllowedSetting = allowed;
            socket.emit("setVoiceSettings", { roomCode, allowed });
            ensureVoiceHostSetting();
            updateVoiceHostButton();
        };

        $("voiceAllowYes")?.addEventListener("change", () => { if ($("voiceAllowYes").checked) send(true); });
        $("voiceAllowNo")?.addEventListener("change", () => { if ($("voiceAllowNo").checked) send(false); });
    }

    const yes = $("voiceAllowYes");
    const no = $("voiceAllowNo");
    if (yes) yes.checked = voiceChatAllowedSetting;
    if (no) no.checked = !voiceChatAllowedSetting;

    const hint = $("voiceAllowHint");
    if (hint) {
        hint.textContent = voiceChatAllowedSetting
            ? `You will pick the voice-chat players when you press START GAME.`
            : "Voice chat is disabled for everyone.";
    }
}

/* "Detective Check: YES / NO" inside the host's Role Settings.
   YES = the morning announcement adds "The detective knows one of the mafia."
   An example of the announcement is shown under the option. */
function ensureDetectiveHostSetting() {
    if (!isHost) return;

    let box = $("detectiveCheckSetting");

    if (!box) {
        const hostSettings = $("hostSettings");
        if (!hostSettings) return;

        box = document.createElement("div");
        box.id = "detectiveCheckSetting";
        box.className = "grandma-setting voice-allow-setting";
        box.innerHTML = `
            <p>🕵️ Detective Check</p>
            <label><input type="radio" name="detectiveCheckChoice" id="detectiveCheckYes"> Yes</label>
            <label><input type="radio" name="detectiveCheckChoice" id="detectiveCheckNo"> No</label>
            <small id="detectiveCheckHint" class="voice-allow-hint"></small>
        `;

        const voiceBox = $("voiceAllowSetting");
        if (voiceBox && voiceBox.parentNode === hostSettings) {
            hostSettings.insertBefore(box, voiceBox.nextSibling);
        } else {
            const heading = hostSettings.querySelector("h2");
            if (heading && heading.nextSibling) {
                hostSettings.insertBefore(box, heading.nextSibling);
            } else {
                hostSettings.insertBefore(box, hostSettings.firstChild);
            }
        }
    }

    if (!box.dataset.bound) {
        box.dataset.bound = "1";

        const send = enabled => {
            detectiveCheckAnnounceSetting = enabled;
            socket.emit("setDetectiveCheckSetting", { roomCode, enabled });
            ensureDetectiveHostSetting();
        };

        $("detectiveCheckYes")?.addEventListener("change", () => { if ($("detectiveCheckYes").checked) send(true); });
        $("detectiveCheckNo")?.addEventListener("change", () => { if ($("detectiveCheckNo").checked) send(false); });
    }

    const yes = $("detectiveCheckYes");
    const no = $("detectiveCheckNo");
    if (yes) yes.checked = detectiveCheckAnnounceSetting;
    if (no) no.checked = !detectiveCheckAnnounceSetting;

    const hint = $("detectiveCheckHint");
    if (hint) {
        hint.textContent = detectiveCheckAnnounceSetting
            ? "Example: ☀️ Ahmed was killed. The doctor saved the wrong person. The detective knows one of the mafia."
            : "Example: ☀️ Ahmed was killed. The doctor saved the wrong person.";
    }
}

/* Host-only button inside the voice panel to change the selected players. */
function updateVoiceHostButton() {
    const body = $("voiceBody");
    if (!body) return;

    const show = Boolean(isHost && voiceChatAllowedSetting);
    let button = $("voicePlayersButton");

    if (!button) {
        if (!show) return;

        button = document.createElement("button");
        button.id = "voicePlayersButton";
        button.type = "button";
        button.className = "voice-control-button";
        button.addEventListener("click", () => openVoicePicker("edit"));
        body.insertBefore(button, $("voiceParticipants") || null);
    }

    button.style.display = show ? "" : "none";
    button.textContent = `👥 VOICE PLAYERS (${voicePlayerIds.length})`;
}

/*
   mode "start": shown after START GAME is pressed; confirming starts the game.
   mode "edit":  host changes the selected players (lobby or during the game).
*/
function openVoicePicker(mode, startPayload) {
    if (!isHost) return;

    ensureMafiaVoiceUiStyles();

    let overlay = $("voicePickerOverlay");
    if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "voicePickerOverlay";
        document.body.appendChild(overlay);
    }

    const list = players.filter(player => player && player.connected !== false);
    const selected = new Set(voicePlayerIds.filter(id => list.some(player => player.id === id)));

    const close = () => { overlay.style.display = "none"; };

    const render = () => {
        overlay.innerHTML = "";

        const card = document.createElement("div");
        card.className = "voice-picker-card";

        const title = document.createElement("h2");
        title.textContent = "🎙️ Choose Voice Chat Players";

        const info = document.createElement("p");
        info.textContent = `Pick the players who can use voice chat. Everyone else still plays normally but cannot use voice chat.`;

        const count = document.createElement("div");
        count.className = "voice-picker-count";
        count.textContent = `${selected.size} selected`;

        card.append(title, info, count);

        list.forEach(player => {
            const row = document.createElement("label");
            row.className = "voice-picker-row";

            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = selected.has(player.id);

            const locked = !checkbox.checked && selected.size >= MAX_VOICE_PLAYERS_CLIENT;
            checkbox.disabled = locked;
            if (locked) row.classList.add("voice-picker-disabled");

            checkbox.addEventListener("change", () => {
                if (checkbox.checked) {
                    if (selected.size >= MAX_VOICE_PLAYERS_CLIENT) { checkbox.checked = false; return; }
                    selected.add(player.id);
                } else {
                    selected.delete(player.id);
                }
                render();
            });

            const name = document.createElement("span");
            name.textContent = player.name + (player.id === socket.id ? " (you)" : "");

            row.append(checkbox, name);
            card.appendChild(row);
        });

        const actions = document.createElement("div");
        actions.className = "voice-picker-actions";

        const confirm = document.createElement("button");
        confirm.type = "button";
        confirm.textContent = mode === "start" ? "▶ START GAME" : "✅ SAVE";
        confirm.addEventListener("click", () => {
            const chosen = Array.from(selected);

            if (mode === "start" && startPayload) {
                startPayload.voice = { allowed: true, players: chosen };
                socket.emit("startGame", startPayload);
            } else {
                socket.emit("setVoiceSettings", { roomCode, allowed: true, players: chosen });
            }

            close();
        });

        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = "CANCEL";
        cancel.addEventListener("click", close);

        actions.append(confirm, cancel);
        card.appendChild(actions);
        overlay.appendChild(card);
    };

    render();
    overlay.style.display = "flex";
}



/* =========================================================
   MUSIC SYSTEM + OWNER SHOP MANAGEMENT
   - 7 songs (1 free + 6 paid). Files live in public/music/.
   - Starts at 50% volume, loops forever, ON/OFF + volume control
     at the bottom-right, Settings -> Music, Shop -> Music,
     Inventory -> Music / Minecraft Skins.
   - Prices, ownership, the free song and enabled items are all
     decided by the SERVER (server.js). This block only shows them.
========================================================= */

var musicState = {
    audio: null,
    currentUrl: "",
    blockedHooked: false,
    previewAudio: null,
    previewTimer: null,
    previewId: null,
    ended: false,
    ctx: null,
    volumeSettable: undefined,
    clickInstalled: false
};

const FALLBACK_FREE_SONG = {
    id: "song_funk",
    name: "FUNK CRIMINAL",
    url: "/music/FUNK%20CRIMINAL.mp3",
    seconds: 83.25,
    price: 0,
    free: true,
    enabled: true
};

var musicReady = true;   // the music block has loaded; earlier callers (page start-up) must wait for this

/* Minecraft skins now come from the server so the Owner can add / price / hide them. */
function mcSkinList() {
    if (shopCatalog && Array.isArray(shopCatalog.skins)) {
        return shopCatalog.skins.map(s => [s.file, s.name, Number(s.price) || 0, s.enabled !== false, Boolean(s.custom)]);
    }
    return MINECRAFT_SKINS.map(([file, name]) => [file, name, 100, true, false]);
}

/* ---------- Song helpers ---------- */

function musicSongList() {
    return (shopCatalog && Array.isArray(shopCatalog.songs) && shopCatalog.songs.length)
        ? shopCatalog.songs
        : [FALLBACK_FREE_SONG];
}

function musicFreeId() {
    return (shopCatalog && shopCatalog.freeSong) || (myProgress && myProgress.freeSong) || FALLBACK_FREE_SONG.id;
}

function musicSong(id) {
    return musicSongList().find(song => song.id === id) || null;
}

function musicOwnedIds() {
    if (authState && authState.username && myProgress && Array.isArray(myProgress.ownedSongs)) {
        return myProgress.ownedSongs.slice();
    }
    return [musicFreeId()];
}

function musicSelectedId() {
    const owned = musicOwnedIds();
    const chosen = authState && authState.username && myProgress ? myProgress.equippedSong : null;
    if (chosen && owned.includes(chosen) && musicSong(chosen)) return chosen;
    return owned.includes(musicFreeId()) ? musicFreeId() : owned[0];
}

function musicFormatTime(seconds) {
    const total = Math.round(Number(seconds) || 0);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function musicVolumeSetting(st) {
    const v = Number(st.musicVolume);
    return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5;
}

function musicInMatchNow() {
    return currentPhase === "night" || currentPhase === "day";
}

/* Music plays when it is ON, except inside a match if the player chose "No" for match music. */
function musicAllowedNow(st) {
    return Boolean(st.musicOn) && !(musicInMatchNow() && st.musicInMatch === false);
}

/* Loop: Yes (default) = the song restarts every time it ends. No = it plays once and stops. */
function musicLoopOn(st) {
    return st.musicLoop !== false;
}

/* Volume: the slider is turned into a perceptual curve (so 50% really sounds about half as
   loud, instead of nearly full) and multiplied by the Master volume from Settings -> Sound. */
function musicScaled(st) {
    const v = musicVolumeSetting(st);
    const master = clampAudioSetting(st.masterVolume, 1);
    return Math.max(0, Math.min(1, v * v * master));
}

function musicPlayVolume(st) {
    return st.musicOn ? musicScaled(st) : 0;      // OFF = silent
}

function musicPreviewVolume(st) {
    return Math.max(0.15, musicScaled(st));       // a preview stays audible even at 0%
}

/* iPhone / iPad ignore audio.volume (it is always 100%). There the music is routed through a
   Web Audio GainNode instead, which does work. Desktop and Android keep using audio.volume. */
function musicVolumeSettable() {
    if (musicState.volumeSettable !== undefined) return musicState.volumeSettable;
    let ok = true;
    try {
        const probe = new Audio();
        probe.volume = 0.5;
        ok = Math.abs(probe.volume - 0.5) < 0.001;
    } catch (_) { ok = true; }
    musicState.volumeSettable = ok;
    return ok;
}

function musicResumeCtx() {
    const ctx = musicState.ctx;
    if (ctx && ctx.state !== "running") {
        try { const promise = ctx.resume(); if (promise) promise.catch(() => {}); } catch (_) { /* ignore */ }
    }
}

function musicGainFor(audio) {
    if (audio._mwGain) return audio._mwGain;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    try {
        if (!musicState.ctx) {
            musicState.ctx = new Ctx();
            // iOS keeps the audio engine suspended until a tap, so wake it on any touch / click / key.
            ["pointerdown", "touchend", "click", "keydown"].forEach(name =>
                document.addEventListener(name, musicResumeCtx, true));
        }
        const source = musicState.ctx.createMediaElementSource(audio);
        const gain = musicState.ctx.createGain();
        source.connect(gain);
        gain.connect(musicState.ctx.destination);
        audio._mwGain = gain;
        audio.volume = 1;
        return gain;
    } catch (_) {
        return null;
    }
}

function setMusicElementVolume(audio, value) {
    if (!audio) return;
    const v = Math.max(0, Math.min(1, Number(value) || 0));

    if (musicVolumeSettable()) {
        audio.volume = v;
        return;
    }

    const gain = musicGainFor(audio);
    if (gain) {
        musicResumeCtx();
        gain.gain.value = v;
    } else {
        try { audio.volume = v; } catch (_) { /* ignore */ }
    }
}

function applyMusicVolume() {
    if (!musicReady) return;
    const st = loadMafiaSettings();
    if (musicState.audio) setMusicElementVolume(musicState.audio, musicPlayVolume(st));
    if (musicState.previewAudio) setMusicElementVolume(musicState.previewAudio, musicPreviewVolume(st));
}

/* ---------- Playback ---------- */

function ensureMusicAudio() {
    if (musicState.audio) return musicState.audio;

    const audio = new Audio();
    audio.preload = "auto";
    audio.loop = musicLoopOn(loadMafiaSettings());

    // With Loop = Yes the song restarts from the beginning. With Loop = No it simply stops.
    audio.addEventListener("ended", () => {
        if (musicLoopOn(loadMafiaSettings())) {
            try {
                audio.currentTime = 0;
                const promise = audio.play();
                if (promise) promise.catch(() => {});
            } catch (_) { /* ignore */ }
        } else {
            musicState.ended = true;
            updateMusicControl();
        }
    });

    musicState.audio = audio;
    return audio;
}

/* Browsers block sound until the player clicks / presses something once. */
function hookMusicUnlock() {
    if (musicState.blockedHooked) return;
    musicState.blockedHooked = true;

    const events = ["pointerdown", "keydown", "touchstart"];
    const retry = () => {
        events.forEach(name => document.removeEventListener(name, retry, true));
        musicState.blockedHooked = false;
        applyMusic();
    };

    events.forEach(name => document.addEventListener(name, retry, true));
}

function applyMusic() {
    const st = loadMafiaSettings();
    const audio = ensureMusicAudio();
    const song = musicSong(musicSelectedId());
    const loop = musicLoopOn(st);

    if (song && musicState.currentUrl !== song.url) {
        musicState.currentUrl = song.url;
        musicState.ended = false;          // a different song starts fresh
        audio.src = song.url;
    }

    if (loop) musicState.ended = false;    // switching Loop back to Yes restarts the song
    audio.loop = loop;
    applyMusicVolume();

    if (song && musicAllowedNow(st) && !musicState.previewId && !musicState.ended) {
        if (audio.paused) {
            musicResumeCtx();
            const promise = audio.play();
            if (promise) promise.catch(() => hookMusicUnlock());
        }
    } else if (!audio.paused) {
        audio.pause();
    }

    updateMusicControl();
}

function setMusicSetting(key, value) {
    const st = loadMafiaSettings();
    const wasOn = Boolean(st.musicOn);

    st[key] = value;

    // Moving the volume slider while music is OFF turns it back on.
    if (key === "musicVolume" && value > 0 && !st.musicOn) st.musicOn = true;

    // Turning music ON again starts the song from the beginning if it had finished.
    if (!wasOn && st.musicOn) musicState.ended = false;

    saveMafiaSettings(st);
    applyMusic();
}

/* ---------- Preview (Shop / Inventory) ---------- */

function stopMusicPreview() {
    clearTimeout(musicState.previewTimer);
    musicState.previewTimer = null;

    if (musicState.previewAudio) {
        try { musicState.previewAudio.pause(); } catch (_) { /* ignore */ }
        musicState.previewAudio = null;
    }

    musicState.previewId = null;
}

function musicPreview(id) {
    const same = musicState.previewId === id;
    stopMusicPreview();

    if (same) {
        applyMusic();
        return;
    }

    const song = musicSong(id);
    if (!song) return;

    const st = loadMafiaSettings();
    const audio = new Audio(song.url);
    musicState.previewAudio = audio;
    setMusicElementVolume(audio, musicPreviewVolume(st));

    musicState.previewId = id;

    if (musicState.audio && !musicState.audio.paused) musicState.audio.pause();

    const promise = audio.play();
    if (promise) promise.catch(() => { stopMusicPreview(); applyMusic(); });

    // 10-second preview, then the normal background music comes back.
    musicState.previewTimer = setTimeout(() => {
        stopMusicPreview();
        applyMusic();
    }, 10000);
}

/* ---------- Bottom-right control ---------- */

(function injectMusicCss() {
    if (document.getElementById("musicCss")) return;
    const style = document.createElement("style");
    style.id = "musicCss";
    style.textContent = `
        .mw-music { position: fixed; right: 14px; bottom: 14px; z-index: 99985; width: min(262px, calc(100vw - 28px)); box-sizing: border-box; padding: 10px 12px; border-radius: 14px; background: rgba(18,10,10,.94); color: #f3e9e9; border: 1px solid rgba(255,60,60,.55); box-shadow: 0 10px 30px rgba(0,0,0,.55), 0 0 18px rgba(200,0,0,.2); font-family: Arial, sans-serif; }
        .mw-music-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .mw-music-title { font-size: 12px; font-weight: 800; letter-spacing: .4px; }
        .mw-music-buttons { display: flex; align-items: center; gap: 6px; }
        .mw-music button { font: inherit; cursor: pointer; }
        #musicToggleButton { min-width: 52px; padding: 4px 10px; border-radius: 999px; border: 0; background: #c1121f; color: #fff; font-size: 12px; font-weight: 800; }
        #musicToggleButton.off { background: #4a4a4a; }
        #musicCollapseButton { width: 24px; height: 24px; border-radius: 8px; border: 1px solid rgba(255,255,255,.25); background: rgba(255,255,255,.08); color: inherit; line-height: 1; }
        .mw-music-song { margin-top: 6px; font-size: 12px; opacity: .88; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .mw-music-vol { display: flex; align-items: center; gap: 8px; margin-top: 7px; }
        .mw-music-vol input { flex: 1; min-width: 0; accent-color: #c1121f; }
        .mw-music-vol span { width: 62px; text-align: right; font-size: 12px; font-weight: 700; }
        .mw-music.collapsed .mw-music-song, .mw-music.collapsed .mw-music-vol { display: none; }
        html[data-mafia-theme="white"] .mw-music { background: rgba(255,255,255,.97); color: #10264d; border-color: #2f7bff; box-shadow: 0 10px 30px rgba(20,60,140,.25); }
        html[data-mafia-theme="white"] #musicToggleButton { background: #2f7bff; }
        html[data-mafia-theme="white"] #musicToggleButton.off { background: #9aa7bd; }
        html[data-mafia-theme="white"] .mw-music-vol input { accent-color: #2f7bff; }
        html[data-mafia-theme="white"] #musicCollapseButton { border-color: rgba(47,123,255,.4); background: rgba(47,123,255,.08); }
        .mw-yesno { display: flex; gap: 14px; }
        .mw-music.docked-hidden { display: none; }
        .voice-music-panel { padding: 6px 2px; }
        .vm-row { display: flex; align-items: center; gap: 10px; padding: 8px 4px; }
        .vm-song { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 800; }
        .vm-label { font-size: 12px; font-weight: 700; white-space: nowrap; }
        .vm-pct { width: 62px; text-align: right; font-size: 12px; font-weight: 700; }
        .vm-row input[type=range] { flex: 1; min-width: 0; accent-color: #c1121f; }
        .vm-toggle { min-width: 52px; padding: 5px 10px; border-radius: 999px; border: 0; background: #c1121f; color: #fff; font-size: 12px; font-weight: 800; cursor: pointer; }
        .vm-toggle.off { background: #4a4a4a; }
        .voice-music-panel .mw-yesno { margin-left: auto; font-size: 13px; }
        .mw-yesno label { display: flex; align-items: center; gap: 6px; cursor: pointer; }
        .mw-admin-note { font-size: .85em; opacity: .75; margin-top: 6px; }
        .mw-admin-add { display: grid; gap: 8px; }
        .mw-admin-add input { padding: 9px 10px; border-radius: 9px; border: 1px solid rgba(255,255,255,.25); background: rgba(0,0,0,.25); color: inherit; font: inherit; }
        .shop-admin-row input[type=text] { width: 150px; padding: 7px 9px; border-radius: 8px; border: 1px solid rgba(255,255,255,.25); background: rgba(0,0,0,.25); color: inherit; font: inherit; }
    `;
    document.head.appendChild(style);
})();

function ensureMusicControl() {
    if ($("musicControl")) return;

    const box = document.createElement("div");
    box.id = "musicControl";
    box.className = "mw-music";
    box.innerHTML = `
        <div class="mw-music-head">
            <span class="mw-music-title">🎵 Background Music</span>
            <span class="mw-music-buttons">
                <button id="musicToggleButton" type="button">ON</button>
                <button id="musicCollapseButton" type="button" title="Minimize">−</button>
            </span>
        </div>
        <div class="mw-music-song" id="musicSongLabel">Selected song</div>
        <div class="mw-music-vol">
            <input id="musicVolumeSlider" type="range" min="0" max="100" step="1" value="50" aria-label="Music volume">
            <span id="musicVolumeText">50%</span>
        </div>
    `;
    document.body.appendChild(box);

    $("musicToggleButton").addEventListener("click", () => {
        const st = loadMafiaSettings();
        setMusicSetting("musicOn", !st.musicOn);
    });

    $("musicVolumeSlider").addEventListener("input", event => {
        setMusicSetting("musicVolume", Number(event.target.value) / 100);
    });

    $("musicCollapseButton").addEventListener("click", () => {
        const collapsed = box.classList.toggle("collapsed");
        $("musicCollapseButton").textContent = collapsed ? "+" : "−";
    });

    syncMusicDock();
}

/* The bottom-right music box hides while the Voice Chat panel is showing (it would be hidden
   underneath it anyway). Music is then controlled with the 🎵 MUSIC button inside Voice Chat. */
function syncMusicDock() {
    const dock = $("musicControl");
    if (!dock) return;
    const voice = $("voiceChatPanel");
    const voiceShown = Boolean(voice) && voice.style.display !== "none";
    dock.classList.toggle("docked-hidden", voiceShown);
}

function musicStatusText(st) {
    if (st.musicOn && musicInMatchNow() && st.musicInMatch === false) return "Paused in match";
    if (musicState.ended && !musicLoopOn(st)) return "Finished";
    return musicLoopOn(st) ? "Loop on" : "Loop off";
}

function updateMusicControl() {
    if (!musicReady) return;
    const st = loadMafiaSettings();
    const song = musicSong(musicSelectedId());
    const pct = Math.round(musicVolumeSetting(st) * 100);
    const loop = musicLoopOn(st);
    const volumeText = st.musicOn ? `${pct}%` : "OFF · 0%";

    const labelText = `${song ? song.name : "No song"} · ${musicStatusText(st)}`;
    const label = $("musicSongLabel");
    if (label) label.textContent = labelText;
    const voiceSong = $("voiceMusicSong");
    if (voiceSong) voiceSong.textContent = `🎵 ${labelText}`;

    ["musicToggleButton", "voiceMusicToggle"].forEach(id => {
        const toggle = $(id);
        if (!toggle) return;
        toggle.textContent = st.musicOn ? "ON" : "OFF";
        toggle.classList.toggle("off", !st.musicOn);
    });

    const slider = $("musicVolumeSlider");
    if (slider) slider.value = String(pct);
    const voiceSlider = $("voiceMusicVolume");
    if (voiceSlider && document.activeElement !== voiceSlider) voiceSlider.value = String(pct);

    const text = $("musicVolumeText");
    if (text) text.textContent = volumeText;
    const voiceText = $("voiceMusicVolumeText");
    if (voiceText) voiceText.textContent = volumeText;

    // Loop Yes / No radios (Settings -> Music and Voice Chat -> Music stay in step).
    document.querySelectorAll("input[data-music-loop]").forEach(input => {
        input.checked = (input.dataset.musicLoop === "yes") === loop;
    });

    // Keep the Settings -> Music page in step with the other controls.
    const settingsOn = $("musicSettingsOn");
    if (settingsOn) settingsOn.checked = Boolean(st.musicOn);
    const settingsVolume = $("musicSettingsVolume");
    if (settingsVolume && document.activeElement !== settingsVolume) settingsVolume.value = String(pct);
    const settingsValue = $("musicSettingsVolumeValue");
    if (settingsValue) settingsValue.textContent = `${pct}%`;
    const settingsInfo = $("musicSettingsSongInfo");
    if (settingsInfo && song) settingsInfo.textContent = `${musicFormatTime(song.seconds)} · ${musicStatusText(st)} · ${song.free ? "Free song" : "Owned"}`;
}

function initMusic() {
    ensureMusicControl();
    applyMusic();
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initMusic);
else initMusic();

/* Start / refresh music when a player joins, and when the game phase changes. */
["roomCreated", "joinedRoom", "rejoinApproved", "gameInformation", "gameRestarted"].forEach(name => {
    socket.on(name, () => setTimeout(applyMusic, 30));
});
socket.on("gameOver", () => setTimeout(applyMusic, 30));
socket.on("connect", () => setTimeout(applyMusic, 800));
socket.on("authResult", () => setTimeout(applyMusic, 60));
socket.on("myProgressData", () => setTimeout(applyMusic, 30));

/* ---------- Shop / catalog updates from the Owner ---------- */

socket.on("shopConfigUpdated", data => {
    if (!data || !shopCatalog) return;

    shopCatalog.songs = Array.isArray(data.songs) ? data.songs : [];
    shopCatalog.skins = Array.isArray(data.skins) ? data.skins : [];
    shopCatalog.freeSong = data.freeSong;
    shopCatalog.disabled = data.disabled || {};

    (shopCatalog.items || []).forEach(item => {
        item.enabled = !shopCatalog.disabled[item.id];
    });

    applyMusic();

    if (progressSettingsOpen && ["inventory", "rewards", "shopadmin", "music"].includes(settingsView)) {
        renderSettingsPage(settingsView);
    }
});

/* ---------- Shop: Music tab ---------- */

function renderMusicShopCards(signedIn, wallet) {
    const owned = new Set(musicOwnedIds());

    // Same card layout as the wallpapers: picture on top, name, price, then the buttons.
    return musicSongList()
        .filter(song => song.enabled !== false || owned.has(song.id))
        .map(song => {
            const have = owned.has(song.id);
            const priceText = song.free ? "Free" : `💰 ${Number(song.price).toLocaleString()}`;
            let action;

            if (song.free) action = `<span class="shop-price">🎁 Free</span>`;
            else if (have) action = `<span class="shop-price">✅ Owned</span>`;
            else if (!signedIn) action = `<button class="inv-btn" type="button" disabled>Sign in to buy</button>`;
            else {
                const afford = wallet >= song.price;
                action = `<button class="inv-btn ${afford ? "primary" : ""}" type="button" data-mu="buy" data-id="${escapeHtml(song.id)}" ${afford ? "" : "disabled"}>${afford ? "Buy" : "Need " + (song.price - wallet)} · ${Number(song.price).toLocaleString()}</button>`;
            }

            return `<div class="shop-card ${have ? "owned" : ""}">
                <div class="shop-thumb sound">🎵</div>
                <strong>${escapeHtml(song.name)}</strong>
                <small>${musicFormatTime(song.seconds)} · ${priceText}</small>
                <div class="shop-actions">
                    <button class="inv-btn" type="button" data-mu="preview" data-id="${escapeHtml(song.id)}">${musicState.previewId === song.id ? "■ Stop" : "▶ Preview"}</button>
                    ${action}
                </div>
            </div>`;
        }).join("");
}

/* ---------- Inventory: Music + Minecraft Skins ---------- */

function renderMusicTab() {
    const owned = new Set(musicOwnedIds());
    const selected = musicSelectedId();
    const songs = musicSongList();

    const rows = songs.filter(song => owned.has(song.id)).map(song => {
        const on = selected === song.id;
        return `<div class="inv-row">
            <div><strong>🎵 ${escapeHtml(song.name)}</strong><small>${musicFormatTime(song.seconds)} · ${on ? (musicLoopOn(loadMafiaSettings()) ? "✅ Selected · loops" : "✅ Selected · plays once") : (song.free ? "Free song" : "Owned")}</small></div>
            <div class="inv-actions">
                <button class="inv-btn" type="button" data-mu="preview" data-id="${escapeHtml(song.id)}">${musicState.previewId === song.id ? "■ Stop" : "▶ Preview"}</button>
                <button class="inv-btn ${on ? "" : "primary"}" type="button" data-mu="equip" data-id="${escapeHtml(song.id)}" ${on ? "disabled" : ""}>${on ? "Selected" : "Select"}</button>
            </div>
        </div>`;
    }).join("");

    const locked = songs.filter(song => !owned.has(song.id) && song.enabled !== false).length;
    const hint = locked
        ? `<p class="settings-muted" style="margin-top:10px">${locked} more song${locked === 1 ? "" : "s"} to unlock in 🛍️ Shop → Music.</p>`
        : "";

    return `<div class="settings-card"><h3>🎵 My Music</h3>${rows || '<div class="settings-muted">No songs yet.</div>'}${hint}<small class="settings-muted">Turn Loop on or off in Settings → Music or in Voice Chat → Music. Use the music control (bottom-right, or the 🎵 Music button in Voice Chat) to turn music ON/OFF or change the volume.</small></div>`;
}

function renderSkinsTab(p) {
    const ownedSet = new Set(p.ownedMinecraftSkins || []);
    const usingMc = p.characterStyle === "minecraft";
    const list = mcSkinList().filter(([file]) => ownedSet.has(file));

    const cards = list.map(([file, name]) => {
        const equipped = usingMc && p.equippedMinecraftSkin === file;
        return `<div class="shop-card ${equipped ? "equipped" : ""}"><div class="shop-thumb minecraft-skin-thumb"><img src="/skins/${encodeURIComponent(file)}.png" alt="${escapeHtml(name)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='block'"><span style="display:none">🧍</span></div><strong>${escapeHtml(name)}</strong><small>${equipped ? "Equipped" : "Owned"}</small><div class="shop-actions"><button class="inv-btn ${equipped ? "" : "primary"}" type="button" data-inv="inv-mc-equip" data-file="${escapeHtml(file)}" ${equipped ? "disabled" : ""}>${equipped ? "Equipped" : "Equip"}</button></div></div>`;
    }).join("");

    const normalCard = `<div class="shop-card ${usingMc ? "" : "equipped"}"><div class="shop-thumb">${avatarHtml(Object.assign({}, myNormalLook()), 58, false)}</div><strong>Normal Character</strong><small>${usingMc ? "Roblox-style" : "Equipped"}</small><div class="shop-actions"><button class="inv-btn ${usingMc ? "primary" : ""}" type="button" data-inv="inv-char-style" data-style="current" ${usingMc ? "" : "disabled"}>${usingMc ? "Equip" : "Equipped"}</button></div></div>`;

    const hint = list.length ? "" : `<p class="settings-muted" style="margin-top:10px">You don't own any Minecraft skins yet. Visit 🛍️ Shop → Character → Minecraft Style.</p>`;

    return `
        <div class="settings-card">
            <div class="shop-preview">${avatarHtml(myLook(), 110, false)}<div><strong>${escapeHtml(authState.username)}</strong><br><small class="settings-muted">This is how other players see you.</small></div></div>
        </div>
        <div class="settings-card"><h3>⛏️ My Minecraft Skins</h3><div class="shop-grid">${normalCard}${cards}</div>${hint}</div>`;
}

/* ---------- Settings -> Music ---------- */

function renderMusicSettingsPage(page) {
    const st = loadMafiaSettings();
    const song = musicSong(musicSelectedId());
    const pct = Math.round(musicVolumeSetting(st) * 100);
    const signedIn = Boolean(authState && authState.username);
    const matchYes = st.musicInMatch !== false;

    page.innerHTML = settingsHeader("🎵 MUSIC") + `
        <div class="settings-card">
            <div class="settings-row"><div><strong>Background Music</strong><small>OFF stops the music. ON plays it at your chosen volume. Master volume also affects it.</small></div><input id="musicSettingsOn" class="settings-switch" type="checkbox" ${st.musicOn ? "checked" : ""}></div>
            <div class="settings-row sound-setting-row">
                <div><strong>🔊 Music Volume</strong><small>Starts at 50%. You can also use the control at the bottom-right.</small></div>
                <div class="settings-slider-wrap"><input id="musicSettingsVolume" class="settings-range" type="range" min="0" max="100" step="1" value="${pct}"><span id="musicSettingsVolumeValue" class="settings-value">${pct}%</span></div>
            </div>
        </div>
        <div class="settings-card">
            <h3>🎮 Play music in match</h3>
            <div class="settings-row">
                <div><strong>Play music in match</strong><small>If you choose No, background music pauses while a match is running. Your normal lobby music and controls stay separate.</small></div>
                <div class="mw-yesno">
                    <label><input type="radio" name="musicInMatch" value="yes" ${matchYes ? "checked" : ""}> Yes</label>
                    <label><input type="radio" name="musicInMatch" value="no" ${matchYes ? "" : "checked"}> No</label>
                </div>
            </div>
        </div>
        <div class="settings-card">
            <h3>🎶 Selected song</h3>
            <div class="settings-row"><div><strong>${escapeHtml(song ? song.name : "—")}</strong><small id="musicSettingsSongInfo">${song ? musicFormatTime(song.seconds) : ""} · ${musicStatusText(st)} · ${song && song.free ? "Free song" : "Owned"}</small></div></div>
            <div class="settings-row">
                <div><strong>🔁 Loop song</strong><small>Yes: the song starts again from the beginning every time it ends. No: the song plays once and stops when it ends.</small></div>
                <div class="mw-yesno">
                    <label><input type="radio" name="musicLoop" data-music-loop="yes" ${musicLoopOn(st) ? "checked" : ""}> Yes</label>
                    <label><input type="radio" name="musicLoop" data-music-loop="no" ${musicLoopOn(st) ? "" : "checked"}> No</label>
                </div>
            </div>
            <small class="settings-muted">${signedIn ? "Choose another song in Inventory → Music. Buy more in Shop → Music." : "Guests can use the free song. Sign in to buy and choose more songs."}</small>
            <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
                <button class="inv-btn" type="button" data-mu="open-inventory">🎒 Open Inventory</button>
                <button class="inv-btn" type="button" data-mu="open-shop">🛍️ Open Shop</button>
            </div>
        </div>
    `;

    $("musicSettingsOn")?.addEventListener("change", event => setMusicSetting("musicOn", Boolean(event.target.checked)));

    $("musicSettingsVolume")?.addEventListener("input", event => {
        setMusicSetting("musicVolume", Number(event.target.value) / 100);
    });

    page.querySelectorAll("input[name='musicInMatch']").forEach(input => {
        input.addEventListener("change", () => setMusicSetting("musicInMatch", input.value === "yes"));
    });

    page.querySelectorAll("input[name='musicLoop']").forEach(input => {
        input.addEventListener("change", () => setMusicSetting("musicLoop", input.dataset.musicLoop === "yes"));
    });
}

/* ---------- Owner: Shop Management (songs, skins, any item) ---------- */

shopAdminCat = "__music";

function adminToggleButton(id, enabled, label) {
    return `<button class="inv-btn" type="button" data-mu="ad-toggle" data-id="${escapeHtml(id)}" data-enabled="${enabled ? 0 : 1}">${enabled ? "Disable" : "Enable"}${label || ""}</button>`;
}

function adminMusicHtml() {
    const rows = musicSongList().map(song => `
        <div class="shop-admin-row" data-song="${escapeHtml(song.id)}">
            <div><strong>🎵 ${escapeHtml(song.name)}</strong> ${song.free ? "<small>(FREE song)</small>" : ""} ${song.enabled === false ? "<small>(disabled)</small>" : ""}<br>
                <small class="settings-muted">${musicFormatTime(song.seconds)} · ${song.free ? "Free for everyone right now" : "Current price: " + Number(song.price).toLocaleString() + " points"}</small></div>
            <div class="shop-admin-controls">
                <input class="mu-price" type="number" min="0" max="1000000" step="1" value="${Number(song.price) || 0}">
                <button class="inv-btn primary" type="button" data-mu="ad-song-save" data-id="${escapeHtml(song.id)}">Save</button>
                <button class="inv-btn" type="button" data-mu="ad-song-reset" data-id="${escapeHtml(song.id)}">Reset</button>
                ${song.free ? "" : `<button class="inv-btn" type="button" data-mu="ad-song-free" data-id="${escapeHtml(song.id)}">Make free</button>${adminToggleButton(song.id, song.enabled !== false)}`}
            </div>
        </div>`).join("");

    return `<div class="settings-card"><h3>🎵 Songs</h3>${rows}<div class="mw-admin-note">Exactly one song is free. Making another song free turns the current free song into a normal paid song (players who bought it keep it).</div></div>`;
}

function adminSkinsHtml() {
    const rows = mcSkinList().map(([file, name, price, enabled]) => `
        <div class="shop-admin-row">
            <div><strong>⛏️ ${escapeHtml(name)}</strong> ${enabled ? "" : "<small>(disabled)</small>"}<br><small class="settings-muted">public/skins/${escapeHtml(file)}.png · ${Number(price).toLocaleString()} points</small></div>
            <div class="shop-admin-controls">
                <input class="mu-skin-name" type="text" maxlength="30" value="${escapeHtml(name)}">
                <input class="mu-price" type="number" min="0" max="1000000" step="1" value="${Number(price)}">
                <button class="inv-btn primary" type="button" data-mu="ad-skin-save" data-file="${escapeHtml(file)}">Save</button>
                ${adminToggleButton("skin:" + file, enabled)}
                <button class="inv-btn danger" type="button" data-mu="ad-skin-remove" data-file="${escapeHtml(file)}">Remove</button>
            </div>
        </div>`).join("") || `<div class="settings-muted">No skins yet.</div>`;

    return `
        <div class="settings-card">
            <h3>➕ Add Minecraft skin</h3>
            <div class="mw-admin-add">
                <input id="muSkinFile" type="text" maxlength="40" placeholder="Picture file name (without .png)" autocomplete="off">
                <input id="muSkinName" type="text" maxlength="30" placeholder="Display name" autocomplete="off">
                <input id="muSkinPrice" type="number" min="0" max="1000000" step="1" value="100" placeholder="Price">
                <button class="inv-btn primary" type="button" data-mu="ad-skin-add">Add skin</button>
            </div>
            <div class="mw-admin-note">First put the picture in <strong>public/skins/&lt;file name&gt;.png</strong>, then add it here so it appears in the Shop.</div>
        </div>
        <div class="settings-card"><h3>⛏️ Minecraft skins</h3>${rows}</div>`;
}

function adminItemsHtml(cat) {
    const rows = shopItemsIn(cat).filter(item => !item.free).map(item => `
        <div class="shop-admin-row">
            <div><strong>${escapeHtml(item.name)}</strong> ${item.enabled === false ? "<small>(disabled)</small>" : ""}<br><small class="settings-muted" id="adminNow_${item.id}">Current price: ${Number(item.price).toLocaleString()} points</small></div>
            <div class="shop-admin-controls">
                <input type="number" min="0" max="1000000" step="1" id="adminPrice_${item.id}" value="${item.price}">
                <button class="inv-btn primary" type="button" data-inv="admin-save" data-id="${item.id}">Save</button>
                <button class="inv-btn" type="button" data-inv="admin-reset" data-id="${item.id}">Reset</button>
                ${adminToggleButton(item.id, item.enabled !== false)}
            </div>
        </div>`).join("") || `<div class="settings-muted">No priced items in this category.</div>`;

    return `<div class="settings-card">${rows}</div>`;
}

renderShopAdminPage = function(page) {
    if (myBadge !== "owner") {
        page.innerHTML = settingsHeader("💰 SHOP MANAGEMENT") + `<div class="settings-card"><p>Only the Owner can manage the shop.</p></div>`;
        return;
    }

    if (!shopCatalog) {
        page.innerHTML = settingsHeader("💰 SHOP MANAGEMENT") + `<div class="settings-card"><p class="settings-muted">Loading…</p></div>`;
        return;
    }

    const cats = shopCatalog.categories;
    const valid = ["__music", "__skins", ...cats.map(c => c.key)];
    if (!valid.includes(shopAdminCat)) shopAdminCat = "__music";

    let body;
    if (shopAdminCat === "__music") body = adminMusicHtml();
    else if (shopAdminCat === "__skins") body = adminSkinsHtml();
    else body = adminItemsHtml(shopAdminCat);

    page.innerHTML = settingsHeader("💰 SHOP MANAGEMENT") + `
        <div class="settings-admin-note">Changes apply immediately for every player. Items players already bought stay theirs. The server re-checks that you are the signed-in Owner.</div>
        <div class="settings-card">
            <div class="settings-row"><div><strong>Category</strong></div>
                <select id="adminCat" class="inv-btn" data-inv="admin-cat">
                    <option value="__music" ${shopAdminCat === "__music" ? "selected" : ""}>🎵 Music songs</option>
                    <option value="__skins" ${shopAdminCat === "__skins" ? "selected" : ""}>⛏️ Minecraft skins</option>
                    ${cats.map(c => `<option value="${c.key}" ${c.key === shopAdminCat ? "selected" : ""}>${c.icon} ${c.label}</option>`).join("")}
                </select>
            </div>
        </div>
        ${body}
        <div class="shop-message" id="shopAdminMessage">${escapeHtml(shopAdminMessage)}</div>
    `;
};

/* ---------- Click handling for all the new buttons ---------- */

function ownerCall(eventName, payload, okText) {
    socket.emit(eventName, payload, result => {
        shopAdminNotice(result && result.ok ? (okText || "✅ Saved.") : ((result && result.error) || "Could not save."));
    });
}

function handleMusicClick(event) {
    const target = event.target.closest("[data-mu]");
    if (!target) return;

    const action = target.dataset.mu;
    const id = target.dataset.id;
    const row = target.closest(".shop-admin-row");

    if (action === "preview") {
        musicPreview(id);
        renderSettingsPage(settingsView);
    } else if (action === "equip") {
        stopMusicPreview();
        socket.emit("musicEquip", { id }, result => {
            inventoryNotice(result && result.ok ? "🎵 Song selected. It now plays on repeat." : ((result && result.error) || "Could not select that song."));
        });
    } else if (action === "buy") {
        target.disabled = true;
        socket.emit("musicBuy", { id }, result => {
            shopNotice(result && result.ok
                ? `✅ Bought ${result.name}! Open Inventory → Music to select it.`
                : ((result && result.error) || "Could not buy that song."));
            if (result && result.ok) showShopToast(`🎵 ${result.name} is yours`);
            else target.disabled = false;
        });
    } else if (action === "open-inventory") {
        inventoryTab = "music";
        settingsNav("inventory");
    } else if (action === "open-shop") {
        shopGroup = "music";
        settingsNav("rewards");
    } else if (action === "ad-toggle") {
        ownerCall("ownerSetEnabled", { id, enabled: target.dataset.enabled === "1" }, "✅ Updated.");
    } else if (action === "ad-song-save") {
        ownerCall("ownerMusicSet", { id, price: row?.querySelector(".mu-price")?.value }, "✅ Song price saved.");
    } else if (action === "ad-song-reset") {
        ownerCall("ownerMusicSet", { id, reset: true }, "✅ Price reset to the default.");
    } else if (action === "ad-song-free") {
        ownerCall("ownerMusicSet", { id, free: true }, "✅ This song is now the free song.");
    } else if (action === "ad-skin-save") {
        ownerCall("ownerSkinSet", {
            file: target.dataset.file,
            name: row?.querySelector(".mu-skin-name")?.value,
            price: row?.querySelector(".mu-price")?.value
        }, "✅ Skin saved.");
    } else if (action === "ad-skin-remove") {
        if (confirm("Remove this skin from the Shop? Players who already own it keep it.")) {
            ownerCall("ownerSkinRemove", { file: target.dataset.file }, "✅ Skin removed from the Shop.");
        }
    } else if (action === "ad-skin-add") {
        ownerCall("ownerSkinAdd", {
            file: $("muSkinFile")?.value,
            name: $("muSkinName")?.value,
            price: $("muSkinPrice")?.value
        }, "✅ Skin added to the Shop.");
    }
}

/* ---------- Hook the Music page + button into Settings ---------- */

const renderSettingsPageBeforeMusic = renderSettingsPage;

renderSettingsPage = function(view) {
    const page = $("settingsPage");

    if (page && !musicState.clickInstalled) {
        musicState.clickInstalled = true;
        page.addEventListener("click", handleMusicClick);
    }

    if (page && view === "music") {
        // Keep the existing Account controls safe (same rule the other pages follow).
        const accountInfo = $("accountInfo");
        const accountChip = $("accountChip");
        if (accountInfo && accountChip && accountInfo.parentElement !== accountChip) {
            accountChip.appendChild(accountInfo);
            accountInfo.style.display = "none";
        }

        renderMusicSettingsPage(page);
        $("settingsBack")?.addEventListener("click", () => settingsNav("main"));
        $("settingsClose")?.addEventListener("click", closeSettings);
        return;
    }

    renderSettingsPageBeforeMusic(view);

    if (view === "main" && page) {
        const grid = page.querySelector(".settings-grid");
        if (grid && !grid.querySelector("[data-music-button]")) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "settings-option settings-category";
            button.dataset.musicButton = "1";
            button.innerHTML = `<span class="settings-icon">🎵</span><span class="settings-copy"><strong>Music</strong><span>Background music, volume and match music</span></span>`;
            button.addEventListener("click", () => settingsNav("music"));
            grid.appendChild(button);
        }
    }
};

/* =========================================================
   OWNER-MADE ACCOUNTS
   - Start page: no Sign Up button, Discord message instead
   - Login page: Username + Password + PIN, "Forgot" link
   - Settings (Owner only): ➕ Add Account -> Add Account / List Accounts (View Account, Edit, Delete)
   - Settings -> Account: username, Display Name, Password, PIN
   Everything is checked again on the server.
========================================================= */

const DISCORD_INVITE_URL = "https://discord.gg/rkzb2eBZz";

/* ---------- Start page + Login page extras ---------- */

function ensureAuthExtras() {
    // The Discord note and Forgot link are in index.html now.
    // This only wires up the "Forgot Password or PIN?" link (once).
    const link = $("authForgotLink");

    if (link && !link.dataset.bound) {
        link.dataset.bound = "1";
        link.addEventListener("click", event => {
            event.preventDefault();
            const box = $("authForgotBox");
            if (box) box.style.display = box.style.display === "none" ? "" : "none";
        });
    }
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureAuthExtras);
} else {
    ensureAuthExtras();
}

/* ---------- Small password / PIN prompt (Show Password, Show PIN) ---------- */

const acctState = {
    clickInstalled: false,
    list: null,          // Owner: loaded accounts (null = still loading)
    filter: "",
    editing: null,       // Owner: the account being edited
    viewData: null,      // Owner: View Account numbers (null = loading)
    gift: null,          // Owner: gift catalog for the viewed player (null = loading)
    giftCat: "all",
    giftFilter: "",
    message: "",
    promptKind: null,    // "password" | "pin"
    revealTimers: {}
};

function openAcctPrompt(options) {
    let overlay = $("acctPromptOverlay");

    if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "acctPromptOverlay";
        overlay.className = "qa-overlay qa-center";
        overlay.style.zIndex = "100000";   // always above the Settings window
        document.body.appendChild(overlay);
    }

    acctState.promptKind = options.kind;

    overlay.innerHTML = `
        <div class="qa-modal">
            <h2>${escapeHtml(options.title)}</h2>
            <p>${escapeHtml(options.text)}</p>
            <input id="acctPromptInput" type="password" autocomplete="new-password"
                ${options.numeric ? 'inputmode="numeric" maxlength="8"' : 'maxlength="72"'}
                placeholder="${escapeHtml(options.placeholder)}">
            <div id="acctPromptNote" class="qa-note"></div>
            <div class="qa-actions">
                <button id="acctPromptCancel" type="button">CANCEL</button>
                <button id="acctPromptConfirm" type="button">${escapeHtml(options.confirmLabel)}</button>
            </div>
        </div>
    `;
    overlay.style.display = "flex";

    const input = $("acctPromptInput");
    setTimeout(() => input.focus(), 40);

    const submit = () => {
        const value = input.value;

        if (options.numeric ? !/^\d{4,8}$/.test(value) : (!value || value.length > 72)) {
            setAcctPromptNote(options.numeric ? "PIN must be 4-8 digits." : "Enter your password.");
            return;
        }

        setAcctPromptNote("Checking…");
        options.onSubmit(value);
    };

    $("acctPromptCancel").addEventListener("click", closeAcctPrompt);
    $("acctPromptConfirm").addEventListener("click", submit);
    input.addEventListener("keydown", event => {
        if (event.key === "Enter") submit();
        if (event.key === "Escape") closeAcctPrompt();
    });
    overlay.addEventListener("click", event => {
        if (event.target === overlay) closeAcctPrompt();
    });
}

function closeAcctPrompt() {
    const overlay = $("acctPromptOverlay");
    if (overlay) overlay.style.display = "none";
    acctState.promptKind = null;
}

function setAcctPromptNote(text) {
    const note = $("acctPromptNote");
    if (note) note.textContent = text || "";
}

/* Shows a secret for 10 seconds, then hides it again. */
function revealAcctSecret(valueId, buttonSelector, value, mask, buttonText) {
    const box = $(valueId);
    if (!box) return;

    box.textContent = value;
    clearTimeout(acctState.revealTimers[valueId]);

    acctState.revealTimers[valueId] = setTimeout(() => {
        const again = $(valueId);
        if (again) again.textContent = mask;
        const button = document.querySelector(buttonSelector);
        if (button) button.textContent = buttonText;
    }, 10000);
}

socket.on("showMyPasswordResult", data => {
    if (acctState.promptKind !== "password") return;

    if (!data?.ok) {
        setAcctPromptNote(data?.error || "Wrong PIN.");
        return;
    }

    closeAcctPrompt();
    revealAcctSecret("acctPwShown", '[data-acct="show-password"]', data.password, "••••••••", "🔒 Show Password");
    const button = document.querySelector('[data-acct="show-password"]');
    if (button) button.textContent = "🔓 Password shown (10s)";
});

socket.on("showMyPinResult", data => {
    if (acctState.promptKind !== "pin") return;

    if (!data?.ok) {
        setAcctPromptNote(data?.error || "Wrong password.");
        return;
    }

    closeAcctPrompt();
    revealAcctSecret("acctPinShown", '[data-acct="show-pin"]', data.pin, "••••", "🔒 Show PIN");
    const button = document.querySelector('[data-acct="show-pin"]');
    if (button) button.textContent = "🔓 PIN shown (10s)";
});

/* ---------- Settings -> Account: details card ---------- */

function renderAccountDetailsCard(page) {
    if ($("acctDetailsCard")) return;

    const card = document.createElement("div");
    card.className = "settings-card";
    card.id = "acctDetailsCard";
    card.innerHTML = `<h3>👤 Account</h3><p class="settings-muted">Loading…</p>`;
    page.querySelector(".settings-header")?.insertAdjacentElement("afterend", card);

    socket.emit("getMyAccountDetails", result => {
        if (!card.isConnected) return;

        if (!result?.ok) {
            card.remove();
            return;
        }

        card.innerHTML = `
            <h3>👤 Account</h3>
            <div class="settings-row"><div><strong>Username</strong><small>${escapeHtml(result.username)} (can't be changed)</small></div></div>
            <div class="settings-row"><div><strong>Display Name</strong><small>Other players see this name instead of your username.</small></div></div>
            <div class="mw-admin-add">
                <input id="acctDisplayName" type="text" maxlength="20" autocomplete="off" value="${escapeHtml(result.displayName)}" placeholder="Display Name">
                <button class="inv-btn primary" type="button" data-acct="save-display">Save</button>
            </div>
            <div class="settings-row"><div><strong>Password</strong><small id="acctPwShown">••••••••</small></div><button class="inv-btn" type="button" data-acct="show-password">🔒 Show Password</button></div>
            <div class="settings-row"><div><strong>PIN</strong><small id="acctPinShown">••••</small></div><button class="inv-btn" type="button" data-acct="show-pin">🔒 Show PIN</button></div>
            <div class="shop-message" id="acctDetailsMessage"></div>
        `;
    });
}

function acctDetailsNotice(text) {
    const box = $("acctDetailsMessage");
    if (box) box.textContent = text || "";
}

function saveDisplayName() {
    const input = $("acctDisplayName");
    if (!input) return;

    socket.emit("setDisplayName", { displayName: input.value }, result => {
        if (!result?.ok) {
            acctDetailsNotice(result?.error || "Could not save the Display Name.");
            return;
        }

        const old = authState.displayName;
        authState.displayName = result.displayName;
        input.value = result.displayName;

        // Name boxes that still hold the old name get the new one.
        ["createPlayerName", "joinPlayerName", "quickStartPlayerName", "rejoinPlayerName"].forEach(id => {
            const box = $(id);
            if (box && (box.value === old || box.value === authState.username)) box.value = result.displayName;
        });

        acctDetailsNotice(`✅ Saved. Other players now see "${result.displayName}" when you create or join a room.`);
    });
}

/* ---------- Owner: Shop -> Add Account ---------- */

function acctNotice(text) {
    acctState.message = text || "";
    const box = $("acctMessage");
    if (box) box.textContent = acctState.message;
}

function loadAcctList() {
    acctState.list = null;

    socket.emit("ownerAccountList", result => {
        if (result?.ok) {
            acctState.list = result.accounts || [];
        } else {
            acctState.list = [];
            acctState.message = result?.error || "Could not load the accounts.";
        }

        if (settingsView === "acctlist") renderSettingsPage("acctlist");
    });
}

function acctRowsHtml() {
    const query = acctState.filter.trim().toLowerCase();

    const rows = (acctState.list || [])
        .filter(a =>
            !query ||
            a.username.toLowerCase().includes(query) ||
            a.displayName.toLowerCase().includes(query)
        )
        .map(a => `
            <div class="shop-admin-row">
                <div>
                    <strong>${escapeHtml(a.username)}</strong>${a.displayName !== a.username ? ` <small class="settings-muted">(shown as ${escapeHtml(a.displayName)})</small>` : ""}<br>
                    <small class="settings-muted">${a.createdByOwner ? "Made by Owner" : "Older account"}</small>
                </div>
                <div class="shop-admin-controls">
                    <button class="inv-btn" type="button" data-acct="view" data-user="${escapeHtml(a.username)}">View Account</button>
                    <button class="inv-btn" type="button" data-acct="edit" data-user="${escapeHtml(a.username)}">Edit</button>
                    <button class="inv-btn" type="button" data-acct="delete" data-user="${escapeHtml(a.username)}">Delete</button>
                </div>
            </div>`)
        .join("");

    return rows || `<div class="settings-muted">No accounts found.</div>`;
}

const GIFT_ROW_LIMIT = 300;

function acctGiftRowsHtml() {
    const g = acctState.gift;
    if (!g) return "";

    const labels = {};
    g.categories.forEach(c => { labels[c.key] = `${c.icon} ${c.label}`; });

    const query = acctState.giftFilter.trim().toLowerCase();

    const matches = g.items.filter(item =>
        (acctState.giftCat === "all" || item.cat === acctState.giftCat) &&
        (!query || item.name.toLowerCase().includes(query))
    );

    if (!matches.length) return `<div class="settings-muted">No items found.</div>`;

    const rows = matches.slice(0, GIFT_ROW_LIMIT).map(item => `
        <div class="shop-admin-row">
            <div>
                <strong>${escapeHtml(item.name)}</strong><br>
                <small class="settings-muted">${escapeHtml(labels[item.cat] || item.cat)}</small>
            </div>
            <div class="shop-admin-controls">
                ${item.owned
                    ? `<button class="inv-btn" type="button" disabled>Owned ✓</button>`
                    : `<button class="inv-btn primary" type="button" data-acct="gift-give" data-kind="${escapeHtml(item.kind)}" data-id="${escapeHtml(item.id)}">Give</button>`}
            </div>
        </div>`).join("");

    const more = matches.length > GIFT_ROW_LIMIT
        ? `<div class="settings-muted" style="margin-top:8px">Showing the first ${GIFT_ROW_LIMIT} of ${matches.length}. Use the search or a category to narrow it down.</div>`
        : "";

    return rows + more;
}

function renderAcctPage(page, view) {
    if (myBadge !== "owner") {
        page.innerHTML = settingsHeader("➕ ADD ACCOUNT") + `<div class="settings-card"><p>Only the Owner can manage accounts.</p></div>`;
        return;
    }

    if (view === "acctmenu") {
        page.innerHTML = settingsHeader("➕ ADD ACCOUNT") + `
            <div class="settings-admin-note">Players can't sign up on their own any more. Accounts made here are the only way in. The server re-checks that you are the Owner.</div>
            <div class="settings-grid">
                <button class="settings-option settings-category" type="button" data-acct="go-add">
                    <span class="settings-icon">➕</span><span class="settings-copy"><strong>Add Account</strong><span>Create a new player account</span></span>
                </button>
                <button class="settings-option settings-category" type="button" data-acct="go-list">
                    <span class="settings-icon">📋</span><span class="settings-copy"><strong>List Accounts</strong><span>See, edit or delete accounts</span></span>
                </button>
            </div>
        `;
    } else if (view === "acctadd") {
        page.innerHTML = settingsHeader("➕ ADD ACCOUNT") + `
            <div class="settings-card">
                <h3>➕ Add Account</h3>
                <div class="mw-admin-add">
                    <input id="acctNewUsername" type="text" maxlength="20" placeholder="Username (3-20 letters, numbers, _)" autocomplete="off" spellcheck="false">
                    <input id="acctNewPassword" type="password" maxlength="72" placeholder="Password (6-72 characters)" autocomplete="new-password">
                    <input id="acctNewPin" type="password" inputmode="numeric" maxlength="8" placeholder="PIN (4-8 digits)" autocomplete="new-password">
                    <button class="inv-btn primary" type="button" data-acct="add-submit">Add Account</button>
                </div>
                <div class="mw-admin-note">Give the player their username, password and PIN yourself. All three are needed to log in.</div>
            </div>
            <div class="shop-message" id="acctMessage">${escapeHtml(acctState.message)}</div>
        `;
    } else if (view === "acctlist") {
        const body = acctState.list === null
            ? `<div class="settings-muted">Loading…</div>`
            : acctRowsHtml();

        page.innerHTML = settingsHeader("📋 LIST ACCOUNTS") + `
            <div class="settings-card">
                <div class="mw-admin-add">
                    <input id="acctSearch" type="text" maxlength="60" placeholder="Search by username or display name" autocomplete="off" value="${escapeHtml(acctState.filter)}">
                </div>
            </div>
            <div class="settings-card" id="acctListBody">${body}</div>
            <div class="shop-message" id="acctMessage">${escapeHtml(acctState.message)}</div>
        `;
    } else if (view === "acctedit") {
        const a = acctState.editing;

        if (!a) {
            settingsNav("acctlist");
            return;
        }

        page.innerHTML = settingsHeader("✏️ EDIT ACCOUNT") + `
            <div class="settings-card">
                <h3>✏️ ${escapeHtml(a.username)}</h3>
                <div class="settings-muted" style="margin-bottom:8px">Change the username, and/or type a new password and/or a new PIN. Leave a box as it is to keep it.</div>
                <div class="mw-admin-add">
                    <input id="acctEditUsername" type="text" maxlength="20" placeholder="Username (3-20 letters, numbers, _)" autocomplete="off" spellcheck="false" value="${escapeHtml(a.username)}">
                    <input id="acctEditPassword" type="password" maxlength="72" placeholder="New password (optional)" autocomplete="new-password">
                    <input id="acctEditPin" type="password" inputmode="numeric" maxlength="8" placeholder="New PIN (optional)" autocomplete="new-password">
                    <button class="inv-btn primary" type="button" data-acct="edit-save">Save</button>
                    <button class="inv-btn danger" type="button" data-acct="ban-toggle">${a.banned ? "✅ Unban" : "⛔ Ban"}</button>
                </div>
                ${a.banned ? '<div class="mw-admin-note">⛔ This account is banned and cannot sign in.</div>' : ""}
                <div class="mw-admin-note">A new username keeps their points, items and progress, and they stay signed in. Changing a password or PIN signs that player out everywhere.</div>
            </div>
            <div class="shop-message" id="acctMessage">${escapeHtml(acctState.message)}</div>
        `;
    }

    else if (view === "acctview") {
        const d = acctState.viewData;
        const who = escapeHtml(acctState.viewing || "");

        page.innerHTML = settingsHeader("👁️ VIEW ACCOUNT") + (d ? `
            <div class="settings-card">
                <h3>👁️ ${escapeHtml(d.username)}</h3>
                <div class="settings-row"><div><strong>Display Name</strong><small>${escapeHtml(d.displayName)}</small></div></div>
                <div class="settings-row"><div><strong>Level</strong><small>${Number(d.level) || 1}</small></div></div>
                <div class="settings-row"><div><strong>Items owned</strong><small>${Number(d.itemsOwned) || 0}</small></div></div>
            </div>
            <div class="settings-card">
                <h3>🏆 Points</h3>
                <div class="settings-muted" style="margin-bottom:8px">Change a number and press Save Points. Rank points can go up or down.</div>
                <div class="mw-admin-add">
                    <label class="acct-field-label" for="acctRankPoints">Rank points</label>
                    <input id="acctRankPoints" type="number" min="0" max="1000000" step="1" value="${Number(d.rankPoints) || 0}">
                    <label class="acct-field-label" for="acctShopPoints">Shop points</label>
                    <input id="acctShopPoints" type="number" min="0" max="1000000" step="1" value="${Number(d.shopPoints) || 0}">
                    <button class="inv-btn primary" type="button" data-acct="save-points">Save Points</button>
                </div>
            </div>
            <div class="shop-message" id="acctMessage">${escapeHtml(acctState.message)}</div>
            <div class="settings-card">
                <button class="inv-btn primary" type="button" data-acct="go-gift" style="width:100%">🎁 Give Gift</button>
            </div>
        ` : `<div class="settings-card"><h3>👁️ ${who}</h3><div class="settings-muted">Loading…</div></div>
             <div class="shop-message" id="acctMessage">${escapeHtml(acctState.message)}</div>`);
    } else if (view === "acctgift") {
        const g = acctState.gift;
        let options = "";

        if (g) {
            const counts = {};
            g.items.forEach(item => { counts[item.cat] = (counts[item.cat] || 0) + 1; });
            options = `<option value="all"${acctState.giftCat === "all" ? " selected" : ""}>All categories</option>` +
                g.categories
                    .filter(c => counts[c.key])
                    .map(c => `<option value="${escapeHtml(c.key)}"${acctState.giftCat === c.key ? " selected" : ""}>${escapeHtml(c.icon)} ${escapeHtml(c.label)}</option>`)
                    .join("");
        }

        page.innerHTML = settingsHeader("🎁 GIVE GIFT") + (g ? `
            <div class="settings-card">
                <h3>🎁 Give a gift to ${escapeHtml(g.username)}</h3>
                <div class="settings-muted" style="margin-bottom:8px">Gifts are free for the player and are not equipped for them.</div>
                <div class="mw-admin-add">
                    <select id="acctGiftCat">${options}</select>
                    <input id="acctGiftSearch" type="text" maxlength="60" placeholder="Search items" autocomplete="off" value="${escapeHtml(acctState.giftFilter)}">
                </div>
            </div>
            <div class="settings-card" id="acctGiftBody">${acctGiftRowsHtml()}</div>
            <div class="shop-message" id="acctMessage">${escapeHtml(acctState.message)}</div>
        ` : `<div class="settings-card"><div class="settings-muted">Loading the shop…</div></div>
             <div class="shop-message" id="acctMessage">${escapeHtml(acctState.message)}</div>`);
    }

    const back = view === "acctmenu" ? "main" : view === "acctedit" || view === "acctview" ? "acctlist" : view === "acctgift" ? "acctview" : "acctmenu";
    $("settingsBack")?.addEventListener("click", () => {
        acctState.message = "";
        settingsNav(back);
    });
    $("settingsClose")?.addEventListener("click", closeSettings);
}

function handleAcctClick(event) {
    const target = event.target.closest("[data-acct]");
    if (!target) return;

    const action = target.dataset.acct;

    if (action === "open-menu") {
        acctState.message = "";
        settingsNav("acctmenu");
    } else if (action === "go-add") {
        acctState.message = "";
        settingsNav("acctadd");
    } else if (action === "go-list") {
        acctState.message = "";
        acctState.filter = "";
        loadAcctList();
        settingsNav("acctlist");
    } else if (action === "add-submit") {
        const payload = {
            username: $("acctNewUsername")?.value || "",
            password: $("acctNewPassword")?.value || "",
            pin: $("acctNewPin")?.value || ""
        };

        if (!payload.username || !payload.password || !payload.pin) {
            acctNotice("Fill in the username, password and PIN.");
            return;
        }

        target.disabled = true;
        acctNotice("Adding…");

        socket.emit("ownerAccountAdd", payload, result => {
            target.disabled = false;

            if (result?.ok) {
                ["acctNewUsername", "acctNewPassword", "acctNewPin"].forEach(id => {
                    if ($(id)) $(id).value = "";
                });
                acctNotice(`✅ Account "${result.username}" added.`);
            } else {
                acctNotice(result?.error || "Could not add the account.");
            }
        });
    } else if (action === "view") {
        acctState.viewing = target.dataset.user;
        acctState.viewData = null;
        acctState.message = "";

        socket.emit("ownerAccountView", { username: acctState.viewing }, result => {
            if (result?.ok) {
                acctState.viewData = result;
            } else {
                acctState.message = result?.error || "Could not load the account.";
            }
            if (settingsView === "acctview") renderSettingsPage("acctview");
        });

        settingsNav("acctview");
    } else if (action === "save-points") {
        const payload = {
            username: acctState.viewing,
            rankPoints: $("acctRankPoints")?.value ?? "",
            shopPoints: $("acctShopPoints")?.value ?? ""
        };

        target.disabled = true;
        acctNotice("Saving…");

        socket.emit("ownerAccountSetPoints", payload, result => {
            target.disabled = false;

            if (result?.ok) {
                acctState.viewData = result;
                acctState.message = "✅ Points saved.";
                renderSettingsPage("acctview");
            } else {
                acctNotice(result?.error || "Could not save the points.");
            }
        });
    } else if (action === "go-gift") {
        acctState.gift = null;
        acctState.giftCat = "all";
        acctState.giftFilter = "";
        acctState.message = "";

        socket.emit("ownerGiftCatalog", { username: acctState.viewing }, result => {
            if (result?.ok) {
                acctState.gift = result;
            } else {
                acctState.message = result?.error || "Could not load the shop.";
            }
            if (settingsView === "acctgift") renderSettingsPage("acctgift");
        });

        settingsNav("acctgift");
    } else if (action === "gift-give") {
        const kind = target.dataset.kind;
        const id = target.dataset.id;

        target.disabled = true;

        socket.emit("ownerGiftGive", { username: acctState.viewing, kind, id }, result => {
            if (result?.ok) {
                const item = acctState.gift?.items.find(i => i.kind === kind && i.id === id);
                if (item) item.owned = true;
                const body = $("acctGiftBody");
                if (body) body.innerHTML = acctGiftRowsHtml();
                acctNotice(`🎁 Gave "${result.name}" to ${acctState.gift?.username || acctState.viewing}.`);
            } else {
                target.disabled = false;
                acctNotice(result?.error || "Could not give that.");
            }
        });
    } else if (action === "edit") {
        const found = (acctState.list || []).find(a => a.username === target.dataset.user);
        if (!found) return;
        acctState.editing = found;
        acctState.message = "";
        settingsNav("acctedit");
    } else if (action === "edit-save") {
        const a = acctState.editing;
        if (!a) return;

        const payload = {
            username: a.username,
            newUsername: ($("acctEditUsername")?.value || "").trim(),
            password: $("acctEditPassword")?.value || "",
            pin: $("acctEditPin")?.value || ""
        };

        if (payload.newUsername === a.username && !payload.password && !payload.pin) {
            acctNotice("Change the username, or type a new password or a new PIN.");
            return;
        }

        target.disabled = true;
        acctNotice("Saving…");

        socket.emit("ownerAccountEdit", payload, result => {
            target.disabled = false;

            if (result?.ok) {
                acctState.message = `✅ Saved "${result.username || a.username}".`;
                acctState.filter = "";
                loadAcctList();
                settingsNav("acctlist");
            } else {
                acctNotice(result?.error || "Could not save the account.");
            }
        });
    } else if (action === "ban-toggle") {
        const a = acctState.editing;
        if (!a) return;

        const willBan = !a.banned;
        if (willBan && !confirm(`Ban the account "${a.username}"? They will be signed out and can't log in until you unban them.`)) return;

        socket.emit("ownerAccountBan", { username: a.username, banned: willBan }, result => {
            if (result?.ok) {
                a.banned = result.banned;
                acctState.message = result.banned ? `⛔ "${a.username}" is banned.` : `✅ "${a.username}" is unbanned.`;
                loadAcctList();
                renderSettingsPage("acctedit");
            } else {
                acctNotice(result?.error || "Could not change the ban.");
            }
        });
    } else if (action === "delete") {
        const username = target.dataset.user;

        if (!confirm(`Delete the account "${username}"? Its points, items and stats will be lost for good.`)) return;

        socket.emit("ownerAccountDelete", { username }, result => {
            acctState.message = result?.ok ? `✅ Account "${username}" deleted.` : (result?.error || "Could not delete the account.");
            loadAcctList();
        });
    } else if (action === "save-display") {
        saveDisplayName();
    } else if (action === "show-password") {
        openAcctPrompt({
            kind: "password",
            title: "ENTER PIN",
            text: "Enter your PIN to reveal your password.",
            placeholder: "PIN",
            numeric: true,
            confirmLabel: "SHOW PASSWORD",
            onSubmit: pin => socket.emit("showMyPassword", { pin })
        });
    } else if (action === "show-pin") {
        openAcctPrompt({
            kind: "pin",
            title: "ENTER PASSWORD",
            text: "Enter your password to reveal your PIN.",
            placeholder: "Password",
            numeric: false,
            confirmLabel: "SHOW PIN",
            onSubmit: password => socket.emit("showMyPin", { password })
        });
    }
}

/* ---------- Hook everything into Settings ---------- */

const renderSettingsPageBeforeAccounts = renderSettingsPage;

renderSettingsPage = function(view) {
    const page = $("settingsPage");

    if (page && !acctState.clickInstalled) {
        acctState.clickInstalled = true;
        page.addEventListener("click", handleAcctClick);
        page.addEventListener("input", event => {
            if (event.target.id === "acctSearch") {
                acctState.filter = event.target.value;
                const body = $("acctListBody");
                if (body && acctState.list !== null) body.innerHTML = acctRowsHtml();
            } else if (event.target.id === "acctGiftSearch") {
                acctState.giftFilter = event.target.value;
                const body = $("acctGiftBody");
                if (body) body.innerHTML = acctGiftRowsHtml();
            }
        });
        page.addEventListener("change", event => {
            if (event.target.id !== "acctGiftCat") return;
            acctState.giftCat = event.target.value;
            const body = $("acctGiftBody");
            if (body) body.innerHTML = acctGiftRowsHtml();
        });
    }

    if (page && ["acctmenu", "acctadd", "acctlist", "acctedit", "acctview", "acctgift"].includes(view)) {
        // Keep the existing Account controls safe (same rule the other pages follow).
        const accountInfo = $("accountInfo");
        const accountChip = $("accountChip");
        if (accountInfo && accountChip && accountInfo.parentElement !== accountChip) {
            accountChip.appendChild(accountInfo);
            accountInfo.style.display = "none";
        }

        renderAcctPage(page, view);
        return;
    }

    renderSettingsPageBeforeAccounts(view);

    // Settings: Owner-only ➕ Add Account entry.
    if (page && view === "main" && myBadge === "owner") {
        const grid = page.querySelector(".settings-grid");

        if (grid && !grid.querySelector('[data-acct="open-menu"]')) {
            grid.insertAdjacentHTML("beforeend", `
                <button class="settings-option settings-category" type="button" data-acct="open-menu">
                    <span class="settings-icon">➕</span><span class="settings-copy"><strong>Add Account</strong><span>Owner only: create and manage player accounts</span></span>
                </button>
            `);
        }
    }

    // Settings -> Account: username, Display Name, password, PIN.
    if (page && view === "account" && authState?.username) {
        renderAccountDetailsCard(page);
    }
};

/* The Owner changed this player's username while they are playing. */
socket.on("accountRenamed", data => {
    if (!authState.username || !data?.username) return;

    const oldDisplay = authState.displayName;
    authState.username = data.username;
    authState.displayName = data.displayName || data.username;

    ["createPlayerName", "joinPlayerName", "quickStartPlayerName", "rejoinPlayerName"].forEach(id => {
        const box = $(id);
        if (box && box.value === oldDisplay) box.value = authState.displayName;
    });

    if (typeof updateAccountChip === "function") updateAccountChip();
});

/* The Owner changed this player's points or gave them a gift. */
socket.on("ownerGiftReceived", data => {
    if (typeof showShopToast === "function") showShopToast(`🎁 The Owner gave you: ${data?.name || "a gift"}`);
    if (typeof requestMyProgress === "function") setTimeout(requestMyProgress, 400);
});

socket.on("ownerPointsChanged", () => {
    if (typeof showShopToast === "function") showShopToast("💰 The Owner updated your points");
    if (typeof requestMyProgress === "function") setTimeout(requestMyProgress, 400);
});


/* =========================================================
   SOUNDBOARD
   - 12 sounds. Put the MP3 files in  public/soundboard/
     (file names below, e.g. "Among Us.mp3").
   - Works in the lobby and during the game; everyone in the
     SAME room hears a sound when a permitted player plays it.
   - The HOST decides which REGISTERED players may play sounds
     (guests cannot be selected). The server checks everything:
     permission, cooldown and spam limits (see server.js).
   - Each player has their own volume + mute (saved on this device).
========================================================= */

var SOUNDBOARD_SOUNDS = [
    { id: "years",     emoji: "⏳", name: "2000 Years Later",  files: ["2000 Years Later.mp3", "2000 years later.mp3", "2000-years-later.mp3"] },
    { id: "amongus",   emoji: "🚨", name: "Among Us",          files: ["Among Us.mp3", "among us.mp3", "among-us.mp3"] },
    { id: "hisname",   emoji: "🎤", name: "And His Name Is",   files: ["And His Name Is.mp3", "and his name is.mp3", "and-his-name-is.mp3"] },
    { id: "cry",       emoji: "😭", name: "Cry",               files: ["Cry.mp3", "cry.mp3"] },
    { id: "explosion", emoji: "💥", name: "Explosion",         files: ["Explosion.mp3", "explosion.mp3"] },
    { id: "fahhhhh",   emoji: "😂", name: "Fahhhhh",           files: ["Fahhhhh.mp3", "fahhhhh.mp3"] },
    { id: "fail",      emoji: "❌", name: "Fail",              files: ["Fail.mp3", "fail.mp3"] },
    { id: "funny",     emoji: "🤣", name: "Funny",             files: ["Funny.mp3", "funny.mp3"] },
    { id: "goodboy",   emoji: "🐶", name: "Good Boy",          files: ["Good Boy.mp3", "good boy.mp3", "good-boy.mp3"] },
    { id: "hawwwww",   emoji: "😱", name: "Hawwwww",           files: ["Hawwwww.mp3", "hawwwww.mp3"] },
    { id: "laugh",     emoji: "😂", name: "Laugh Hahahaha",    files: ["Laugh Hahahaha.mp3", "laugh hahahaha.mp3", "laugh-hahahaha.mp3"] },
    { id: "omgbruh",   emoji: "💀", name: "OMG Bruh",          files: ["OMG Bruh.mp3", "omg bruh.mp3", "omg-bruh.mp3"] }
];

var SOUNDBOARD_COOLDOWN_MS = 2000;   // the server enforces the same limit
var SOUNDBOARD_MAX_OVERLAP = 3;      // at most 3 sounds at the same time

var soundboardPlayerIds = [];        // players the host selected (from the server)
var sbDraft = null;                  // host's unsaved selection (null = follow the server)
var sbOpen = false;
var sbCooldownUntil = 0;
var sbActiveAudio = [];
var sbToastTimer = null;
var sbRefreshTimer = null;

function sbLoadNumber(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        if (raw === null) return fallback;
        const value = Number(raw);
        return Number.isFinite(value) ? value : fallback;
    } catch (error) {
        return fallback;
    }
}

function sbSaveNumber(key, value) {
    try { localStorage.setItem(key, String(value)); } catch (error) { /* private mode */ }
}

var sbVolume = Math.min(100, Math.max(0, sbLoadNumber("mafiaSoundboardVolume", 70)));
var sbMuted = sbLoadNumber("mafiaSoundboardMuted", 0) === 1;

function readSoundboardSettings(data) {
    if (!data || !Array.isArray(data.soundboardPlayerIds)) return;

    soundboardPlayerIds = data.soundboardPlayerIds.slice();

    // The server list can arrive before isHost is updated, so refresh a moment later.
    scheduleSoundboardRefresh();
}

function scheduleSoundboardRefresh() {
    clearTimeout(sbRefreshTimer);
    sbRefreshTimer = setTimeout(refreshSoundboardUi, 0);
}

function sbCanPlay() {
    return Boolean(isHost || soundboardPlayerIds.includes(socket.id));
}

function sbInRoomScreen() {
    const visible = id => {
        const el = $(id);
        return Boolean(el) && getComputedStyle(el).display !== "none";
    };

    return visible("lobby") || visible("gameScreen");
}

function sbSelectedSet() {
    return sbDraft || new Set(soundboardPlayerIds);
}

function sbStatus(text) {
    const status = $("soundboardStatus");
    if (status) status.textContent = text || "";
}

/* One line: shown in the panel, or as a small toast when the panel is closed. */
function sbFlash(text) {
    sbStatus(text);

    if (sbOpen) return;

    const toast = $("soundboardToast");
    if (!toast) return;

    toast.textContent = text;
    toast.classList.add("sb-toast-show");

    clearTimeout(sbToastTimer);
    sbToastTimer = setTimeout(() => toast.classList.remove("sb-toast-show"), 2600);
}

/* ---------- Host: who may play ---------- */

function renderSoundboardPermissions(container) {
    if (!container) return;

    container.innerHTML = "";

    const list = (players || []).filter(player => player && player.connected !== false);
    const selected = sbSelectedSet();

    list.forEach(player => {
        const registered = Boolean(player.registered);
        const isHostRow = player.id === window.currentHostId;

        const row = document.createElement("label");
        row.className = "sb-perm-row" + (registered || isHostRow ? "" : " sb-perm-guest");

        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = isHostRow || (registered && selected.has(player.id));
        box.disabled = isHostRow || !registered;

        const name = document.createElement("span");
        name.className = "sb-perm-name";
        name.textContent = player.name + (player.id === socket.id ? " (you)" : "");

        const tag = document.createElement("span");
        tag.className = "sb-perm-tag";
        tag.textContent = isHostRow ? "Host · always allowed" : (registered ? "Registered" : "Guest · not allowed");

        box.addEventListener("change", () => {
            if (sbDraft === null) sbDraft = new Set(soundboardPlayerIds);

            if (box.checked) sbDraft.add(player.id);
            else sbDraft.delete(player.id);

            refreshSoundboardUi();
        });

        row.append(box, name, tag);
        container.appendChild(row);
    });

    if (!list.length) {
        const empty = document.createElement("div");
        empty.className = "sb-empty";
        empty.textContent = "No players yet.";
        container.appendChild(empty);
    }
}

function sbApplyPermissions() {
    if (!isHost) return;

    const chosen = Array.from(sbSelectedSet()).filter(id =>
        (players || []).some(player => player.id === id && player.registered)
    );

    socket.emit("setSoundboardPermissions", { roomCode, players: chosen });

    sbDraft = null;
    sbStatus("✅ Soundboard permissions updated.");
    scheduleSoundboardRefresh();
}

function sbUpdateButtonLabel(button) {
    if (!button) return;

    const count = Array.from(sbSelectedSet()).filter(id =>
        (players || []).some(player => player.id === id && player.registered)
    ).length;

    button.textContent = `✅ UPDATE PERMISSIONS (${count})` + (sbDraft ? " •" : "");
}

/* The section in the lobby's host settings (markup is in index.html; created here if missing). */
function ensureSoundboardHostSection() {
    const hostSettings = $("hostSettings");
    if (!hostSettings) return;

    let section = $("soundboardHostSection");

    if (!section) {
        section = document.createElement("div");
        section.id = "soundboardHostSection";
        section.className = "sb-host-section";
        section.innerHTML =
            "<h3>🔊 Soundboard Permissions</h3>" +
            "<p>Choose which registered players can play sounds. Guests can't be selected.</p>" +
            "<div id=\"soundboardPermList\" class=\"sb-perm-list\"></div>" +
            "<button id=\"soundboardPermUpdate\" type=\"button\" class=\"sb-update-button\"></button>";

        const start = $("startGame");
        hostSettings.insertBefore(section, start && start.parentNode === hostSettings ? start : null);
    }

    const update = $("soundboardPermUpdate");

    if (update && !update.dataset.bound) {
        update.dataset.bound = "1";
        update.addEventListener("click", sbApplyPermissions);
    }

    section.style.display = isHost ? "" : "none";

    renderSoundboardPermissions($("soundboardPermList"));
    sbUpdateButtonLabel(update);
}

/* ---------- Panel (lives inside the Voice Chat panel) ---------- */

/* Adds a 🎛️ SOUNDBOARD button to the Voice Chat panel's button row and a
   soundboard section under it. Returns false until the voice panel exists. */
function ensureSoundboardUi() {
    if ($("voiceSoundboardPanel")) return true;

    const voice = $("voiceChatPanel");
    const controls = voice ? voice.querySelector(".voice-controls") : null;
    const body = $("voiceBody");

    if (!voice || !controls || !body) return false;

    const toggle = document.createElement("button");
    toggle.id = "soundboardToggle";
    toggle.type = "button";
    toggle.className = "voice-control-button";
    toggle.textContent = "🎛️ SOUNDBOARD";
    toggle.addEventListener("click", () => {
        sbOpen = !sbOpen;
        refreshSoundboardUi();
    });
    controls.appendChild(toggle);

    const toast = document.createElement("div");
    toast.id = "soundboardToast";
    voice.appendChild(toast);

    const panel = document.createElement("div");
    panel.id = "voiceSoundboardPanel";
    panel.className = "voice-speaker-panel sb-panel";
    panel.style.display = "none";

    const note = document.createElement("div");
    note.id = "soundboardNote";
    note.className = "sb-note";

    const volumeRow = document.createElement("div");
    volumeRow.className = "sb-volume-row";

    const mute = document.createElement("button");
    mute.id = "soundboardMute";
    mute.type = "button";
    mute.className = "sb-mute";
    mute.addEventListener("click", () => {
        sbMuted = !sbMuted;
        sbSaveNumber("mafiaSoundboardMuted", sbMuted ? 1 : 0);
        sbApplyVolume();
    });

    const slider = document.createElement("input");
    slider.id = "soundboardVolume";
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.step = "1";
    slider.value = String(sbVolume);
    slider.setAttribute("aria-label", "Soundboard volume");
    slider.addEventListener("input", () => {
        sbVolume = Number(slider.value) || 0;
        sbSaveNumber("mafiaSoundboardVolume", sbVolume);
        sbApplyVolume();
    });

    const label = document.createElement("span");
    label.id = "soundboardVolumeLabel";
    label.className = "sb-volume-label";

    volumeRow.append(mute, slider, label);

    const grid = document.createElement("div");
    grid.id = "soundboardGrid";
    grid.className = "sb-grid";

    SOUNDBOARD_SOUNDS.forEach(sound => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "sb-sound";
        button.dataset.sound = sound.id;

        const emoji = document.createElement("span");
        emoji.className = "sb-emoji";
        emoji.textContent = sound.emoji;

        const name = document.createElement("span");
        name.className = "sb-name";
        name.textContent = sound.name;

        button.append(emoji, name);
        button.addEventListener("click", () => sbPlay(sound.id));
        grid.appendChild(button);
    });

    const status = document.createElement("div");
    status.id = "soundboardStatus";
    status.className = "sb-status";

    const hostBox = document.createElement("details");
    hostBox.id = "soundboardHostBox";
    hostBox.className = "sb-host-box";
    hostBox.style.display = "none";

    const summary = document.createElement("summary");
    summary.textContent = "⚙️ Permissions (host)";

    const permList = document.createElement("div");
    permList.id = "soundboardPanelPermList";
    permList.className = "sb-perm-list";

    const update = document.createElement("button");
    update.id = "soundboardPanelUpdate";
    update.type = "button";
    update.className = "sb-update-button";
    update.addEventListener("click", sbApplyPermissions);

    hostBox.append(summary, permList, update);

    panel.append(note, volumeRow, grid, status, hostBox);
    body.appendChild(panel);

    sbApplyVolume();
    setTimeout(refreshSoundboardUi, 0);

    return true;
}

function sbApplyVolume() {
    const mute = $("soundboardMute");
    const label = $("soundboardVolumeLabel");

    if (mute) mute.textContent = sbMuted || sbVolume <= 0 ? "🔇" : (sbVolume < 40 ? "🔈" : "🔊");
    if (label) label.textContent = sbMuted ? "MUTED" : `${sbVolume}%`;

    sbActiveAudio.forEach(audio => { audio.volume = sbMuted ? 0 : sbVolume / 100; });
}

/* Cheap check: panel open/closed + which buttons are enabled. Runs every second. */
function sbSyncVisibility() {
    if (!ensureSoundboardUi()) return;

    const voice = $("voiceChatPanel");
    const voiceShown = Boolean(voice) && voice.style.display !== "none";

    if (!voiceShown || !sbInRoomScreen()) sbOpen = false;

    $("soundboardToggle")?.classList.toggle("voice-control-active", sbOpen);

    const panel = $("voiceSoundboardPanel");
    if (panel) panel.style.display = sbOpen ? "block" : "none";

    const hostBox = $("soundboardHostBox");
    if (hostBox) hostBox.style.display = isHost ? "" : "none";

    const canPlay = sbCanPlay();
    const cooling = Date.now() < sbCooldownUntil;

    document.querySelectorAll("#soundboardGrid .sb-sound").forEach(button => {
        button.disabled = !canPlay || cooling;
    });

    $("soundboardGrid")?.classList.toggle("sb-locked", !canPlay);
    $("soundboardGrid")?.classList.toggle("sb-cooling", canPlay && cooling);

    const note = $("soundboardNote");

    if (note) {
        note.textContent = canPlay
            ? "Tap a sound to play it for everyone in this room."
            : "🔒 You can listen, but the host has not given you permission to play sounds.";
    }
}

/* Full redraw: after permissions, players or the host change. */
function refreshSoundboardUi() {
    sbSyncVisibility();

    if (isHost && sbOpen) {
        renderSoundboardPermissions($("soundboardPanelPermList"));
        sbUpdateButtonLabel($("soundboardPanelUpdate"));
    }

    ensureSoundboardHostSection();
}

/* ---------- Playing ---------- */

function sbPlay(soundId) {
    if (!sbCanPlay()) {
        sbStatus("🔒 You do not have soundboard permission.");
        return;
    }

    const now = Date.now();
    if (now < sbCooldownUntil) return;

    sbCooldownUntil = now + SOUNDBOARD_COOLDOWN_MS;

    socket.emit("soundboardPlay", { roomCode, soundId });

    sbSyncVisibility();
    setTimeout(sbSyncVisibility, SOUNDBOARD_COOLDOWN_MS + 40);
}

function sbPlayAudio(sound) {
    const audio = new Audio();
    audio.preload = "auto";
    audio.volume = sbMuted ? 0 : sbVolume / 100;

    let attempt = 0;

    // Tries the exact file name first, then simpler spellings (Linux servers are case-sensitive).
    const tryNext = () => {
        if (attempt >= sound.files.length) return;

        audio.src = "/soundboard/" + encodeURIComponent(sound.files[attempt++]);
        const started = audio.play();
        if (started && started.catch) started.catch(() => { /* blocked or missing */ });
    };

    audio.addEventListener("error", tryNext);

    audio.addEventListener("ended", () => {
        sbActiveAudio = sbActiveAudio.filter(item => item !== audio);
    });

    sbActiveAudio.push(audio);

    while (sbActiveAudio.length > SOUNDBOARD_MAX_OVERLAP) {
        const oldest = sbActiveAudio.shift();
        try { oldest.pause(); } catch (error) { /* ignore */ }
    }

    tryNext();
}

socket.on("soundboardPlayed", data => {
    const sound = SOUNDBOARD_SOUNDS.find(item => item.id === data?.soundId);
    if (!sound) return;

    const who = String(data?.fromName || "Someone").slice(0, 24);

    sbFlash(`${sound.emoji} ${who} played ${sound.name}`);

    if (sbMuted || sbVolume <= 0) return;

    sbPlayAudio(sound);
});

socket.on("soundboardError", message => {
    sbCooldownUntil = 0;
    sbFlash("⚠️ " + String(message || "Soundboard error."));
    sbSyncVisibility();
});

setInterval(sbSyncVisibility, 1000);

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", refreshSoundboardUi);
} else {
    refreshSoundboardUi();
}


/* =========================================================
   LOBBY CHAT
   Text chat in the lobby, so players without a microphone can
   talk too. The server checks the room, the lobby phase and spam
   (see server.js). Messages are drawn with textContent only.
========================================================= */

var lobbyChatKey = "";          // "ROOM:socketId" the history was loaded for
var lobbyChatErrorTimer = null;
var lobbyChatLastTime = 0;

function lcTimeText(time) {
    try {
        return new Date(time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch (error) {
        return "";
    }
}

function lcClear() {
    const box = $("lobbyChatMessages");
    if (!box) return;

    box.innerHTML = "";

    const empty = document.createElement("div");
    empty.className = "lc-empty";
    empty.textContent = "No messages yet. Say hi 👋";
    box.appendChild(empty);
}

function lcAdd(entry) {
    const box = $("lobbyChatMessages");
    if (!box || !entry) return;

    box.querySelector(".lc-empty")?.remove();

    const mine = entry.fromId === socket.id;
    const isHostSender = entry.fromId === window.currentHostId;

    const row = document.createElement("div");
    row.className = "lc-msg " + (mine ? "lc-me" : "lc-them");

    const meta = document.createElement("div");
    meta.className = "lc-meta";

    const name = document.createElement("span");
    name.className = "lc-name";
    name.textContent = (isHostSender ? "👑 " : "") + (mine ? "You" : String(entry.name || "Player").slice(0, 24));

    const time = document.createElement("span");
    time.className = "lc-time";
    time.textContent = lcTimeText(entry.time);

    meta.append(name, time);

    const text = document.createElement("div");
    text.className = "lc-text";
    text.textContent = String(entry.text || "");

    row.append(meta, text);
    box.appendChild(row);

    while (box.children.length > 80) box.firstElementChild.remove();

    box.scrollTop = box.scrollHeight;
}

function lcError(message) {
    const el = $("lobbyChatError");
    if (!el) return;

    el.textContent = message || "";

    clearTimeout(lobbyChatErrorTimer);
    lobbyChatErrorTimer = setTimeout(() => { el.textContent = ""; }, 3000);
}

function lcSend() {
    const input = $("lobbyChatInput");
    if (!input) return;

    const message = input.value.trim();
    if (!message) return;

    // Same limits as the server, so the player gets instant feedback.
    if (Date.now() - lobbyChatLastTime < 600) {
        lcError("You are typing too fast.");
        return;
    }

    lobbyChatLastTime = Date.now();

    socket.emit("sendLobbyMessage", { roomCode, message });

    input.value = "";
    input.focus();
}

function setupLobbyChat() {
    const input = $("lobbyChatInput");
    const send = $("lobbyChatSend");

    if (!input || !send || send.dataset.bound) return;

    send.dataset.bound = "1";
    send.addEventListener("click", lcSend);

    input.addEventListener("keydown", event => {
        if (event.key === "Enter") {
            event.preventDefault();
            lcSend();
        }
    });

    lcClear();
}

socket.on("lobbyChatHistory", list => {
    lcClear();

    if (!Array.isArray(list)) return;

    list.forEach(entry => lcAdd(entry));
});

socket.on("lobbyMessage", entry => lcAdd(entry));

socket.on("lobbyChatError", message => lcError(String(message || "Could not send.")));

// The lobby update tells us which room we are in; load its saved messages once per room/connection.
socket.on("playerJoined", data => {
    const code = data && !Array.isArray(data) ? data.roomCode : "";
    if (!code) return;

    const key = `${code}:${socket.id}`;
    if (key === lobbyChatKey) return;

    lobbyChatKey = key;
    setupLobbyChat();
    lcClear();
    socket.emit("lobbyChatRequest");
});

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupLobbyChat);
} else {
    setupLobbyChat();
}


/* =========================================================
   VIEW ACCOUNT
   A small "👤 View Account" button on every player in the lobby and
   in the game. It opens that player's PUBLIC card: rank, rank points,
   level, stats. Guests have no account, so the card says so.
   The server only answers for players in your own room and never
   sends the login name, shop points, items or game roles.
========================================================= */

var accountCardId = "";   // player the open card is waiting for / showing

function makeViewAccountButton(player) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "view-account-btn";
    button.textContent = "👤 View Account";
    button.title = "See this player's rank, points and stats";
    button.addEventListener("click", event => {
        event.stopPropagation();
        openAccountCard(player);
    });
    return button;
}

function ensureAccountCardOverlay() {
    let overlay = $("accountCardOverlay");
    if (overlay) return overlay;

    overlay = document.createElement("div");
    overlay.id = "accountCardOverlay";
    overlay.style.display = "none";
    overlay.addEventListener("click", event => {
        if (event.target === overlay) closeAccountCard();
    });

    document.body.appendChild(overlay);

    document.addEventListener("keydown", event => {
        if (event.key === "Escape" && overlay.style.display !== "none") closeAccountCard();
    });

    return overlay;
}

function closeAccountCard() {
    const overlay = $("accountCardOverlay");
    if (overlay) overlay.style.display = "none";
    accountCardId = "";
}

function openAccountCard(player) {
    if (!player || !player.id) return;

    const overlay = ensureAccountCardOverlay();

    accountCardId = player.id;

    overlay.innerHTML = "";

    const card = document.createElement("div");
    card.className = "ac-card";

    const loading = document.createElement("div");
    loading.className = "ac-loading";
    loading.textContent = "Loading account…";

    card.appendChild(loading);
    overlay.appendChild(card);
    overlay.style.display = "flex";

    socket.emit("getAccountCard", { playerId: player.id });
}

function acStat(label, value) {
    const cell = document.createElement("div");
    cell.className = "ac-stat";

    const number = document.createElement("strong");
    number.textContent = String(value);

    const text = document.createElement("span");
    text.textContent = label;

    cell.append(number, text);
    return cell;
}

function renderAccountCard(data) {
    const overlay = ensureAccountCardOverlay();

    overlay.innerHTML = "";

    const card = document.createElement("div");
    card.className = "ac-card";

    const close = document.createElement("button");
    close.type = "button";
    close.className = "ac-close";
    close.textContent = "✕";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", closeAccountCard);
    card.appendChild(close);

    if (!data || !data.ok) {
        const message = document.createElement("div");
        message.className = "ac-loading";
        message.textContent = (data && data.error) || "Could not load this account.";
        card.appendChild(message);
        overlay.appendChild(card);
        return;
    }

    /* ----- top: character + name ----- */
    const top = document.createElement("div");
    top.className = "ac-top";

    const avatarBox = document.createElement("div");
    avatarBox.className = "ac-avatar";
    avatarBox.appendChild(avatarNode(data.look, 74, false));

    const who = document.createElement("div");
    who.className = "ac-who";

    const name = document.createElement("div");
    name.className = "ac-name";
    setTierName(name, data.name, data.guest ? null : data.tier);
    if (!data.guest) appendUserBadge(name, data.badge);

    const tags = document.createElement("div");
    tags.className = "ac-tags";

    const kind = document.createElement("span");
    kind.className = "ac-tag" + (data.guest ? " ac-tag-guest" : "");
    kind.textContent = data.guest ? "GUEST" : "REGISTERED";
    tags.appendChild(kind);

    if (data.isHost) {
        const host = document.createElement("span");
        host.className = "ac-tag ac-tag-host";
        host.textContent = "👑 HOST";
        tags.appendChild(host);
    }

    if (data.playerId === socket.id) {
        const you = document.createElement("span");
        you.className = "ac-tag";
        you.textContent = "YOU";
        tags.appendChild(you);
    }

    who.append(name, tags);
    top.append(avatarBox, who);
    card.appendChild(top);

    if (data.guest) {
        const note = document.createElement("div");
        note.className = "ac-guest-note";
        note.textContent = "This player is a guest. Guests have no account, so they have no rank, points or level.";
        card.appendChild(note);
        overlay.appendChild(card);
        return;
    }

    /* ----- rank + points ----- */
    const tier = getTierInfo(data.tier);
    const big = document.createElement("div");
    big.className = "ac-big";

    const rankBox = document.createElement("div");
    rankBox.className = "ac-big-box";
    const rankLabel = document.createElement("span");
    rankLabel.textContent = "LEADERBOARD";
    const rankValue = document.createElement("strong");
    rankValue.textContent = `#${data.position}`;
    const rankSmall = document.createElement("small");
    rankSmall.textContent = `of ${data.accounts} account${data.accounts === 1 ? "" : "s"}`;
    rankBox.append(rankLabel, rankValue, rankSmall);

    const pointsBox = document.createElement("div");
    pointsBox.className = "ac-big-box";
    const pointsLabel = document.createElement("span");
    pointsLabel.textContent = "RANK POINTS";
    const pointsValue = document.createElement("strong");
    pointsValue.textContent = String(data.points);
    const pointsSmall = document.createElement("small");
    if (data.nextTier) {
        const nextInfo = getTierInfo(data.nextTier.key);
        pointsSmall.textContent = `${data.nextTier.min - data.points} to ${nextInfo ? nextInfo.name : "next rank"}`;
    } else {
        pointsSmall.textContent = "Top rank reached";
    }
    pointsBox.append(pointsLabel, pointsValue, pointsSmall);

    const tagBox = document.createElement("div");
    tagBox.className = "ac-big-box";
    const tagLabel = document.createElement("span");
    tagLabel.textContent = "RANK TAG";
    const tagValue = document.createElement("strong");
    tagValue.textContent = tier ? `${tier.symbol} ${tier.name}` : "Unranked";
    if (tier) tagValue.style.color = tier.color;
    const tagSmall = document.createElement("small");
    tagSmall.textContent = tier ? "Unlocked" : "Starts at 150 pts";
    tagBox.append(tagLabel, tagValue, tagSmall);

    big.append(rankBox, pointsBox, tagBox);
    card.appendChild(big);

    /* ----- level bar ----- */
    const level = document.createElement("div");
    level.className = "ac-level";

    const levelTop = document.createElement("div");
    levelTop.className = "ac-level-top";
    const levelName = document.createElement("strong");
    levelName.textContent = `⭐ LEVEL ${data.level}`;
    const levelXp = document.createElement("span");
    levelXp.textContent = data.xpNeeded ? `${data.xpIntoLevel} / ${data.xpNeeded} XP` : "MAX LEVEL";
    levelTop.append(levelName, levelXp);

    const bar = document.createElement("div");
    bar.className = "ac-bar";
    const fill = document.createElement("div");
    fill.className = "ac-bar-fill";
    fill.style.width = (data.xpNeeded ? Math.min(100, Math.round(data.xpIntoLevel / data.xpNeeded * 100)) : 100) + "%";
    bar.appendChild(fill);

    level.append(levelTop, bar);
    card.appendChild(level);

    /* ----- stats ----- */
    const st = data.stats || {};
    const totalWins = (st.jesterWins || 0) + (st.mafiaWins || 0) + (st.civilianWins || 0);

    const grid = document.createElement("div");
    grid.className = "ac-grid";
    grid.append(
        acStat("🏆 Total Wins", totalWins),
        acStat("🔪 Kills", st.kills || 0),
        acStat("🛡️ Saves", st.saves || 0),
        acStat("🔎 Detects", st.detects || 0),
        acStat("🗳️ Correct Votes", st.civilianVotes || 0),
        acStat("☠️ Mafia Wins", st.mafiaWins || 0),
        acStat("🎉 Civilian Wins", st.civilianWins || 0),
        acStat("🤡 Jester Wins", st.jesterWins || 0)
    );
    card.appendChild(grid);

    /* ----- medals + member since ----- */
    if (Array.isArray(data.medals) && data.medals.length) {
        const medals = document.createElement("div");
        medals.className = "ac-medals";

        const title = document.createElement("span");
        title.textContent = "MEDALS";
        medals.appendChild(title);

        data.medals.forEach(medal => {
            const icon = document.createElement("span");
            icon.className = "ac-medal";
            icon.textContent = medal.icon;
            icon.title = `${medal.name} (level ${medal.level})`;
            medals.appendChild(icon);
        });

        card.appendChild(medals);
    }

    if (data.memberSince) {
        const since = document.createElement("div");
        since.className = "ac-since";
        try {
            since.textContent = "Member since " + new Date(data.memberSince).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
            card.appendChild(since);
        } catch (error) { /* ignore */ }
    }

    overlay.appendChild(card);
}

socket.on("accountCardData", data => {
    const overlay = $("accountCardOverlay");

    // Ignore late answers for a card the player already closed or replaced.
    if (!overlay || overlay.style.display === "none") return;
    if (data && data.ok && data.playerId !== accountCardId) return;

    renderAccountCard(data);
});


/* =========================================================
   MAFIA WARS - EXTRA ROLES AND FEATURES (client)
   New roles, Details button, host role setup rows, dead chat,
   last words, emotes, friends list, game replay.
   All new screens are created by this code, so they work
   without changing index.html or style.css.
========================================================= */
(function () {
    "use strict";

    const EXTRA_ROLE_ROWS = [
        { key: "bodyguard",   role: "Bodyguard",   label: "Bodyguard" },
        { key: "vigilante",   role: "Vigilante",   label: "Vigilante" },
        { key: "sheriff",     role: "Sheriff",     label: "Sheriff" },
        { key: "mayor",       role: "Mayor",       label: "Mayor" },
        { key: "escort",      role: "Escort",      label: "Escort" },
        { key: "framer",      role: "Framer",      label: "Framer" },
        { key: "medium",      role: "Medium",      label: "Medium" },
        { key: "executioner", role: "Executioner", label: "Executioner" },
        { key: "amnesiac",    role: "Amnesiac",    label: "Amnesiac" }
    ];

    const ROLE_INFO = {
        "Mafia":       { icon: "🔪", team: "Mafia",   text: "Each night the Mafia team secretly picks one player to kill. Win by having as many players as the town." },
        "Godfather":   { icon: "👑", team: "Mafia",   text: "A Mafia boss. The Detective and Sheriff see him as innocent. If he dies, the whole Mafia team dies with him." },
        "Grandmafia":  { icon: "🧓", team: "Mafia",   text: "Mafia member. On Night 1 secretly picks a player who becomes Baby Mafia when the Grandmafia dies." },
        "Baby Mafia":  { icon: "👶", team: "Mafia",   text: "Becomes Mafia after the Grandmafia dies and can kill with the team." },
        "Framer":      { icon: "🎭", team: "Mafia",   text: "Mafia member. Each night frames one player: that night the Detective and Sheriff will see them as Mafia / suspicious." },
        "Doctor":      { icon: "💚", team: "Town",    text: "Each night protects one player from the Mafia attack (and from the Vigilante)." },
        "Detective":   { icon: "🔎", team: "Town",    text: "Each night investigates one player and learns if they are MAFIA or NOT MAFIA. The Godfather looks innocent, framed players look guilty." },
        "Cupid":       { icon: "💘", team: "Town",    text: "On Night 1 links two players as lovers. If one dies, the other dies too." },
        "Grandma":     { icon: "👵", team: "Town",    text: "If the Mafia attacks her, the attack is reflected and kills the attacker." },
        "Civilian":    { icon: "🙂", team: "Town",    text: "No special power. Talk, think and vote out the Mafia." },
        "Bodyguard":   { icon: "🛡️", team: "Town",    text: "Each night guards one player. If the Mafia attacks that player, the Bodyguard dies in their place and the target lives." },
        "Vigilante":   { icon: "🔫", team: "Town",    text: "Each night can shoot one player (or skip). If the Vigilante kills 2 innocent players in one game, he dies of guilt." },
        "Sheriff":     { icon: "⭐", team: "Town",    text: "Each night checks one player: SUSPICIOUS or NOT SUSPICIOUS. Mafia, framed players, the Jester and the Executioner look suspicious. The Godfather looks innocent." },
        "Mayor":       { icon: "🏛️", team: "Town",    text: "Has no night action. The Mayor's vote counts as 2 votes during the day." },
        "Escort":      { icon: "🚧", team: "Town",    text: "Acts first each night. Picks one player and blocks their ability for that night (Doctor, Detective, Mafia kill, and more)." },
        "Medium":      { icon: "🔮", team: "Town",    text: "Can talk to the dead in the Dead Chat during the night and learn hints from them." },
        "Jester":      { icon: "🤡", team: "Neutral", text: "Wins immediately if the Jester is eliminated. Act suspicious so the town votes you out." },
        "Executioner": { icon: "🪓", team: "Neutral", text: "Gets a secret target. Wins if the town votes that target out. If the target dies another way, you become a Civilian." },
        "Amnesiac":    { icon: "🧠", team: "Neutral", text: "Starts with no role. When the FIRST player dies, the Amnesiac takes that player's role and abilities." }
    };

    const ROLE_ORDER = [
        "Mafia", "Godfather", "Grandmafia", "Framer", "Doctor", "Detective", "Sheriff", "Bodyguard",
        "Vigilante", "Escort", "Medium", "Mayor", "Cupid", "Grandma", "Civilian", "Jester", "Executioner", "Amnesiac"
    ];

    const COUNT_ID_ROLE = {
        mafiaCount: "Mafia", godfatherCount: "Godfather", grandmafiaCount: "Grandmafia", grandmaCount: "Grandma",
        doctorCount: "Doctor", detectiveCount: "Detective", jesterCount: "Jester", loverCount: "Cupid",
        civilianCount: "Civilian"
    };

    const ACTION_TEXT = {
        Escort:    { button: "🚧 BLOCK",  hint: "Choose a player to block tonight." },
        Framer:    { button: "🎭 FRAME",  hint: "Choose a player to frame as Mafia." },
        Bodyguard: { button: "🛡️ GUARD",  hint: "Choose a player to protect with your life." },
        Sheriff:   { button: "⭐ CHECK",  hint: "Choose a player to investigate." },
        Vigilante: { button: "🔫 SHOOT",  hint: "Choose a player to shoot, or skip." }
    };

    const EXTRA_TURN_ROLES = { escort: "Escort", framer: "Framer", bodyguard: "Bodyguard", sheriff: "Sheriff", vigilante: "Vigilante" };

    window.MW_ROLE_INFO = ROLE_INFO;
    window.MW_EXTRA_TURN_ROLES = EXTRA_TURN_ROLES;
    window.MW_ACTION_TEXT = ACTION_TEXT;

    /* ---------------- tiny helpers ---------------- */
    const el = (tag, cls, html) => {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (html !== undefined) n.innerHTML = html;
        return n;
    };
    const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const getRoom = () => (typeof roomCode !== "undefined" ? roomCode : "");

    /* ---------------- styles ---------------- */
    const css = document.createElement("style");
    css.id = "mwExtraCss";
    css.textContent = `
    .mwx-dock{position:fixed;left:12px;bottom:12px;z-index:2147483040;display:flex;flex-direction:column;gap:8px}
    .mwx-fab{background:linear-gradient(180deg,var(--mx-bg),var(--mx-card));color:#fff;border:1px solid var(--mx-line);border-radius:12px;padding:9px 13px;font-weight:700;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.55);font-size:14px;text-align:left;transition:transform .12s,border-color .12s}
    .mwx-fab:hover{transform:translateY(-2px);border-color:var(--mx-acc)}
    .mwx-fab .mwx-dot{display:inline-block;min-width:18px;padding:0 5px;margin-left:6px;border-radius:9px;background:var(--mx-acc);color:#fff;font-size:12px;text-align:center}
    .mwx-modal{position:fixed;inset:0;z-index:2147483060;background:var(--mx-backdrop);display:none;align-items:center;justify-content:center;padding:14px;backdrop-filter:blur(3px)}
    .mwx-modal.open{display:flex}
    .mwx-card{width:min(640px,100%);max-height:88vh;overflow:auto;background:linear-gradient(180deg,var(--mx-bg),var(--mx-bg2));border:1px solid var(--mx-line);border-radius:16px;box-shadow:0 18px 60px rgba(0,0,0,.8);color:var(--mx-text);padding:18px 18px 16px;font-family:inherit}
    .mwx-card h2{margin:0 0 4px;font-size:22px;letter-spacing:.5px}
    .mwx-sub{opacity:.7;font-size:13px;margin-bottom:12px}
    .mwx-close{float:right;background:var(--mx-card);color:#fff;border:1px solid var(--mx-line);border-radius:9px;padding:5px 11px;cursor:pointer;font-weight:700}
    .mwx-role{display:flex;gap:11px;align-items:flex-start;padding:10px;border-radius:12px;background:var(--mx-soft);border:1px solid var(--mx-soft);margin-bottom:8px}
    .mwx-role.hl{border-color:var(--mx-acc);background:rgba(255,59,82,.12)}
    .mwx-role .ic{font-size:26px;line-height:1}
    .mwx-role b{font-size:15px}
    .mwx-role p{margin:3px 0 0;font-size:13px;opacity:.88;line-height:1.4}
    .mwx-tag{display:inline-block;margin-left:8px;font-size:11px;padding:1px 8px;border-radius:9px;font-weight:700}
    .mwx-tag.Mafia{background:var(--mx-tagm-bg);color:var(--mx-tagm-fg)}.mwx-tag.Town{background:#0d4a2a;color:#a8f0c8}.mwx-tag.Neutral{background:#4a3a0d;color:#f0dca0}
    .mwx-details-btn{margin-left:8px;background:var(--mx-card);color:#fff;border:1px solid var(--mx-line);border-radius:8px;padding:3px 10px;font-size:12px;font-weight:700;cursor:pointer}
    .mwx-details-btn:hover{border-color:var(--mx-acc)}
    .mwx-newrows{margin:8px 0;padding:8px 10px;border:1px dashed var(--mx-line);border-radius:12px;background:rgba(122,20,36,.10)}
    .mwx-newrows .ttl{font-size:12px;opacity:.7;margin-bottom:6px;font-weight:700;letter-spacing:.5px}
    .mwx-row{display:flex;align-items:center;gap:8px;margin:5px 0}
    .mwx-row label{min-width:110px;font-weight:700}
    .mwx-row input{width:64px;padding:5px 7px;border-radius:8px;border:1px solid var(--mx-line);background:var(--mx-card);color:#fff;text-align:center}
    .mwx-rolecard{position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:8000;max-width:min(560px,92vw);background:var(--mx-bg);border:1px solid var(--mx-line);border-radius:12px;padding:8px 13px;color:var(--mx-text);font-size:13px;display:none;box-shadow:0 6px 24px rgba(0,0,0,.6)}
    .mwx-rolecard b{font-size:14px}
    .mwx-rolecard .exec{margin-top:4px;color:#ffd27a;font-weight:700}
    .mwx-rolecard .sub{opacity:.85;margin-top:2px}
    .mwx-skip{margin:6px 0 0;padding:8px 14px;border-radius:10px;border:1px solid var(--mx-line);background:var(--mx-card);color:#fff;font-weight:700;cursor:pointer}
    .mwx-toast{position:fixed;left:50%;top:70px;transform:translate(-50%,-10px);z-index:2147483070;background:#1b0a0e;border:1px solid var(--mx-acc);color:#fff;border-radius:12px;padding:11px 18px;font-weight:700;box-shadow:0 8px 30px rgba(0,0,0,.7);opacity:0;pointer-events:none;transition:all .25s;max-width:92vw;text-align:center}
    .mwx-toast.show{opacity:1;transform:translate(-50%,0)}
    .mwx-result{position:fixed;inset:0;z-index:9700;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.7)}
    .mwx-result.open{display:flex}
    .mwx-result .box{background:linear-gradient(180deg,var(--mx-bg),var(--mx-bg2));border:2px solid var(--mx-acc);border-radius:18px;padding:26px 38px;text-align:center;color:#fff;box-shadow:0 0 60px rgba(255,59,82,.35)}
    .mwx-result .big{font-size:30px;font-weight:900;margin-top:6px;letter-spacing:1px}
    .mwx-result .big.bad{color:#ff6b7b}.mwx-result .big.good{color:#7dffb0}
    .mwx-emotes{position:fixed;left:50%;bottom:10px;transform:translateX(-50%);z-index:8500;display:none;gap:6px;background:var(--mx-bg);border:1px solid var(--mx-line);border-radius:30px;padding:6px 10px}
    .mwx-emotes button{background:transparent;border:none;font-size:23px;cursor:pointer;padding:2px 5px;border-radius:10px;transition:transform .1s}
    .mwx-emotes button:hover{transform:scale(1.3);background:var(--mx-soft)}
    .mwx-float{position:fixed;z-index:2147483045;pointer-events:none;text-align:center;animation:mwxfloat 2.6s ease-out forwards}
    .mwx-float .e{font-size:44px;display:block}
    .mwx-float .n{font-size:12px;font-weight:700;background:rgba(0,0,0,.7);border-radius:8px;padding:1px 8px;color:#fff}
    @keyframes mwxfloat{0%{transform:translateY(0) scale(.6);opacity:0}15%{opacity:1;transform:translateY(-20px) scale(1.1)}100%{transform:translateY(-190px) scale(1);opacity:0}}
    .mwx-dead{position:fixed;right:12px;bottom:12px;z-index:2147483050;width:min(320px,92vw);display:none;flex-direction:column;background:var(--mx-bg);border:1px solid #5b5b8a;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.7);color:var(--mx-text)}
    .mwx-dead .hd{padding:8px 12px;font-weight:800;border-bottom:1px solid var(--mx-soft);cursor:pointer;display:flex;justify-content:space-between}
    .mwx-dead .msgs{height:170px;overflow:auto;padding:8px 10px;font-size:13px}
    .mwx-dead .msgs div{margin-bottom:5px;line-height:1.35}
    .mwx-dead .msgs b{color:#a9a9ff}.mwx-dead .msgs b.med{color:#ffd27a}
    .mwx-dead form,.mwx-dead .inrow{display:flex;gap:6px;padding:8px}
    .mwx-dead input{flex:1;background:var(--mx-card);border:1px solid #444470;border-radius:8px;color:#fff;padding:6px 8px}
    .mwx-dead button{background:#3a3a66;color:#fff;border:none;border-radius:8px;padding:6px 11px;font-weight:700;cursor:pointer}
    .mwx-dead.min .msgs,.mwx-dead.min .inrow{display:none}
    .mwx-frow{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;background:var(--mx-soft);margin-bottom:6px}
    .mwx-frow .nm{flex:1;font-weight:700}.mwx-frow .st{font-size:12px;opacity:.8}
    .mwx-frow .on{display:inline-block;width:9px;height:9px;border-radius:50%;background:#555;margin-right:6px}
    .mwx-frow .on.y{background:#3ddc84}
    .mwx-sm{background:var(--mx-card);color:#fff;border:1px solid var(--mx-line);border-radius:8px;padding:4px 10px;font-size:12px;font-weight:700;cursor:pointer}
    .mwx-sm.go{background:#0d4a2a;border-color:#2e9b63}
    .mwx-addrow{display:flex;gap:8px;margin:8px 0 12px}
    .mwx-addrow input,.mwx-willbox textarea{flex:1;background:var(--mx-card);border:1px solid var(--mx-line);border-radius:9px;color:#fff;padding:8px 10px;font-family:inherit}
    .mwx-willbox textarea{width:100%;min-height:80px;box-sizing:border-box;resize:vertical}
    .mwx-rp-h{margin:12px 0 5px;font-weight:800;color:var(--mx-acc2)}
    .mwx-rp-l{font-size:13px;padding:5px 9px;border-left:3px solid var(--mx-line);margin-bottom:4px;background:rgba(255,255,255,.03);border-radius:0 8px 8px 0}
    .mwx-rp-l.death{border-color:var(--mx-acc)}.mwx-rp-l.win{border-color:#ffd27a;font-weight:700}
    .mwx-rp-p{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 4px}
    .mwx-rp-p span{font-size:12px;background:var(--mx-soft);border-radius:9px;padding:3px 9px}
    .mwx-rp-p span.dead{opacity:.55;text-decoration:line-through}
    .mwx-card.wide{width:min(720px,100%)}
    .mwx-ftabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
    .mwx-ft{position:relative;background:var(--mx-soft);color:var(--mx-text);border:1px solid var(--mx-soft);border-radius:12px;padding:8px 12px;font-weight:800;font-size:13px;cursor:pointer}
    .mwx-ft.on{background:linear-gradient(180deg,var(--mx-btn1),var(--mx-btn2));color:#fff;border-color:var(--mx-acc)}
    .mwx-badge{display:inline-block;min-width:19px;padding:1px 6px;margin-left:6px;border-radius:10px;background:var(--mx-acc);color:#fff;font-size:11px;font-weight:900;text-align:center;line-height:16px}
    .mwx-chatbox{display:flex;flex-direction:column;height:min(380px,52vh)}
    .mwx-chathead{display:flex;align-items:center;gap:8px;margin-bottom:8px;font-weight:800}
    .mwx-msgs{flex:1;overflow:auto;background:var(--mx-soft);border:1px solid var(--mx-soft);border-radius:12px;padding:10px;display:flex;flex-direction:column;gap:6px}
    .mwx-m{max-width:82%;padding:6px 10px;border-radius:12px;background:var(--mx-soft);font-size:13px;line-height:1.35;align-self:flex-start;word-break:break-word}
    .mwx-m b{display:block;font-size:11px;color:var(--mx-acc2);margin-bottom:1px}
    .mwx-m.mine{align-self:flex-end;background:linear-gradient(180deg,var(--mx-btn1),var(--mx-btn2))}
    .mwx-m.mine b{display:none}
    .mwx-send{display:flex;gap:8px;margin-top:8px}
    .mwx-send input,.mwx-form input[type=text]{flex:1;background:var(--mx-card);border:1px solid var(--mx-line);border-radius:10px;color:#fff;padding:9px 11px;font-family:inherit}
    .mwx-form{display:flex;flex-direction:column;gap:8px}
    .mwx-chk{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:10px;background:var(--mx-soft);cursor:pointer}
    .mwx-hostbox{position:fixed;right:14px;bottom:90px;z-index:2147483075;width:min(300px,90vw);background:linear-gradient(180deg,var(--mx-bg),var(--mx-bg2));border:1px solid #2e9b63;border-left:5px solid #3ddc84;border-radius:12px;padding:12px 14px;color:#fff;box-shadow:0 8px 30px rgba(0,0,0,.7);animation:mwxslide .35s ease-out}
    .mwx-hostbox .btns{display:flex;gap:8px;margin-top:10px}
    .mwx-hostbox .btns button{flex:1}
    .mwx-empty{opacity:.65;font-size:13px;padding:10px 2px}
    .mwx-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:4px 0 12px}
    .mwx-tab{background:var(--mx-soft);color:var(--mx-text);border:1px solid var(--mx-soft);border-radius:20px;padding:5px 14px;font-weight:800;font-size:12px;letter-spacing:.5px;cursor:pointer}
    .mwx-tab.on{background:linear-gradient(180deg,var(--mx-btn1),var(--mx-btn2));color:#fff;border-color:var(--mx-acc)}
    .mwx-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px}
    .mwx-rc{position:relative;display:flex;flex-direction:column;gap:6px;padding:14px;border-radius:14px;background:linear-gradient(160deg,var(--mx-soft),var(--mx-soft2));border:1px solid var(--mx-soft);border-top:3px solid #888;overflow:hidden}
    .mwx-rc.Mafia{border-top-color:var(--mx-mafia)}.mwx-rc.Town{border-top-color:#2fbf71}.mwx-rc.Neutral{border-top-color:#e0b43c}
    .mwx-rc.hl{box-shadow:0 0 0 2px var(--mx-acc),0 0 22px rgba(255,59,82,.4)}
    .mwx-rc .top{display:flex;align-items:center;gap:11px}
    .mwx-rc .pic{width:54px;height:54px;border-radius:14px;background:var(--mx-soft);display:flex;align-items:center;justify-content:center;font-size:30px;overflow:hidden;flex:none;border:1px solid var(--mx-soft)}
    .mwx-rc .pic img{width:100%;height:100%;object-fit:cover}
    .mwx-rc h3{margin:0;font-size:17px}
    .mwx-rc p{margin:0;font-size:13px;line-height:1.45;opacity:.9}
    .mwx-rc.big{max-width:480px;margin:0 auto}
    .mwx-rc.big .pic{width:84px;height:84px;font-size:46px}
    .mwx-rc.big p{font-size:15px}
    .mwx-lw{position:fixed;left:50%;top:18%;transform:translateX(-50%);z-index:2147483055;width:min(420px,92vw);background:linear-gradient(180deg,var(--mx-bg),var(--mx-bg2));border:2px solid var(--mx-acc);border-radius:16px;padding:16px;color:#fff;display:none;box-shadow:0 0 50px rgba(255,59,82,.35)}
    .mwx-lw h3{margin:0 0 4px}
    .mwx-lw .bar{height:5px;background:var(--mx-soft);border-radius:4px;margin:8px 0 10px;overflow:hidden}
    .mwx-lw .bar i{display:block;height:100%;width:100%;background:var(--mx-acc);transform-origin:left}
    .mwx-lw .row{display:flex;gap:8px}
    .mwx-lw input{flex:1;background:var(--mx-card);border:1px solid var(--mx-line);border-radius:9px;color:#fff;padding:9px 10px}
    .mwx-lwshow{position:fixed;right:14px;top:80px;z-index:2147483065;max-width:min(340px,90vw);background:linear-gradient(180deg,var(--mx-bg),var(--mx-bg2));border:1px solid var(--mx-acc);border-left:5px solid var(--mx-acc);border-radius:12px;padding:12px 14px;color:#fff;box-shadow:0 8px 30px rgba(0,0,0,.7);animation:mwxslide .35s ease-out}
    .mwx-lwshow b{display:block;color:var(--mx-acc2);margin-bottom:3px}
    @keyframes mwxslide{from{transform:translateX(120%);opacity:0}to{transform:none;opacity:1}}
    .mwx-inline-rp{margin:14px 0 4px}
    .mwx-inline-rp button{width:100%}
    @media(max-width:700px){.mwx-fab{padding:8px 10px;font-size:13px}.mwx-rolecard{top:4px;font-size:12px}}
    
    :root{--mx-bg:#1b0a0e;--mx-bg2:#0d0507;--mx-card:#14060a;--mx-line:#7a1424;--mx-acc:#ff3b52;--mx-acc2:#ff8896;--mx-btn1:#b51f1f;--mx-btn2:#5c0d18;--mx-text:#f3e9ea;--mx-soft:rgba(255,255,255,.07);--mx-soft2:rgba(255,255,255,.03);--mx-mafia:#e32626;--mx-tagm-bg:#5c0d18;--mx-tagm-fg:#ffb3bd;--mx-backdrop:rgba(0,0,0,.72)}
    html[data-mafia-theme="white"]{--mx-bg:#ffffff;--mx-bg2:#e9f0ff;--mx-card:#f3f7ff;--mx-line:#1a56e6;--mx-acc:#1a56e6;--mx-acc2:#2f6bff;--mx-btn1:#4a82ff;--mx-btn2:#0b3fbf;--mx-text:#10264d;--mx-soft:rgba(26,86,230,.09);--mx-soft2:rgba(26,86,230,.04);--mx-mafia:#1a56e6;--mx-tagm-bg:#0b3fbf;--mx-tagm-fg:#dbe7ff;--mx-backdrop:rgba(214,228,255,.8)}
    .mwx-card,.mwx-toast,.mwx-lw,.mwx-lwshow,.mwx-hostbox,.mwx-rolecard,.mwx-dead,.mwx-result .box,.mwx-emotes{color:var(--mx-text)}
    .mwx-fab,.mwx-skip,.mwx-close,.mwx-sm,.mwx-tab.on,.mwx-ft.on,.mwx-details-btn{color:#fff}
    html[data-mafia-theme="white"] .mwx-tab,html[data-mafia-theme="white"] .mwx-ft{color:#10264d}
    html[data-mafia-theme="white"] .mwx-tab.on,html[data-mafia-theme="white"] .mwx-ft.on{color:#fff}
    .mwx-card input,.mwx-dead input,.mwx-lw input,.mwx-send input,.mwx-addrow input{color:var(--mx-text)!important}
    .mwx-m.mine{color:#fff}
    .mwx-emotes{flex-wrap:wrap;justify-content:center;max-width:94vw;border-radius:20px;bottom:8px}
    .mwx-emoji-btn{background:var(--mx-soft);border:1px solid var(--mx-line);border-radius:8px;cursor:pointer;font-size:18px;line-height:1;padding:0 8px;min-height:32px}
    .mwx-emoji-pop{position:fixed;z-index:2147483085;width:min(300px,92vw);max-height:220px;overflow:auto;display:none;grid-template-columns:repeat(8,1fr);gap:2px;padding:8px;background:var(--mx-bg);border:1px solid var(--mx-line);border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.45)}
    .mwx-emoji-pop button{background:transparent;border:none;font-size:22px;cursor:pointer;border-radius:8px;padding:3px}
    .mwx-emoji-pop button:hover{background:var(--mx-soft)}

    @media(max-width:1000px){.mwx-rolecard{display:none!important}}
    @media(max-width:650px){
      .mwx-dock{left:8px;bottom:84px;gap:7px}
      .mwx-fab{padding:10px 12px;font-size:17px;border-radius:50%;min-width:46px;min-height:46px;text-align:center}
      .mwx-fab .lb{display:none}
      .mwx-modal{align-items:flex-end;padding:0}
      .mwx-card,.mwx-card.wide{width:100%;max-height:92vh;border-radius:20px 20px 0 0;padding:14px 12px 18px}
      .mwx-card h2{font-size:19px}
      .mwx-grid{grid-template-columns:1fr}
      .mwx-ftabs,.mwx-tabs{flex-wrap:nowrap;overflow-x:auto;padding-bottom:4px;scrollbar-width:none}
      .mwx-ft,.mwx-tab{white-space:nowrap;padding:8px 11px;font-size:12px;flex:none}
      .mwx-chatbox{height:min(330px,46vh)}
      .mwx-emotes{bottom:72px;flex-wrap:nowrap;overflow-x:auto;max-width:96vw;padding:5px 9px;gap:2px}
      .mwx-emotes button{font-size:23px;flex:none}
      .mwx-dead{left:8px;right:8px;width:auto;bottom:70px}
      .mwx-dead .msgs{height:104px}
      .mwx-pick-back{align-items:flex-end;padding:0}
      .mwx-pick{width:100%;border-radius:20px 20px 0 0}
      .mwx-pick-list{max-height:min(304px,38vh)}
      .mwx-pick-head{padding:14px 14px 6px}
      .mwx-pick-head .ic{font-size:28px}
      .mwx-lw{top:7%}
      .mwx-lwshow{right:8px;top:54px;max-width:88vw}
      .mwx-hostbox{right:8px;bottom:150px}
      .mwx-toast{top:54px;font-size:13px}
      .mwx-skip{width:100%}
    }

    #targetPlayer,#grandmafiaTarget,#lover1,#lover2{display:none!important}
    :root{--mx-pick:#ffffff}
    html[data-mafia-theme="white"]{--mx-pick:#1a56e6}
    .mwx-pick-back{position:fixed;inset:0;z-index:2147483058;background:var(--mx-backdrop);display:none;align-items:center;justify-content:center;padding:14px;backdrop-filter:blur(3px)}
    .mwx-pick-back.open{display:flex}
    .mwx-pick{width:min(430px,100%);display:flex;flex-direction:column;background:linear-gradient(180deg,var(--mx-bg),var(--mx-bg2));border:1px solid var(--mx-line);border-radius:18px;box-shadow:0 20px 70px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.03) inset;color:var(--mx-text);overflow:hidden;animation:mwxpop .22s ease-out}
    @keyframes mwxpop{from{transform:translateY(14px) scale(.96);opacity:0}to{transform:none;opacity:1}}
    .mwx-pick-head{padding:18px 18px 8px;text-align:center}
    .mwx-pick-head .ic{font-size:34px;display:block;margin-bottom:4px}
    .mwx-pick-head h3{margin:0;font-size:20px;letter-spacing:.3px}
    .mwx-pick-head p{margin:6px 0 0;font-size:13px;opacity:.75}
    .mwx-pick-list{margin:8px 14px;max-height:304px;overflow-y:auto;display:flex;flex-direction:column;gap:7px;padding:2px 4px 2px 2px;scrollbar-width:thin;scrollbar-color:var(--mx-line) transparent}
    .mwx-pick-list::-webkit-scrollbar{width:7px}
    .mwx-pick-list::-webkit-scrollbar-thumb{background:var(--mx-line);border-radius:6px}
    .mwx-prow{display:flex;align-items:center;gap:11px;min-height:48px;padding:7px 14px 7px 10px;border-radius:13px;background:var(--mx-soft);border:1px solid transparent;color:var(--mx-text);font-family:inherit;font-size:15px;font-weight:700;cursor:pointer;text-align:left;transition:background .12s,border-color .12s,transform .12s}
    .mwx-prow:hover{border-color:var(--mx-line);transform:translateX(2px)}
    .mwx-prow .av{width:34px;height:34px;display:flex;align-items:center;justify-content:center;flex:none;overflow:hidden}
    .mwx-prow .nm{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .mwx-bubble{width:24px;height:24px;border-radius:50%;border:2px solid var(--mx-line);flex:none;display:flex;align-items:center;justify-content:center;transition:all .12s}
    .mwx-prow.sel{background:var(--mx-soft);border-color:var(--mx-acc);box-shadow:0 0 0 1px var(--mx-acc)}
    .mwx-prow.sel .mwx-bubble{background:var(--mx-pick);border-color:var(--mx-pick);box-shadow:0 0 12px var(--mx-pick)}
    .mwx-prow.sel .mwx-bubble::after{content:"✓";font-size:14px;font-weight:900;color:var(--mx-acc)}
    html[data-mafia-theme="white"] .mwx-prow.sel .mwx-bubble::after{color:#fff}
    .mwx-pick-more{text-align:center;font-size:12px;opacity:.7;margin:0 0 4px}
    .mwx-pick-sel{text-align:center;font-size:13px;min-height:18px;margin:6px 14px 0;opacity:.9}
    .mwx-pick-foot{display:flex;gap:10px;padding:12px 14px 16px}
    .mwx-pick-foot button{flex:1;padding:13px 10px;border-radius:12px;font-family:inherit;font-weight:900;font-size:14px;letter-spacing:.6px;cursor:pointer;border:1px solid var(--mx-line)}
    .mwx-pick-foot .cancel{background:var(--mx-soft);color:var(--mx-text);flex:0 0 28%}
    .mwx-pick-foot .go{background:linear-gradient(180deg,var(--mx-btn1),var(--mx-btn2));color:#fff;border-color:var(--mx-acc)}
    .mwx-pick-foot .go:disabled{opacity:.4;cursor:not-allowed;filter:grayscale(.4)}
    .mwx-pick-skip{margin:0 14px 14px;padding:9px;border-radius:10px;background:transparent;border:1px dashed var(--mx-line);color:var(--mx-text);font-weight:700;cursor:pointer;font-family:inherit}
`;
    document.head.appendChild(css);

    /* ---------------- toast + result popup ---------------- */
    const toastEl = el("div", "mwx-toast");
    document.body.appendChild(toastEl);
    let toastTimer = null;
    function toast(message, ms) {
        toastEl.textContent = message;
        toastEl.classList.add("show");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms || 3500);
    }
    window.mwToast = toast;

    const resultEl = el("div", "mwx-result");
    resultEl.innerHTML = `<div class="box"><div id="mwxResTitle"></div><div class="big" id="mwxResBig"></div><div id="mwxResSub" style="opacity:.8;margin-top:6px"></div></div>`;
    document.body.appendChild(resultEl);
    let resultTimer = null;
    function showResult(title, big, sub, bad) {
        resultEl.querySelector("#mwxResTitle").textContent = title;
        const b = resultEl.querySelector("#mwxResBig");
        b.textContent = big;
        b.className = "big " + (bad ? "bad" : "good");
        resultEl.querySelector("#mwxResSub").textContent = sub || "";
        resultEl.classList.add("open");
        clearTimeout(resultTimer);
        resultTimer = setTimeout(() => resultEl.classList.remove("open"), 3000);
    }

    /* ---------------- generic modal ---------------- */
    function makeModal(id, title, sub) {
        const m = el("div", "mwx-modal");
        m.id = id;
        m.innerHTML = `<div class="mwx-card"><button class="mwx-close" type="button">✕ Close</button><h2>${title}</h2><div class="mwx-sub">${sub || ""}</div><div class="mwx-body"></div></div>`;
        const closeIt = () => { m.classList.remove("open"); m.dispatchEvent(new Event("mwxclose")); };
        m.addEventListener("click", e => { if (e.target === m) closeIt(); });
        m.querySelector(".mwx-close").addEventListener("click", closeIt);
        document.body.appendChild(m);
        return m;
    }

    /* ---------------- ROLE GUIDE (Details) ---------------- */
    const guide = makeModal("mwxGuide", "📖 Role Details", "What every role does.");
    function roleImg(name) {
        try { return typeof getRoleImage === "function" ? getRoleImage(name) : ""; } catch (e) { return ""; }
    }
    function roleCardHtml(name, big) {
        const info = ROLE_INFO[name];
        const img = roleImg(name) || ("/images/roles/" + name.toLowerCase().replace(/\s+/g, "") + ".png");
        return `<div class="top"><div class="pic"><img src="${esc(img)}" alt="" onerror="if(this.src.indexOf('-blue.')>-1){this.src=this.src.replace('-blue.','.')}else{this.remove()}"><span class="fb">${info.icon}</span></div><div><h3>${esc(name)}</h3><span class="mwx-tag ${info.team}" style="margin-left:0">${info.team}</span></div></div><p>${esc(info.text)}</p>`;
    }
    function openGuide(focusRole, singleOnly) {
        const body = guide.querySelector(".mwx-body");
        const title = guide.querySelector("h2");
        const sub = guide.querySelector(".mwx-sub");
        body.innerHTML = "";

        if (singleOnly && ROLE_INFO[focusRole]) {
            title.textContent = "📖 " + focusRole;
            sub.textContent = "Role details";
            const card = el("div", "mwx-rc big " + ROLE_INFO[focusRole].team, roleCardHtml(focusRole, true));
            body.appendChild(card);
            const more = el("button", "mwx-sm", "Show all roles");
            more.type = "button";
            more.style.cssText = "display:block;margin:14px auto 0";
            more.addEventListener("click", () => openGuide(focusRole, false));
            body.appendChild(more);
            guide.classList.add("open");
            return;
        }

        title.textContent = "📖 Role Details";
        sub.textContent = "Tap a tab to filter the roles.";
        const tabs = el("div", "mwx-tabs");
        const grid = el("div", "mwx-grid");
        let current = "All";
        const draw = () => {
            grid.innerHTML = "";
            ROLE_ORDER.forEach(name => {
                const info = ROLE_INFO[name];
                if (!info || (current !== "All" && info.team !== current)) return;
                const card = el("div", "mwx-rc " + info.team + (name === focusRole ? " hl" : ""), roleCardHtml(name, false));
                card.dataset.role = name;
                grid.appendChild(card);
            });
            tabs.querySelectorAll(".mwx-tab").forEach(t => t.classList.toggle("on", t.dataset.team === current));
        };
        ["All", "Town", "Mafia", "Neutral"].forEach(t => {
            const b = el("button", "mwx-tab", t);
            b.type = "button";
            b.dataset.team = t;
            b.addEventListener("click", () => { current = t; draw(); });
            tabs.appendChild(b);
        });
        body.append(tabs, grid);
        draw();
        guide.classList.add("open");
        const hl = grid.querySelector(".hl");
        if (hl) setTimeout(() => hl.scrollIntoView({ block: "center" }), 30);
    }

    /* ---------------- host role setup: new role rows + Details buttons ---------------- */
    function addDetailsButton(input, roleName) {
        if (!input || input.dataset.mwxDetails) return;
        input.dataset.mwxDetails = "1";
        const b = el("button", "mwx-details-btn", "Details");
        b.type = "button";
        b.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); openGuide(roleName, true); });
        input.insertAdjacentElement("afterend", b);
    }

    function installRoleSetup() {
        const civ = document.getElementById("civilianCount");
        if (!civ) return false;

        if (!document.getElementById("mwxNewRows") && !document.getElementById("bodyguardCount")) {
            const box = el("div", "mwx-newrows");
            box.id = "mwxNewRows";
            box.innerHTML = `<div class="ttl">MORE ROLES</div>`;

            EXTRA_ROLE_ROWS.forEach(r => {
                const row = el("div", "mwx-row");
                const label = el("label", "", esc(r.label));
                label.htmlFor = r.key + "Count";
                const input = el("input");
                input.type = "number";
                input.min = "0";
                input.max = (r.key === "mayor" || r.key === "amnesiac" || r.key === "executioner") ? "1" : "9";
                input.value = "0";
                input.id = r.key + "Count";
                input.addEventListener("input", () => {
                    if (r.key === "mayor" || r.key === "amnesiac" || r.key === "executioner") {
                        if (Number(input.value) > 1) input.value = 1;
                    }
                    if (Number(input.value) < 0) input.value = 0;
                    if (typeof updateCivilianCount === "function") updateCivilianCount();
                });
                row.append(label, input);
                box.appendChild(row);
                addDetailsButton(input, r.role);
            });

            const guideBtn = el("button", "mwx-sm", "📖 Details of all roles");
            guideBtn.type = "button";
            guideBtn.style.marginTop = "6px";
            guideBtn.addEventListener("click", () => openGuide());
            box.appendChild(guideBtn);

            const civRow = civ.closest("div, li, tr, p, label") || civ.parentElement;
            const anchor = (civRow && civRow.parentElement && civRow !== document.body) ? civRow : civ;
            anchor.parentElement.insertBefore(box, anchor);
        }

        Object.entries(COUNT_ID_ROLE).forEach(([id, role]) => addDetailsButton(document.getElementById(id), role));

        EXTRA_ROLE_ROWS.forEach(r => {
            const input = document.getElementById(r.key + "Count");
            if (!input) return;
            addDetailsButton(input, r.role);
            if (!input.dataset.mwxClamp) {
                input.dataset.mwxClamp = "1";
                input.addEventListener("input", () => {
                    const single = r.key === "mayor" || r.key === "amnesiac" || r.key === "executioner";
                    if (single && Number(input.value) > 1) input.value = 1;
                    if (Number(input.value) < 0) input.value = 0;
                });
            }
        });
        return true;
    }

    /* The lobby may be built after load: keep trying while the page is used. */
    setInterval(installRoleSetup, 800);
    installRoleSetup();

    /* ---------------- floating dock (Roles / Friends / Will / Replay) ---------------- */
    const dock = el("div", "mwx-dock");
    const btnRoles = el("button", "mwx-fab", `<span class="ic">📖</span><span class="lb"> Roles</span>`);
    const btnFriends = el("button", "mwx-fab", `<span class="ic">👥</span><span class="lb"> Friends</span><span class="mwx-dot" id="mwxFriendDot" style="display:none">0</span>`);
    [btnRoles, btnFriends].forEach(b => { b.type = "button"; });
    dock.append(btnFriends, btnRoles);
    document.body.appendChild(dock);
    btnRoles.addEventListener("click", () => openGuide());

    /* ---------------- role card (your role + secret info) ---------------- */
    const roleCard = el("div", "mwx-rolecard");
    document.body.appendChild(roleCard);
    let lastExtra = null;

    function renderRoleCard() {
        const role = typeof myRole !== "undefined" ? myRole : "";
        const phase = typeof currentPhase !== "undefined" ? currentPhase : "";
        const info = ROLE_INFO[role];
        if (!role || !info || phase === "lobby" || phase === "gameover" || !phase) {
            roleCard.style.display = "none";
            return;
        }
        let extra = "";
        if (role === "Executioner" && lastExtra && lastExtra.execTarget) {
            extra = `<div class="exec">🎯 Your target: ${esc(lastExtra.execTarget)} - get them voted out!</div>`;
        }
        if (role === "Vigilante" && lastExtra) {
            extra = `<div class="exec">Innocent kills: ${lastExtra.vigilanteInnocent || 0}/${lastExtra.vigilanteMax || 2}</div>`;
        }
        roleCard.innerHTML = `<b>${info.icon} ${esc(role)}</b><span class="mwx-tag ${info.team}">${info.team}</span><div class="sub">${esc(info.text)}</div>${extra}`;
        roleCard.style.display = "block";
    }

    /* ---------------- gameInformation listener ---------------- */
    let pendingSteal = null;
    let lastNightSeen = 0;
    let deadChatOn = false;
    let emotesOn = false;

    socket.on("gameInformation", data => {
        if (!data) return;
        lastExtra = data.extra || null;
        renderRoleCard();
        updateExtraControls(data);

        const ph = data.phase;
        window.MW_EXEC_TARGET_ID = (lastExtra && lastExtra.execTargetId) || null;
        if (typeof renderGamePlayers === "function") renderGamePlayers();

        // Amnesiac: the "you stole a role" box appears when the NEXT night starts.
        const nn = Number(data.nightNumber) || 0;
        if (pendingSteal && ph === "night" && nn > pendingSteal.afterNight) {
            const p = pendingSteal; pendingSteal = null;
            showPopup({ kind: "amnesiac", targetName: `${p.fromName} (${p.role})` });
        }
        if (ph === "night") lastNightSeen = nn;

        const me = data.players.find(p => p.id === socket.id);
        const iAmDead = Boolean(me) && me.alive === false && ph !== "lobby" && ph !== "gameover";
        const canChat = Boolean(lastExtra && lastExtra.canDeadChat) || iAmDead;
        if (canChat && !deadChatOn) { socket.emit("deadChatHistory", { roomCode: getRoom() }); }
        deadChatOn = canChat;
        deadBox.style.display = canChat ? "flex" : "none";
        deadBox.querySelector(".hdt").textContent = me && me.alive ? "🔮 Medium - Dead Chat" : "☠️ Dead Chat";

        const showEmotes = ph === "day" && me && me.alive;
        emotesOn = Boolean(showEmotes);
        emoteBar.style.display = showEmotes ? "flex" : "none";
        if (lastExtra && lastExtra.emotes && !emoteBar.dataset.built) buildEmotes(lastExtra.emotes);

    });

    /* extra roles: button text, skip button, hints */
    let skipBtn = null;
    function updateExtraControls(data) {
        const role = typeof myRole !== "undefined" ? myRole : "";
        const turnRole = EXTRA_TURN_ROLES[data.nightTurn];
        const isMyExtra = data.phase === "night" && ACTION_TEXT[role] && turnRole === role;
        const confirmBtn = document.getElementById("confirmAction");

        if (skipBtn) { skipBtn.remove(); skipBtn = null; }

        if (isMyExtra && confirmBtn) {
            const hasTargets = (data.actionTargets || []).length > 0;
            if (hasTargets) {
                confirmBtn.textContent = ACTION_TEXT[role].button;
                skipBtn = el("button", "mwx-skip", "⏭️ Skip tonight");
                skipBtn.type = "button";
                skipBtn.addEventListener("click", () => {
                    socket.emit("roleChoose", { roomCode: getRoom(), skip: true });
                });
                confirmBtn.insertAdjacentElement("afterend", skipBtn);
                const msg = document.getElementById("actionMessage");
                if (msg) msg.textContent = "🎯 " + ACTION_TEXT[role].hint;
            }
        }
    }

    const POPUP_VIEWS = {
        grandmafia:{ icon: "👶", kicker: "GRANDMAFIA • NIGHT 1",   title: "BABY MAFIA CHOSEN", label: "BABY MAFIA", footer: "PRIVATE GRANDMAFIA REPORT" },
        escort:    { icon: "🚧", kicker: "ESCORT • NIGHT DUTY",     title: "PLAYER BLOCKED",   label: "BLOCKING",   footer: "PRIVATE ESCORT REPORT" },
        framer:    { icon: "🎭", kicker: "FRAMER • NIGHT DUTY",     title: "PLAYER FRAMED",    label: "FRAMING",    footer: "PRIVATE FRAMER REPORT" },
        bodyguard: { icon: "🛡️", kicker: "BODYGUARD • NIGHT DUTY",  title: "GUARD POSTED",     label: "GUARDING",   footer: "PRIVATE BODYGUARD REPORT" },
        vigilante: { icon: "🔫", kicker: "VIGILANTE • NIGHT ORDER", title: "TARGET LOCKED",    label: "SHOOTING",   footer: "PRIVATE VIGILANTE REPORT" },
        sheriff:   { icon: "⭐", kicker: "SHERIFF • INVESTIGATION", title: "REPORT READY",     label: "RESULT",     footer: "PRIVATE SHERIFF REPORT" },
        vote:      { icon: "🗳️", kicker: "TOWN • DAY VOTE",         title: "VOTE CAST",        label: "YOU VOTED",  footer: "YOUR VOTE IS SECRET UNTIL THE END" },
        amnesiac:  { icon: "🧠", kicker: "AMNESIAC • MEMORY",       title: "ROLE STOLEN",      label: "YOU STOLE",  footer: "PRIVATE AMNESIAC REPORT" },
        blocked:   { icon: "🚫", kicker: "ESCORT • BLOCKED",        title: "ABILITY BLOCKED",  label: "STATUS",     footer: "YOUR ABILITY HAS BEEN BLOCKED", fixed: "Your ability has been blocked!" }
    };
    window.MW_POPUP_VIEW = function (data) {
        const v = POPUP_VIEWS[data && data.kind];
        if (!v) return null;
        return { icon: v.icon, kicker: v.kicker, title: v.title, label: v.label, footer: v.footer, value: v.fixed || data.targetName || "Unknown" };
    };
    function showPopup(data) {
        if (typeof showNightActionPopup === "function") showNightActionPopup(data);
        else toast((data.targetName || data.kind), 3000);
    }

    socket.on("voteConfirmed", name => showPopup({ kind: "vote", targetName: name }));
    socket.on("amnesiacStole", d => { if (d) pendingSteal = { fromName: d.fromName, role: d.role, afterNight: lastNightSeen }; });

    socket.on("extraActionDone", d => {
        if (!d) return;
        const msg = document.getElementById("actionMessage");
        if (msg && d.message) msg.textContent = d.message;
        if (skipBtn) { skipBtn.remove(); skipBtn = null; }
        const sel = document.getElementById("targetPlayer");
        const conf = document.getElementById("confirmAction");
        if (sel) sel.style.display = "none";
        if (conf) conf.style.display = "none";
    });

    socket.on("extraNotice", d => { if (d && d.message) toast(d.message, 4500); });

    socket.on("sheriffResult", d => {
        if (!d) return;
        showPopup({ kind: "sheriff", targetName: `${d.playerName}: ${d.result}` });
        const msg = document.getElementById("actionMessage");
        if (msg) msg.textContent = `⭐ ${d.playerName} is ${d.result}.`;
    });

    /* ---------------- dead chat ---------------- */
    const deadBox = el("div", "mwx-dead");
    deadBox.innerHTML = `<div class="hd"><span class="hdt">☠️ Dead Chat</span><span>▾</span></div><div class="msgs"></div><div class="inrow"><input maxlength="200" placeholder="Talk to the dead..."><button type="button">Send</button></div>`;
    document.body.appendChild(deadBox);
    deadBox.querySelector(".hd").addEventListener("click", () => deadBox.classList.toggle("min"));
    const deadMsgs = deadBox.querySelector(".msgs");
    const deadInput = deadBox.querySelector("input");
    function sendDead() {
        const v = deadInput.value.trim();
        if (!v) return;
        socket.emit("deadChatSend", { roomCode: getRoom(), message: v });
        deadInput.value = "";
    }
    deadBox.querySelector("button").addEventListener("click", sendDead);
    deadInput.addEventListener("keydown", e => { if (e.key === "Enter") sendDead(); });
    function addDeadLine(m) {
        const d = el("div");
        d.innerHTML = `<b class="${m.fromMedium ? "med" : ""}">${m.fromMedium ? "🔮 " : ""}${esc(m.playerName)}:</b> ${esc(m.message)}`;
        deadMsgs.appendChild(d);
        deadMsgs.scrollTop = deadMsgs.scrollHeight;
    }
    socket.on("deadChatMessage", addDeadLine);
    socket.on("deadChatHistory", list => { deadMsgs.innerHTML = ""; (list || []).forEach(addDeadLine); });

    /* ---------------- last words: 20 seconds after you die ---------------- */
    const lwBox = el("div", "mwx-lw");
    lwBox.innerHTML = `<h3>☠️ You died</h3><div style="opacity:.85;font-size:13px">Write your last words. Everyone will see them! <b id="mwxLwSec">20</b>s</div><div class="bar"><i></i></div><div class="row"><input maxlength="140" placeholder="Your last words..."><button class="mwx-sm go" type="button">Send</button></div>`;
    document.body.appendChild(lwBox);
    let lwTimer = null;
    function closeLw() { lwBox.style.display = "none"; clearInterval(lwTimer); }
    socket.on("lastWordsPrompt", d => {
        const total = (d && d.seconds) || 20;
        const endsAt = Date.now() + total * 1000;
        lwBox.style.display = "block";
        const input = lwBox.querySelector("input");
        input.value = "";
        setTimeout(() => input.focus(), 50);
        const bar = lwBox.querySelector(".bar i");
        const sec = lwBox.querySelector("#mwxLwSec");
        clearInterval(lwTimer);
        lwTimer = setInterval(() => {
            const left = Math.max(0, endsAt - Date.now());
            sec.textContent = Math.ceil(left / 1000);
            bar.style.transform = "scaleX(" + (left / (total * 1000)) + ")";
            if (left <= 0) closeLw();
        }, 100);
    });
    socket.on("lastWordsClosed", closeLw);
    function sendLw() {
        const v = lwBox.querySelector("input").value.trim();
        if (!v) return;
        socket.emit("lastWordsSend", { roomCode: getRoom(), message: v }, res => {
            if (res && res.ok) closeLw();
            else if (res && res.message) toast(res.message, 3000);
        });
    }
    lwBox.querySelector("button").addEventListener("click", sendLw);
    lwBox.querySelector("input").addEventListener("keydown", e => { if (e.key === "Enter") sendLw(); });

    socket.on("lastWords", d => {
        if (!d || !d.message) return;
        const box = el("div", "mwx-lwshow", `<b>📜 ${esc(d.playerName)}'s last words</b>${esc(d.message)}`);
        document.body.appendChild(box);
        setTimeout(() => box.remove(), 7000);
    });
    socket.on("gameInformation", () => {});

    /* ---------------- emotes ---------------- */
    const emoteBar = el("div", "mwx-emotes");
    document.body.appendChild(emoteBar);
    function buildEmotes(list) {
        emoteBar.dataset.built = "1";
        list.forEach(e => {
            const b = el("button", "", e);
            b.type = "button";
            b.addEventListener("click", () => socket.emit("sendEmote", { roomCode: getRoom(), emote: e }));
            emoteBar.appendChild(b);
        });
    }
    socket.on("emote", d => {
        if (!d) return;
        const f = el("div", "mwx-float", `<span class="e">${esc(d.emote)}</span><span class="n">${esc(d.playerName)}</span>`);
        f.style.left = (15 + Math.random() * 70) + "%";
        f.style.bottom = "90px";
        document.body.appendChild(f);
        setTimeout(() => f.remove(), 2700);
    });

    /* ---------------- friends: chat, private chats, groups, requests, online ---------------- */
    const friendsModal = makeModal("mwxFriends", "👥 Friends", "Chat with everybody, message friends, make groups and join rooms.");
    friendsModal.querySelector(".mwx-card").classList.add("wide");
    const fBody = friendsModal.querySelector(".mwx-body");
    fBody.innerHTML = `<div class="mwx-ftabs" id="mwxFTabs"></div><div id="mwxFPane"></div>`;
    const fTabs = fBody.querySelector("#mwxFTabs");
    const fPane = fBody.querySelector("#mwxFPane");

    const F = {
        tab: "friends",
        view: null,            // { type: "dm", username, displayName } | { type: "group", id, name }
        creating: false,
        data: { friends: [], groups: [], requests: [], unread: {}, unreadTotal: 0, guest: false },
        msgBox: null
    };
    const TABS = [["chat", "💬 Chat"], ["friends", "👤 Friends"], ["groups", "👥 Groups"], ["requests", "📨 Requests"], ["online", "🟢 Online"]];

    const modalOpen = () => friendsModal.classList.contains("open");
    const badgeHtml = n => n > 0 ? `<span class="mwx-badge">${n > 99 ? "99+" : n}</span>` : "";
    const sumUnread = prefix => Object.entries(F.data.unread || {}).reduce((t, [k, v]) => t + (k.startsWith(prefix) ? Number(v) || 0 : 0), 0);

    function updateDockBadge() {
        const dot = btnFriends.querySelector("#mwxFriendDot");
        if (!dot) return;
        const total = (F.data.unreadTotal || 0) + (F.data.requests || []).length;
        dot.style.display = total > 0 ? "inline-block" : "none";
        dot.textContent = total > 99 ? "99+" : String(total);
    }

    function drawTabs() {
        fTabs.innerHTML = "";
        TABS.forEach(([id, label]) => {
            const n = id === "friends" ? sumUnread("dm:") : id === "groups" ? sumUnread("grp:") : id === "requests" ? (F.data.requests || []).length : 0;
            const b = el("button", "mwx-ft" + (F.tab === id ? " on" : ""), esc(label) + badgeHtml(n));
            b.type = "button";
            b.addEventListener("click", () => switchTab(id));
            fTabs.appendChild(b);
        });
    }

    function leaveConversation() {
        if (F.view) socket.emit("chatClose");
        F.view = null;
        F.msgBox = null;
    }

    function switchTab(id) {
        if (F.tab === "chat" && id !== "chat") socket.emit("pubChatLeave");
        leaveConversation();
        F.creating = false;
        F.tab = id;
        if (id === "chat") socket.emit("pubChatJoin");
        drawTabs();
        drawPane();
    }

    function addMsg(m) {
        if (!F.msgBox) return;
        const d = el("div", "mwx-m" + (m.mine ? " mine" : ""), `<b>${esc(m.name)}</b>${esc(m.text)}`);
        F.msgBox.appendChild(d);
        F.msgBox.scrollTop = F.msgBox.scrollHeight;
    }

    function drawChatBox(title, onSend, onBack, extraButton) {
        fPane.innerHTML = "";
        const box = el("div", "mwx-chatbox");
        const head = el("div", "mwx-chathead");
        if (onBack) {
            const back = el("button", "mwx-sm", "← Back"); back.type = "button";
            back.addEventListener("click", onBack);
            head.appendChild(back);
        }
        head.appendChild(el("span", "", esc(title)));
        if (extraButton) { head.appendChild(extraButton); }
        const msgs = el("div", "mwx-msgs");
        const send = el("div", "mwx-send");
        const input = el("input"); input.maxLength = 200; input.placeholder = "Type a message...";
        const btn = el("button", "mwx-sm go", "Send"); btn.type = "button";
        const go = () => { const v = input.value.trim(); if (!v) return; onSend(v); input.value = ""; };
        btn.addEventListener("click", go);
        input.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
        send.append(input, btn);
        box.append(head, msgs, send);
        fPane.appendChild(box);
        F.msgBox = msgs;
        setTimeout(() => input.focus(), 30);
    }

    function openDm(f) {
        F.view = { type: "dm", username: f.username, displayName: f.displayName };
        drawChatBox("💬 " + f.displayName, text => socket.emit("dmSend", { username: f.username, text }), () => { leaveConversation(); drawPane(); });
        socket.emit("dmOpen", { username: f.username });
    }

    function openGroup(g) {
        F.view = { type: "group", id: g.id, name: g.name };
        const leave = el("button", "mwx-sm", "Leave group"); leave.type = "button"; leave.style.marginLeft = "auto";
        leave.addEventListener("click", () => {
            if (!confirm('Leave the group "' + g.name + '"?')) return;
            socket.emit("groupLeave", { id: g.id });
            leaveConversation(); drawPane();
        });
        drawChatBox("👥 " + g.name, text => socket.emit("groupSend", { id: g.id, text }), () => { leaveConversation(); drawPane(); }, leave);
        socket.emit("groupOpen", { id: g.id });
    }

    function friendRow(f, withChat) {
        const unread = (F.data.unread || {})[f.convo] || 0;
        const row = el("div", "mwx-frow", `<span class="nm"><span class="on ${f.online ? "y" : ""}"></span>${esc(f.displayName)}${badgeHtml(unread)}</span><span class="st">${esc(f.status)}</span>`);
        if (withChat) { row.style.cursor = "pointer"; row.addEventListener("click", () => openDm(f)); }
        return row;
    }

    function drawPane() {
        if (F.view) return;
        fPane.innerHTML = "";
        F.msgBox = null;
        const d = F.data;

        if (d.guest && F.tab !== "chat") {
            fPane.innerHTML = `<div class="mwx-empty">Sign in with an account to use friends.</div>`;
            return;
        }

        if (F.tab === "chat") {
            drawChatBox("🌍 Public chat - everyone can read", text => socket.emit("pubChatSend", { text }), null);
            return;
        }

        if (F.tab === "friends") {
            if (!d.friends.length) { fPane.innerHTML = `<div class="mwx-empty">No friends yet. Go to <b>Requests</b> to add someone.</div>`; return; }
            fPane.appendChild(el("div", "mwx-sub", "Tap a friend to open a private chat."));
            [...d.friends].sort((a, b) => Number(b.online) - Number(a.online)).forEach(f => {
                const row = friendRow(f, true);
                const rm = el("button", "mwx-sm", "✕"); rm.type = "button"; rm.title = "Remove friend";
                rm.addEventListener("click", e => { e.stopPropagation(); if (confirm("Remove " + f.displayName + " from your friends?")) socket.emit("friendRemove", { username: f.username }); });
                row.appendChild(rm);
                fPane.appendChild(row);
            });
            return;
        }

        if (F.tab === "groups") {
            if (F.creating) { drawGroupForm(); return; }
            const mk = el("button", "mwx-sm go", "➕ Make group"); mk.type = "button"; mk.style.marginBottom = "10px";
            mk.addEventListener("click", () => {
                if (!d.friends.length) { toast("Add some friends first.", 2500); return; }
                F.creating = true; drawPane();
            });
            fPane.appendChild(mk);
            if (!d.groups.length) fPane.appendChild(el("div", "mwx-empty", "No groups yet."));
            d.groups.forEach(g => {
                const unread = (d.unread || {})[g.convo] || 0;
                const row = el("div", "mwx-frow", `<span class="nm">👥 ${esc(g.name)}${badgeHtml(unread)}</span><span class="st">${g.members.length} members</span>`);
                row.style.cursor = "pointer";
                row.addEventListener("click", () => openGroup(g));
                fPane.appendChild(row);
            });
            return;
        }

        if (F.tab === "requests") {
            const add = el("div", "mwx-addrow", `<input id="mwxFriendName" maxlength="24" placeholder="Add a friend by username"><button class="mwx-sm go" type="button">Add</button>`);
            const doAdd = () => {
                const input = add.querySelector("input");
                const v = input.value.trim();
                if (!v) return;
                socket.emit("friendAdd", { username: v });
                input.value = "";
            };
            add.querySelector("button").addEventListener("click", doAdd);
            add.querySelector("input").addEventListener("keydown", e => { if (e.key === "Enter") doAdd(); });
            fPane.appendChild(add);
            if (!d.requests.length) fPane.appendChild(el("div", "mwx-empty", "No friend requests right now."));
            d.requests.forEach(r => {
                const row = el("div", "mwx-frow", `<span class="nm">${esc(r.displayName)}</span><span class="st">wants to be your friend</span>`);
                const yes = el("button", "mwx-sm go", "Accept"); yes.type = "button";
                const no = el("button", "mwx-sm", "Decline"); no.type = "button";
                yes.addEventListener("click", () => socket.emit("friendRespond", { username: r.username, accept: true }));
                no.addEventListener("click", () => socket.emit("friendRespond", { username: r.username, accept: false }));
                row.append(yes, no);
                fPane.appendChild(row);
            });
            return;
        }

        if (F.tab === "online") {
            const online = d.friends.filter(f => f.online);
            if (!online.length) { fPane.innerHTML = `<div class="mwx-empty">None of your friends are online.</div>`; return; }
            online.forEach(f => {
                const row = friendRow(f, false);
                if (f.roomCode) {
                    const join = el("button", "mwx-sm go", "Join room"); join.type = "button";
                    join.addEventListener("click", () => socket.emit("friendJoin", { username: f.username }));
                    row.appendChild(join);
                }
                fPane.appendChild(row);
            });
        }
    }

    function drawGroupForm() {
        fPane.innerHTML = "";
        const form = el("div", "mwx-form");
        form.innerHTML = `<div class="mwx-rp-h" style="margin:0">Make a group</div><input type="text" maxlength="24" placeholder="Group name">`;
        const list = el("div");
        F.data.friends.forEach(f => {
            const row = el("label", "mwx-chk", `<input type="checkbox" value="${esc(f.username)}"> ${esc(f.displayName)}`);
            list.appendChild(row);
        });
        const btns = el("div", "mwx-send");
        const cancel = el("button", "mwx-sm", "Cancel"); cancel.type = "button";
        const create = el("button", "mwx-sm go", "Create group"); create.type = "button";
        cancel.addEventListener("click", () => { F.creating = false; drawPane(); });
        create.addEventListener("click", () => {
            const name = form.querySelector("input[type=text]").value.trim();
            const usernames = [...list.querySelectorAll("input:checked")].map(i => i.value);
            if (!name) { toast("Give your group a name.", 2200); return; }
            if (!usernames.length) { toast("Pick at least one friend.", 2200); return; }
            socket.emit("groupCreate", { name, usernames });
            F.creating = false;
            drawPane();
        });
        btns.append(cancel, create);
        form.append(list, btns);
        fPane.appendChild(form);
    }

    function refreshFriends() { socket.emit("friendsGet"); }
    let friendsTimer = null;
    btnFriends.addEventListener("click", () => {
        friendsModal.classList.add("open");
        refreshFriends();
        drawTabs();
        drawPane();
        clearInterval(friendsTimer);
        friendsTimer = setInterval(() => {
            if (!modalOpen()) { clearInterval(friendsTimer); return; }
            refreshFriends();
        }, 10000);
    });
    friendsModal.addEventListener("mwxclose", () => {
        if (F.tab === "chat") socket.emit("pubChatLeave");
        leaveConversation();
        F.creating = false;
        F.tab = "friends";
    });

    socket.on("friendsNotice", d => { if (d && d.message) toast(d.message, 3800); });

    socket.on("friendsData", d => {
        F.data = Object.assign({ friends: [], groups: [], requests: [], unread: {}, unreadTotal: 0, guest: false }, d || {});
        updateDockBadge();
        if (!modalOpen()) return;
        drawTabs();
        // do not redraw while the person is typing in a chat or filling the group form
        if (!F.view && !F.creating && F.tab !== "chat") drawPane();
    });

    socket.on("dmHistory", d => {
        if (!F.view || F.view.type !== "dm" || F.view.username !== d.username) return;
        if (F.msgBox) F.msgBox.innerHTML = "";
        d.messages.forEach(addMsg);
    });
    socket.on("groupHistory", d => {
        if (!F.view || F.view.type !== "group" || F.view.id !== d.id) return;
        if (F.msgBox) F.msgBox.innerHTML = "";
        d.messages.forEach(addMsg);
    });
    socket.on("chatMessage", m => {
        if (!m || !F.view) return;
        if (m.scope === "dm" && F.view.type === "dm" && F.view.username === m.with) addMsg(m);
        if (m.scope === "group" && F.view.type === "group" && F.view.id === m.id) addMsg(m);
    });
    socket.on("chatNotify", d => {
        if (!d) return;
        toast("💬 " + d.fromName + ": " + String(d.text).slice(0, 50), 3500);
    });

    socket.on("pubChatHistory", list => {
        if (F.tab !== "chat" || !F.msgBox) return;
        F.msgBox.innerHTML = "";
        (list || []).forEach(m => addMsg({ mine: false, name: m.name, text: m.text }));
    });
    socket.on("pubChatMessage", m => {
        if (F.tab !== "chat" || !F.msgBox || !m) return;
        addMsg({ mine: false, name: m.name, text: m.text });
    });

    /* A friend wants to join your room: small Yes / No box for the host. */
    socket.on("friendJoinRequest", d => {
        if (!d) return;
        const box = el("div", "mwx-hostbox", `<b>👥 ${esc(d.name)}</b> wants to join your room.`);
        const btns = el("div", "btns");
        const yes = el("button", "mwx-sm go", "Yes"); yes.type = "button";
        const no = el("button", "mwx-sm", "No"); no.type = "button";
        btns.append(yes, no);
        box.appendChild(btns);
        const answer = accept => { socket.emit("friendJoinRespond", { requesterId: d.requesterId, accept }); box.remove(); };
        yes.addEventListener("click", () => answer(true));
        no.addEventListener("click", () => answer(false));
        document.body.appendChild(box);
        setTimeout(() => box.remove(), 30000);
    });
    socket.on("friendJoinReady", d => {
        if (!d || !d.roomCode) return;
        friendsModal.classList.remove("open");
        friendsModal.dispatchEvent(new Event("mwxclose"));
        socket.emit("joinRoom", { playerName: "Player", roomCode: d.roomCode });
    });
    setTimeout(refreshFriends, 1500);

    /* ---------------- game replay (inside GAME STATISTICS) ---------------- */
    const replayModal = makeModal("mwxReplay", "🎞️ Game Replay", "What everybody did, night by night.");
    let replayData = null;
    socket.on("gameOver", () => {
        replayData = null;
        setTimeout(() => socket.emit("getReplay", { roomCode: getRoom() }), 700);
    });
    socket.on("gameReplay", d => { replayData = d; ensureReplayButton(); });
    function openReplay() {
        if (!replayData) return;
        const body = replayModal.querySelector(".mwx-body");
        body.innerHTML = "";
        const pl = el("div", "mwx-rp-p");
        replayData.players.forEach(p => pl.appendChild(el("span", p.alive ? "" : "dead", `${esc(p.name)} - ${esc(p.role || "?")}`)));
        body.appendChild(el("div", "mwx-rp-h", "Final roles"));
        body.appendChild(pl);
        let lastKey = "";
        replayData.entries.forEach(e => {
            const key = (e.phase === "day" ? "☀️ Day " : "🌙 Night ") + e.night;
            if (key !== lastKey) { body.appendChild(el("div", "mwx-rp-h", key)); lastKey = key; }
            body.appendChild(el("div", "mwx-rp-l " + (e.kind === "death" ? "death" : e.kind === "win" ? "win" : ""), esc(e.text)));
        });
        replayModal.classList.add("open");
    }
    function ensureReplayButton() {
        const stats = document.getElementById("gameOverStats");
        if (!stats || !replayData || document.getElementById("mwxReplayInline")) return;
        const wrap = el("div", "mwx-inline-rp");
        wrap.id = "mwxReplayInline";
        const b = el("button", "mwx-fab", "🎞️ GAME REPLAY - see who did what each night");
        b.type = "button";
        b.style.cssText = "width:100%;text-align:center";
        b.addEventListener("click", openReplay);
        wrap.appendChild(b);
        stats.appendChild(wrap);
    }
    setInterval(ensureReplayButton, 700);
    socket.on("gameRestarted", () => { replayData = null; const w = document.getElementById("mwxReplayInline"); if (w) w.remove(); });

    /* The Friends / Roles buttons are for the home and lobby screens only. */
    function updateDockVisibility() {
        const game = document.getElementById("gameScreen");
        const inGame = game && game.offsetParent !== null;
        const auth = document.getElementById("authScreen") || document.getElementById("loginScreen");
        const onAuth = auth && auth.offsetParent !== null;
        dock.style.display = (inGame || onAuth) ? "none" : "flex";
    }
    setInterval(updateDockVisibility, 800);


    /* ---------------- target picker: vote / kill / save / check / block / guard / shoot ---------------- */
    const pickBack = el("div", "mwx-pick-back");
    pickBack.innerHTML = `<div class="mwx-pick"><div class="mwx-pick-head"><span class="ic"></span><h3></h3><p></p></div><div class="mwx-pick-list"></div><div class="mwx-pick-more"></div><div class="mwx-pick-sel"></div><div class="mwx-pick-foot"><button type="button" class="cancel">Cancel</button><button type="button" class="go" disabled>CONFIRM</button></div></div>`;
    document.body.appendChild(pickBack);
    const pk = {
        icon: pickBack.querySelector(".ic"), title: pickBack.querySelector("h3"), sub: pickBack.querySelector(".mwx-pick-head p"),
        list: pickBack.querySelector(".mwx-pick-list"), more: pickBack.querySelector(".mwx-pick-more"), sel: pickBack.querySelector(".mwx-pick-sel"),
        cancel: pickBack.querySelector(".cancel"), go: pickBack.querySelector(".go"), card: pickBack.querySelector(".mwx-pick")
    };
    let pickState = null;
    let pickSkip = null;

    function closePicker() {
        pickBack.classList.remove("open");
        pickState = null;
        if (pickSkip) { pickSkip.remove(); pickSkip = null; }
    }

    function refreshPickerUi() {
        if (!pickState) return;
        const chosen = pickState.options.filter(o => pickState.chosen.includes(o.id));
        pk.list.querySelectorAll(".mwx-prow").forEach(row => row.classList.toggle("sel", pickState.chosen.includes(row.dataset.id)));
        pk.sel.textContent = chosen.length ? "Selected: " + chosen.map(o => o.name).join(" + ") : "";
        pk.go.disabled = chosen.length !== pickState.max;
    }

    /* opts: { icon, title, sub, confirm, options:[{id,name}], max, onConfirm(ids), skip } */
    function openPicker(opts) {
        pickState = { options: opts.options, chosen: [], max: opts.max || 1, onConfirm: opts.onConfirm };
        pk.icon.textContent = opts.icon || "🎯";
        pk.title.textContent = opts.title;
        pk.sub.textContent = opts.sub || "";
        pk.go.textContent = opts.confirm || "CONFIRM";
        pk.list.innerHTML = "";

        opts.options.forEach(o => {
            const row = el("button", "mwx-prow");
            row.type = "button";
            row.dataset.id = o.id;
            const av = el("span", "av");
            try {
                const pl = Array.isArray(players) ? players.find(x => x.id === o.id) : null;
                if (pl && typeof avatarNode === "function") av.appendChild(avatarNode(pl.look, 30, true));
            } catch (err) { /* avatar is optional */ }
            const nm = el("span", "nm");
            nm.textContent = o.name;
            row.append(av, nm, el("span", "mwx-bubble"));
            row.addEventListener("click", () => {
                if (!pickState) return;
                const i = pickState.chosen.indexOf(o.id);
                if (i >= 0) pickState.chosen.splice(i, 1);
                else if (pickState.max === 1) pickState.chosen = [o.id];
                else if (pickState.chosen.length < pickState.max) pickState.chosen.push(o.id);
                refreshPickerUi();
            });
            pk.list.appendChild(row);
        });

        pk.more.textContent = opts.options.length > 5 ? "↓ Scroll to see more players ↓" : "";
        pk.list.scrollTop = 0;

        if (pickSkip) { pickSkip.remove(); pickSkip = null; }
        if (opts.skip) {
            pickSkip = el("button", "mwx-pick-skip", "⏭️ Skip tonight");
            pickSkip.type = "button";
            pickSkip.addEventListener("click", () => { closePicker(); opts.skip(); });
            pk.card.appendChild(pickSkip);
        }

        refreshPickerUi();
        pickBack.classList.add("open");
    }
    window.mwOpenPicker = openPicker;

    pk.cancel.addEventListener("click", closePicker);
    pickBack.addEventListener("click", e => { if (e.target === pickBack) closePicker(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && pickState) closePicker(); });
    pk.go.addEventListener("click", () => {
        if (!pickState || pk.go.disabled) return;
        const ids = pickState.chosen.slice();
        const done = pickState.onConfirm;
        closePicker();
        if (done) done(ids);
    });

    function selectOptions(select) {
        return select ? [...select.options].filter(o => o.value).map(o => ({ id: o.value, name: o.textContent })) : [];
    }

    function mainActionContext() {
        const phase = typeof currentPhase !== "undefined" ? currentPhase : "";
        const role = typeof myRole !== "undefined" ? myRole : "";
        const turn = typeof currentNightTurn !== "undefined" ? currentNightTurn : "";
        if (phase === "day") return { icon: "🗳️", title: "Who do you want to vote for?", sub: "Pick one player to vote out of the game.", confirm: "✅ CONFIRM VOTE" };
        if (role === "Framer" && turn === "framer") return { icon: "🎭", title: "Who do you want to frame?", sub: "They will look like Mafia tonight.", confirm: "🎭 CONFIRM FRAME" };
        if (["Mafia", "Grandmafia", "Baby Mafia", "Framer"].includes(role)) return { icon: "🔪", title: "Who do you want to kill?", sub: "Pick tonight's target for the Mafia.", confirm: "🔪 CONFIRM KILL" };
        const map = {
            Doctor:    { icon: "💚", title: "Who do you want to save?", sub: "They cannot be killed by the Mafia tonight.", confirm: "💚 CONFIRM SAVE" },
            Detective: { icon: "🔎", title: "Who do you want to investigate?", sub: "You will learn if they are Mafia.", confirm: "🔎 CONFIRM CHECK" },
            Sheriff:   { icon: "⭐", title: "Who do you want to check?", sub: "You will learn if they are suspicious.", confirm: "⭐ CONFIRM CHECK" },
            Escort:    { icon: "🚧", title: "Who do you want to block?", sub: "Their ability does nothing tonight.", confirm: "🚧 CONFIRM BLOCK" },
            Bodyguard: { icon: "🛡️", title: "Who do you want to guard?", sub: "If they are attacked, you die instead.", confirm: "🛡️ CONFIRM GUARD" },
            Vigilante: { icon: "🔫", title: "Who do you want to shoot?", sub: "Killing 2 innocent players kills you.", confirm: "🔫 CONFIRM SHOT" }
        };
        return map[role] || { icon: "🎯", title: "Choose a player", sub: "", confirm: "✅ CONFIRM" };
    }

    function hookPickerButtons() {
        const mainBtn = document.getElementById("confirmAction");
        if (mainBtn && !mainBtn.dataset.mwxPick) {
            mainBtn.dataset.mwxPick = "1";
            let pass = false;
            mainBtn.addEventListener("click", e => {
                if (pass) return;
                e.preventDefault();
                e.stopImmediatePropagation();
                const select = document.getElementById("targetPlayer");
                const ctx = mainActionContext();
                const role = typeof myRole !== "undefined" ? myRole : "";
                const turn = typeof currentNightTurn !== "undefined" ? currentNightTurn : "";
                const canSkip = window.MW_EXTRA_TURN_ROLES && window.MW_EXTRA_TURN_ROLES[turn] === role && currentPhase === "night";
                openPicker(Object.assign({}, ctx, {
                    options: selectOptions(select),
                    max: 1,
                    skip: canSkip ? () => socket.emit("roleChoose", { roomCode: getRoom(), skip: true }) : null,
                    onConfirm: ids => {
                        select.value = ids[0];
                        pass = true;
                        try { mainBtn.click(); } finally { pass = false; }
                    }
                }));
            }, true);
        }

        const gmBtn = document.getElementById("grandmafiaButton");
        if (gmBtn && !gmBtn.dataset.mwxPick) {
            gmBtn.dataset.mwxPick = "1";
            let pass = false;
            gmBtn.addEventListener("click", e => {
                if (pass) return;
                e.preventDefault();
                e.stopImmediatePropagation();
                const select = document.getElementById("grandmafiaTarget");
                openPicker({
                    icon: "👶", title: "Who becomes Baby Mafia?", sub: "They join the Mafia when you die.", confirm: "👶 CONFIRM BABY MAFIA",
                    options: selectOptions(select), max: 1,
                    onConfirm: ids => { select.value = ids[0]; pass = true; try { gmBtn.click(); } finally { pass = false; } }
                });
            }, true);
        }

        const loverBtn = document.getElementById("loverButton");
        if (loverBtn && !loverBtn.dataset.mwxPick) {
            loverBtn.dataset.mwxPick = "1";
            let pass = false;
            loverBtn.addEventListener("click", e => {
                if (pass) return;
                e.preventDefault();
                e.stopImmediatePropagation();
                const a = document.getElementById("lover1");
                const b = document.getElementById("lover2");
                openPicker({
                    icon: "💘", title: "Who do you want to link?", sub: "Pick TWO players. If one dies, the other dies too.", confirm: "💘 CONFIRM LINK",
                    options: selectOptions(a), max: 2,
                    onConfirm: ids => { a.value = ids[0]; b.value = ids[1]; pass = true; try { loverBtn.click(); } finally { pass = false; } }
                });
            }, true);
        }
    }
    setInterval(hookPickerButtons, 600);
    hookPickerButtons();

    // close the picker if the phase or the night turn moves on while it is open
    let pickerPhaseKey = "";
    socket.on("gameInformation", data => {
        const key = (data && data.phase) + "|" + (data && data.nightTurn);
        if (pickState && key !== pickerPhaseKey) closePicker();
        pickerPhaseKey = key;
    });

    /* ---------------- theme-aware pictures (blue for White theme, red/black for Dark) ---------------- */
    const isWhiteTheme = () => document.documentElement.dataset.mafiaTheme === "white";
    const BLUE_IMAGE_ROLES = [
        "mafia", "doctor", "detective", "cupid", "godfather", "grandmafia", "grandma", "jester", "civilian", "babymafia",
        "bodyguard", "vigilante", "sheriff", "mayor", "escort", "framer", "medium", "executioner", "amnesiac"
    ];

    window.mwTurnImage = function (role) {
        const mobile = typeof isMobileOrTablet === "function" && isMobileOrTablet();
        const dev = mobile ? "mobile" : "laptop";
        return `/images/${dev}/${role}-turn-${dev}${isWhiteTheme() ? "-blue" : ""}.png`;
    };

    if (typeof getRoleImage === "function") {
        const originalGetRoleImage = getRoleImage;
        getRoleImage = function (role) {
            const base = originalGetRoleImage(role);
            const key = String(role || "").toLowerCase().replace(/\s+/g, "");
            if (base && isWhiteTheme() && BLUE_IMAGE_ROLES.includes(key)) return base.replace(/\.png$/, "-blue.png");
            return base;
        };
    }

    if (typeof getDeathImage === "function") {
        const originalGetDeathImage = getDeathImage;
        getDeathImage = function () {
            const base = originalGetDeathImage();
            return isWhiteTheme() ? base.replace(/\.png$/, "-blue.png") : base;
        };
    }

    // If a blue picture does not exist yet, quietly use the normal one.
    document.addEventListener("error", e => {
        const t = e.target;
        if (t && t.tagName === "IMG" && /-blue\.(png|jpg|jpeg|webp)(\?.*)?$/i.test(t.src || "") && !t.dataset.mwxFallback) {
            t.dataset.mwxFallback = "1";
            t.src = t.src.replace("-blue.", ".");
        }
    }, true);

    /* ---------------- emoji picker for every chat box ---------------- */
    const EMOJIS = ("😀 😂 🤣 😊 😍 😎 🤔 😮 😱 😭 😡 🤬 😈 💀 👻 🤡 👀 🙏 👍 👎 👏 💪 🤝 🔥 ❤️ 💔 🎉 🏆 " +
        "🔪 🔫 🕵️ 🛡️ ⭐ 🧠 🪓 🎭 🚧 🔮 🏛️ 🤫 😴 🥶 🤮 🍀 💰 🌙 ☀️ ⚰️ 🗳️ 😇 🥷 🤠 👑").split(" ");

    const emojiPop = el("div", "mwx-emoji-pop");
    EMOJIS.forEach(e => { const b = el("button", "", e); b.type = "button"; emojiPop.appendChild(b); });
    document.body.appendChild(emojiPop);
    let emojiTarget = null;

    emojiPop.addEventListener("click", ev => {
        const b = ev.target.closest("button");
        if (!b || !emojiTarget) return;
        const input = emojiTarget;
        const at = input.selectionStart == null ? input.value.length : input.selectionStart;
        input.value = input.value.slice(0, at) + b.textContent + input.value.slice(input.selectionEnd == null ? at : input.selectionEnd);
        input.focus();
        const pos = at + b.textContent.length;
        try { input.setSelectionRange(pos, pos); } catch (err) { /* ignore */ }
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    document.addEventListener("click", ev => {
        if (!emojiPop.contains(ev.target) && !(ev.target.classList && ev.target.classList.contains("mwx-emoji-btn"))) {
            emojiPop.style.display = "none";
        }
    });

    function attachEmojiPicker(input) {
        if (!input || input.dataset.mwxEmoji) return;
        input.dataset.mwxEmoji = "1";
        const btn = el("button", "mwx-emoji-btn", "😊");
        btn.type = "button";
        btn.title = "Emojis";
        btn.addEventListener("click", ev => {
            ev.preventDefault(); ev.stopPropagation();
            emojiTarget = input;
            const r = btn.getBoundingClientRect();
            emojiPop.style.display = "grid";
            const w = Math.min(300, window.innerWidth * 0.92);
            emojiPop.style.left = Math.max(6, Math.min(window.innerWidth - w - 6, r.right - w)) + "px";
            emojiPop.style.top = Math.max(6, r.top - 230) + "px";
        });
        input.insertAdjacentElement("afterend", btn);
    }
    window.mwAttachEmojiPicker = attachEmojiPicker;

    function scanChatInputs() {
        ["lobbyChatInput", "chatInput", "mafiaChatInput"].forEach(id => attachEmojiPicker(document.getElementById(id)));
        document.querySelectorAll(".mwx-send input, .mwx-dead input, .mwx-lw input").forEach(attachEmojiPicker);
    }
    setInterval(scanChatInputs, 800);

    /* ---------------- text that cannot be read is fixed automatically ---------------- */
    const NAVY = "#10264d";
    const rgbOf = str => {
        const m = String(str || "").match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const p = m[1].split(/[,\s\/]+/).filter(Boolean).map(Number);
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    };
    const lum = c => {
        const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

    function backdropOf(el, cache) {
        const trail = [];
        let node = el, found;
        while (node && node.nodeType === 1) {
            if (cache.has(node)) { found = cache.get(node); break; }
            trail.push(node);
            const cs = getComputedStyle(node);
            const bi = cs.backgroundImage;
            if (bi && bi !== "none") {
                if (bi.indexOf("url(") >= 0) { found = null; break; }
                const cols = (bi.match(/rgba?\([^)]+\)/g) || []).map(rgbOf).filter(c => c && c.a >= 0.5);
                if (cols.length) {
                    found = {
                        r: cols.reduce((t, c) => t + c.r, 0) / cols.length,
                        g: cols.reduce((t, c) => t + c.g, 0) / cols.length,
                        b: cols.reduce((t, c) => t + c.b, 0) / cols.length
                    };
                    break;
                }
            }
            const bg = rgbOf(cs.backgroundColor);
            if (bg && bg.a >= 0.5) { found = bg; break; }
            node = node.parentElement;
        }
        if (found === undefined) found = null;
        trail.forEach(n => cache.set(n, found));
        return found;
    }

    function fixTextColor(el, cache) {
        if (el.tagName === "OPTION" || el.tagName === "SCRIPT" || el.tagName === "STYLE") return;
        const cs = getComputedStyle(el);
        if (cs.visibility === "hidden" || cs.display === "none") return;
        if (cs.webkitBackgroundClip === "text" || cs.backgroundClip === "text") return;     // gradient names
        if (/transparent|rgba\(0, 0, 0, 0\)/.test(cs.webkitTextFillColor || "")) return;
        const col = rgbOf(cs.color);
        if (!col || col.a < 0.3) return;
        const bg = backdropOf(el, cache);
        if (!bg) return;
        if (ratio(col, bg) >= 3.2) return;
        const pick = ratio({ r: 16, g: 38, b: 77 }, bg) >= ratio({ r: 255, g: 255, b: 255 }, bg) ? NAVY : "#ffffff";
        el.style.setProperty("color", pick, "important");
        el.style.setProperty("-webkit-text-fill-color", pick, "important");
        el.dataset.mwFix = "1";
    }

    let contrastBusy = false;
    function contrastPass() {
        if (contrastBusy || !document.body) return;
        contrastBusy = true;
        try {
            const cache = new Map();
            const seen = new Set();
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
                acceptNode: n => n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
            });
            let n, count = 0;
            while ((n = walker.nextNode()) && count < 4000) {
                const parent = n.parentElement;
                if (parent && !seen.has(parent)) { seen.add(parent); count++; }
            }
            document.querySelectorAll("input,textarea,select,button").forEach(e => seen.add(e));
            seen.forEach(e => fixTextColor(e, cache));
        } catch (err) { /* never break the game */ }
        contrastBusy = false;
    }

    function resetContrastFixes() {
        document.querySelectorAll("[data-mw-fix]").forEach(e => {
            e.style.removeProperty("color");
            e.style.removeProperty("-webkit-text-fill-color");
            delete e.dataset.mwFix;
        });
    }

    let contrastTimer = null;
    function scheduleContrast() {
        if (contrastTimer) return;
        contrastTimer = setTimeout(() => { contrastTimer = null; contrastPass(); }, 300);
    }
    if (typeof MutationObserver === "function") {
        new MutationObserver(scheduleContrast).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden"] });
        new MutationObserver(() => { resetContrastFixes(); scheduleContrast(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-mafia-theme"] });
    }
    window.mwContrastPass = contrastPass;
    setInterval(scheduleContrast, 2500);
    setTimeout(contrastPass, 600);

    /* ---------------- logout: straight back to the sign in screen ---------------- */
    function wireLogout() {
        const btn = document.getElementById("accountLogoutButton");
        if (!btn || btn.dataset.mwxLogout) return;
        btn.dataset.mwxLogout = "1";
        btn.addEventListener("click", () => {
            try { if (typeof roomCode !== "undefined" && roomCode) socket.emit("leaveRoom", { roomCode }); } catch (e) { /* ignore */ }
            F.data = { friends: [], groups: [], requests: [], unread: {}, unreadTotal: 0, guest: true };
            F.view = null; F.creating = false; F.tab = "friends";
            updateDockBadge();
            document.querySelectorAll(".mwx-modal.open, .mwx-pick-back.open").forEach(m => m.classList.remove("open"));
            setTimeout(() => {
                try { if (typeof showAuthForm === "function") showAuthForm("login"); } catch (e) { /* ignore */ }
                try { if (typeof setScreen === "function") setScreen("authScreen"); } catch (e) { /* ignore */ }
            }, 0);
        }, true);
    }
    setInterval(wireLogout, 700);
    wireLogout();
})();



/* =========================================================
   MAFIA WARS - LOBBY UPGRADE
   - ▼ / ▲ buttons for every role number
   - Room options (host): players needed + adjustable timers
   - Kick / Ban (host) in the lobby and during the game
   - Packages: Owner writes role presets, hosts load them in the lobby
   - In-game / lobby background hooks (blue + red theme)
   This block only ADDS things. Nothing above is removed.
========================================================= */
(function mwLobbyUpgrade() {
    "use strict";

    const STEP_ROLE_IDS = [
        "mafiaCount", "godfatherCount", "grandmafiaCount", "framerCount",
        "doctorCount", "detectiveCount", "sheriffCount", "bodyguardCount", "vigilanteCount",
        "escortCount", "mediumCount", "mayorCount", "loverCount", "grandmaCount",
        "jesterCount", "executionerCount", "amnesiacCount"
    ];

    /* role key (server) -> [label, input id] */
    const ROLE_DEFS = [
        ["mafia", "Mafia", "🔪", "mafiaCount"],
        ["godfather", "Godfather", "🎩", "godfatherCount"],
        ["grandmafia", "Grandmafia", "👵", "grandmafiaCount"],
        ["framer", "Framer", "🎭", "framerCount"],
        ["doctor", "Doctor", "💚", "doctorCount"],
        ["detective", "Detective", "🔎", "detectiveCount"],
        ["sheriff", "Sheriff", "⭐", "sheriffCount"],
        ["bodyguard", "Bodyguard", "🛡️", "bodyguardCount"],
        ["vigilante", "Vigilante", "🔫", "vigilanteCount"],
        ["escort", "Escort", "🚧", "escortCount"],
        ["medium", "Medium", "🔮", "mediumCount"],
        ["mayor", "Mayor", "🏛️", "mayorCount"],
        ["lover", "Cupid", "💘", "loverCount"],
        ["grandma", "Grandma", "👵", "grandmaCount"],
        ["jester", "Jester", "🤡", "jesterCount"],
        ["executioner", "Executioner", "🪓", "executionerCount"],
        ["amnesiac", "Amnesiac", "🌀", "amnesiacCount"]
    ];
    const ROLE_MAX = { mayor: 1, lover: 1, jester: 1, executioner: 1, amnesiac: 1 };

    const LIMITS = {
        maxPlayers: { min: 4, max: 30, step: 1 },
        turn: { min: 10, max: 120, step: 5 },
        discussion: { min: 0, max: 300, step: 15 },
        voting: { min: 15, max: 300, step: 15 }
    };

    const state = {
        maxPlayers: 20,
        timers: { turn: 30, discussion: 60, voting: 60 },
        packages: [],
        pendingSend: null,
        votingOpensAt: null
    };

    const esc = text => String(text ?? "").replace(/[&<>"']/g, ch => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch]
    ));

    const fmt = seconds => {
        const s = Math.max(0, Math.round(seconds));
        return s >= 60 ? `${Math.floor(s / 60)}m${s % 60 ? " " + (s % 60) + "s" : ""}` : `${s}s`;
    };

    /* ---------------------------------------------------------
       Small popup (used for kick / ban and delete confirmation)
    --------------------------------------------------------- */
    function mwModal({ title, text, buttons }) {
        document.querySelectorAll(".mw-modal-back.mw-temp").forEach(el => el.remove());

        const back = document.createElement("div");
        back.className = "mw-modal-back mw-temp";
        back.innerHTML = `
            <div class="mw-modal" role="dialog" aria-modal="true">
                <h3>${esc(title)}</h3>
                <p>${esc(text)}</p>
                <div class="mw-modal-actions"></div>
            </div>`;

        const actions = back.querySelector(".mw-modal-actions");

        buttons.forEach(def => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "mw-btn " + (def.kind || "");
            button.textContent = def.label;
            button.addEventListener("click", () => {
                back.remove();
                if (def.onClick) def.onClick();
            });
            actions.appendChild(button);
        });

        back.addEventListener("click", event => {
            if (event.target === back) back.remove();
        });

        document.body.appendChild(back);
    }

    /* ---------------------------------------------------------
       1. ▼ / ▲ buttons for every role number in the lobby
    --------------------------------------------------------- */
    function flash(el) {
        if (!el) return;
        el.classList.remove("mw-shake");
        void el.offsetWidth;
        el.classList.add("mw-shake");
    }

    function stepInput(input, delta) {
        if (!input || input.disabled || input.readOnly) return false;

        const min = input.min !== "" ? Number(input.min) : 0;
        const max = input.max !== "" ? Number(input.max) : Infinity;
        const current = Number(input.value) || 0;
        let next = Math.min(max, Math.max(min, current + delta));

        if (next === current) return false;

        // Going UP needs a free player slot (Civilians are the leftover slots).
        if (delta > 0) {
            const civilians = document.getElementById("civilianCount");
            if (civilians && (Number(civilians.value) || 0) <= 0) return false;
        }

        input.value = next;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
    }

    function makeStepButton(label, className, title) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "mw-step-btn " + className;
        button.textContent = label;
        button.title = title;
        button.setAttribute("aria-label", title);
        return button;
    }

    function enhanceRoleSteppers() {
        const settings = document.getElementById("hostSettings");
        if (!settings) return;

        STEP_ROLE_IDS.forEach(id => {
            const input = document.getElementById(id);
            if (!input || input.dataset.mwStepper) return;

            input.dataset.mwStepper = "1";

            const wrap = document.createElement("span");
            wrap.className = "mw-stepper";

            const down = makeStepButton("▼", "mw-step-down", "Less");
            const up = makeStepButton("▲", "mw-step-up", "More");

            input.parentNode.insertBefore(wrap, input);
            wrap.append(down, input, up);

            const bump = delta => {
                if (!stepInput(input, delta)) flash(wrap);
            };

            down.addEventListener("click", event => { event.preventDefault(); bump(-1); });
            up.addEventListener("click", event => { event.preventDefault(); bump(1); });
        });

        syncStepperDisabled();
    }

    function syncStepperDisabled() {
        document.querySelectorAll("#hostSettings .mw-stepper").forEach(wrap => {
            const input = wrap.querySelector("input");
            wrap.classList.toggle("mw-disabled", Boolean(input && input.disabled));
        });
    }

    /* ---------------------------------------------------------
       2. Room options (host): players needed + timers
    --------------------------------------------------------- */
    let optionsTimer = null;
    let optionsDirty = false;

    function optionRow(key, icon, label, hint) {
        const lim = LIMITS[key];
        return `
            <div class="mw-opt-row" data-opt="${key}">
                <div class="mw-opt-label"><strong>${icon} ${label}</strong><small>${hint}</small></div>
                <div class="mw-stepper mw-opt-stepper">
                    <button type="button" class="mw-step-btn" data-opt-step="-1" aria-label="Less">▼</button>
                    <output class="mw-opt-value" data-opt-value="${key}">0</output>
                    <button type="button" class="mw-step-btn" data-opt-step="1" aria-label="More">▲</button>
                </div>
            </div>`;
    }

    function ensureRoomOptions() {
        const settings = document.getElementById("hostSettings");
        if (!settings) return;

        let panel = document.getElementById("mwRoomOptions");

        if (!panel) {
            panel = document.createElement("div");
            panel.id = "mwRoomOptions";
            panel.className = "mw-panel mw-room-options";
            panel.innerHTML = `
                <h3>🏠 Room Options</h3>
                ${optionRow("maxPlayers", "👥", "Players needed", "How many players can join this room")}
                ${optionRow("turn", "🌙", "Turn time", "Every night role turn")}
                ${optionRow("discussion", "💬", "Discussion time", "Talk first, voting is locked (0 = off)")}
                ${optionRow("voting", "🗳️", "Voting time", "How long players can vote")}
            `;

            const firstGroup = settings.querySelector(".role-group");
            if (firstGroup) settings.insertBefore(panel, firstGroup);
            else settings.appendChild(panel);

            panel.addEventListener("click", event => {
                const stepButton = event.target.closest("[data-opt-step]");
                if (stepButton) {
                    const key = stepButton.closest("[data-opt]").dataset.opt;
                    changeOption(key, Number(stepButton.dataset.optStep));
                    return;
                }

            });
        }

        renderRoomOptionValues();
    }

    function renderRoomOptionValues() {
        const panel = document.getElementById("mwRoomOptions");
        if (!panel) return;

        const values = {
            maxPlayers: state.maxPlayers,
            turn: state.timers.turn,
            discussion: state.timers.discussion,
            voting: state.timers.voting
        };

        Object.entries(values).forEach(([key, value]) => {
            const out = panel.querySelector(`[data-opt-value="${key}"]`);
            if (!out) return;
            out.textContent = key === "maxPlayers" ? String(value) : (value === 0 ? "OFF" : fmt(value));
        });

        // Never let the limit go below the number of players that are already inside.
        const down = panel.querySelector('[data-opt="maxPlayers"] [data-opt-step="-1"]');
        if (down) down.disabled = state.maxPlayers <= Math.max(LIMITS.maxPlayers.min, players.length);
    }

    function changeOption(key, direction) {
        const lim = LIMITS[key];
        const current = key === "maxPlayers" ? state.maxPlayers : state.timers[key];
        let next = current + direction * lim.step;

        next = Math.min(lim.max, Math.max(lim.min, next));

        if (key === "maxPlayers" && next < players.length) next = Math.max(players.length, lim.min);
        if (next === current) return;

        if (key === "maxPlayers") state.maxPlayers = next;
        else state.timers[key] = next;

        optionsDirty = true;
        renderRoomOptionValues();
        renderRoomInfo();

        clearTimeout(optionsTimer);
        optionsTimer = setTimeout(() => {
            socket.emit("setRoomOptions", {
                roomCode,
                maxPlayers: state.maxPlayers,
                timers: { ...state.timers }
            });
            optionsDirty = false;
        }, 280);
    }

    /* Everyone sees the room rules (read only). */
    function renderRoomInfo() {
        const countSpan = document.getElementById("rolePlayerCount");
        if (!countSpan) return;

        let max = document.getElementById("mwRoomMax");

        if (!max) {
            max = document.createElement("span");
            max.id = "mwRoomMax";
            countSpan.insertAdjacentElement("afterend", max);
        }

        max.textContent = ` / ${state.maxPlayers}`;

        let info = document.getElementById("mwRoomInfo");

        if (!info) {
            info = document.createElement("div");
            info.id = "mwRoomInfo";
            info.className = "mw-room-info";
            const heading = countSpan.closest("h3");
            if (heading) heading.insertAdjacentElement("afterend", info);
        }

        info.innerHTML = `
            <span>🌙 Turn <b>${fmt(state.timers.turn)}</b></span>
            <span>💬 Discussion <b>${state.timers.discussion ? fmt(state.timers.discussion) : "OFF"}</b></span>
            <span>🗳️ Voting <b>${fmt(state.timers.voting)}</b></span>`;
    }

    function readRoomData(data) {
        if (!data || Array.isArray(data)) return;

        if (Number.isFinite(Number(data.maxPlayers))) state.maxPlayers = Number(data.maxPlayers);

        if (data.timers && typeof data.timers === "object" && !optionsDirty) {
            ["turn", "discussion", "voting"].forEach(key => {
                if (Number.isFinite(Number(data.timers[key]))) state.timers[key] = Number(data.timers[key]);
            });
        }

        if (data.votingOpensAt !== undefined) state.votingOpensAt = data.votingOpensAt || null;
    }

    /* ---------------------------------------------------------
       3. Kick / Ban buttons (host only)
    --------------------------------------------------------- */
    function askKick(player, ban) {
        mwModal({
            title: `🥾 Kick ${player.name}?`,
            text: "They are removed from this room. They can join again with the code (in the lobby).",
            buttons: [
                { label: "CANCEL", kind: "ghost" },
                {
                    label: "KICK",
                    kind: "danger",
                    onClick: () => socket.emit("kickPlayer", { roomCode, targetId: player.id, ban })
                }
            ]
        });
    }

    function decoratePlayerList(listId, list) {
        const ul = document.getElementById(listId);
        if (!ul) return;

        ul.querySelectorAll(".mw-kick-row").forEach(el => el.remove());
        if (!isHost) return;

        Array.from(ul.children).forEach((li, index) => {
            const player = list[index];
            if (!player || player.id === socket.id) return;

            const row = document.createElement("span");
            row.className = "mw-kick-row";

            const kick = document.createElement("button");
            kick.type = "button";
            kick.className = "mw-kick-btn";
            kick.title = "Kick";
            kick.textContent = "🥾";
            kick.addEventListener("click", event => { event.stopPropagation(); askKick(player, false); });

            row.append(kick);
            li.appendChild(row);
        });
    }

    const baseRenderLobbyPlayers = renderLobbyPlayers;
    renderLobbyPlayers = function () {
        baseRenderLobbyPlayers.apply(this, arguments);
        decoratePlayerList("playerList", players.filter(p => p.connected !== false));
        renderRoomInfo();
        renderRoomOptionValues();
        enhanceRoleSteppers();
    };

    const baseRenderGamePlayers = renderGamePlayers;
    renderGamePlayers = function () {
        baseRenderGamePlayers.apply(this, arguments);
        decoratePlayerList("gamePlayerList", players);
    };

    socket.on("kickedFromRoom", data => {
        try { disableVoice(); } catch (e) { /* ignore */ }

        const voicePanel = document.getElementById("voiceChatPanel");
        if (voicePanel) voicePanel.style.display = "none";

        roomCode = "";
        myRole = "";
        players = [];
        currentPhase = "";
        hasVoted = false;
        isHost = false;
        window.currentHostId = "";

        setScreen("homeScreen");

        mwModal({
            title: data && data.banned ? "⛔ You were banned" : "🥾 You were kicked",
            text: (data && data.message) || "The host removed you from the room.",
            buttons: [{ label: "OK", kind: "danger" }]
        });
    });

    /* ---------------------------------------------------------
       4. Discussion banner during the day
    --------------------------------------------------------- */
    function ensureDiscussionBanner() {
        let banner = document.getElementById("mwDiscussion");
        if (banner) return banner;

        const anchor = document.getElementById("phaseTimer") || document.getElementById("phaseTitle");
        if (!anchor) return null;

        banner = document.createElement("div");
        banner.id = "mwDiscussion";
        banner.className = "mw-discussion";
        banner.style.display = "none";
        anchor.insertAdjacentElement("afterend", banner);
        return banner;
    }

    function tickDiscussion() {
        const banner = ensureDiscussionBanner();
        if (!banner) return;

        const opens = state.votingOpensAt;

        if (currentPhase === "day" && opens && Date.now() < opens) {
            const left = Math.ceil((opens - Date.now()) / 1000);
            banner.style.display = "";
            banner.className = "mw-discussion mw-discussion-on";
            banner.textContent = `💬 Discussion time – voting opens in ${fmt(left)}`;
        } else if (currentPhase === "day" && opens) {
            banner.style.display = "";
            banner.className = "mw-discussion mw-discussion-vote";
            banner.textContent = "🗳️ Voting is open!";
        } else {
            banner.style.display = "none";
        }
    }

    setInterval(tickDiscussion, 400);

    /* ---------------------------------------------------------
       5. Packages
    --------------------------------------------------------- */
    function loadPackages(done) {
        socket.emit("packagesGet", result => {
            if (result && result.ok) state.packages = result.packages || [];
            if (done) done();
        });
    }

    socket.on("packagesUpdated", list => {
        state.packages = Array.isArray(list) ? list : [];
        if (typeof settingsView !== "undefined" && settingsView === "packages" && document.getElementById("settingsPage")) {
            if (!packageEditor) renderPackagesPage();
        }
    });

    /* ----- Settings -> Package (everyone reads, only the Owner writes) ----- */
    let packageEditor = null;   // null = list view, otherwise { id, name, text }
    let packageMessage = "";

    function isOwnerNow() {
        return typeof myBadge !== "undefined" && myBadge === "owner";
    }

    const nl2br = text => esc(text).replace(/\n/g, "<br>");

    function renderPackagesPage() {
        const page = document.getElementById("settingsPage");
        if (!page) return;

        const owner = isOwnerNow();

        if (packageEditor && owner) {
            renderPackageEditor(page);
            return;
        }

        const cards = state.packages.length
            ? state.packages.map(pack => `
                <div class="mw-package-card">
                    <div class="mw-package-top">
                        <strong class="mw-package-name">📦 ${esc(pack.name)}</strong>
                    </div>
                    <p class="mw-package-text">${nl2br(pack.text)}</p>
                    ${owner ? `
                        <div class="mw-package-actions">
                            <button type="button" class="mw-btn" data-pkg-edit="${esc(pack.id)}">✏️ EDIT</button>
                            <button type="button" class="mw-btn danger" data-pkg-delete="${esc(pack.id)}">🗑️ DELETE</button>
                        </div>` : ""}
                </div>`).join("")
            : `<div class="mw-empty">${owner ? "No packages yet. Press ADD PACKAGE to write the first one." : "No packages yet."}</div>`;

        page.innerHTML = settingsHeader("📦 PACKAGES") + `
            <div class="settings-card">
                ${owner ? `<button type="button" class="mw-btn mw-wide" id="mwAddPackage">➕ ADD PACKAGE</button>` : `<p>Packages and offers from the Owner.</p>`}
                <div class="shop-message" id="mwPackageMessage">${esc(packageMessage)}</div>
            </div>
            <div class="mw-package-list">${cards}</div>`;

        document.getElementById("settingsBack")?.addEventListener("click", () => settingsNav("main"));
        document.getElementById("settingsClose")?.addEventListener("click", closeSettings);

        document.getElementById("mwAddPackage")?.addEventListener("click", () => {
            packageEditor = { id: "", name: "", text: "" };
            packageMessage = "";
            renderPackagesPage();
        });

        page.querySelectorAll("[data-pkg-edit]").forEach(button => {
            button.addEventListener("click", () => {
                const pack = state.packages.find(p => p.id === button.dataset.pkgEdit);
                if (!pack) return;
                packageEditor = { id: pack.id, name: pack.name, text: pack.text || "" };
                packageMessage = "";
                renderPackagesPage();
            });
        });

        page.querySelectorAll("[data-pkg-delete]").forEach(button => {
            button.addEventListener("click", () => {
                const pack = state.packages.find(p => p.id === button.dataset.pkgDelete);
                if (!pack) return;

                mwModal({
                    title: `🗑️ Delete “${pack.name}”?`,
                    text: "This package is removed for everybody.",
                    buttons: [
                        { label: "CANCEL", kind: "ghost" },
                        {
                            label: "DELETE",
                            kind: "danger",
                            onClick: () => socket.emit("ownerPackageDelete", { id: pack.id }, result => {
                                packageMessage = result && result.ok ? "🗑️ Package deleted." : ((result && result.error) || "Could not delete.");
                                if (result && result.ok) state.packages = result.packages || [];
                                renderPackagesPage();
                            })
                        }
                    ]
                });
            });
        });
    }

    function renderPackageEditor(page) {
        const editing = Boolean(packageEditor.id);

        page.innerHTML = settingsHeader(editing ? "✏️ EDIT PACKAGE" : "➕ ADD PACKAGE") + `
            <div class="settings-card mw-package-card mw-package-editor">
                <label class="mw-field">Package name
                    <input id="mwPkgName" type="text" maxlength="40" placeholder="Example: Coats pack" value="${esc(packageEditor.name)}">
                </label>
                <label class="mw-field">What is in it (write anything: items, price, rules...)
                    <textarea id="mwPkgText" maxlength="1000" rows="8" placeholder="Example: All the coats for 10 riyal">${esc(packageEditor.text)}</textarea>
                </label>
                <div class="mw-package-actions">
                    <button type="button" class="mw-btn" id="mwPkgSave">💾 SAVE PACKAGE</button>
                    <button type="button" class="mw-btn ghost" id="mwPkgCancel">CANCEL</button>
                </div>
                <div class="shop-message" id="mwPkgMessage"></div>
            </div>`;

        const back = () => { packageEditor = null; renderPackagesPage(); };

        document.getElementById("settingsBack")?.addEventListener("click", back);
        document.getElementById("settingsClose")?.addEventListener("click", closeSettings);
        document.getElementById("mwPkgCancel")?.addEventListener("click", back);

        document.getElementById("mwPkgSave")?.addEventListener("click", () => {
            socket.emit("ownerPackageSave", {
                id: packageEditor.id || undefined,
                name: document.getElementById("mwPkgName").value,
                text: document.getElementById("mwPkgText").value
            }, result => {
                if (result && result.ok) {
                    state.packages = result.packages || [];
                    packageMessage = "✅ Package saved.";
                    packageEditor = null;
                    renderPackagesPage();
                } else {
                    const box = document.getElementById("mwPkgMessage");
                    if (box) box.textContent = (result && result.error) || "Could not save.";
                }
            });
        });
    }

    const baseRenderSettingsPage = renderSettingsPage;
    renderSettingsPage = function (view) {
        const page = document.getElementById("settingsPage");

        if (view === "packages" && page) {
            loadPackages(() => renderPackagesPage());
            renderPackagesPage();
            return;
        }

        packageEditor = null;
        baseRenderSettingsPage.apply(this, arguments);

        if (view === "main") {
            const grid = page && page.querySelector(".settings-grid");

            if (grid && !grid.querySelector("[data-mw-package]")) {
                const button = document.createElement("button");
                button.type = "button";
                button.className = "settings-option settings-category";
                button.dataset.mwPackage = "1";
                button.innerHTML = `<span class="settings-icon">📦</span><span class="settings-copy"><strong>Package</strong><span>${isOwnerNow() ? "Owner: add, edit and delete packages" : "Packages and offers from the Owner"}</span></span>`;
                button.addEventListener("click", () => settingsNav("packages"));
                grid.appendChild(button);
            }
        }
    };

    /* ---------------------------------------------------------
       6. Background hooks: body.mw-in-game / body.mw-in-lobby
    --------------------------------------------------------- */
    function syncScreenClasses() {
        const visible = id => {
            const el = document.getElementById(id);
            return Boolean(el && el.style.display !== "none" && el.offsetParent !== null);
        };

        document.body.classList.toggle("mw-in-game", visible("gameScreen"));
        document.body.classList.toggle("mw-in-lobby", visible("lobby"));
    }

    ["gameScreen", "lobby"].forEach(id => {
        const el = document.getElementById(id);
        if (el) new MutationObserver(syncScreenClasses).observe(el, { attributes: true, attributeFilter: ["style", "class"] });
    });

    setInterval(syncScreenClasses, 1000);
    syncScreenClasses();

    /* ---------------------------------------------------------
       7. Wire server events
    --------------------------------------------------------- */
    socket.on("playerJoined", data => {
        readRoomData(data);
        ensureRoomOptions();
        enhanceRoleSteppers();
        renderRoomInfo();
        renderRoomOptionValues();
    });

    socket.on("gameInformation", data => {
        readRoomData(data);
        decoratePlayerList("gamePlayerList", players);
        tickDiscussion();
    });

    socket.on("gameRestarted", () => {
        state.votingOpensAt = null;
        tickDiscussion();
    });

    document.addEventListener("input", event => {
        if (event.target && event.target.closest && event.target.closest("#hostSettings")) syncStepperDisabled();
    });

    document.addEventListener("change", event => {
        if (event.target && event.target.name === "grandma") setTimeout(syncStepperDisabled, 0);
    });

    ensureRoomOptions();
    enhanceRoleSteppers();
    renderRoomInfo();
    loadPackages();
})();

socket.on("accountBanned", data => {
    try { alert((data && data.message) || "Your account was banned."); } catch (e) { /* ignore */ }
    try { if (typeof showAuthForm === "function") showAuthForm("login"); } catch (e) { /* ignore */ }
    try { setScreen("authScreen"); } catch (e) { /* ignore */ }
});

/* =========================================================
   MAFIA WARS - TEAM ROLE SETTINGS + FRIENDS/ROLES BUTTONS + DEAD BACKGROUND
   - Host: one "ROLE SETTINGS" button in the lobby (under the chat).
     It opens 4 buttons: Mafia Team / Town Team / Neutral Team / Other.
     Every team page has the +/- number for each role (the old long list is gone).
     "Other" holds the room options, voice / detective settings and soundboard permissions.
   - Friends + Roles buttons live inside the Voice Chat box (lobby)
     and inside the Background Music box (everywhere else).
   - Dead players: the death picture is only a background, the game + chat sit on top of it.
   This block only ADDS things. Every input id (mafiaCount, doctorCount ...) stays the same,
   so server.js and the old code keep working.
========================================================= */
(function mwTeamsUpgrade() {
    "use strict";

    const byId = id => document.getElementById(id);

    /* ---------------------------------------------------------
       1. ROLE SETTINGS HUB (host only, inside #hostSettings)
    --------------------------------------------------------- */
    const TEAMS = [
        {
            key: "mafia", icon: "🔪", name: "Mafia Team",
            hint: "Choose how many of each Mafia role.",
            roles: ["mafiaCount", "godfatherCount", "grandmafiaCount", "framerCount"]
        },
        {
            key: "town", icon: "🏙️", name: "Town Team",
            hint: "Choose how many of each Town role. Civilians fill the free slots.",
            roles: [
                "doctorCount", "detectiveCount", "sheriffCount", "bodyguardCount", "vigilanteCount",
                "escortCount", "mediumCount", "mayorCount", "loverCount", "grandmaCount"
            ]
        },
        {
            key: "neutral", icon: "🃏", name: "Neutral Team",
            hint: "Neutral roles win on their own, not with the Mafia or the Town.",
            roles: ["jesterCount", "executionerCount", "amnesiacCount"]
        },
        {
            key: "other", icon: "⚙️", name: "Other",
            hint: "Room options, voice chat, detective check and soundboard permissions.",
            roles: null
        }
    ];

    const ALL_ROLE_IDS = TEAMS.flatMap(team => team.roles || []);

    let view = "closed";   // closed | hub | mafia | town | neutral | other
    let hub = null;
    let started = false;

    const pages = {};      // team key -> { page, list }

    function build() {
        const hs = byId("hostSettings");
        if (!hs || byId("mwRoleHub")) return Boolean(byId("mwRoleHub"));

        hub = document.createElement("div");
        hub.id = "mwRoleHub";
        hub.className = "mw-hub";

        const pageHtml = TEAMS.map(team => `
            <section class="mw-team-page mw-team-${team.key}" data-page="${team.key}" hidden>
                <header class="mw-page-head">
                    <button type="button" class="mw-page-back" data-mw-back>← BACK</button>
                    <h3>${team.icon} ${team.name}</h3>
                    <span class="mw-page-count" data-mw-page-count="${team.key}"></span>
                </header>
                <p class="mw-page-hint">${team.hint}</p>
                <div class="mw-page-list" data-mw-list="${team.key}"></div>
            </section>`).join("");

        const teamButtons = TEAMS.map(team => `
            <button type="button" class="mw-team-btn mw-team-${team.key}" data-mw-open="${team.key}">
                <span class="mw-team-icon">${team.icon}</span>
                <span class="mw-team-name">${team.name}</span>
                <span class="mw-team-badge" data-mw-badge="${team.key}">${team.roles ? "0" : "•••"}</span>
            </button>`).join("");

        hub.innerHTML = `
            <button type="button" id="mwRoleOpen" class="mw-hub-open" aria-expanded="false">
                <span>⚙️ ROLE SETTINGS</span>
                <span class="mw-hub-chev" aria-hidden="true">▾</span>
            </button>
            <div class="mw-hub-body" id="mwHubBody" hidden>
                <div class="mw-summary" id="mwRoleSummary">
                    <div class="mw-chip"><span>👥 Players</span><b id="mwChipPlayers">0</b></div>
                    <div class="mw-chip"><span>🎭 Roles</span><b id="mwChipRoles">0</b></div>
                </div>
                <div class="mw-team-grid" id="mwTeamGrid">${teamButtons}</div>
                ${pageHtml}
            </div>`;

        TEAMS.forEach(team => {
            const page = hub.querySelector(`[data-page="${team.key}"]`);
            pages[team.key] = { page, list: page.querySelector("[data-mw-list]") };
        });

        const heading = hs.querySelector("h2");
        if (heading && heading.parentNode === hs) hs.insertBefore(hub, heading.nextSibling);
        else hs.insertBefore(hub, hs.firstChild);

        hs.classList.add("mw-hub-on");

        hub.addEventListener("click", event => {
            const openRoles = event.target.closest("#mwRoleOpen");
            if (openRoles) {
                setView(view === "closed" ? "hub" : "closed");
                return;
            }

            const team = event.target.closest("[data-mw-open]");
            if (team) {
                setView(team.dataset.mwOpen);
                return;
            }

            if (event.target.closest("[data-mw-back]")) setView("hub");
        });

        return true;
    }

    function setView(next) {
        view = next;

        const open = view !== "closed";
        const body = byId("mwHubBody");
        const button = byId("mwRoleOpen");

        if (body) body.hidden = !open;
        if (button) {
            button.setAttribute("aria-expanded", open ? "true" : "false");
            button.classList.toggle("is-open", open);
        }

        const grid = byId("mwTeamGrid");
        const summary = byId("mwRoleSummary");
        const onHub = view === "hub";

        if (grid) grid.hidden = !onHub;
        if (summary) summary.hidden = !open;

        TEAMS.forEach(team => {
            if (pages[team.key]) pages[team.key].page.hidden = view !== team.key;
        });

        refresh();
    }

    /* The old flat list lives in #hostSettings. Move each piece into its team page.
       Nothing is cloned: the same <input> elements move, so every id and listener still works. */
    function roleNode(id) {
        const input = byId(id);
        if (!input) return null;
        return id === "grandmaCount" ? input.closest(".grandma-setting") : input.closest("label");
    }

    function tidyDetailsButton(node) {
        if (!node || !node.querySelector) return;

        const details = node.querySelector(".mwx-details-btn");
        const wrap = node.querySelector(".mw-stepper");

        // The Details button sits next to the role name, the +/- stays on the right.
        if (details && wrap && wrap.contains(details)) node.insertBefore(details, wrap);
    }

    function sortSettings() {
        const hs = byId("hostSettings");
        if (!hs || !hub) return;

        TEAMS.forEach(team => {
            (team.roles || []).forEach(id => {
                const node = roleNode(id);
                if (!node) return;

                const target = pages[team.key].list;
                if (node.parentNode !== target) target.appendChild(node);

                tidyDetailsButton(node);
            });
        });

        // Civilians (automatic, read only) go in the summary strip.
        const civilians = byId("civilianCount");
        const civilianLabel = civilians ? civilians.closest("label") : null;
        const summary = byId("mwRoleSummary");

        if (civilianLabel && summary && civilianLabel.parentNode !== summary) {
            civilianLabel.classList.add("mw-chip", "mw-chip-civ");
            summary.appendChild(civilianLabel);
        }

        const start = byId("startGame");

        Array.from(hs.children).forEach(child => {
            if (child === hub || child === start || child.tagName === "H2") return;

            if (child.classList.contains("role-group")) {
                child.classList.add("mw-gone");
                return;
            }

            pages.other.list.appendChild(child);
        });

        if (start && hs.lastElementChild !== start) hs.appendChild(start);
    }

    function numberValue(id) {
        const input = byId(id);
        return input ? (Number(input.value) || 0) : 0;
    }

    function refresh() {
        let total = 0;

        TEAMS.forEach(team => {
            if (!team.roles) return;

            const count = team.roles.reduce((sum, id) => {
                const input = byId(id);
                if (!input || input.disabled) return sum;
                return sum + numberValue(id);
            }, 0);

            total += count;

            const badge = hub && hub.querySelector(`[data-mw-badge="${team.key}"]`);
            if (badge) {
                badge.textContent = String(count);
                badge.classList.toggle("is-zero", count === 0);
            }

            const pageCount = hub && hub.querySelector(`[data-mw-page-count="${team.key}"]`);
            if (pageCount) pageCount.textContent = count === 1 ? "1 selected" : `${count} selected`;
        });

        const players = byId("mwChipPlayers");
        const roles = byId("mwChipRoles");
        const playerCount = byId("rolePlayerCount");

        if (players) players.textContent = playerCount ? playerCount.textContent : "0";
        if (roles) roles.textContent = String(total);
    }

    function tickHub() {
        if (!build()) return;
        if (!started) {
            started = true;
            setView("closed");
        }
        sortSettings();
        refresh();
    }

    const settingsEl = byId("hostSettings");

    if (settingsEl) {
        // Other parts of the game add boxes to the host settings later (voice, detective, soundboard).
        try {
            new MutationObserver(() => { if (hub) sortSettings(); })
                .observe(settingsEl, { childList: true });
        } catch (e) { /* ignore */ }

        document.addEventListener("input", event => {
            if (event.target && event.target.closest && event.target.closest("#hostSettings")) refresh();
        });
        document.addEventListener("change", event => {
            if (event.target && event.target.closest && event.target.closest("#hostSettings")) refresh();
        });
        document.addEventListener("click", event => {
            if (event.target && event.target.closest && event.target.closest("#hostSettings .mw-step-btn")) {
                setTimeout(refresh, 30);
            }
        });
    }

    tickHub();
    setInterval(tickHub, 900);

    ["playerJoined", "gameInformation", "gameRestarted", "roomCreated", "joinedRoom"].forEach(name => {
        socket.on(name, () => setTimeout(tickHub, 60));
    });

    // New game in the same room: start with the hub closed again.
    socket.on("gameRestarted", () => setTimeout(() => setView("closed"), 80));

    /* ---------------------------------------------------------
       2. FRIENDS + ROLES buttons inside the Voice Chat box and the Music box
    --------------------------------------------------------- */
    function dockButton(kind) {
        return Array.from(document.querySelectorAll(".mwx-dock .mwx-fab"))
            .find(button => button.textContent.indexOf(kind) !== -1) || null;
    }

    function makeLinkButton(kind, className) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = className + " mw-link-btn";
        button.dataset.mwLink = kind;
        button.innerHTML = kind === "Friends"
            ? `👥 FRIENDS<span class="mw-link-dot" hidden>0</span>`
            : `📖 ROLES`;

        button.addEventListener("click", () => {
            const source = dockButton(kind);
            if (source) source.click();
        });

        return button;
    }

    function installLinkButtons() {
        const voice = byId("voiceChatPanel");
        const controls = voice ? voice.querySelector(".voice-controls") : null;

        if (controls && !controls.querySelector("[data-mw-link]")) {
            controls.append(
                makeLinkButton("Friends", "voice-control-button"),
                makeLinkButton("Roles", "voice-control-button")
            );
        }

        const music = byId("musicControl");

        if (music && !music.querySelector(".mw-music-links")) {
            const row = document.createElement("div");
            row.className = "mw-music-links";
            row.append(
                makeLinkButton("Friends", "mw-music-link"),
                makeLinkButton("Roles", "mw-music-link")
            );
            music.appendChild(row);
        }
    }

    function shown(id) {
        const el = byId(id);
        return Boolean(el) && el.style.display !== "none" && getComputedStyle(el).display !== "none";
    }

    function syncLinkButtons() {
        installLinkButtons();

        // Same rule as before: Friends / Roles are for the home and lobby screens, not in a match or on sign in.
        document.body.classList.toggle(
            "mw-hide-links",
            shown("gameScreen") || shown("authScreen") || shown("loginScreen")
        );

        const sourceDot = byId("mwxFriendDot");
        const count = sourceDot ? sourceDot.textContent : "0";
        const showDot = Boolean(sourceDot) && sourceDot.style.display !== "none" && count !== "0" && count !== "";

        document.querySelectorAll(".mw-link-dot").forEach(dot => {
            dot.textContent = count;
            dot.hidden = !showDot;
        });
    }

    setInterval(syncLinkButtons, 700);
    syncLinkButtons();

    /* ---------------------------------------------------------
       3. DEAD PLAYERS: the death picture is the background, the game and chat stay visible
    --------------------------------------------------------- */
    function ensureDeadBanner() {
        let banner = byId("mwDeadBanner");
        if (banner) return banner;

        banner = document.createElement("div");
        banner.id = "mwDeadBanner";
        banner.textContent = "☠️ YOU ARE DEAD";
        document.body.appendChild(banner);
        return banner;
    }

    function syncDeadMode() {
        const overlay = byId("deathRevealOverlay");
        const dead = Boolean(overlay) && overlay.style.display !== "none" && overlay.style.display !== "";

        document.body.classList.toggle("mw-dead", dead);

        if (dead) ensureDeadBanner();

        placeDeadChat(dead);
    }

    /* Dead players: the Dead Chat sits where the Action box was (same box, same buttons, just moved). */
    function placeDeadChat(dead) {
        const box = document.querySelector(".mwx-dead");
        const center = document.querySelector("#gameScreen .center-game-column");
        if (!box || !center) return;

        if (dead) {
            if (box.parentNode !== center) center.insertBefore(box, center.firstChild);
            box.classList.add("mw-dead-inline");
        } else if (box.parentNode !== document.body) {
            document.body.appendChild(box);
            box.classList.remove("mw-dead-inline");
        }
    }

    setInterval(syncDeadMode, 400);
    syncDeadMode();
})();


/* =========================================================
   MAFIA WARS - MVP SYSTEM, TEAM LOADING SCREENS, STATISTICS PROFILE
   All screens are created by this code. Styles are at the end
   of style.css (search for "MVP / LOADING / PROFILE").
========================================================= */
(function () {
    "use strict";

    const MAFIA_ROLES = ["Mafia", "Godfather", "Grandmafia", "Baby Mafia", "Framer"];
    const NEUTRAL_ROLES = ["Jester", "Executioner", "Amnesiac"];
    const TEAM_LABEL = { mafia: "Mafia", civilian: "Civilian", neutral: "Neutral" };

    function teamOf(role) {
        if (MAFIA_ROLES.includes(role)) return "mafia";
        if (NEUTRAL_ROLES.includes(role)) return "neutral";
        return "civilian";
    }

    function esc(value) {
        return String(value == null ? "" : value).replace(/[&<>"']/g, c => (
            { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]
        ));
    }

    function reducedMotion() {
        try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (_) { return false; }
    }

    /* Counts a number up from 0. */
    function animateCount(el, target, decimals, suffix) {
        if (!el) return;
        const end = Number(target) || 0;
        const text = v => (decimals ? v.toFixed(decimals) : String(Math.round(v))) + (suffix || "");

        if (reducedMotion() || end === 0) {
            el.textContent = text(end);
            return;
        }

        const duration = 900;
        const start = performance.now();
        const step = now => {
            const t = Math.min(1, (now - start) / duration);
            const eased = 1 - Math.pow(1 - t, 3);
            el.textContent = text(end * eased);
            if (t < 1) requestAnimationFrame(step);
            else el.textContent = text(end);
        };
        requestAnimationFrame(step);
    }

    function runCounters(root) {
        root.querySelectorAll("[data-count]").forEach(el => {
            animateCount(
                el,
                Number(el.dataset.count),
                Number(el.dataset.decimals) || 0,
                el.dataset.suffix || ""
            );
        });
    }

    /* =====================================================
       TEAM LOADING SCREENS
       Chosen on THIS player's device from THEIR OWN role.
       Nothing is sent to the server or to other players, every
       player sees a loading screen of the same length, and the
       screen only names the TEAM (never the role).
    ===================================================== */

    const LOADING_THEMES = {
        mafia:    { title: "MAFIA",      line: "The family gathers in the dark…",   icon: "🕴️" },
        civilian: { title: "CIVILIAN",   line: "Stay alert. Trust no one…",         icon: "🏙️" },
        neutral:  { title: "NEUTRAL",    line: "Your game is your own…",            icon: "🎭" },
        general:  { title: "MAFIA WARS", line: "Loading…",                          icon: "🎲" }
    };

    const TEAM_LOADING_MS = 2600;   // same for every player, so the length never gives anything away
    const FADE_MS = 450;

    let loadingTimer = null;
    let loadingHideTimer = null;
    let loadingDone = null;

    function ensureLoadingOverlay() {
        let overlay = document.getElementById("mwLoadingOverlay");
        if (overlay) return overlay;

        overlay = document.createElement("div");
        overlay.id = "mwLoadingOverlay";
        overlay.setAttribute("aria-hidden", "true");
        overlay.innerHTML = `
            <div class="mwl-glow"></div>
            <div class="mwl-lines"></div>
            <div class="mwl-center">
                <div class="mwl-icon" id="mwlIcon"></div>
                <div class="mwl-title" id="mwlTitle"></div>
                <div class="mwl-line" id="mwlLine"></div>
                <div class="mwl-bar"><div class="mwl-bar-fill" id="mwlBarFill"></div></div>
            </div>`;
        document.body.appendChild(overlay);
        return overlay;
    }

    function hideLoading() {
        const overlay = document.getElementById("mwLoadingOverlay");
        clearTimeout(loadingTimer);
        clearTimeout(loadingHideTimer);
        if (!overlay) return;

        overlay.classList.remove("on");
        loadingHideTimer = setTimeout(() => {
            overlay.style.display = "none";
            overlay.setAttribute("aria-hidden", "true");
        }, FADE_MS);
    }

    /* kind: "mafia" | "civilian" | "neutral" | "general" */
    function showLoading(kind, ms, done) {
        const theme = LOADING_THEMES[kind] || LOADING_THEMES.general;
        const overlay = ensureLoadingOverlay();

        clearTimeout(loadingTimer);
        clearTimeout(loadingHideTimer);
        if (loadingDone) { const previous = loadingDone; loadingDone = null; try { previous(true); } catch (_) { /* ignore */ } }

        overlay.className = "mwl-" + (LOADING_THEMES[kind] ? kind : "general");
        overlay.style.display = "flex";
        overlay.setAttribute("aria-hidden", "false");

        document.getElementById("mwlIcon").textContent = theme.icon;
        document.getElementById("mwlTitle").textContent = theme.title;
        document.getElementById("mwlLine").textContent = theme.line;

        const fill = document.getElementById("mwlBarFill");
        fill.style.transition = "none";
        fill.style.width = "0%";

        loadingDone = done || null;

        requestAnimationFrame(() => requestAnimationFrame(() => {
            overlay.classList.add("on");
            fill.style.transition = `width ${ms}ms linear`;
            fill.style.width = "100%";
        }));

        loadingTimer = setTimeout(() => {
            const finish = loadingDone;
            loadingDone = null;
            // Start the next screen while this one is still fully covering, then fade out.
            if (finish) { try { finish(false); } catch (error) { console.error(error); } }
            hideLoading();
        }, ms);
    }

    let teamLoadingPending = false;

    window.MWLoading = {
        /* Before the match: team screen from my own role, then runs `next`. */
        beforeMatch(next) {
            if (teamLoadingPending) return;
            teamLoadingPending = true;

            const kind = String(myRole || "").trim() ? teamOf(myRole) : "general";

            showLoading(kind, TEAM_LOADING_MS, cancelled => {
                teamLoadingPending = false;
                if (cancelled) return;
                // Don't start a match screen if the room already went back to the lobby / game ended.
                if (currentPhase === "lobby" || currentPhase === "gameover" || !currentPhase) return;
                if (typeof next === "function") next();
            });
        },
        general(ms) { showLoading("general", ms || 900); },
        hide: hideLoading,
        isPending() { return teamLoadingPending; }
    };

    /* Lobby + transitions. */
    ["roomCreated", "joinedRoom", "gameRestarted"].forEach(name => {
        socket.on(name, () => {
            if (!teamLoadingPending) showLoading("general", 900);
        });
    });

    /* =====================================================
       PLAYER OF THE MATCH
    ===================================================== */

    function ensureMvpOverlay() {
        let overlay = document.getElementById("mvpOverlay");
        if (overlay) return overlay;

        overlay = document.createElement("div");
        overlay.id = "mvpOverlay";
        overlay.style.display = "none";
        document.body.appendChild(overlay);
        return overlay;
    }

    function closeMvp() {
        const overlay = document.getElementById("mvpOverlay");
        if (!overlay) return;
        overlay.classList.remove("on");
        setTimeout(() => { overlay.style.display = "none"; overlay.innerHTML = ""; }, 350);
    }

    function showMvp(data) {
        if (!data) return;

        const overlay = ensureMvpOverlay();
        const isMe = Boolean(data.you);

        overlay.innerHTML = "";

        const card = document.createElement("div");
        card.className = "mvp-card mvp-team-" + (data.team || "civilian");

        const crown = document.createElement("div");
        crown.className = "mvp-crown";
        crown.textContent = "👑";

        const title = document.createElement("div");
        title.className = "mvp-title";
        title.textContent = "PLAYER OF THE MATCH";

        const avatarWrap = document.createElement("div");
        avatarWrap.className = "mvp-avatar";
        avatarWrap.appendChild(avatarNode(data.look, 96, false));

        const name = document.createElement("div");
        name.className = "mvp-name";
        setTierName(name, data.name, data.guest ? null : data.tier);
        if (!data.guest) appendUserBadge(name, data.badge);

        const chips = document.createElement("div");
        chips.className = "mvp-chips";
        chips.innerHTML = `
            <span class="mvp-badge">⭐ MVP${data.mvpCount ? " ×" + esc(data.mvpCount) : ""}</span>
            <span class="mvp-chip">${esc(data.role)}</span>
            <span class="mvp-chip mvp-chip-team">${esc(TEAM_LABEL[data.team] || "")} team</span>
            <span class="mvp-chip ${data.won ? "mvp-chip-win" : ""}">${data.won ? "🏆 Winner" : "Lost"}</span>
            <span class="mvp-chip">${data.alive ? "❤️ Survived" : "💀 Eliminated"}</span>`;

        const score = document.createElement("div");
        score.className = "mvp-score";
        score.innerHTML = `<strong data-count="${Number(data.score) || 0}">0</strong><span>MVP POINTS</span>`;

        const stats = document.createElement("div");
        stats.className = "mvp-stats";
        const st = data.stats || {};
        stats.innerHTML = [
            ["🔪", "Kills", st.kills],
            ["🛡️", "Saves", st.saves],
            ["🔎", "Detections", st.detects],
            ["🗳️", "Correct votes", st.votes]
        ].map(([icon, label, value]) =>
            `<div class="mvp-stat"><strong data-count="${Number(value) || 0}">0</strong><span>${icon} ${label}</span></div>`
        ).join("");

        const breakdown = document.createElement("ul");
        breakdown.className = "mvp-breakdown";
        breakdown.innerHTML = (data.breakdown || []).map(row =>
            `<li><span>${esc(row.label)}${row.count > 1 ? " ×" + esc(row.count) : ""}</span><b>+${esc(row.points)}</b></li>`
        ).join("");

        card.append(crown, title, avatarWrap, name, chips, score, stats, breakdown);

        if (Array.isArray(data.runnersUp) && data.runnersUp.length) {
            const runners = document.createElement("div");
            runners.className = "mvp-runners";
            runners.innerHTML = "<span>NEXT BEST</span>" + data.runnersUp.map((r, i) =>
                `<em>${i + 2}. ${esc(r.name)} · ${esc(r.score)}</em>`
            ).join("");
            card.appendChild(runners);
        }

        const award = document.createElement("div");
        award.className = "mvp-award";
        if (data.guest) {
            award.textContent = "Guests don't keep MVP awards. Sign up to save yours!";
            award.classList.add("mvp-award-guest");
        } else if (isMe) {
            award.textContent = `🎉 You are the MVP! +1 MVP Award saved to your account (total ${data.mvpCount}).`;
        } else {
            award.textContent = `+1 MVP Award saved to ${data.name}'s account.`;
        }
        card.appendChild(award);

        const buttons = document.createElement("div");
        buttons.className = "mvp-buttons";

        if (!data.guest && data.playerId) {
            const view = document.createElement("button");
            view.type = "button";
            view.textContent = "📊 VIEW PROFILE";
            view.addEventListener("click", () => openFullProfile(null, data.playerId));
            buttons.appendChild(view);
        }

        const next = document.createElement("button");
        next.type = "button";
        next.className = "mvp-continue";
        next.textContent = "CONTINUE";
        next.addEventListener("click", closeMvp);
        buttons.appendChild(next);

        card.appendChild(buttons);
        overlay.appendChild(card);

        hydrateAvatars(overlay);
        overlay.style.display = "flex";
        requestAnimationFrame(() => requestAnimationFrame(() => {
            overlay.classList.add("on");
            runCounters(card);
        }));
    }

    /* The victory screen is shown first, then the MVP announcement. */
    socket.on("mvpResult", data => {
        setTimeout(() => {
            if (currentPhase === "gameover") showMvp(data);
        }, 3200);
    });

    // Never keep an old announcement on screen into the next game.
    socket.on("gameRestarted", closeMvp);

    /* =====================================================
       STATISTICS PROFILE (public: click a username)
    ===================================================== */

    function ensureProfileOverlay() {
        let overlay = document.getElementById("mwProfileOverlay");
        if (overlay) return overlay;

        overlay = document.createElement("div");
        overlay.id = "mwProfileOverlay";
        overlay.style.display = "none";
        overlay.addEventListener("click", event => {
            if (event.target === overlay) closeFullProfile();
        });
        document.body.appendChild(overlay);
        return overlay;
    }

    function closeFullProfile() {
        const overlay = document.getElementById("mwProfileOverlay");
        if (overlay) overlay.style.display = "none";
    }

    document.addEventListener("keydown", event => {
        if (event.key === "Escape") closeFullProfile();
    });

    /* Either a username (ranks / my account) or a playerId (someone in your room). */
    function openFullProfile(username, playerId) {
        if (!username && !playerId) return;

        const overlay = ensureProfileOverlay();
        overlay.innerHTML = `<div class="mwp-card"><div class="mwp-loading">Loading profile…</div></div>`;
        overlay.style.display = "flex";

        socket.emit("getFullProfile", playerId ? { playerId: String(playerId) } : { username: String(username) });
    }

    window.openFullProfile = openFullProfile;

    function statCell(icon, label, value, opts) {
        opts = opts || {};
        const isNumber = typeof value === "number";
        const inner = isNumber
            ? `<strong data-count="${value}" data-decimals="${opts.decimals || 0}" data-suffix="${esc(opts.suffix || "")}">0</strong>`
            : `<strong class="mwp-text">${esc(value)}</strong>`;
        return `<div class="mwp-stat"><span>${icon} ${esc(label)}</span>${inner}</div>`;
    }

    function renderFullProfile(data) {
        const overlay = ensureProfileOverlay();
        if (overlay.style.display === "none") return;

        overlay.innerHTML = "";

        const card = document.createElement("div");
        card.className = "mwp-card";

        const close = document.createElement("button");
        close.type = "button";
        close.className = "mwp-close";
        close.textContent = "✕";
        close.setAttribute("aria-label", "Close");
        close.addEventListener("click", closeFullProfile);
        card.appendChild(close);

        if (!data || !data.ok) {
            const message = document.createElement("div");
            message.className = "mwp-loading";
            message.textContent = "This profile could not be found.";
            card.appendChild(message);
            overlay.appendChild(card);
            return;
        }

        const t = data.totals || {};

        /* ----- header ----- */
        const head = document.createElement("div");
        head.className = "mwp-head";

        const avatar = document.createElement("div");
        avatar.className = "mwp-avatar";
        avatar.appendChild(avatarNode(data.look, 70, false));

        const who = document.createElement("div");
        who.className = "mwp-who";

        const name = document.createElement("div");
        name.className = "mwp-name";
        setTierName(name, data.displayName || data.username, data.tier);
        appendUserBadge(name, data.badge);

        const tags = document.createElement("div");
        tags.className = "mwp-tags";
        tags.innerHTML = `<span>⭐ LEVEL ${esc(data.level)}</span><span>🏆 ${esc(data.rankPoints)} rank pts</span>` +
            (t.mvps ? `<span class="mwp-mvp">👑 MVP ×${esc(t.mvps)}</span>` : "");

        who.append(name, tags);
        head.append(avatar, who);
        card.appendChild(head);

        /* ----- level bar ----- */
        const level = document.createElement("div");
        level.className = "mwp-level";
        const pct = data.xpNeeded ? Math.min(100, Math.round(data.xpIntoLevel / data.xpNeeded * 100)) : 100;
        level.innerHTML = `
            <div class="mwp-level-top"><strong>LEVEL ${esc(data.level)}</strong><span>${data.xpNeeded ? esc(data.xpIntoLevel) + " / " + esc(data.xpNeeded) + " XP" : "MAX LEVEL"}</span></div>
            <div class="mwp-bar"><div class="mwp-bar-fill" style="width:0%" data-width="${pct}"></div></div>`;
        card.appendChild(level);

        /* ----- main statistics ----- */
        const grid = document.createElement("div");
        grid.className = "mwp-grid";
        grid.innerHTML = [
            statCell("🎮", "Total Games", t.games || 0),
            statCell("🏆", "Total Wins", t.wins || 0),
            statCell("📈", "Win Rate", Number(t.winRate) || 0, { decimals: 1, suffix: "%" }),
            statCell("🔪", "Total Kills", t.kills || 0),
            statCell("🛡️", "Total Saves", t.saves || 0),
            statCell("🔎", "Total Detections", t.detects || 0),
            statCell("🎭", "Favourite Role", t.favouriteRole || "—"),
            statCell("🔥", "Highest Win Streak", t.bestStreak || 0),
            statCell("👑", "MVP Awards", t.mvps || 0)
        ].join("");
        card.appendChild(grid);

        /* ----- per team ----- */
        const teamsTitle = document.createElement("div");
        teamsTitle.className = "mwp-section";
        teamsTitle.textContent = "TEAM STATISTICS";
        card.appendChild(teamsTitle);

        const teams = document.createElement("div");
        teams.className = "mwp-teams";
        (data.teams || []).forEach(team => {
            const box = document.createElement("div");
            box.className = "mwp-team mwp-team-" + team.team;
            box.innerHTML = `
                <strong>${esc(TEAM_LABEL[team.team])}</strong>
                <div><span>Games</span><b>${esc(team.games)}</b></div>
                <div><span>Wins</span><b>${esc(team.wins)}</b></div>
                <div><span>Win rate</span><b>${esc(team.winRate)}%</b></div>
                <div><span>Kills</span><b>${esc(team.kills)}</b></div>
                <div><span>Saves</span><b>${esc(team.saves)}</b></div>
                <div><span>Detections</span><b>${esc(team.detects)}</b></div>`;
            teams.appendChild(box);
        });
        card.appendChild(teams);

        /* ----- role performance ----- */
        if (Array.isArray(data.roles) && data.roles.length) {
            const rolesTitle = document.createElement("div");
            rolesTitle.className = "mwp-section";
            rolesTitle.textContent = "ROLE PERFORMANCE";
            card.appendChild(rolesTitle);

            const roles = document.createElement("div");
            roles.className = "mwp-roles";
            roles.innerHTML = data.roles.map(r =>
                `<div class="mwp-role"><strong>${esc(r.role)}</strong><span>${esc(r.games)} game${r.games === 1 ? "" : "s"} · ${esc(r.winRate)}% wins${r.mvps ? " · 👑 " + esc(r.mvps) : ""}</span></div>`
            ).join("");
            card.appendChild(roles);
        }

        /* ----- achievements ----- */
        const achTitle = document.createElement("div");
        achTitle.className = "mwp-section";
        const unlocked = (data.achievements || []).filter(a => a.unlocked).length;
        achTitle.textContent = `ACHIEVEMENTS (${unlocked}/${(data.achievements || []).length})`;
        card.appendChild(achTitle);

        const ach = document.createElement("div");
        ach.className = "mwp-ach";
        ach.innerHTML = (data.achievements || []).map(a =>
            `<div class="mwp-badge ${a.unlocked ? "on" : "off"}" title="${esc(a.desc)}"><i>${a.unlocked ? esc(a.icon) : "🔒"}</i><span>${esc(a.name)}</span><small>${esc(a.desc)}</small></div>`
        ).join("");
        card.appendChild(ach);

        /* ----- match history ----- */
        const histTitle = document.createElement("div");
        histTitle.className = "mwp-section";
        histTitle.textContent = "MATCH HISTORY";
        card.appendChild(histTitle);

        const hist = document.createElement("div");
        hist.className = "mwp-history";
        if (!data.history || !data.history.length) {
            hist.innerHTML = `<div class="mwp-empty">No completed matches yet.</div>`;
        } else {
            hist.innerHTML = data.history.map(m => {
                let when = "";
                try { when = new Date(m.t).toLocaleDateString([], { month: "short", day: "numeric" }); } catch (_) { /* ignore */ }
                return `<div class="mwp-match ${m.won ? "won" : "lost"}">
                    <b>${m.won ? "WIN" : "LOSS"}</b>
                    <span>${esc(m.role)} · ${esc(TEAM_LABEL[m.team] || "")}${m.mvp ? " · 👑 MVP" : ""}</span>
                    <em>${esc(m.kills)}🔪 ${esc(m.saves)}🛡️ ${esc(m.detects)}🔎</em>
                    <small>${esc(when)}</small>
                </div>`;
            }).join("");
        }
        card.appendChild(hist);

        if (data.memberSince) {
            const since = document.createElement("div");
            since.className = "mwp-since";
            try {
                since.textContent = "Member since " + new Date(data.memberSince).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
                card.appendChild(since);
            } catch (_) { /* ignore */ }
        }

        overlay.appendChild(card);
        hydrateAvatars(overlay);

        requestAnimationFrame(() => requestAnimationFrame(() => {
            runCounters(card);
            card.querySelectorAll(".mwp-bar-fill").forEach(el => { el.style.width = el.dataset.width + "%"; });
        }));
    }

    socket.on("fullProfileData", renderFullProfile);

    /* =====================================================
       ENTRY POINTS
       - Account menu: MY STATISTICS button
       - Ranks list: click a username
       - Ranks DETAILS popup: FULL PROFILE button
       - Player card in the room: FULL PROFILE button
    ===================================================== */

    function addAccountStatsButton() {
        if (document.getElementById("accountStatsButton")) return;
        const logout = document.getElementById("accountLogoutButton");
        if (!logout || !logout.parentElement) return;

        const button = document.createElement("button");
        button.id = "accountStatsButton";
        button.className = "account-stats-button";
        button.type = "button";
        button.textContent = "📊 MY STATISTICS";
        button.addEventListener("click", () => {
            if (authState && authState.username) openFullProfile(authState.username);
        });
        logout.parentElement.insertBefore(button, logout);
    }

    function addRanksProfileButton() {
        const card = document.querySelector("#ranksDetailsOverlay .ranks-details-card");
        const close = document.getElementById("closeRanksDetails");
        if (!card || !close || document.getElementById("ranksFullProfileButton")) return;

        const button = document.createElement("button");
        button.id = "ranksFullProfileButton";
        button.className = "secondary-screen-button";
        button.type = "button";
        button.textContent = "📊 FULL PROFILE";
        button.addEventListener("click", () => {
            if (button.dataset.username) openFullProfile(button.dataset.username);
        });
        card.insertBefore(button, close);
    }

    /* The ranks DETAILS popup learns whose stats it shows from the last "Details" click. */
    socket.on("playerStatsData", data => {
        if (!data || !data.ok) return;
        addRanksProfileButton();
        const button = document.getElementById("ranksFullProfileButton");
        if (button) button.dataset.username = data.username;
    });

    /* Rank names become clickable (rows are rebuilt on every search, so watch the list). */
    function makeRankNamesClickable() {
        document.querySelectorAll(".rank-row:not([data-mwp]), #ranksList > div:not([data-mwp])").forEach(row => {
            const details = row.querySelector(".rank-details-button");
            const name = row.querySelector(".rank-name");
            if (!details || !name) return;
            row.dataset.mwp = "1";
            name.classList.add("mwp-clickable");
            name.title = "Open profile";
            name.addEventListener("click", () => details.click());
        });
    }

    /* The existing room player card gets a FULL PROFILE button. */
    function decorateAccountCard() {
        const card = document.querySelector("#accountCardOverlay .ac-card");
        if (!card || card.querySelector(".ac-full-profile") || !card.querySelector(".ac-grid")) return;

        const button = document.createElement("button");
        button.type = "button";
        button.className = "ac-full-profile";
        button.textContent = "📊 FULL PROFILE";
        button.addEventListener("click", () => {
            const playerId = card.dataset.mwPlayerId;
            if (playerId) openFullProfile(null, playerId);
        });
        card.appendChild(button);
    }

    /* accountCardData has no login name (on purpose), so the profile is requested by room player id. */
    socket.on("accountCardData", data => {
        setTimeout(() => {
            const card = document.querySelector("#accountCardOverlay .ac-card");
            if (!card || !data || !data.ok || data.guest) return;

            card.dataset.mwPlayerId = data.playerId;

            if (data.mvps) {
                const tags = card.querySelector(".ac-tags");
                if (tags && !tags.querySelector(".ac-tag-mvp")) {
                    const tag = document.createElement("span");
                    tag.className = "ac-tag ac-tag-mvp";
                    tag.textContent = "👑 MVP ×" + data.mvps;
                    tags.appendChild(tag);
                }
            }

            decorateAccountCard();
        }, 30);
    });

    function boot() {
        addAccountStatsButton();
        addRanksProfileButton();
        makeRankNamesClickable();
        setInterval(() => {
            addAccountStatsButton();
            makeRankNamesClickable();
        }, 800);
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
})();
