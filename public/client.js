const socket = io();

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

    announcement(
        data.message || "",
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
        mafia: mobile ? "/mafia-role-mobile.png" : "/mafia-role-laptop.png",
        doctor: mobile ? "/doctor-role-mobile.png" : "/doctor-role-laptop.png",
        detective: mobile ? "/detective-role-mobile.png" : "/detective-role-laptop.png",
        cupid: mobile ? "/cupid-role-mobile.png" : "/cupid-role-laptop.png",
        godfather: "/godfather.png",
        grandmafia: "/grandmafia.png",
        grandma: "/grandma.png",
        jester: "/jester.png",
        civilian: "/civilian.png",
        babymafia: mobile ? "/mafia-role-mobile.png" : "/mafia-role-laptop.png"
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

function updateNightTurnOverlay(turn, endsAt) {
    currentNightTurn = turn || "";
    currentNightTurnEndsAt = endsAt || null;

    if (nightTurnTimerInterval) {
        clearInterval(nightTurnTimerInterval);
        nightTurnTimerInterval = null;
    }

    const overlay = ensureNightTurnOverlay();
    const card = overlay?.querySelector(".night-turn-card");
    const photo = $("nightTurnPhoto");
    const title = $("nightTurnTitle");
    const subtitle = $("nightTurnSubtitle");
    const timer = $("nightTurnTimer");

    // The player whose role is currently active gets the private action UI.
    // Everyone else gets the full-screen public turn announcement.
    if (isMyActiveNightTurn(turn)) {
        overlay.style.display = "none";
        if (card) card.className = "night-turn-card";
        return;
    }

    const roleData = {
        mafia: {
            title: "MAFIA TURN",
            subtitle: "MAFIA IS MAKING A DECISION",
            image: "/mafia-turn-public.png"
        },
        doctor: {
            title: "DOCTOR TURN",
            subtitle: "DOCTOR IS MAKING A DECISION",
            image: "/doctor-turn-public.png"
        },
        detective: {
            title: "DETECTIVE TURN",
            subtitle: "DETECTIVE IS MAKING A DECISION",
            image: "/detective-turn-public.png"
        },
        cupid: {
            title: "CUPID TURN",
            subtitle: "CUPID IS MAKING A DECISION",
            image: "/cupid-turn-public.png"
        }
    };

    const info = roleData[turn];

    if (!info || currentPhase !== "night" || !endsAt) {
        overlay.style.display = "none";
        if (card) card.className = "night-turn-card";
        return;
    }

    if (card) {
        card.className = "night-turn-card night-turn-public-role";
        card.dataset.turn = turn;
    }

    // Clear the previous image first. This prevents Doctor/Detective/Cupid
    // from briefly showing the previous Mafia image while the new image loads.
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

    const tick = () => {
        const remaining = Math.max(
            0,
            Number(currentNightTurnEndsAt) - Date.now()
        );
        const totalSeconds = Math.ceil(remaining / 1000);
        const seconds = Math.min(30, totalSeconds);

        if (timer) {
            timer.textContent = `00:${String(seconds).padStart(2, "0")}`;
            timer.classList.toggle("night-turn-timer-warning", seconds <= 10);
        }

        if (remaining <= 0 && nightTurnTimerInterval) {
            clearInterval(nightTurnTimerInterval);
            nightTurnTimerInterval = null;
        }
    };

    tick();
    nightTurnTimerInterval = setInterval(tick, 100);
}

function hideNightTurnOverlay() {
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
        "Mafia": isMobileOrTablet() ? "mafia-role-mobile.png" : "mafia-role-laptop.png",
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

        if ($("actionMessage")) {

            $("actionMessage").textContent =
                "💕 Clupids linked: " +
                message;
        }
    }
);

/* =========================================================
   DETECTIVE
========================================================= */

socket.on(
    "detectiveResult",
    data => {

        // The Detective result is private and must remain visible
        // even when the next public night-turn overlay (Cupid, etc.) starts.
        let popup = $("detectiveResultPopup");

        if (!popup) {
            popup = document.createElement("div");
            popup.id = "detectiveResultPopup";
            popup.innerHTML = `
                <div class="detective-result-card">
                    <div class="detective-result-title">🔎 INVESTIGATION RESULT</div>
                    <div class="detective-result-player" id="detectiveResultPlayer"></div>
                    <div class="detective-result-answer" id="detectiveResultAnswer"></div>
                </div>
            `;
            document.body.appendChild(popup);
        }

        const playerBox = $("detectiveResultPlayer");
        const answerBox = $("detectiveResultAnswer");

        if (playerBox) {
            playerBox.textContent = data?.playerName || "Unknown player";
        }

        if (answerBox) {
            answerBox.textContent = data?.result || "UNKNOWN";
            answerBox.className =
                "detective-result-answer " +
                (data?.result === "MAFIA"
                    ? "detective-result-mafia"
                    : "detective-result-not-mafia");
        }

        popup.style.display = "flex";

        // Keep the result visible while the next night turn runs,
        // then hide it automatically.
        clearTimeout(window.detectiveResultPopupTimer);
        window.detectiveResultPopupTimer = setTimeout(() => {
            if (popup) popup.style.display = "none";
        }, 5000);

        if ($("actionMessage")) {
            $("actionMessage").textContent =
                `🔎 ${data.playerName}: ${data.result}`;
        }
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

    return overlay;
}

function showDeathRevealOverlay(names) {
    if (!Array.isArray(names) || !names.length) return;
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

function hideDeathRevealOverlay() {
    const overlay = $("deathRevealOverlay");
    if (overlay) overlay.style.display = "none";
}

/* =========================================================
   PRIVATE DEATH REVEAL
   Only the socket of an eliminated player receives this event.
========================================================= */

socket.on(
    "deathReveal",
    data => {

        const names =
            Array.isArray(data?.names)
                ? data.names
                : [];

        if (names.length) {
            showDeathRevealOverlay(names);
        }
    }
);

/* =========================================================
   MORNING RESULT
========================================================= */

socket.on(
    "morningResult",
    data => {

        const names =
            data.eliminatedPlayers || [];

        /*
           Death screens are private.
           The server sends "deathReveal" only to players who died.
           This public morning event must never open the death screen
           for everyone in the room.
        */

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

        // A dead player's private death screen must never remain
        // visible when the game reaches the winner screen.
        hideDeathRevealOverlay();

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
        hideDeathRevealOverlay();

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
        hideDeathRevealOverlay();

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