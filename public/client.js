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
    turnOver: new Audio("/sounds/turn-over.mp3")
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
   player hear all five sounds at once.
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
        "homeScreen",
        "createRoomScreen",
        "joinRoomScreen",
        "lobby",
        "gameScreen"
    ].forEach(id => hide(id));

    show(screen);
}

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

    /* Sound #3 — a new night/round starts */
    if (/Night\s+\d+\s+has begun/i.test(message) || /Night\s+1\s+begins/i.test(message)) {
        playGameSound(gameSounds.newRound);
    }

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

        const screen =
            document.createElement("section");

        screen.id = "createRoomScreen";

        screen.style.display = "none";

        screen.innerHTML = `
            <div class="home-container">

                <div class="logo-icon">🏠</div>

                <h1>Create Room</h1>

                <p>Enter your name to create a room</p>

                <input
                    id="createPlayerName"
                    type="text"
                    maxlength="30"
                    placeholder="Enter your name"
                    autocomplete="off"
                >

                <button id="confirmCreateRoom">
                    🏠 CREATE ROOM
                </button>

                <button id="backFromCreate">
                    ← BACK
                </button>

            </div>
        `;

        document.body.appendChild(screen);
    }

    if (!$("joinRoomScreen")) {

        const screen =
            document.createElement("section");

        screen.id = "joinRoomScreen";

        screen.style.display = "none";

        screen.innerHTML = `
            <div class="home-container">

                <div class="logo-icon">🚪</div>

                <h1>Join Room</h1>

                <p>Enter your name and room code</p>

                <input
                    id="joinPlayerName"
                    type="text"
                    maxlength="30"
                    placeholder="Enter your name"
                    autocomplete="off"
                >

                <input
                    id="joinRoomCode"
                    type="text"
                    maxlength="10"
                    placeholder="Enter room code"
                    autocomplete="off"
                >

                <button id="confirmJoinRoom">
                    🚪 JOIN ROOM
                </button>

                <button id="backFromJoin">
                    ← BACK
                </button>

            </div>
        `;

        document.body.appendChild(screen);
    }

    $("confirmCreateRoom")?.addEventListener(
        "click",
        createRoom
    );

    $("createPlayerName")?.addEventListener(
        "keydown",
        e => {

            if (e.key === "Enter") {
                createRoom();
            }
        }
    );

    $("confirmJoinRoom")?.addEventListener(
        "click",
        joinRoom
    );

    $("joinPlayerName")?.addEventListener(
        "keydown",
        e => {

            if (e.key === "Enter") {
                $("joinRoomCode")?.focus();
            }
        }
    );

    $("joinRoomCode")?.addEventListener(
        "keydown",
        e => {

            if (e.key === "Enter") {
                joinRoom();
            }
        }
    );

    $("backFromCreate")?.addEventListener(
        "click",
        () => setScreen("homeScreen")
    );

    $("backFromJoin")?.addEventListener(
        "click",
        () => setScreen("homeScreen")
    );
}

/* =========================================================
   CREATE ROOM
========================================================= */

function createRoom() {

    const input =
        $("createPlayerName");

    if (!input) return;

    const name =
        input.value.trim();

    if (!name) {

        alert("Enter your name!");

        input.focus();

        return;
    }

    socket.emit(
        "createRoom",
        name
    );
}

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

    players.forEach(player => {

        const li =
            document.createElement("li");

        li.className =
            "lobby-player";

        const name =
            document.createElement("span");

        name.textContent =
            player.name;

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
}

/* =========================================================
   ROOM CREATED
========================================================= */

socket.on("roomCreated", code => {

    roomCode = code;

    isHost = true;

    window.currentHostId =
        socket.id;

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

    isHost = false;

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
    }

    isHost =
        socket.id ===
        window.currentHostId;

    updateHostUI();
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

            socket.emit(
                "startGame",
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

    if (turn === "mafia") {
        return isMafiaTeamClient(myRole);
    }
    if (turn === "doctor") {
        return myRole === "Doctor";
    }
    if (turn === "detective") {
        return myRole === "Detective";
    }
    if (turn === "cupid") {
        return myRole === "Clupid" || myRole === "Cupid";
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

    if (!info || currentPhase !== "night" || !endsAt) {
        stopLast10Sound();
        overlay.style.display = "none";
        return;
    }

    /* The active role gets the private action UI.
       Other players see the public turn overlay. */
    if (isMyActiveNightTurn(turn)) {
        overlay.style.display = "none";
    } else {
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
        "Clupid": getRoleImage("cupid"),
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

            if (
                newNightNumber !== currentNightNumber
            ) {
                currentNightNumber = newNightNumber;
                detectiveResultMessage = "";
                hideDetectiveResultPopup();
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
       CLUPID
    ===================================================== */

    if (
        myRole === "Clupid" &&
        data.nightNumber === 1 &&
        !data.clupidUsed
    ) {

        show("loverPanel");
        show("loverButton");

        fillClupidSelect(
            "lover1",
            data.clupidTargets || []
        );

        fillClupidSelect(
            "lover2",
            data.clupidTargets || []
        );

    } else {

        hide("loverPanel");
        hide("loverButton");
    }
}

/* =========================================================
   CLUPID SELECT
========================================================= */

function fillClupidSelect(
    id,
    targets
) {

    const select =
        $(id);

    if (!select) return;

    select.innerHTML =
        `<option value="">-- Select Clupid --</option>`;

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
   CLUPID BUTTON
========================================================= */

function setupClupid() {

    $("loverButton")
        ?.addEventListener(
            "click",
            () => {

                const clupid1 =
                    $("lover1")?.value;

                const clupid2 =
                    $("lover2")?.value;

                if (!clupid1 || !clupid2) {

                    alert(
                        "Choose both clupids!"
                    );

                    return;
                }

                if (
                    clupid1 === clupid2
                ) {

                    alert(
                        "Choose two different players!"
                    );

                    return;
                }

                stopLast10Sound();
                socket.emit(
                    "clupidChoose",
                    {
                        roomCode,
                        clupid1,
                        clupid2
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
            (currentNightTurn === "cupid" && (myRole === "Clupid" || myRole === "Cupid"))
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
   CLUPID
========================================================= */

socket.on(
    "clupidConfirmed",
    message => {

        stopLast10Sound();
        if ($("actionMessage")) {

            $("actionMessage").textContent =
                "💕 Clupids linked: " +
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
        hideNightTurnOverlay();
        deathScreenLocked = false;
        hideDeathRevealOverlay(true);
        hideDetectiveResultPopup();

        showGameOverMenu(
            data.winner,
            data.message
        );
    }
);
/* =========================================================
   GAME OVER
========================================================= */
function showGameOverMenu(winner, message) {

    const overlay = $("gameOverOverlay");
    const messageBox = $("gameOverMessage");
    const winnerLogo = $("winnerLogo");

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

        setupClupid();

        setupPublicChat();

        setupMafiaChat();

        setupRestartButton();
        
        setupBackHomeGameOver();

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