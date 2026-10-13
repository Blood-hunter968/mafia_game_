const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    // Room for custom wallpaper / sound uploads (max 4 MB file + overhead).
    maxHttpBufferSize: 6 * 1024 * 1024
});

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
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");

try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch (error) { console.error("Could not create uploads folder:", error); }

/* Custom sounds / wallpapers uploaded by players (random, unguessable file names). */
app.use("/uploads", express.static(UPLOADS_DIR, {
    index: false,
    dotfiles: "deny",
    setHeaders: res => {
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Cache-Control", "public, max-age=86400");
    }
}));

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
    awardXp(user, stat);
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
            tier: getEquippedTierKey(user),
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
            tier: user.tier,
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
   PROGRESSION: RANK TIERS, LEVELS / XP, INVENTORY
   - Rank tier comes ONLY from points (150 / 200 / 300 / 400 / 500).
   - Levels use their own XP and are separate from points.
   - 600 pts unlocks custom sounds, 1000 pts unlocks custom wallpapers.
   - Everything is checked on the server; the browser cannot fake it.
========================================================= */

const TIERS = [
    { key: "red",     min: 150 },
    { key: "gold",    min: 200 },
    { key: "diamond", min: 300 },
    { key: "elite",   min: 400 },
    { key: "legend",  min: 500 }
];

const SOUND_UNLOCK_POINTS = 0;      // no point requirement anymore
const WALLPAPER_UNLOCK_POINTS = 0;  // no point requirement anymore
const SOUND_EVENTS = ["roundStart", "turnStart", "turnOver", "votingStart", "gameEnd", "playerDeath"];
const MAX_CUSTOM_SOUNDS = 12;
const MAX_CUSTOM_WALLPAPERS = 12;
const MAX_SOUND_BYTES = 1200 * 1024;
const MAX_WALLPAPER_BYTES = 4 * 1024 * 1024;

/* XP is separate from points. Edit these numbers freely. */
const XP_VALUES = { kills: 15, saves: 12, detects: 12, civilianVotes: 6, jesterWins: 30, mafiaWins: 40, civilianWins: 30 };
const MAX_LEVEL = 100;

/* XP needed to go from level N to level N+1. */
function xpForNextLevel(level) {
    return 100 * level;
}

/* Reward collectibles granted when a level is reached. Edit / add freely. */
const LEVEL_REWARDS = {
    5:  { icon: "🎖️", name: "Rookie Medal" },
    10: { icon: "🥉", name: "Street Soldier Medal" },
    15: { icon: "🥈", name: "Enforcer Medal" },
    20: { icon: "🥇", name: "Underboss Medal" },
    30: { icon: "🏅", name: "Boss Medal" },
    40: { icon: "🏆", name: "Godfather Trophy" },
    50: { icon: "👑", name: "Crime Lord Crown" }
};

function levelInfo(xp) {
    let level = 1;
    let left = Math.max(0, Math.floor(Number(xp) || 0));

    while (level < MAX_LEVEL && left >= xpForNextLevel(level)) {
        left -= xpForNextLevel(level);
        level++;
    }

    return {
        level,
        xpIntoLevel: left,
        xpNeeded: level >= MAX_LEVEL ? 0 : xpForNextLevel(level)
    };
}

function ensureProgress(user) {
    if (!user.progress || typeof user.progress !== "object") user.progress = {};
    const p = user.progress;

    p.xp = Math.max(0, Number(p.xp) || 0);
    if (!Array.isArray(p.rewards)) p.rewards = [];
    if (!Array.isArray(p.pendingLevelUps)) p.pendingLevelUps = [];
    if (!Array.isArray(p.sounds)) p.sounds = [];
    if (!Array.isArray(p.wallpapers)) p.wallpapers = [];
    if (!p.equipped || typeof p.equipped !== "object") p.equipped = {};
    if (typeof p.equipped.tier !== "string") p.equipped.tier = "auto";
    if (!p.equipped.sounds || typeof p.equipped.sounds !== "object") p.equipped.sounds = {};
    if (typeof p.equipped.wallpaper !== "string") p.equipped.wallpaper = null;
    if (typeof p.equipped.logo !== "string") p.equipped.logo = null;
    if (!p.equipped.character || typeof p.equipped.character !== "object") p.equipped.character = {};

    /* Shop wallet + owned items (see the SHOP section below). */
    if (!p.shop || typeof p.shop !== "object") p.shop = {};
    p.shop.points = Math.max(0, Math.floor(Number(p.shop.points) || 0));
    p.shop.earned = Math.max(0, Math.floor(Number(p.shop.earned) || 0));
    if (!Array.isArray(p.shop.owned)) p.shop.owned = [];

    if (!p.shop.tagsMigrated) {
        p.shop.tagsMigrated = true;
        // Players who already unlocked rank tags by score keep them.
        if (GRANDFATHER_EXISTING_TAGS) {
            getUnlockedTiers(totalStats(user.stats)).forEach(tier => {
                const id = "tag_" + tier.key;
                if (!p.shop.owned.includes(id)) p.shop.owned.push(id);
            });
        }
    }

    return p;
}

function awardXp(user, stat) {
    const gain = XP_VALUES[stat] || 0;
    if (!gain) return;

    const p = ensureProgress(user);
    const before = levelInfo(p.xp).level;
    p.xp += gain;
    const after = levelInfo(p.xp).level;

    for (let level = before + 1; level <= after; level++) {
        p.pendingLevelUps.push(level);
        if (LEVEL_REWARDS[level] && !p.rewards.includes(level)) p.rewards.push(level);
    }
}

function getUnlockedTiers(points) {
    return TIERS.filter(tier => points >= tier.min);
}

/* The tier that is actually SHOWN next to the player's name. */
function getEquippedTierKey(user) {
    if (!user) return null;

    const unlocked = getOwnedTiers(user);
    const chosen = ensureProgress(user).equipped.tier;

    if (chosen === "none") return null;
    if (chosen !== "auto" && unlocked.some(tier => tier.key === chosen)) return chosen;

    return unlocked.length ? unlocked[unlocked.length - 1].key : null;
}

function getTierOfPlayer(player) {
    const user = player && player.account ? accountsDb.users[player.account] : null;
    return getEquippedTierKey(user);
}

function sniffAudioExt(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
    if (buf.slice(0, 3).toString("latin1") === "ID3") return "mp3";
    if (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) return "mp3";
    if (buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WAVE") return "wav";
    if (buf.slice(0, 4).toString("latin1") === "OggS") return "ogg";
    if (buf.slice(4, 8).toString("latin1") === "ftyp") return "m4a";
    if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) return "webm";
    return null;
}

function sniffImageExt(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
    if (buf[0] === 0x89 && buf.slice(1, 4).toString("latin1") === "PNG") return "png";
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return "jpg";
    if (buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") return "webp";
    return null;
}

function cleanUploadName(value, fallback) {
    const name = String(value || "").replace(/[^\w .\-()]/g, "").trim().slice(0, 24);
    return name || fallback;
}

function userUploadDir(accountKey) {
    return path.join(UPLOADS_DIR, accountKey);
}

function uploadUrl(accountKey, file) {
    return `/uploads/${encodeURIComponent(accountKey)}/${encodeURIComponent(file)}`;
}

function removeUploadedFile(accountKey, file) {
    try {
        const safe = path.basename(String(file || ""));
        if (safe) fs.unlinkSync(path.join(userUploadDir(accountKey), safe));
    } catch (_) { /* already gone */ }
}

function buildProgressPayload(accountKey, user) {
    const p = ensureProgress(user);
    const points = totalStats(user.stats);
    const info = levelInfo(p.xp);
    const unlocked = getOwnedTiers(user).map(tier => tier.key);

    const rewardOwned = p.rewards
        .filter(level => LEVEL_REWARDS[level])
        .map(level => ({ level, icon: LEVEL_REWARDS[level].icon, name: LEVEL_REWARDS[level].name }));

    const upcoming = Object.keys(LEVEL_REWARDS)
        .map(Number)
        .filter(level => level > info.level)
        .sort((a, b) => a - b)
        .slice(0, 3)
        .map(level => ({ level, icon: LEVEL_REWARDS[level].icon, name: LEVEL_REWARDS[level].name }));

    return {
        ok: true,
        username: user.username,
        points,
        tiers: TIERS,
        unlockedTiers: unlocked,
        equippedTier: p.equipped.tier,
        shownTier: getEquippedTierKey(user),
        shopPoints: p.shop.points,
        shopEarned: p.shop.earned,
        ownedItems: p.shop.owned.slice(),
        look: getLookOfUser(user),
        level: info.level,
        xp: Math.floor(p.xp),
        xpIntoLevel: info.xpIntoLevel,
        xpNeeded: info.xpNeeded,
        nextLevel: info.level >= MAX_LEVEL ? null : info.level + 1,
        upcomingRewards: upcoming,
        rewards: rewardOwned,
        soundUnlockPoints: SOUND_UNLOCK_POINTS,
        wallpaperUnlockPoints: WALLPAPER_UNLOCK_POINTS,
        soundsUnlocked: points >= SOUND_UNLOCK_POINTS,
        wallpapersUnlocked: points >= WALLPAPER_UNLOCK_POINTS,
        soundEvents: SOUND_EVENTS,
        sounds: p.sounds.map(item => ({ id: item.id, name: item.name, event: item.event, url: uploadUrl(accountKey, item.file) })),
        wallpapers: p.wallpapers.map(item => ({ id: item.id, name: item.name, url: uploadUrl(accountKey, item.file) })),
        equipped: {
            sounds: { ...p.equipped.sounds },
            wallpaper: p.equipped.wallpaper,
            logo: p.equipped.logo
        }
    };
}

/* =========================================================
   SHOP (buy) + INVENTORY (equip) + SHOP POINTS
   - Shop points are a SEPARATE wallet from rank points, so spending
     never lowers a player's rank or leaderboard position.
   - Players earn shop points for finishing a game + a win bonus.
   - Only signed-in accounts can buy / equip. Guests use defaults.
   - The SERVER checks login, ownership, current price and balance.
   - Wallet, owned items and equipped items are saved on the account
     (accounts.json inside DATA_DIR), so they survive logout, restarts
     and redeploys as long as DATA_DIR is on persistent storage.
   - Prices set by the Owner are saved in accountsDb.shop.prices.
   - To add a new item later, add ONE line to the catalog below.
========================================================= */

const SHOP_POINTS_PER_GAME = 20;        // earned for completing a game
const SHOP_POINTS_WIN_BONUS = 30;       // extra points for being on the winning side
const GRANDFATHER_EXISTING_TAGS = true; // players who already unlocked tags by score keep them
const MAX_SHOP_PRICE = 1000000;

const CHARACTER_SLOTS = ["face", "hair", "shirt", "suit", "pants", "hat", "mask", "accessory"];
const REQUIRED_SLOT_DEFAULTS = { face: "face_basic", shirt: "shirt_basic", pants: "pants_basic" };

const SHOP_CATEGORIES = [
    { key: "face",      group: "character", label: "Faces",       icon: "🙂" },
    { key: "hair",      group: "character", label: "Hairstyles",  icon: "💇" },
    { key: "shirt",     group: "character", label: "Shirts",      icon: "👕" },
    { key: "suit",      group: "character", label: "Suits",       icon: "🤵" },
    { key: "pants",     group: "character", label: "Pants",       icon: "👖" },
    { key: "hat",       group: "character", label: "Hats",        icon: "🎩" },
    { key: "mask",      group: "character", label: "Masks",       icon: "🎭" },
    { key: "accessory", group: "character", label: "Accessories", icon: "🕶️" },
    { key: "tag",       group: "tag",       label: "Name Tags",   icon: "🏷️" },
    { key: "wallpaper", group: "wallpaper", label: "Wallpapers",  icon: "🖼️" },
    { key: "sound",     group: "sound",     label: "Sounds",      icon: "🔊" },
    { key: "logo",      group: "logo",      label: "Logos",       icon: "📛" }
];

/* ---------- Catalog ----------
   id         unique, never change it after players own it
   cat        one of SHOP_CATEGORIES keys
   price      default price in shop points (Owner can override it live)
   free       true = everyone owns it (the default character)
   art        SVG markup drawn on the avatar (viewBox 0 0 100 140)
   emoji      { t, x, y, s } emoji drawn on the avatar instead of SVG
   skin       (faces) skin color of the head, neck and hands
   css        (wallpapers) any CSS background-image value, e.g. a gradient
   file       (wallpapers / sounds) URL of your own file in /public
   base       (wallpapers / logos) file name WITHOUT extension. Put your image in
              public/wallpapers/<base>.jpg|png|webp  or  public/logos/<base>.png|jpg|webp
              (the server finds whichever extension you used, no restart needed)
   tier       (tags) matches TIER_INFO key in client.js                */

const SHOP_CATALOG = [];

function shopAdd(item) {
    SHOP_CATALOG.push(item);
}

/* ----- Faces ----- */
const faceEyes = "<circle cx='43' cy='34' r='2.2' fill='#222'/><circle cx='57' cy='34' r='2.2' fill='#222'/>";
const faceSmile = "<path d='M43 44 Q50 49 57 44' stroke='#222' stroke-width='2' fill='none' stroke-linecap='round'/>";
shopAdd({ id: "face_basic",   cat: "face", name: "Classic",   price: 0,   free: true, skin: "#f1c27d", art: faceEyes + faceSmile });
shopAdd({ id: "face_happy",   cat: "face", name: "Happy",     price: 100, skin: "#e0ac69", art: "<path d='M39 35 Q43 30 47 35' stroke='#222' stroke-width='2' fill='none' stroke-linecap='round'/><path d='M53 35 Q57 30 61 35' stroke='#222' stroke-width='2' fill='none' stroke-linecap='round'/><path d='M41 42 Q50 55 59 42 Z' fill='#fff' stroke='#222' stroke-width='1.6' stroke-linejoin='round'/>" });
shopAdd({ id: "face_serious", cat: "face", name: "Serious",   price: 100, skin: "#c68642", art: faceEyes + "<path d='M38 28 L47 30' stroke='#222' stroke-width='2' stroke-linecap='round'/><path d='M62 28 L53 30' stroke='#222' stroke-width='2' stroke-linecap='round'/><path d='M44 46 H56' stroke='#222' stroke-width='2' stroke-linecap='round'/>" });
shopAdd({ id: "face_scar",    cat: "face", name: "Scarface",  price: 150, skin: "#d9a066", art: faceEyes + faceSmile + "<path d='M57 24 L63 43' stroke='#a33' stroke-width='2' stroke-linecap='round'/><path d='M55 31 L61 30 M57 37 L63 36' stroke='#a33' stroke-width='1.4'/>" });
shopAdd({ id: "face_angry",    cat: "face", name: "Angry",     price: 120, skin: "#f1c27d", art: faceEyes + "<path d='M38 27 L47 32' stroke='#222' stroke-width='2.4' stroke-linecap='round'/><path d='M62 27 L53 32' stroke='#222' stroke-width='2.4' stroke-linecap='round'/><path d='M43 47 Q50 41 57 47' stroke='#222' stroke-width='2' fill='none' stroke-linecap='round'/>" });
shopAdd({ id: "face_vampire", cat: "face", name: "Vampire",   price: 200, skin: "#efe2da", art: "<circle cx='43' cy='34' r='2.4' fill='#c1121f'/><circle cx='57' cy='34' r='2.4' fill='#c1121f'/><path d='M43 43 Q50 48 57 43' stroke='#222' stroke-width='2' fill='none' stroke-linecap='round'/><path d='M45 44 L47 50 L49 45 Z M51 45 L53 50 L55 44 Z' fill='#fff' stroke='#222' stroke-width='.8'/>" });

/* ----- Hairstyles ----- */
shopAdd({ id: "hair_short",  cat: "hair", name: "Short Cut",   price: 100, art: "<path d='M30 36 Q28 13 50 13 Q72 13 70 36 Q64 24 50 24 Q36 24 30 36Z' fill='#2b1d14'/>" });
shopAdd({ id: "hair_slick",  cat: "hair", name: "Slick Back",  price: 100, art: "<path d='M29 37 Q27 11 52 12 Q73 13 71 37 Q66 22 50 21 Q36 21 29 37Z' fill='#151515'/><path d='M38 19 Q52 14 65 21' stroke='#555' stroke-width='1.6' fill='none' stroke-linecap='round'/>" });
shopAdd({ id: "hair_spiky",  cat: "hair", name: "Spiky Blond", price: 100, art: "<path d='M30 36 L27 14 L38 24 L42 7 L50 22 L58 7 L62 24 L73 14 L70 36 Q60 24 50 24 Q40 24 30 36Z' fill='#e8c547'/>" });
shopAdd({ id: "hair_long",   cat: "hair", name: "Long Brown",  price: 120, art: "<path d='M28 42 Q25 11 50 12 Q75 11 72 42 L72 64 Q65 62 65 52 L65 31 Q50 21 35 31 L35 52 Q35 62 28 64Z' fill='#6b3f1f'/>" });
shopAdd({ id: "hair_curly",  cat: "hair", name: "Curly",       price: 120, art: "<g fill='#2b1d14'><circle cx='36' cy='21' r='8'/><circle cx='50' cy='15' r='9'/><circle cx='64' cy='21' r='8'/><circle cx='29' cy='30' r='6'/><circle cx='71' cy='30' r='6'/></g>" });
shopAdd({ id: "hair_mohawk", cat: "hair", name: "Red Mohawk",  price: 150, art: "<path d='M43 22 L45 4 L50 12 L55 3 L57 22Z' fill='#d62828'/>" });

/* ----- Shirts / Suits / Pants ----- */
function shirtArt(color, extra) {
    return `<rect x='28' y='60' width='44' height='42' rx='6' fill='${color}'/><rect x='15' y='62' width='14' height='24' rx='7' fill='${color}'/><rect x='71' y='62' width='14' height='24' rx='7' fill='${color}'/>${extra || ""}`;
}
function suitArt(color, tie, trim) {
    return `<rect x='26' y='59' width='48' height='46' rx='6' fill='${color}'/><rect x='13' y='61' width='15' height='32' rx='7' fill='${color}'/><rect x='72' y='61' width='15' height='32' rx='7' fill='${color}'/><path d='M42 60 L58 60 L50 82 Z' fill='#f4f4f4'/><path d='M50 64 L46.5 70 L50 90 L53.5 70 Z' fill='${tie}'/><path d='M42 60 L33 60 L47 90 L50 82 Z' fill='${trim}'/><path d='M58 60 L67 60 L53 90 L50 82 Z' fill='${trim}'/><circle cx='50' cy='96' r='1.6' fill='#111'/><circle cx='50' cy='102' r='1.6' fill='#111'/>`;
}
function pantsArt(color) {
    return `<rect x='31' y='96' width='17' height='38' rx='3' fill='${color}'/><rect x='52' y='96' width='17' height='38' rx='3' fill='${color}'/><rect x='29' y='132' width='21' height='7' rx='3' fill='#1b1b1b'/><rect x='50' y='132' width='21' height='7' rx='3' fill='#1b1b1b'/>`;
}
shopAdd({ id: "shirt_basic",  cat: "shirt", name: "Grey Tee",       price: 0,   free: true, art: shirtArt("#8a8f98") });
shopAdd({ id: "shirt_white",  cat: "shirt", name: "White Shirt",    price: 150, art: shirtArt("#f2f2f2", "<path d='M50 60 V102' stroke='#cfcfcf' stroke-width='1.2'/>") });
shopAdd({ id: "shirt_red",    cat: "shirt", name: "Red Shirt",      price: 150, art: shirtArt("#c62828") });
shopAdd({ id: "shirt_blue",   cat: "shirt", name: "Blue Shirt",     price: 150, art: shirtArt("#1e63c9") });
shopAdd({ id: "shirt_green",  cat: "shirt", name: "Green Shirt",    price: 150, art: shirtArt("#2e7d32") });
shopAdd({ id: "shirt_stripe", cat: "shirt", name: "Striped Shirt",  price: 170, art: shirtArt("#f2f2f2", "<g stroke='#c62828' stroke-width='3'><path d='M28 68 H72 M28 78 H72 M28 88 H72 M28 98 H72'/><path d='M15 70 H29 M15 80 H29 M71 70 H85 M71 80 H85'/></g>") });
shopAdd({ id: "shirt_hawaii", cat: "shirt", name: "Hawaiian Shirt", price: 200, art: shirtArt("#17a2b8", "<g fill='#ffd23f'><circle cx='36' cy='70' r='3'/><circle cx='56' cy='76' r='3'/><circle cx='42' cy='88' r='3'/><circle cx='64' cy='94' r='3'/></g><g fill='#ff6b9d'><circle cx='62' cy='67' r='2.6'/><circle cx='34' cy='82' r='2.6'/><circle cx='52' cy='96' r='2.6'/></g>") });

shopAdd({ id: "suit_black",     cat: "suit", name: "Black Suit",     price: 350, art: suitArt("#1b1b22", "#b3001b", "#101015") });
shopAdd({ id: "suit_navy",      cat: "suit", name: "Navy Suit",      price: 380, art: suitArt("#16264a", "#e8e8e8", "#0e1a35") });
shopAdd({ id: "suit_white",     cat: "suit", name: "White Suit",     price: 400, art: suitArt("#ececec", "#111111", "#d0d0d0") });
shopAdd({ id: "suit_pinstripe", cat: "suit", name: "Pinstripe Suit", price: 450, art: suitArt("#2a2a33", "#c9a227", "#1c1c23") + "<g stroke='#6b6b78' stroke-width='.8'><path d='M32 62 V104 M38 62 V104 M62 62 V104 M68 62 V104'/></g>" });
shopAdd({ id: "suit_red",       cat: "suit", name: "Crimson Suit",   price: 500, art: suitArt("#9d0f1c", "#111111", "#7a0b15") });

shopAdd({ id: "pants_basic", cat: "pants", name: "Grey Trousers", price: 0,   free: true, art: pantsArt("#3c4048") });
shopAdd({ id: "pants_jeans", cat: "pants", name: "Blue Jeans",    price: 200, art: pantsArt("#2b4f8f") });
shopAdd({ id: "pants_black", cat: "pants", name: "Black Pants",   price: 200, art: pantsArt("#17171a") });
shopAdd({ id: "pants_khaki", cat: "pants", name: "Khaki Pants",   price: 200, art: pantsArt("#b59d6b") });
shopAdd({ id: "pants_white", cat: "pants", name: "White Pants",   price: 220, art: pantsArt("#e6e6e6") });
shopAdd({ id: "pants_red",   cat: "pants", name: "Red Pants",     price: 250, art: pantsArt("#a31d1d") });

/* ----- Hats (the fedora is drawn; the rest are emoji) ----- */
shopAdd({ id: "hat_cap",     cat: "hat", name: "Cap",         price: 150, emoji: { t: "🧢", x: 50, y: 27, s: 34 } });
shopAdd({ id: "hat_grad",    cat: "hat", name: "Graduate",    price: 200, emoji: { t: "🎓", x: 50, y: 25, s: 36 } });
shopAdd({ id: "hat_fedora",  cat: "hat", name: "Fedora",      price: 250, art: "<ellipse cx='50' cy='23' rx='31' ry='7' fill='#2f2f2f'/><path d='M33 23 Q33 3 50 3 Q67 3 67 23Z' fill='#444'/><rect x='33' y='16' width='34' height='5' fill='#a02020'/>" });
shopAdd({ id: "hat_helmet",  cat: "hat", name: "Helmet",      price: 250, emoji: { t: "🪖", x: 50, y: 28, s: 36 } });
shopAdd({ id: "hat_tophat",  cat: "hat", name: "Top Hat",     price: 300, emoji: { t: "🎩", x: 50, y: 26, s: 38 } });
shopAdd({ id: "hat_crown",   cat: "hat", name: "Golden Crown", price: 800, emoji: { t: "👑", x: 50, y: 24, s: 34 } });

/* ----- Masks (emoji over the face) ----- */
shopAdd({ id: "mask_surgical", cat: "mask", name: "Face Mask",    price: 300, emoji: { t: "😷", x: 50, y: 48, s: 38 } });
shopAdd({ id: "mask_theatre",  cat: "mask", name: "Theatre Mask", price: 300, emoji: { t: "🎭", x: 50, y: 47, s: 38 } });
shopAdd({ id: "mask_clown",    cat: "mask", name: "Clown Mask",   price: 350, emoji: { t: "🤡", x: 50, y: 48, s: 38 } });
shopAdd({ id: "mask_oni",      cat: "mask", name: "Oni Mask",     price: 400, emoji: { t: "👹", x: 50, y: 48, s: 38 } });
shopAdd({ id: "mask_robot",    cat: "mask", name: "Robot Mask",   price: 400, emoji: { t: "🤖", x: 50, y: 48, s: 38 } });
shopAdd({ id: "mask_skull",    cat: "mask", name: "Skull Mask",   price: 450, emoji: { t: "💀", x: 50, y: 48, s: 38 } });

/* ----- Accessories (emoji) ----- */
shopAdd({ id: "acc_rose",       cat: "accessory", name: "Red Rose",    price: 120, emoji: { t: "🌹", x: 80, y: 102, s: 22 } });
shopAdd({ id: "acc_bow",        cat: "accessory", name: "Bow",         price: 130, emoji: { t: "🎀", x: 50, y: 70, s: 20 } });
shopAdd({ id: "acc_scarf",      cat: "accessory", name: "Scarf",       price: 150, emoji: { t: "🧣", x: 50, y: 70, s: 28 } });
shopAdd({ id: "acc_shades",     cat: "accessory", name: "Sunglasses",  price: 200, emoji: { t: "🕶️", x: 50, y: 41, s: 26 } });
shopAdd({ id: "acc_headphones", cat: "accessory", name: "Headphones",  price: 250, emoji: { t: "🎧", x: 50, y: 43, s: 40 } });
shopAdd({ id: "acc_chain",      cat: "accessory", name: "Gold Chain",  price: 300, emoji: { t: "🔗", x: 50, y: 74, s: 16 } });
shopAdd({ id: "acc_gem",        cat: "accessory", name: "Diamond Pin", price: 400, emoji: { t: "💎", x: 61, y: 74, s: 14 } });

/* ----- Name tags (colors / symbols are in client.js TIER_INFO) ----- */
shopAdd({ id: "tag_red",     cat: "tag", name: "Red Tag",     price: 150, tier: "red" });
shopAdd({ id: "tag_gold",    cat: "tag", name: "Gold Tag",    price: 200, tier: "gold" });
shopAdd({ id: "tag_diamond", cat: "tag", name: "Diamond Tag", price: 300, tier: "diamond" });
shopAdd({ id: "tag_elite",   cat: "tag", name: "Elite Tag",   price: 400, tier: "elite" });
shopAdd({ id: "tag_legend",  cat: "tag", name: "Legend Tag",  price: 500, tier: "legend" });

/* ----- Wallpapers -----
   Put YOUR image in  public/wallpapers/<base>.jpg  (.png / .webp also work).
   The file name must match "base" below. To add a new wallpaper, add one line. */
shopAdd({ id: "wp_midnight", cat: "wallpaper", name: "Midnight Blue", price: 200, base: "midnight-blue" });
shopAdd({ id: "wp_frozen",   cat: "wallpaper", name: "Frozen Night",  price: 300, base: "frozen-night" });
shopAdd({ id: "wp_emerald",  cat: "wallpaper", name: "Emerald Noir",  price: 350, base: "emerald-noir" });
shopAdd({ id: "wp_city",     cat: "wallpaper", name: "City Lights",   price: 400, base: "city-lights" });
shopAdd({ id: "wp_blood",    cat: "wallpaper", name: "Blood Moon",    price: 500, base: "blood-moon" });
shopAdd({ id: "wp_gold",     cat: "wallpaper", name: "Golden Hour",   price: 500, base: "golden-hour" });
shopAdd({ id: "wp_neon",     cat: "wallpaper", name: "Neon Vice",     price: 500, base: "neon-vice" });

/* ----- Logos -----
   Put YOUR image in  public/logos/<base>.png  (.jpg / .webp also work).
   A bought + equipped logo replaces the main Mafia Wars logo for that player. */
shopAdd({ id: "logo_skull",  cat: "logo", name: "Red Skull",     price: 300, base: "red-skull" });
shopAdd({ id: "logo_crown",  cat: "logo", name: "Gold Crown",    price: 400, base: "gold-crown" });
shopAdd({ id: "logo_rose",   cat: "logo", name: "Black Rose",    price: 400, base: "black-rose" });
shopAdd({ id: "logo_dagger", cat: "logo", name: "Silver Dagger", price: 500, base: "silver-dagger" });
shopAdd({ id: "logo_mask",   cat: "logo", name: "Neon Mask",     price: 600, base: "neon-mask" });
shopAdd({ id: "logo_fist",   cat: "logo", name: "Iron Fist",     price: 600, base: "iron-fist" });
shopAdd({ id: "logo_viper",  cat: "logo", name: "Purple Viper",  price: 700, base: "purple-viper" });

/* ----- Sounds (the client plays a built-in synth sound with the same id;
   or add  file: "/sounds/x.mp3"  to use your own file from /public) ----- */
shopAdd({ id: "snd_chime",     cat: "sound", name: "Soft Chime",    price: 250, icon: "🔔" });
shopAdd({ id: "snd_coin",      cat: "sound", name: "Coin Drop",     price: 250, icon: "💰" });
shopAdd({ id: "snd_horn",      cat: "sound", name: "Car Horn",      price: 300, icon: "📯" });
shopAdd({ id: "snd_heartbeat", cat: "sound", name: "Heartbeat",     price: 350, icon: "💓" });
shopAdd({ id: "snd_bell",      cat: "sound", name: "Church Bell",   price: 350, icon: "⛪" });
shopAdd({ id: "snd_siren",     cat: "sound", name: "Police Siren",  price: 350, icon: "🚨" });
shopAdd({ id: "snd_gunshot",   cat: "sound", name: "Gunshot",       price: 350, icon: "💥" });

const SHOP_ITEMS = new Map(SHOP_CATALOG.map(item => [item.id, item]));

function ensureShopDb() {
    if (!accountsDb.shop || typeof accountsDb.shop !== "object") accountsDb.shop = {};
    if (!accountsDb.shop.prices || typeof accountsDb.shop.prices !== "object") accountsDb.shop.prices = {};
    return accountsDb.shop;
}

/* The CURRENT price: Owner override if there is one, else the default. */
function shopPriceOf(item) {
    if (!item || item.free) return 0;
    const override = Number(ensureShopDb().prices[item.id]);
    if (Number.isFinite(override) && override >= 0) return Math.floor(override);
    return item.price;
}

/* Finds the image the Owner dropped into public/<folder>/<base>.<ext>.
   If no file exists yet it still returns the .jpg / .png path, so the item
   works the moment the file is added. */
const SHOP_FILE_DIRS = { wallpaper: ["wallpapers", "wallpaper"], logo: ["logos", "logo"] };
const SHOP_FILE_EXTS = ["jpg", "jpeg", "png", "webp", "gif", "avif"];

/* "Midnight Blue.JPG", "midnight_blue.png", "midnight-blue.webp" all become "midnightblue". */
function shopNorm(value) {
    return String(value || "").toLowerCase().replace(/\.[a-z0-9]+$/, "").replace(/[^a-z0-9]/g, "");
}

function shopFileUrl(item) {
    const dirs = SHOP_FILE_DIRS[item.cat];
    if (!dirs) return null;

    // The names that are allowed to match this item's picture file.
    const wanted = [item.base, item.name, String(item.id || "").replace(/^[a-z]+_/, "")]
        .map(shopNorm).filter(Boolean);

    // express.static("public") is relative to where the server was started,
    // so look there AND next to server.js.
    const roots = Array.from(new Set([path.resolve("public"), path.join(__dirname, "public")]));

    for (const dir of dirs) {
        for (const root of roots) {
            let files = [];
            try { files = fs.readdirSync(path.join(root, dir)); } catch (_) { continue; }

            for (const name of wanted) {
                const hit = files.find(file => shopNorm(file) === name && SHOP_FILE_EXTS.includes(file.split(".").pop().toLowerCase()));
                if (hit) return `/${dir}/${encodeURIComponent(hit)}`;
            }
        }
    }

    // Nothing found yet: still return the normal path so it works once the file is added.
    return `/${dirs[0]}/${item.base}.${item.cat === "logo" ? "png" : "jpg"}`;
}

/* Prints (when the server starts) which wallpaper / logo pictures were found and which are missing. */
(function logShopPictures() {
    try {
        const roots = Array.from(new Set([path.resolve("public"), path.join(__dirname, "public")]));
        console.log("[shop] looking for pictures in: " + roots.map(r => path.join(r, "wallpapers|logos")).join("  and  "));
        SHOP_CATALOG.filter(item => item.base).forEach(item => {
            const url = shopFileUrl(item);
            const found = roots.some(root => fs.existsSync(path.join(root, decodeURIComponent(url))));
            console.log(`[shop] ${found ? "OK     " : "MISSING"} ${item.cat.padEnd(9)} ${item.name.padEnd(15)} -> ${found ? url : "put a file named " + item.base + ".jpg/.png in public" + url.replace(/[^/]+$/, "")}`);
        });
    } catch (error) {
        console.log("[shop] picture check failed:", error.message);
    }
})();

function publicShopItem(item) {
    const out = {
        id: item.id,
        cat: item.cat,
        name: item.name,
        price: shopPriceOf(item),
        free: Boolean(item.free)
    };
    ["skin", "art", "emoji", "css", "tier", "icon"].forEach(key => {
        if (item[key] !== undefined) out[key] = item[key];
    });
    if (item.file) out.url = item.file;
    else if (item.base) out.url = shopFileUrl(item);
    return out;
}

function currentShopPrices() {
    const prices = {};
    SHOP_CATALOG.forEach(item => { if (!item.free) prices[item.id] = shopPriceOf(item); });
    return prices;
}

function shopOwns(user, item) {
    if (!item) return false;
    if (item.free) return true;
    return ensureProgress(user).shop.owned.includes(item.id);
}

function defaultLook() {
    return { face: "face_basic", hair: null, shirt: "shirt_basic", suit: null, pants: "pants_basic", hat: null, mask: null, accessory: null };
}

/* The character a player is wearing. Always valid: unowned / unknown items fall back to the default. */
function getLookOfUser(user) {
    const look = defaultLook();
    if (!user) return look;

    const saved = ensureProgress(user).equipped.character || {};

    CHARACTER_SLOTS.forEach(slot => {
        const item = SHOP_ITEMS.get(saved[slot]);
        if (item && item.cat === slot && shopOwns(user, item)) look[slot] = item.id;
    });

    return look;
}

function getLookOfPlayer(player) {
    const user = player && player.account ? accountsDb.users[player.account] : null;
    return user ? getLookOfUser(user) : null;
}

/* Tags the player has BOUGHT (or kept from before the shop existed). */
function getOwnedTiers(user) {
    const owned = ensureProgress(user).shop.owned;
    return TIERS.filter(tier => owned.includes("tag_" + tier.key));
}

/* Called once per finished game. winnerTest(player) -> true for the winning side. */
function grantGameRewards(room, winnerTest) {
    if (!room) return;

    room.players.forEach(player => {
        if (!player || !player.account || !player.role || player.connected === false) return;

        const user = accountsDb.users[player.account];
        if (!user) return;

        const won = Boolean(winnerTest && winnerTest(player));
        const earned = SHOP_POINTS_PER_GAME + (won ? SHOP_POINTS_WIN_BONUS : 0);
        const shop = ensureProgress(user).shop;

        shop.points += earned;
        shop.earned += earned;

        io.to(player.id).emit("shopReward", {
            earned,
            won,
            bonus: won ? SHOP_POINTS_WIN_BONUS : 0,
            balance: shop.points
        });
    });

    saveAccounts();
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
                hostBadge: getBadgeOf(connectedPlayers.find(player => player.id === room.host)?.id || connectedPlayers[0]?.id),
                hostTier: getTierOfPlayer(connectedPlayers.find(player => player.id === room.host) || connectedPlayers[0])
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
    broadcastVoiceState(roomCode);
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

        broadcastVoiceState(roomCode);
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

    // The voice channel changes whenever the active night role changes.
    // Broadcast it immediately so every browser closes the old peer group
    // and connects to the correct group without waiting for another event.
    broadcastVoiceState(roomCode);
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

        // The host picks the voice-chat players again for the next game.
        player.voiceAllowed = false;
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
                tier: getTierOfPlayer(player),
                look: getLookOfPlayer(player),
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

            voiceChatAllowed:
                room.voiceChatAllowed !== false,

            voicePlayerIds:
                getVoicePlayerIds(room),

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

                voiceChatAllowed:
                    room.voiceChatAllowed !== false,

                voicePlayerIds:
                    getVoicePlayerIds(room),

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
        grantGameRewards(room, p => p === deadJester);

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
        grantGameRewards(room, p => !isMafiaTeam(p.role) && p.role !== "Jester");

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
        grantGameRewards(room, p => isMafiaTeam(p.role));

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

    // Day voice is a shared channel for all living players.
    broadcastVoiceState(roomCode);

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
   WEBRTC VOICE CHAT
   Server-side permissions + Socket.IO signaling only.
   Raw audio never passes through this server.
========================================================= */

const MAX_VOICE_PLAYERS = Infinity; // no limit on voice-chat players

function getVoicePlayerIds(room) {
    if (!room) return [];

    return room.players
        .filter(p => p.voiceAllowed && p.connected !== false)
        .map(p => p.id);
}

/*
   Validates the host's voice-player selection.
   Returns { ids } or { error }. The 5-player limit is enforced HERE, on
   the server, so a modified browser cannot go over it.
*/
function cleanVoiceSelection(room, ids) {
    const raw = Array.isArray(ids) ? ids.map(id => String(id)) : [];
    const unique = Array.from(new Set(raw));

    if (unique.length > MAX_VOICE_PLAYERS) {
        return { error: `You can select at most ${MAX_VOICE_PLAYERS} voice-chat players.` };
    }

    const valid = unique.filter(id =>
        room.players.some(p => p.id === id && p.connected !== false)
    );

    return { ids: valid };
}

/*
   allowed: true / false / undefined (undefined = leave unchanged)
   ids:     array of player ids / undefined (undefined = leave unchanged)
   Returns an error string, or null when everything was applied.
*/
function setRoomVoiceSettings(room, allowed, ids) {
    let selection = null;

    if (ids !== undefined) {
        const cleaned = cleanVoiceSelection(room, ids);
        if (cleaned.error) return cleaned.error;
        selection = cleaned.ids;
    }

    if (typeof allowed === "boolean") {
        room.voiceChatAllowed = allowed;
    }

    if (selection) {
        room.players.forEach(p => {
            p.voiceAllowed = selection.includes(p.id);
        });
    }

    return null;
}

function getVoiceGroup(room, player) {
    if (!room || !player || player.connected === false) return "none";

    // Host turned voice chat OFF -> nobody has voice.
    if (room.voiceChatAllowed === false) return "none";

    // Once the game has started, only the players the host selected
    // (maximum 5) can use voice chat. Everyone else plays normally.
    if (room.phase !== "lobby" && !player.voiceAllowed) return "none";

    if (room.phase === "lobby") return "lobby";
    if (room.phase === "gameover") return "gameover";
    if (!player.alive) return "dead";
    if (room.phase === "day") return "alive";

    if (room.phase === "night") {
        if (room.nightTurn === "mafia" && isMafiaTeam(player.role)) return "mafia";
        if (room.nightTurn === "doctor" && player.role === "Doctor") return "doctor";
        if (room.nightTurn === "detective" && player.role === "Detective") return "detective";
        if (room.nightTurn === "cupid" && player.role === "Cupid") return "cupid";
        return "silent";
    }

    return "none";
}

function getVoicePeers(room, player) {
    const group = getVoiceGroup(room, player);
    if (group === "none" || group === "silent") return [];

    return room.players
        .filter(other =>
            other.id !== player.id &&
            other.connected !== false &&
            getVoiceGroup(room, other) === group
        )
        .map(other => ({
            id: other.id,
            name: other.name,
            badge: getBadgeOf(other.id),
            alive: other.alive,
            role: group === "mafia" && isMafiaTeam(other.role) ? other.role : null
        }));
}

function broadcastVoiceState(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;

    room.players.forEach(player => {
        const chatAllowed = room.voiceChatAllowed !== false;
        const selected = room.phase === "lobby" || Boolean(player.voiceAllowed);

        io.to(player.id).emit("voiceState", {
            enabled: chatAllowed && selected,
            chatAllowed,
            selected,
            group: getVoiceGroup(room, player),
            peers: getVoicePeers(room, player)
        });
    });
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
        tier: (() => {
            const key = socketAccounts.get(request.socketId);
            return key ? getEquippedTierKey(accountsDb.users[key]) : null;
        })(),
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
                tier: getEquippedTierKey(user),
                level: levelInfo(ensureProgress(user).xp).level,
                look: getLookOfUser(user),
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

        /* =================================================
           PROGRESSION: rank tag, level, inventory
        ================================================= */

        function progressionUser() {
            const key = getSocketAccountKey(socket);
            const user = key ? accountsDb.users[key] : null;
            return user ? { key, user } : null;
        }

        function sendProgress(ctx, includeLevelUps) {
            const payload = buildProgressPayload(ctx.key, ctx.user);

            if (includeLevelUps) {
                const p = ensureProgress(ctx.user);
                payload.levelUps = p.pendingLevelUps.map(level => ({
                    level,
                    reward: LEVEL_REWARDS[level] ? { icon: LEVEL_REWARDS[level].icon, name: LEVEL_REWARDS[level].name } : null
                }));
                if (p.pendingLevelUps.length) {
                    p.pendingLevelUps = [];
                    saveAccounts();
                }
            }

            socket.emit("myProgressData", payload);
        }

        socket.on("getMyProgress", () => {
            const ctx = progressionUser();
            if (!ctx) return socket.emit("myProgressData", { ok: false });
            sendProgress(ctx, true);
        });

        socket.on("equipTier", (data, callback) => {
            const ctx = progressionUser();
            const reply = typeof callback === "function" ? callback : () => {};
            if (!ctx) return reply({ ok: false, error: "Sign in first." });

            const choice = String(data?.tier || "");
            const allowed = choice === "auto" || choice === "none" ||
                getOwnedTiers(ctx.user).some(tier => tier.key === choice);

            if (!allowed) return reply({ ok: false, error: "Buy that tag in the Shop first." });

            ensureProgress(ctx.user).equipped.tier = choice;
            saveAccounts();
            sendProgress(ctx, false);
            reply({ ok: true });
        });

        /* =================================================
           SHOP: catalog, buying, equipping, Owner prices
           Everything is checked here on the server.
        ================================================= */

        function refreshLookInRoom() {
            for (const [code, room] of Object.entries(rooms)) {
                if (room.phase === "lobby" && room.players.some(pl => pl.id === socket.id)) {
                    emitLobby(code);
                    break;
                }
            }
        }

        socket.on("getShopCatalog", callback => {
            if (typeof callback !== "function") return;
            callback({
                ok: true,
                categories: SHOP_CATEGORIES,
                slots: CHARACTER_SLOTS,
                items: SHOP_CATALOG.map(publicShopItem),
                pointsPerGame: SHOP_POINTS_PER_GAME,
                winBonus: SHOP_POINTS_WIN_BONUS
            });
        });

        socket.on("shopBuy", (data, callback) => {
            const ctx = progressionUser();
            const reply = typeof callback === "function" ? callback : () => {};
            if (!ctx) return reply({ ok: false, error: "Sign in to buy items." });

            const item = SHOP_ITEMS.get(String(data?.id || ""));
            if (!item || item.free) return reply({ ok: false, error: "That item is not for sale." });

            const shop = ensureProgress(ctx.user).shop;
            if (shop.owned.includes(item.id)) return reply({ ok: false, error: "You already own this item." });

            const price = shopPriceOf(item);   // always the CURRENT price, never one sent by the browser
            if (shop.points < price) {
                return reply({ ok: false, error: `Not enough points. You need ${price - shop.points} more.` });
            }

            shop.points -= price;
            shop.owned.push(item.id);

            saveAccounts();
            sendProgress(ctx, false);
            reply({ ok: true, id: item.id, price, balance: shop.points });
        });

        socket.on("equipCharacter", (data, callback) => {
            const ctx = progressionUser();
            const reply = typeof callback === "function" ? callback : () => {};
            if (!ctx) return reply({ ok: false, error: "Sign in first." });

            const slot = String(data?.slot || "");
            if (!CHARACTER_SLOTS.includes(slot)) return reply({ ok: false, error: "Unknown item slot." });

            const p = ensureProgress(ctx.user);
            const id = data?.id ? String(data.id) : null;

            if (id) {
                const item = SHOP_ITEMS.get(id);
                if (!item || item.cat !== slot || !shopOwns(ctx.user, item)) {
                    return reply({ ok: false, error: "You do not own that item." });
                }
                p.equipped.character[slot] = id;
            } else {
                // Unequip. Face / shirt / pants fall back to the free default.
                p.equipped.character[slot] = REQUIRED_SLOT_DEFAULTS[slot] || null;
            }

            saveAccounts();
            sendProgress(ctx, false);
            refreshLookInRoom();
            reply({ ok: true });
        });

        socket.on("equipShopSound", (data, callback) => {
            const ctx = progressionUser();
            const reply = typeof callback === "function" ? callback : () => {};
            if (!ctx) return reply({ ok: false, error: "Sign in first." });

            const item = SHOP_ITEMS.get(String(data?.id || ""));
            const event = String(data?.event || "");

            if (!item || item.cat !== "sound" || !shopOwns(ctx.user, item)) {
                return reply({ ok: false, error: "You do not own that sound." });
            }
            if (!SOUND_EVENTS.includes(event)) return reply({ ok: false, error: "Choose a game event." });

            const p = ensureProgress(ctx.user);

            if (data?.equip === false) {
                if (p.equipped.sounds[event] === item.id) delete p.equipped.sounds[event];
            } else {
                p.equipped.sounds[event] = item.id;
            }

            saveAccounts();
            sendProgress(ctx, false);
            reply({ ok: true });
        });

        socket.on("equipLogo", (data, callback) => {
            const ctx = progressionUser();
            const reply = typeof callback === "function" ? callback : () => {};
            if (!ctx) return reply({ ok: false, error: "Sign in first." });

            const p = ensureProgress(ctx.user);
            const id = data?.id ? String(data.id) : null;

            if (id) {
                const item = SHOP_ITEMS.get(id);
                if (!item || item.cat !== "logo" || !shopOwns(ctx.user, item)) {
                    return reply({ ok: false, error: "You do not own that logo." });
                }
            }

            p.equipped.logo = id;
            saveAccounts();
            sendProgress(ctx, false);
            reply({ ok: true });
        });

        /* OWNER ONLY: change (or reset) the point price of any shop item.
           The check uses the badge stored on the server-side socket, so the
           browser cannot fake it. */
        socket.on("ownerSetPrice", (data, callback) => {
            const reply = typeof callback === "function" ? callback : () => {};

            if (socket.badge !== "owner" || !getSocketAccountKey(socket)) {
                return reply({ ok: false, error: "Only the signed-in Owner can change prices." });
            }

            const item = SHOP_ITEMS.get(String(data?.id || ""));
            if (!item || item.free) return reply({ ok: false, error: "That item has no price." });

            const shopDb = ensureShopDb();

            if (data?.reset) {
                delete shopDb.prices[item.id];
            } else {
                const price = Math.floor(Number(data?.price));
                if (!Number.isFinite(price) || price < 0 || price > MAX_SHOP_PRICE) {
                    return reply({ ok: false, error: `Price must be a number from 0 to ${MAX_SHOP_PRICE}.` });
                }
                shopDb.prices[item.id] = price;
            }

            saveAccounts();
            io.emit("shopPricesUpdated", { prices: currentShopPrices() });
            reply({ ok: true, id: item.id, price: shopPriceOf(item) });
        });

        socket.on("uploadSound", (data, callback) => {
            const ctx = progressionUser();
            const reply = typeof callback === "function" ? callback : () => {};
            if (!ctx) return reply({ ok: false, error: "Sign in first." });

            const p = ensureProgress(ctx.user);
            // Custom sound uploads are disabled for everyone.
            return reply({ ok: false, error: "Custom sounds are not available." });

            const event = String(data?.event || "");
            if (!SOUND_EVENTS.includes(event)) return reply({ ok: false, error: "Choose a game event." });
            if (p.sounds.length >= MAX_CUSTOM_SOUNDS) return reply({ ok: false, error: `You can keep up to ${MAX_CUSTOM_SOUNDS} sounds. Delete one first.` });

            const bytes = Buffer.isBuffer(data?.bytes) ? data.bytes : (data?.bytes ? Buffer.from(data.bytes) : null);
            if (!bytes || !bytes.length) return reply({ ok: false, error: "No sound file received." });
            if (bytes.length > MAX_SOUND_BYTES) return reply({ ok: false, error: "Sound file is too large. Use a short clip (5 seconds max)." });

            const ext = sniffAudioExt(bytes);
            if (!ext) return reply({ ok: false, error: "Unsupported sound file. Use MP3, WAV, OGG, M4A or WEBM." });

            try {
                fs.mkdirSync(userUploadDir(ctx.key), { recursive: true });
                const id = crypto.randomBytes(8).toString("hex");
                const file = `${crypto.randomBytes(16).toString("hex")}.${ext}`;
                fs.writeFileSync(path.join(userUploadDir(ctx.key), file), bytes);

                p.sounds.push({ id, name: cleanUploadName(data?.name, "My sound"), event, file });
                if (!p.equipped.sounds[event]) p.equipped.sounds[event] = id;

                saveAccounts();
                sendProgress(ctx, false);
                reply({ ok: true });
            } catch (error) {
                console.error("uploadSound error:", error);
                reply({ ok: false, error: "Could not save the sound." });
            }
        });

        socket.on("equipSound", (data, callback) => {
            const ctx = progressionUser();
            const reply = typeof callback === "function" ? callback : () => {};
            if (!ctx) return reply({ ok: false, error: "Sign in first." });

            const p = ensureProgress(ctx.user);
            const item = p.sounds.find(s => s.id === String(data?.id || ""));
            if (!item) return reply({ ok: false, error: "Sound not found." });

            if (data?.equip === false) {
                if (p.equipped.sounds[item.event] === item.id) delete p.equipped.sounds[item.event];
            } else {
                p.equipped.sounds[item.event] = item.id;
            }

            saveAccounts();
            sendProgress(ctx, false);
            reply({ ok: true });
        });

        socket.on("deleteSound", (data, callback) => {
            const ctx = progressionUser();
            const reply = typeof callback === "function" ? callback : () => {};
            if (!ctx) return reply({ ok: false, error: "Sign in first." });

            const p = ensureProgress(ctx.user);
            const index = p.sounds.findIndex(s => s.id === String(data?.id || ""));
            if (index < 0) return reply({ ok: false, error: "Sound not found." });

            const [item] = p.sounds.splice(index, 1);
            removeUploadedFile(ctx.key, item.file);
            if (p.equipped.sounds[item.event] === item.id) delete p.equipped.sounds[item.event];

            saveAccounts();
            sendProgress(ctx, false);
            reply({ ok: true });
        });

        socket.on("uploadWallpaper", (data, callback) => {
            const ctx = progressionUser();
            const reply = typeof callback === "function" ? callback : () => {};
            if (!ctx) return reply({ ok: false, error: "Sign in first." });

            const p = ensureProgress(ctx.user);
            // Custom wallpaper uploads are disabled for everyone.
            return reply({ ok: false, error: "Custom wallpapers are not available." });
            if (p.wallpapers.length >= MAX_CUSTOM_WALLPAPERS) return reply({ ok: false, error: `You can keep up to ${MAX_CUSTOM_WALLPAPERS} wallpapers. Delete one first.` });

            const bytes = Buffer.isBuffer(data?.bytes) ? data.bytes : (data?.bytes ? Buffer.from(data.bytes) : null);
            if (!bytes || !bytes.length) return reply({ ok: false, error: "No image received." });
            if (bytes.length > MAX_WALLPAPER_BYTES) return reply({ ok: false, error: "Image is too large (4 MB max)." });

            const ext = sniffImageExt(bytes);
            if (!ext) return reply({ ok: false, error: "Unsupported image. Use PNG, JPG or WEBP." });

            try {
                fs.mkdirSync(userUploadDir(ctx.key), { recursive: true });
                const id = crypto.randomBytes(8).toString("hex");
                const file = `${crypto.randomBytes(16).toString("hex")}.${ext}`;
                fs.writeFileSync(path.join(userUploadDir(ctx.key), file), bytes);

                p.wallpapers.push({ id, name: cleanUploadName(data?.name, "My wallpaper"), file });
                if (!p.equipped.wallpaper) p.equipped.wallpaper = id;

                saveAccounts();
                sendProgress(ctx, false);
                reply({ ok: true });
            } catch (error) {
                console.error("uploadWallpaper error:", error);
                reply({ ok: false, error: "Could not save the wallpaper." });
            }
        });

        socket.on("equipWallpaper", (data, callback) => {
            const ctx = progressionUser();
            const reply = typeof callback === "function" ? callback : () => {};
            if (!ctx) return reply({ ok: false, error: "Sign in first." });

            const p = ensureProgress(ctx.user);
            const id = data?.id ? String(data.id) : null;

            if (id && !p.wallpapers.some(w => w.id === id)) {
                const shopItem = SHOP_ITEMS.get(id);
                if (!shopItem || shopItem.cat !== "wallpaper" || !shopOwns(ctx.user, shopItem)) {
                    return reply({ ok: false, error: "Wallpaper not found." });
                }
            }

            p.equipped.wallpaper = id;
            saveAccounts();
            sendProgress(ctx, false);
            reply({ ok: true });
        });

        socket.on("deleteWallpaper", (data, callback) => {
            const ctx = progressionUser();
            const reply = typeof callback === "function" ? callback : () => {};
            if (!ctx) return reply({ ok: false, error: "Sign in first." });

            const p = ensureProgress(ctx.user);
            const index = p.wallpapers.findIndex(w => w.id === String(data?.id || ""));
            if (index < 0) return reply({ ok: false, error: "Wallpaper not found." });

            const [item] = p.wallpapers.splice(index, 1);
            removeUploadedFile(ctx.key, item.file);
            if (p.equipped.wallpaper === item.id) p.equipped.wallpaper = null;

            saveAccounts();
            sendProgress(ctx, false);
            reply({ ok: true });
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

                try {
                    fs.rmSync(userUploadDir(key), { recursive: true, force: true });
                } catch (_) { /* nothing to remove */ }

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
           WEBRTC VOICE SIGNALING
        ================================================= */

        socket.on("voiceRequestState", () => {
            for (const roomCode of Object.keys(rooms)) {
                const room = rooms[roomCode];
                if (room?.players?.some(p => p.id === socket.id)) {
                    broadcastVoiceState(roomCode);
                    break;
                }
            }
        });

        function relayVoiceSignal(eventName, data) {
            const roomCode = String(data?.roomCode || "").trim().toUpperCase();
            const targetId = String(data?.targetId || "");
            const room = rooms[roomCode];
            if (!room || !targetId || targetId === socket.id) return;

            const sender = room.players.find(p => p.id === socket.id);
            const target = room.players.find(p => p.id === targetId);
            if (!sender || !target) return;

            const senderGroup = getVoiceGroup(room, sender);
            const targetGroup = getVoiceGroup(room, target);
            if (senderGroup === "none" || senderGroup === "silent" || senderGroup !== targetGroup) {
                return;
            }

            io.to(targetId).emit(eventName, {
                fromId: socket.id,
                fromName: sender.name,
                ...data
            });
        }

        socket.on("voiceOffer", data => relayVoiceSignal("voiceOffer", data));
        socket.on("voiceAnswer", data => relayVoiceSignal("voiceAnswer", data));
        socket.on("voiceIceCandidate", data => relayVoiceSignal("voiceIceCandidate", data));


        /* =================================================
           HOST VOICE SETTINGS
           Allow Voice Chat YES/NO + choose up to 5 voice players.
        ================================================= */

        socket.on("setVoiceSettings", data => {
            const roomCode = String(data?.roomCode || "").trim().toUpperCase();
            const room = rooms[roomCode];

            if (!room || room.host !== socket.id) return;

            const error = setRoomVoiceSettings(
                room,
                typeof data?.allowed === "boolean" ? data.allowed : undefined,
                Array.isArray(data?.players) ? data.players : undefined
            );

            if (error) {
                return socket.emit("gameError", error);
            }

            if (room.phase === "lobby") {
                emitLobby(roomCode);
            } else {
                sendGameInformation(roomCode);
            }

            broadcastVoiceState(roomCode);
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

                    // Voice chat: host can turn it off; maximum 5 voice players.
                    voiceChatAllowed: true,
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
                broadcastVoiceState(roomCode);

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
                broadcastVoiceState(roomCode);

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

            broadcastVoiceState(roomCode);
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
            broadcastVoiceState(code);
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
                   VOICE CHAT SELECTION
                   (validated before anything starts)
                ========================= */

                const voiceInput =
                    data.voice && typeof data.voice === "object"
                        ? data.voice
                        : null;

                if (voiceInput) {
                    const voiceCheck = cleanVoiceSelection(
                        room,
                        voiceInput.players
                    );

                    if (voiceCheck.error) {
                        return socket.emit(
                            "gameError",
                            voiceCheck.error
                        );
                    }
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

if (voiceInput) {
    setRoomVoiceSettings(
        room,
        typeof voiceInput.allowed === "boolean" ? voiceInput.allowed : undefined,
        Array.isArray(voiceInput.players) ? voiceInput.players : []
    );
}

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
                broadcastVoiceState(roomCode);

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

                    broadcastVoiceState(roomCode);


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
