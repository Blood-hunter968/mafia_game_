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

/* ---------- Owner-created accounts: display name, secrets ---------- */

const DISCORD_URL = "https://discord.gg/rkzb2eBZz";

function cleanDisplayName(name) {
    return String(name || "").replace(/\s+/g, " ").trim();
}

function isValidDisplayName(name) {
    return /^[\p{L}\p{N}_. -]{3,20}$/u.test(name);
}

/* What other players see. The original username never changes. */
function getDisplayName(user) {
    return (user && (user.displayName || user.username)) || "";
}

/* True if another account already uses this name as a username or display name. */
function isNameTaken(name, exceptKey) {
    const lower = String(name).toLowerCase();
    for (const [key, user] of Object.entries(accountsDb.users)) {
        if (key === exceptKey) continue;
        if (String(user.username).toLowerCase() === lower) return true;
        if (user.displayName && String(user.displayName).toLowerCase() === lower) return true;
    }
    return false;
}

/* Logged-in players always use their account Display Name in rooms. */
function resolvePlayerName(socket, typedName) {
    const key = socketAccounts.get(socket.id);
    const user = key ? accountsDb.users[key] : null;
    return user ? getDisplayName(user) : typedName;
}

/* Same AES-GCM idea as encryptPassword, for reading a secret back with the OTHER credential. */
function decryptSecret(encrypted, secret) {
    try {
        if (!encrypted?.salt || !encrypted.iv || !encrypted.tag || !encrypted.ciphertext) return null;
        const key = crypto.scryptSync(String(secret), Buffer.from(encrypted.salt, "hex"), 32);
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.iv, "hex"));
        decipher.setAuthTag(Buffer.from(encrypted.tag, "hex"));
        return Buffer.concat([
            decipher.update(Buffer.from(encrypted.ciphertext, "hex")),
            decipher.final()
        ]).toString("utf8");
    } catch (_) {
        return null;
    }
}

async function verifyHash(secret, salt, expectedHex) {
    if (!salt || !expectedHex) return false;
    const attempt = await hashPassword(String(secret), salt);
    const a = Buffer.from(attempt, "hex");
    const b = Buffer.from(expectedHex, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function dropSessionsOf(accountKey) {
    for (const [token, key] of accountSessions.entries()) {
        if (key === accountKey) accountSessions.delete(token);
    }
}

function emptyStats() {
    return { kills: 0, saves: 0, detects: 0, civilianVotes: 0, jesterWins: 0, mafiaWins: 0, civilianWins: 0 };
}

/* Points per action: 1 kill = 3, 1 save = 2, 1 detective check = 2,
   1 Jester win = 4, 1 civilian correct Mafia vote = 1,
   1 Mafia team win = 5, 1 Civilian team win = 4. */
const POINT_VALUES = { kills: 3, saves: 2, detects: 2, jesterWins: 4, civilianVotes: 1, mafiaWins: 5, civilianWins: 4 };

/* Points the player EARNED from what they did in games. */
function baseStatPoints(stats) {
    return STAT_KEYS.reduce(
        (sum, key) => sum + (Number(stats?.[key]) || 0) * (POINT_VALUES[key] || 0),
        0
    );
}

/* Rank points = earned points + the Owner's adjustment (stats.bonusPoints, can be negative). */
function totalStats(stats) {
    return Math.max(0, baseStatPoints(stats) + (Number(stats?.bonusPoints) || 0));
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
/* Position of one account on the leaderboard (same order as the Ranks screen, but not limited to 100). */
function getLeaderboardPosition(user) {
    const mine = totalStats(user.stats);
    let position = 1;
    let count = 0;

    for (const other of Object.values(accountsDb.users)) {
        count++;
        if (other === user) continue;

        const total = totalStats(other.stats);

        if (total > mine || (total === mine && String(other.username).localeCompare(String(user.username)) < 0)) {
            position++;
        }
    }

    return { position, count };
}

function getRanksList() {
    return Object.values(accountsDb.users)
        .map(user => ({
            username: user.username,
            displayName: getDisplayName(user),
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
            displayName: user.displayName,
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
        displayName: getDisplayName(user),
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
const SOUND_EVENTS = ["buttonClick", "roundStart", "turnStart", "turnOver", "votingStart", "last10", "gameEnd", "playerDeath"];
/* The game's ORIGINAL sounds. A player can also pick these for any moment
   (for example use the Button Click sound for a new round). Files live in public/sounds/. */
const DEFAULT_SOUND_IDS = ["def_button", "def_death", "def_newround", "def_last10", "def_turnover"];
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
    if (p.equipped.characterStyle !== "minecraft") p.equipped.characterStyle = "current";

    /* Shop wallet + owned items (see the SHOP section below). */
    if (!p.shop || typeof p.shop !== "object") p.shop = {};
    p.shop.points = Math.max(0, Math.floor(Number(p.shop.points) || 0));
    p.shop.earned = Math.max(0, Math.floor(Number(p.shop.earned) || 0));
    if (!Array.isArray(p.shop.owned)) p.shop.owned = [];
    if (!Array.isArray(p.shop.ownedMinecraftSkins)) p.shop.ownedMinecraftSkins = [];
    if (!Array.isArray(p.shop.ownedSongs)) p.shop.ownedSongs = [];
    if (typeof p.equipped.song !== "string") p.equipped.song = null;

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
        ownedSongs: ownedSongIds(user),
        equippedSong: equippedSongId(user),
        freeSong: freeSongId(),
        ownedMinecraftSkins: p.shop.ownedMinecraftSkins.slice(),
        equippedMinecraftSkin: p.equipped.minecraftSkin || null,
        characterStyle: p.equipped.characterStyle,
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

const SHOP_POINTS_PER_GAME = 10;        // shop points for a LOSS (finished game): +10
const SHOP_POINTS_WIN_BONUS = 10;       // extra on a WIN, so a win = 10 + 10 = +20 shop points
const GRANDFATHER_EXISTING_TAGS = true; // players who already unlocked tags by score keep them
const MAX_SHOP_PRICE = 1000000;

const CHARACTER_SLOTS = ["face", "tone", "hair", "shirt", "suit", "pants", "shoes", "hat", "mask", "accessory"];
const REQUIRED_SLOT_DEFAULTS = { face: "face_basic", shirt: "shirt_basic", pants: "pants_basic", shoes: "shoes_basic" };

const SHOP_CATEGORIES = [
    { key: "face",      group: "character", label: "Faces",       icon: "🙂" },
    { key: "tone",      group: "character", label: "Skin Tones",  icon: "🎨" },
    { key: "hair",      group: "character", label: "Hairstyles",  icon: "💇" },
    { key: "shirt",     group: "character", label: "Shirts",      icon: "👕" },
    { key: "suit",      group: "character", label: "Suits",       icon: "🤵" },
    { key: "pants",     group: "character", label: "Pants",       icon: "👖" },
    { key: "shoes",     group: "character", label: "Shoes",       icon: "👟" },
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
shopAdd({ id: "hair_buzz",     cat: "hair", name: "Buzz Cut",      price: 100, art: "<path d='M31 34 Q30 16 50 16 Q70 16 69 34 Q62 26 50 26 Q38 26 31 34Z' fill='#3a3a3a'/>" });
shopAdd({ id: "hair_sidepart", cat: "hair", name: "Side Part",     price: 110, art: "<path d='M29 37 Q26 12 50 12 Q74 12 71 37 Q66 23 52 22 Q40 21 29 37Z' fill='#7a4a22'/><path d='M40 15 Q36 22 33 28' stroke='#4d2e12' stroke-width='1.6' fill='none' stroke-linecap='round'/>" });
shopAdd({ id: "hair_afro",     cat: "hair", name: "Afro",          price: 150, art: "<g fill='#1a1210'><circle cx='34' cy='19' r='9'/><circle cx='50' cy='12' r='10'/><circle cx='66' cy='19' r='9'/><circle cx='27' cy='31' r='7'/><circle cx='73' cy='31' r='7'/><circle cx='42' cy='13' r='8'/><circle cx='58' cy='13' r='8'/></g>" });
shopAdd({ id: "hair_ponytail", cat: "hair", name: "Ponytail",      price: 130, art: "<path d='M30 36 Q28 13 50 13 Q72 13 70 36 Q64 24 50 24 Q36 24 30 36Z' fill='#8b5a2b'/><path d='M68 26 Q88 28 83 58 Q79 46 70 40Z' fill='#8b5a2b'/><circle cx='69' cy='28' r='2.6' fill='#d62828'/>" });
shopAdd({ id: "hair_manbun",   cat: "hair", name: "Man Bun",       price: 140, art: "<path d='M29 37 Q27 11 52 12 Q73 13 71 37 Q66 22 50 21 Q36 21 29 37Z' fill='#2b1d14'/><circle cx='50' cy='8' r='7' fill='#2b1d14'/><rect x='46' y='13' width='8' height='2.6' rx='1.3' fill='#d62828'/>" });
shopAdd({ id: "hair_pinkbob",  cat: "hair", name: "Pink Bob",      price: 160, art: "<path d='M28 46 Q24 11 50 12 Q76 11 72 46 L66 48 L66 30 Q50 20 34 30 L34 48 Z' fill='#ff5fa2'/>" });
shopAdd({ id: "hair_silver",   cat: "hair", name: "Silver Slick",  price: 180, art: "<path d='M29 37 Q27 11 52 12 Q73 13 71 37 Q66 22 50 21 Q36 21 29 37Z' fill='#d9d9e3'/><path d='M38 19 Q52 14 65 21' stroke='#fff' stroke-width='1.6' fill='none' stroke-linecap='round'/>" });
shopAdd({ id: "hair_blue",     cat: "hair", name: "Blue Spikes",   price: 150, art: "<path d='M30 36 L27 14 L38 24 L42 7 L50 22 L58 7 L62 24 L73 14 L70 36 Q60 24 50 24 Q40 24 30 36Z' fill='#2f7bff'/>" });
shopAdd({ id: "hair_braids",   cat: "hair", name: "Long Braids",   price: 200, art: "<path d='M29 38 Q27 12 50 12 Q73 12 71 38 Q64 24 50 24 Q36 24 29 38Z' fill='#1a1210'/><path d='M30 34 L30 72 M34 36 L34 74 M66 36 L66 74 M70 34 L70 72' stroke='#1a1210' stroke-width='4' stroke-linecap='round'/>" });

/* ----- Shirts / Suits / Pants ----- */
function shirtArt(color, extra) {
    return `<rect x='28' y='60' width='44' height='42' rx='6' fill='${color}'/><rect x='15' y='62' width='14' height='24' rx='7' fill='${color}'/><rect x='71' y='62' width='14' height='24' rx='7' fill='${color}'/>${extra || ""}`;
}
function suitArt(color, tie, trim) {
    return `<rect x='26' y='59' width='48' height='46' rx='6' fill='${color}'/><rect x='13' y='61' width='15' height='32' rx='7' fill='${color}'/><rect x='72' y='61' width='15' height='32' rx='7' fill='${color}'/><path d='M42 60 L58 60 L50 82 Z' fill='#f4f4f4'/><path d='M50 64 L46.5 70 L50 90 L53.5 70 Z' fill='${tie}'/><path d='M42 60 L33 60 L47 90 L50 82 Z' fill='${trim}'/><path d='M58 60 L67 60 L53 90 L50 82 Z' fill='${trim}'/><circle cx='50' cy='96' r='1.6' fill='#111'/><circle cx='50' cy='102' r='1.6' fill='#111'/>`;
}
function pantsArt(color) {
    /* Blocky Roblox-style legs. Shoes are now their own item (see shoesArt). */
    return `<rect x='31' y='96' width='17' height='36' rx='2' fill='${color}'/><rect x='52' y='96' width='17' height='36' rx='2' fill='${color}'/>`;
}
function shoesArt(color, sole) {
    return `<rect x='29' y='130' width='21' height='9' rx='2.5' fill='${color}'/><rect x='50' y='130' width='21' height='9' rx='2.5' fill='${color}'/><rect x='29' y='136' width='21' height='3' rx='1.5' fill='${sole || "#0e0e10"}'/><rect x='50' y='136' width='21' height='3' rx='1.5' fill='${sole || "#0e0e10"}'/>`;
}
shopAdd({ id: "shirt_basic",  cat: "shirt", name: "Grey Tee",       price: 0,   free: true, art: shirtArt("#8a8f98") });
shopAdd({ id: "shirt_white",  cat: "shirt", name: "White Shirt",    price: 150, art: shirtArt("#f2f2f2", "<path d='M50 60 V102' stroke='#cfcfcf' stroke-width='1.2'/>") });
shopAdd({ id: "shirt_red",    cat: "shirt", name: "Red Shirt",      price: 150, art: shirtArt("#c62828") });
shopAdd({ id: "shirt_blue",   cat: "shirt", name: "Blue Shirt",     price: 150, art: shirtArt("#1e63c9") });
shopAdd({ id: "shirt_green",  cat: "shirt", name: "Green Shirt",    price: 150, art: shirtArt("#2e7d32") });
shopAdd({ id: "shirt_stripe", cat: "shirt", name: "Striped Shirt",  price: 170, art: shirtArt("#f2f2f2", "<g stroke='#c62828' stroke-width='3'><path d='M28 68 H72 M28 78 H72 M28 88 H72 M28 98 H72'/><path d='M15 70 H29 M15 80 H29 M71 70 H85 M71 80 H85'/></g>") });
shopAdd({ id: "shirt_hawaii", cat: "shirt", name: "Hawaiian Shirt", price: 200, art: shirtArt("#17a2b8", "<g fill='#ffd23f'><circle cx='36' cy='70' r='3'/><circle cx='56' cy='76' r='3'/><circle cx='42' cy='88' r='3'/><circle cx='64' cy='94' r='3'/></g><g fill='#ff6b9d'><circle cx='62' cy='67' r='2.6'/><circle cx='34' cy='82' r='2.6'/><circle cx='52' cy='96' r='2.6'/></g>") });
shopAdd({ id: "shirt_black",   cat: "shirt", name: "Black Tee",      price: 150, art: shirtArt("#18181b") });
shopAdd({ id: "shirt_yellow",  cat: "shirt", name: "Yellow Shirt",   price: 150, art: shirtArt("#e8b923") });
shopAdd({ id: "shirt_purple",  cat: "shirt", name: "Purple Shirt",   price: 150, art: shirtArt("#6a2fb5") });
shopAdd({ id: "shirt_orange",  cat: "shirt", name: "Orange Shirt",   price: 150, art: shirtArt("#e8661a") });
shopAdd({ id: "shirt_pink",    cat: "shirt", name: "Pink Shirt",     price: 150, art: shirtArt("#ff6fa5") });
shopAdd({ id: "shirt_plaid",   cat: "shirt", name: "Plaid Shirt",    price: 180, art: shirtArt("#a82828", "<g stroke='#1b1b1b' stroke-width='2.4' opacity='.75'><path d='M28 70 H72 M28 84 H72 M28 98 H72 M38 60 V102 M50 60 V102 M62 60 V102'/><path d='M15 72 H29 M15 82 H29 M71 72 H85 M71 82 H85'/></g>") });
shopAdd({ id: "shirt_skull",   cat: "shirt", name: "Skull Tee",      price: 220, art: shirtArt("#18181b", "<ellipse cx='50' cy='78' rx='9' ry='8' fill='#f2f2f2'/><rect x='45' y='83' width='10' height='6' rx='1.5' fill='#f2f2f2'/><circle cx='46' cy='78' r='2.4' fill='#18181b'/><circle cx='54' cy='78' r='2.4' fill='#18181b'/><path d='M49 84 V88 M51 84 V88' stroke='#18181b' stroke-width='.9'/>") });
shopAdd({ id: "shirt_jersey",  cat: "shirt", name: "Sport Jersey",   price: 220, art: shirtArt("#1e63c9", "<path d='M28 66 H72' stroke='#f2f2f2' stroke-width='3'/><path d='M15 68 H29 M71 68 H85' stroke='#f2f2f2' stroke-width='3'/><text x='50' y='92' text-anchor='middle' font-family='Arial Black, Arial, sans-serif' font-weight='900' font-size='20' fill='#f2f2f2'>10</text>") });
shopAdd({ id: "shirt_hoodie",  cat: "shirt", name: "Grey Hoodie",    price: 250, art: shirtArt("#6b7078", "<path d='M38 60 Q50 72 62 60 Q50 66 38 60Z' fill='#4f535a'/><path d='M46 66 V80 M54 66 V80' stroke='#e8e8e8' stroke-width='1.6' stroke-linecap='round'/><path d='M36 90 H64 L61 101 H39Z' fill='#585c63'/>") });
shopAdd({ id: "shirt_leather", cat: "shirt", name: "Leather Jacket", price: 320, art: shirtArt("#17171a", "<path d='M50 60 V102' stroke='#8a8a94' stroke-width='1.6'/><path d='M42 60 L50 76 L36 74Z M58 60 L50 76 L64 74Z' fill='#2a2a30'/><path d='M34 90 H44' stroke='#8a8a94' stroke-width='1.4'/><path d='M30 66 Q34 64 38 66' stroke='#3a3a42' stroke-width='1.2' fill='none'/>") });

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
shopAdd({ id: "pants_navy",    cat: "pants", name: "Navy Pants",    price: 200, art: pantsArt("#16264a") });
shopAdd({ id: "pants_brown",   cat: "pants", name: "Brown Pants",   price: 200, art: pantsArt("#6b4423") });
shopAdd({ id: "pants_olive",   cat: "pants", name: "Army Green",    price: 220, art: pantsArt("#5a6b34") });
shopAdd({ id: "pants_purple",  cat: "pants", name: "Purple Pants",  price: 230, art: pantsArt("#5b2a91") });
shopAdd({ id: "pants_camo",    cat: "pants", name: "Camo Pants",    price: 260, art: pantsArt("#5a6b34") + "<g fill='#33401d'><ellipse cx='38' cy='106' rx='5' ry='3'/><ellipse cx='42' cy='122' rx='4' ry='3'/><ellipse cx='60' cy='108' rx='5' ry='3'/><ellipse cx='58' cy='124' rx='4' ry='3'/></g><g fill='#8a7a4a'><ellipse cx='36' cy='118' rx='3' ry='2'/><ellipse cx='63' cy='116' rx='3' ry='2'/></g>" });
shopAdd({ id: "pants_pinstripe", cat: "pants", name: "Pinstripe Pants", price: 280, art: pantsArt("#2a2a33") + "<g stroke='#6b6b78' stroke-width='.8'><path d='M36 96 V132 M42 96 V132 M58 96 V132 M64 96 V132'/></g>" });
shopAdd({ id: "pants_leather", cat: "pants", name: "Leather Pants", price: 300, art: pantsArt("#101012") + "<g stroke='#4a4a54' stroke-width='1.4' stroke-linecap='round'><path d='M36 102 V118'/><path d='M57 102 V118'/></g>" });
shopAdd({ id: "pants_gold",   cat: "pants", name: "Golden Pants",  price: 500, art: pantsArt("#c9a227") });

/* ----- Shoes (Roblox-style blocky shoes) ----- */
shopAdd({ id: "shoes_basic",   cat: "shoes", name: "Black Shoes",    price: 0,   free: true, art: shoesArt("#1b1b1b") });
shopAdd({ id: "shoes_white",   cat: "shoes", name: "White Sneakers", price: 120, art: shoesArt("#f2f2f2", "#9a9a9a") });
shopAdd({ id: "shoes_red",     cat: "shoes", name: "Red Sneakers",   price: 130, art: shoesArt("#c62828", "#f2f2f2") });
shopAdd({ id: "shoes_blue",    cat: "shoes", name: "Blue Sneakers",  price: 130, art: shoesArt("#1e63c9", "#f2f2f2") });
shopAdd({ id: "shoes_brown",   cat: "shoes", name: "Brown Boots",    price: 160, art: shoesArt("#6b4423", "#2a1a0c") });
shopAdd({ id: "shoes_dress",   cat: "shoes", name: "Dress Shoes",    price: 180, art: shoesArt("#0b0b0d", "#3a3a40") });
shopAdd({ id: "shoes_green",   cat: "shoes", name: "Green Sneakers", price: 130, art: shoesArt("#2e7d32", "#f2f2f2") });
shopAdd({ id: "shoes_gold",    cat: "shoes", name: "Golden Shoes",   price: 400, art: shoesArt("#d4af37", "#8a6d12") });

/* ----- Hats (the fedora is drawn; the rest are emoji) ----- */
shopAdd({ id: "hat_cap",     cat: "hat", name: "Cap",         price: 150, emoji: { t: "🧢", x: 50, y: 27, s: 34 } });
shopAdd({ id: "hat_grad",    cat: "hat", name: "Graduate",    price: 200, emoji: { t: "🎓", x: 50, y: 25, s: 36 } });
shopAdd({ id: "hat_fedora",  cat: "hat", name: "Fedora",      price: 250, art: "<ellipse cx='50' cy='23' rx='31' ry='7' fill='#2f2f2f'/><path d='M33 23 Q33 3 50 3 Q67 3 67 23Z' fill='#444'/><rect x='33' y='16' width='34' height='5' fill='#a02020'/>" });
shopAdd({ id: "hat_helmet",  cat: "hat", name: "Helmet",      price: 250, emoji: { t: "🪖", x: 50, y: 28, s: 36 } });
shopAdd({ id: "hat_tophat",  cat: "hat", name: "Top Hat",     price: 300, emoji: { t: "🎩", x: 50, y: 26, s: 38 } });
shopAdd({ id: "hat_crown",   cat: "hat", name: "Golden Crown", price: 800, emoji: { t: "👑", x: 50, y: 24, s: 34 } });

/* ----- Masks (emoji over the face) ----- */
/* ----- Skin tones (colors the head, neck and hands; works with any face) ----- */
shopAdd({ id: "tone_porcelain", cat: "tone", name: "Porcelain", price: 80, skin: "#f8dcc6" });
shopAdd({ id: "tone_fair", cat: "tone", name: "Fair", price: 80, skin: "#f1c9a5" });
shopAdd({ id: "tone_light", cat: "tone", name: "Light", price: 80, skin: "#e8b98a" });
shopAdd({ id: "tone_sand", cat: "tone", name: "Sand", price: 80, skin: "#d8a574" });
shopAdd({ id: "tone_honey", cat: "tone", name: "Honey", price: 80, skin: "#cf9a63" });
shopAdd({ id: "tone_bronze", cat: "tone", name: "Bronze", price: 80, skin: "#a9713f" });
shopAdd({ id: "tone_caramel", cat: "tone", name: "Caramel", price: 80, skin: "#8d5524" });
shopAdd({ id: "tone_mocha", cat: "tone", name: "Mocha", price: 80, skin: "#5c3a21" });
shopAdd({ id: "tone_espresso", cat: "tone", name: "Espresso", price: 80, skin: "#3d2314" });
shopAdd({ id: "tone_zombie", cat: "tone", name: "Zombie Green", price: 150, skin: "#7fb069" });
shopAdd({ id: "tone_ocean", cat: "tone", name: "Ocean Blue", price: 150, skin: "#4a90d9" });
shopAdd({ id: "tone_royal", cat: "tone", name: "Royal Purple", price: 150, skin: "#8e5bd0" });
shopAdd({ id: "tone_blood", cat: "tone", name: "Blood Red", price: 150, skin: "#c0392b" });
shopAdd({ id: "tone_ghost", cat: "tone", name: "Ghost Grey", price: 150, skin: "#b8bcc4" });
shopAdd({ id: "tone_gold", cat: "tone", name: "Pure Gold", price: 250, skin: "#e6b800" });

shopAdd({ id: "mask_surgical", cat: "mask", name: "Face Mask",    price: 300, emoji: { t: "😷", x: 50, y: 48, s: 38 } });
shopAdd({ id: "mask_theatre",  cat: "mask", name: "Theatre Mask", price: 300, emoji: { t: "🎭", x: 50, y: 49, s: 50 } });
shopAdd({ id: "mask_clown",    cat: "mask", name: "Clown Mask",   price: 350, emoji: { t: "🤡", x: 50, y: 49, s: 50 } });
shopAdd({ id: "mask_oni",      cat: "mask", name: "Oni Mask",     price: 400, emoji: { t: "👹", x: 50, y: 49, s: 50 } });
shopAdd({ id: "mask_robot",    cat: "mask", name: "Robot Mask",   price: 400, emoji: { t: "🤖", x: 50, y: 49, s: 50 } });
shopAdd({ id: "mask_skull",    cat: "mask", name: "Skull Mask",   price: 450, emoji: { t: "💀", x: 50, y: 49, s: 50 } });
shopAdd({ id: "mask_vendetta", cat: "mask", name: "Vendetta Mask", price: 500, emoji: { t: "🎭", x: 50, y: 49, s: 50 } });
shopAdd({ id: "mask_demon", cat: "mask", name: "Demon Mask", price: 550, emoji: { t: "👺", x: 50, y: 49, s: 50 } });

shopAdd({ id: "hat_crown", cat: "hat", name: "Royal Crown", price: 450, emoji: { t: "👑", x: 50, y: 12, s: 30 } });
shopAdd({ id: "hat_top_hat", cat: "hat", name: "Top Hat", price: 300, emoji: { t: "🎩", x: 50, y: 15, s: 30 } });
shopAdd({ id: "suit_tuxedo", cat: "suit", name: "Classic Tuxedo", price: 500, art: "<path d=\"M34 51 L50 65 L66 51 L72 94 L28 94 Z\" fill=\"#111827\"/><path d=\"M43 55 L50 65 L57 55 L53 82 L47 82 Z\" fill=\"#f5f5f5\"/>" });
shopAdd({ id: "suit_red", cat: "suit", name: "Crimson Suit", price: 550, art: "<path d=\"M34 51 L50 63 L66 51 L72 94 L28 94 Z\" fill=\"#791b25\"/><path d=\"M43 55 L50 63 L57 55 L53 82 L47 82 Z\" fill=\"#eeeeee\"/>" });

/* ----- Accessories (emoji) ----- */
shopAdd({ id: "acc_rose",       cat: "accessory", name: "Red Rose",    price: 120, emoji: { t: "🌹", x: 80, y: 102, s: 22 } });
shopAdd({ id: "acc_bow",        cat: "accessory", name: "Bow",         price: 130, emoji: { t: "🎀", x: 50, y: 70, s: 20 } });
shopAdd({ id: "acc_scarf",      cat: "accessory", name: "Scarf",       price: 150, emoji: { t: "🧣", x: 50, y: 70, s: 28 } });
shopAdd({ id: "acc_shades",     cat: "accessory", name: "Sunglasses",  price: 200, emoji: { t: "🕶️", x: 50, y: 41, s: 26 } });
shopAdd({ id: "acc_headphones", cat: "accessory", name: "Headphones",  price: 250, emoji: { t: "🎧", x: 50, y: 43, s: 40 } });
shopAdd({ id: "acc_chain",      cat: "accessory", name: "Gold Chain",  price: 300, emoji: { t: "🔗", x: 50, y: 74, s: 16 } });
shopAdd({ id: "acc_gem",        cat: "accessory", name: "Diamond Pin", price: 400, emoji: { t: "💎", x: 61, y: 74, s: 14 } });
shopAdd({ id: "acc_glasses",    cat: "accessory", name: "Round Glasses", price: 150, emoji: { t: "👓", x: 50, y: 41, s: 26 } });
shopAdd({ id: "acc_eyepatch",   cat: "accessory", name: "Eye Patch",   price: 160, art: "<path d='M33 26 L64 40' stroke='#111' stroke-width='1.6'/><ellipse cx='57' cy='35' rx='6.5' ry='5.5' fill='#111'/>" });
shopAdd({ id: "acc_watch",      cat: "accessory", name: "Watch",       price: 180, emoji: { t: "⌚", x: 17, y: 86, s: 14 } });
shopAdd({ id: "acc_beads",      cat: "accessory", name: "Beads",       price: 200, emoji: { t: "📿", x: 50, y: 72, s: 22 } });
shopAdd({ id: "acc_belt",       cat: "accessory", name: "Gold Buckle Belt", price: 220, art: "<rect x='30' y='93' width='40' height='5' fill='#3b2a1a'/><rect x='45' y='92' width='10' height='7' rx='1' fill='#d4af37'/><rect x='47.5' y='94' width='5' height='3' fill='#3b2a1a'/>" });
shopAdd({ id: "acc_bowtie",     cat: "accessory", name: "Bow Tie",     price: 220, art: "<path d='M50 64 L38 58 L38 70 Z M50 64 L62 58 L62 70 Z' fill='#b3001b'/><circle cx='50' cy='64' r='3' fill='#7a0012'/>" });
shopAdd({ id: "acc_badge",      cat: "accessory", name: "Gold Badge",  price: 250, emoji: { t: "⭐", x: 62, y: 74, s: 15 } });
shopAdd({ id: "acc_medal",      cat: "accessory", name: "Medal",       price: 300, emoji: { t: "🏅", x: 50, y: 78, s: 18 } });
shopAdd({ id: "acc_briefcase",  cat: "accessory", name: "Briefcase",   price: 320, emoji: { t: "💼", x: 17, y: 108, s: 26 } });
shopAdd({ id: "acc_knife",      cat: "accessory", name: "Dagger",      price: 380, emoji: { t: "🗡️", x: 83, y: 104, s: 24 } });
shopAdd({ id: "acc_gloves",     cat: "accessory", name: "Boxing Gloves", price: 350, emoji: { t: "🥊", x: 82, y: 92, s: 22 } });

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

/* ----- Sounds -----
   These use YOUR own sound files. Put each file in  public/sounds/<base>.mp3
   (.wav / .ogg / .m4a / .webm also work; the server finds whichever one you used).
     braan.mp3   gunshot.mp3   police-siren.mp3   power-down.mp3   shock.mp3   train.mp3
   To add a new sound, add one line here with its file name (without extension) as "base". */
shopAdd({ id: "snd_braan",     cat: "sound", name: "Braan",        price: 300, base: "braan",        icon: "📯" });
shopAdd({ id: "snd_gunshot",   cat: "sound", name: "Gunshot",      price: 350, base: "gunshot",      icon: "💥" });
shopAdd({ id: "snd_siren",     cat: "sound", name: "Police Siren", price: 350, base: "police-siren", icon: "🚨" });
shopAdd({ id: "snd_powerdown", cat: "sound", name: "Power Down",   price: 300, base: "power-down",   icon: "🔋" });
shopAdd({ id: "snd_shock",     cat: "sound", name: "Shock",        price: 350, base: "shock",        icon: "⚡" });
shopAdd({ id: "snd_train",     cat: "sound", name: "Train",        price: 400, base: "train",        icon: "🚆" });

const SHOP_ITEMS = new Map(SHOP_CATALOG.map(item => [item.id, item]));

function ensureShopDb() {
    if (!accountsDb.shop || typeof accountsDb.shop !== "object") accountsDb.shop = {};
    if (!accountsDb.shop.prices || typeof accountsDb.shop.prices !== "object") accountsDb.shop.prices = {};
    if (!accountsDb.shop.disabled || typeof accountsDb.shop.disabled !== "object") accountsDb.shop.disabled = {};
    if (!accountsDb.shop.music || typeof accountsDb.shop.music !== "object") accountsDb.shop.music = {};
    if (!accountsDb.shop.music.prices || typeof accountsDb.shop.music.prices !== "object") accountsDb.shop.music.prices = {};
    if (!accountsDb.shop.skins || typeof accountsDb.shop.skins !== "object") accountsDb.shop.skins = {};
    return accountsDb.shop;
}

/* =========================================================
   MUSIC SONGS + MINECRAFT SKIN CATALOG (owner-manageable)
   - Put the 7 song files in  public/music/  (names below, exactly).
   - Minecraft skin pictures live in  public/skins/<file>.png
   - The Owner can change prices, choose the free song, enable / disable
     items and add / remove skins. Everything is saved in accounts.json.
========================================================= */

const MUSIC_URL_DIR = "/music/";
const DEFAULT_FREE_SONG = "song_funk";

const MUSIC_SONGS = [
    { id: "song_funk",     name: "FUNK CRIMINAL",             file: "FUNK CRIMINAL.mp3",             seconds: 83.25,  price: 300 },
    { id: "song_control",  name: "M4GN - EL CONTROL",         file: "M4GN - EL CONTROL.mp3",         seconds: 99.79,  price: 300 },
    { id: "song_elder",    name: "MONTAGEM ELDER (SLOWED)",   file: "MONTAGEM ELDER (SLOWED).mp3",   seconds: 100.75, price: 300 },
    { id: "song_unknown",  name: "MONTAGEM UNKNOWN",          file: "MONTAGEM UNKNOWN.mp3",          seconds: 72.10,  price: 300 },
    { id: "song_batidao",  name: "NO BATIDÃO (Extended)",     file: "NO BATIDÃO (Extended).mp3",     seconds: 318.56, price: 500 },
    { id: "song_semtempo", name: "Sem Tempo",                 file: "Sem Tempo.mp3",                 seconds: 98.06,  price: 300 },
    { id: "song_chubina",  name: "ჩუბინა",                    file: "ჩუბინა.mp3",                    seconds: 90.64,  price: 300 }
];

const DEFAULT_MINECRAFT_SKINS = {
    "clownpierce": { name: "ClownPierce", price: 100 },
    "flamefrags": { name: "FlameFrags", price: 100 },
    "gloden king": { name: "Golden King", price: 100 },
    "jaden_man": { name: "Jaden Man", price: 100 },
    "jamatop": { name: "Jamatop", price: 100 },
    "mafia": { name: "Mafia", price: 100 },
    "manepear": { name: "ManePear", price: 100 },
    "minetech": { name: "MineTech", price: 100 },
    "ninja": { name: "Ninja", price: 100 },
    "parrot": { name: "Parrot", price: 100 },
    "parrotx2 king": { name: "ParrotX2 King", price: 100 },
    "spoke": { name: "Spoke", price: 100 },
    "steve": { name: "Steve", price: 100 },
    "technoblade": { name: "Technoblade", price: 100 },
    "theobalthebird": { name: "TheobaldTheBird", price: 100 },
    "warroir": { name: "Warrior", price: 100 },
    "wemmbu tech": { name: "Wemmbu Tech", price: 100 },
    "wemmbu": { name: "Wemmbu", price: 100 },
    "wifize": { name: "Wifize", price: 100 },
    "wizerd": { name: "Wizard", price: 100 }
};

function isShopDisabled(id) {
    return Boolean(ensureShopDb().disabled[id]);
}

function freeSongId() {
    const id = ensureShopDb().music.freeId;
    return MUSIC_SONGS.some(song => song.id === id) ? id : DEFAULT_FREE_SONG;
}

function songPriceOf(song) {
    if (!song || song.id === freeSongId()) return 0;
    const override = Number(ensureShopDb().music.prices[song.id]);
    if (Number.isFinite(override) && override >= 0) return Math.floor(override);
    return song.price;
}

function publicSong(song) {
    return {
        id: song.id,
        name: song.name,
        url: MUSIC_URL_DIR + encodeURIComponent(song.file),
        seconds: song.seconds,
        price: songPriceOf(song),
        free: song.id === freeSongId(),
        enabled: !isShopDisabled(song.id)
    };
}

function ownsSong(user, songId) {
    if (songId === freeSongId()) return true;
    return ensureProgress(user).shop.ownedSongs.includes(songId);
}

function ownedSongIds(user) {
    return MUSIC_SONGS.filter(song => ownsSong(user, song.id)).map(song => song.id);
}

function equippedSongId(user) {
    const chosen = ensureProgress(user).equipped.song;
    if (chosen && MUSIC_SONGS.some(song => song.id === chosen) && ownsSong(user, chosen)) return chosen;
    return freeSongId();
}

function getSkinInfo(file) {
    file = String(file || "");
    const cfg = ensureShopDb().skins[file];
    if (cfg && cfg.removed) return null;

    const base = Object.prototype.hasOwnProperty.call(DEFAULT_MINECRAFT_SKINS, file) ? DEFAULT_MINECRAFT_SKINS[file] : null;
    if (!base && !(cfg && cfg.custom)) return null;

    const price = Number(cfg && cfg.price);
    return {
        file,
        name: (cfg && cfg.name) || (base && base.name) || file,
        price: Number.isFinite(price) && price >= 0 ? Math.floor(price) : (base ? base.price : 100),
        enabled: !isShopDisabled("skin:" + file),
        custom: !base
    };
}

function publicSkins() {
    const files = new Set([...Object.keys(DEFAULT_MINECRAFT_SKINS), ...Object.keys(ensureShopDb().skins)]);
    return Array.from(files).map(getSkinInfo).filter(Boolean);
}

function shopConfigPayload() {
    return {
        songs: MUSIC_SONGS.map(publicSong),
        skins: publicSkins(),
        freeSong: freeSongId(),
        disabled: { ...ensureShopDb().disabled }
    };
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
const SHOP_FILE_DIRS = { wallpaper: ["wallpapers", "wallpaper"], logo: ["logos", "logo"], sound: ["sounds", "sound"] };
const SHOP_FILE_EXTS = ["jpg", "jpeg", "png", "webp", "gif", "avif"];
const SHOP_SOUND_EXTS = ["mp3", "wav", "ogg", "m4a", "webm", "aac"];
const shopExtsFor = item => (item.cat === "sound" ? SHOP_SOUND_EXTS : SHOP_FILE_EXTS);
const shopDefaultExt = item => (item.cat === "sound" ? "mp3" : item.cat === "logo" ? "png" : "jpg");

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
                const hit = files.find(file => shopNorm(file) === name && shopExtsFor(item).includes(file.split(".").pop().toLowerCase()));
                if (hit) return `/${dir}/${encodeURIComponent(hit)}`;
            }
        }
    }

    // Nothing found yet: still return the normal path so it works once the file is added.
    return `/${dirs[0]}/${item.base}.${shopDefaultExt(item)}`;
}

/* Prints (when the server starts) which wallpaper / logo pictures were found and which are missing. */
(function logShopPictures() {
    try {
        const roots = Array.from(new Set([path.resolve("public"), path.join(__dirname, "public")]));
        console.log("[shop] looking for pictures in: " + roots.map(r => path.join(r, "wallpapers|logos")).join("  and  "));
        SHOP_CATALOG.filter(item => item.base).forEach(item => {
            const url = shopFileUrl(item);
            const found = roots.some(root => fs.existsSync(path.join(root, decodeURIComponent(url))));
            console.log(`[shop] ${found ? "OK     " : "MISSING"} ${item.cat.padEnd(9)} ${item.name.padEnd(15)} -> ${found ? url : "put a file named " + item.base + (item.cat === "sound" ? ".mp3" : ".jpg/.png") + " in public" + url.replace(/[^/]+$/, "")}`);
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
        free: Boolean(item.free),
        enabled: !isShopDisabled(item.id)
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
    return { face: "face_basic", tone: null, hair: null, shirt: "shirt_basic", suit: null, pants: "pants_basic", shoes: "shoes_basic", hat: null, mask: null, accessory: null };
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

    /* Minecraft style: other players see the equipped Minecraft skin instead of the normal character. */
    const prog = ensureProgress(user);
    const mcSkin = prog.equipped.minecraftSkin;
    if (prog.equipped.characterStyle === "minecraft" && mcSkin && prog.shop.ownedMinecraftSkins.includes(mcSkin)) {
        look.minecraft = mcSkin;
    }

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
                registered: Boolean(player.account),
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

            detectiveCheckAnnounce:
                room.detectiveCheckAnnounce !== false,

            voicePlayerIds:
                getVoicePlayerIds(room),

            soundboardPlayerIds:
                getSoundboardPlayerIds(room),

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

                detectiveCheckAnnounce:
                    room.detectiveCheckAnnounce !== false,

                voicePlayerIds:
                    getVoicePlayerIds(room),

                soundboardPlayerIds:
                    getSoundboardPlayerIds(room),

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

    // Grandma reflects the attack no matter what, so a Doctor protecting
    // her does NOT count as a save.
    const mafiaTargetIsGrandma =
        Boolean(
            mafiaTarget &&
            room.players.some(
                p => p.id === mafiaTarget &&
                     p.alive &&
                     p.role === "Grandma"
            )
        );

    const doctorSavedTarget =
        Boolean(
            mafiaTarget &&
            !mafiaTargetIsGrandma &&
            protectedPlayers.has(mafiaTarget)
        );

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

    // Read these BEFORE the night actions are reset.
    // Detective: did a Detective check a real Mafia member tonight?
    // (Godfather shows as NOT MAFIA, so he does not count.)
    const detectiveKnowsMafia =
        room.detectiveCheckAnnounce !== false &&
        Object.values(room.nightActions.detective || {}).some(targetId => {
            const checked = room.players.find(p => p.id === targetId);
            return Boolean(checked && isDetectiveMafia(checked.role));
        });

    // Doctor: did a Doctor actually choose someone tonight?
    const doctorActed =
        Object.keys(room.nightActions.doctor || {}).length > 0;

    resetNightActions(room);

    const names =
        eliminatedPlayers.map(
            p => p.name
        );

    const detectiveLine =
        detectiveKnowsMafia
            ? " The detective knows one of the mafia."
            : "";

    if (doctorSavedTarget) {

        // Doctor protected the attacked player.
        announce(
            roomCode,
            "☀️ Nobody was eliminated. The doctor saved the person." + detectiveLine,
            "success"
        );

    } else if (names.length) {

        // Someone died (this includes a Grandma reflect, which is never a save).
        const verb = names.length > 1 ? "were" : "was";

        const doctorLine = doctorActed
            ? " The doctor saved the wrong person."
            : " The doctor did not save the person.";

        announce(
            roomCode,
            `☀️ ${names.join(", ")} ${verb} killed.${doctorLine}${detectiveLine}`,
            "danger"
        );

    } else {

        announce(
            roomCode,
            "☀️ Nobody died tonight." + detectiveLine,
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

/* =========================================================
   LOBBY CHAT (server side)
   Text chat while the room is still in the lobby, so players
   without a microphone can talk too. Checked here: the sender
   must really be in the room, the room must be in the lobby,
   and there is a spam limit. The last messages are kept so
   people who join later can read them.
========================================================= */

const LOBBY_CHAT_MAX_LENGTH = 200;
const LOBBY_CHAT_HISTORY = 50;
const LOBBY_CHAT_MIN_GAP_MS = 600;
const LOBBY_CHAT_BURST_LIMIT = 8;
const LOBBY_CHAT_BURST_WINDOW_MS = 10000;

function findRoomCodeBySocket(socketId) {
    for (const code of Object.keys(rooms)) {
        if (rooms[code]?.players?.some(p => p.id === socketId && p.connected !== false)) {
            return code;
        }
    }

    return null;
}

/* =========================================================
   SOUNDBOARD (server side)
   - 12 sounds. The audio files live in public/soundboard/.
   - The HOST chooses which REGISTERED players may play sounds
     (guests can never be selected). The host can always play.
   - Everything is checked HERE, so a modified browser cannot play
     without permission, spam sounds, or reach another room.
========================================================= */

const SOUNDBOARD_IDS = new Set([
    "years", "amongus", "hisname", "cry", "explosion", "fahhhhh",
    "fail", "funny", "goodboy", "hawwwww", "laugh", "omgbruh"
]);

const SOUNDBOARD_COOLDOWN_MS = 2000;        // per player, between two sounds
const SOUNDBOARD_BURST_LIMIT = 6;           // max sounds per player ...
const SOUNDBOARD_BURST_WINDOW_MS = 20000;   // ... inside this window
const SOUNDBOARD_ROOM_GAP_MS = 400;         // whole room: minimum gap between sounds

function isRegisteredPlayer(player) {
    return Boolean(player && player.account);
}

function getSoundboardPlayerIds(room) {
    if (!room) return [];

    return room.players
        .filter(p => p.soundboardAllowed && isRegisteredPlayer(p) && p.connected !== false)
        .map(p => p.id);
}

function canPlaySoundboard(room, player) {
    if (!room || !player || player.connected === false) return false;

    return room.host === player.id ||
        Boolean(player.soundboardAllowed && isRegisteredPlayer(player));
}

/* Returns an error string, or null when the host's selection was applied. */
function setRoomSoundboardPermissions(room, ids) {
    const unique = Array.from(new Set(
        (Array.isArray(ids) ? ids : []).map(id => String(id))
    ));

    const chosen = [];

    for (const id of unique) {
        const player = room.players.find(p => p.id === id && p.connected !== false);

        if (!player) continue;

        if (!isRegisteredPlayer(player)) {
            return "Guest players cannot use the soundboard. Only registered players can be selected.";
        }

        chosen.push(id);
    }

    room.players.forEach(p => {
        p.soundboardAllowed = chosen.includes(p.id) && isRegisteredPlayer(p);
    });

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

        /* Public sign-up is closed: accounts are made by the Owner (Shop -> Add Account). */
        socket.on("signUp", () => {
            socket.emit("authResult", {
                ok: false,
                error: "Want to make an account? Join our Discord server: " + DISCORD_URL
            });
        });

        /* Login needs ALL THREE to match: username, password and PIN. */
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
                    validPassword = await verifyHash(password, user.salt, user.hash);
                } else {
                    // Same amount of work for unknown users.
                    await hashPassword(password.slice(0, 72), "0000000000000000");
                }

                if (user && isValidPin(pin)) {
                    if (user.pinHash && user.pinSalt) {
                        validPin = await verifyHash(pin, user.pinSalt, user.pinHash);
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

                    // One message for every case, so nobody can learn which part was right.
                    return socket.emit("authResult", {
                        ok: false,
                        error: "Username, password or PIN is incorrect."
                    });
                }

                socket.data.authFails = 0;

                // Both credentials are known right now, so (re)build the two "show" secrets.
                let changed = false;

                if (!user.passwordEncrypted?.ciphertext) {
                    user.passwordEncrypted = {
                        salt: user.pinSalt,
                        ...encryptPassword(password, pin, user.pinSalt)
                    };
                    changed = true;
                }

                if (!user.pinEncrypted?.ciphertext) {
                    user.pinEncrypted = {
                        salt: user.salt,
                        ...encryptPassword(pin, password, user.salt)
                    };
                    changed = true;
                }

                if (changed) saveAccounts();

                loginSocket(socket, key, false);
            } catch (error) {
                console.error("login error:", error);
                socket.emit("authResult", {
                    ok: false,
                    error: "Something went wrong. Try again."
                });
            }
        });

        /* =================================================
           OWNER ONLY: ACCOUNT MANAGEMENT (Shop -> Add Account)
           The server checks the Owner badge on every call.
        ================================================= */

        function requireOwnerAccounts(reply) {
            if (socket.badge !== "owner") {
                reply({ ok: false, error: "Only the Owner can manage accounts." });
                return false;
            }
            return true;
        }

        function checkNewCredentials({ username, password, pin }, needAll) {
            if (needAll || username !== undefined) {
                if (!isValidUsername(username)) return "Username must be 3-20 letters, numbers or _ only.";
            }
            if (needAll || password) {
                if (password.length < 6 || password.length > 72) return "Password must be 6-72 characters.";
            }
            if (needAll || pin) {
                if (!isValidPin(pin)) return "PIN must be 4-8 digits.";
            }
            return null;
        }

        socket.on("ownerAccountAdd", async (data, callback) => {
            const reply = typeof callback === "function" ? callback : () => {};

            try {
                if (!requireOwnerAccounts(reply)) return;

                const username = String(data?.username || "").trim();
                const password = String(data?.password || "");
                const pin = String(data?.pin || "");

                const problem = checkNewCredentials({ username, password, pin }, true);
                if (problem) return reply({ ok: false, error: problem });

                const key = username.toLowerCase();

                if (accountsDb.users[key] || isNameTaken(username, null)) {
                    return reply({ ok: false, error: "That username is already taken." });
                }

                const salt = crypto.randomBytes(16).toString("hex");
                const hash = await hashPassword(password, salt);
                const pinSalt = crypto.randomBytes(16).toString("hex");
                const pinHash = await hashPassword(pin, pinSalt);

                // Check again: something may have changed while hashing.
                if (accountsDb.users[key]) {
                    return reply({ ok: false, error: "That username is already taken." });
                }

                accountsDb.users[key] = {
                    username,
                    salt,
                    hash,
                    pinSalt,
                    pinHash,
                    passwordEncrypted: { salt: pinSalt, ...encryptPassword(password, pin, pinSalt) },
                    pinEncrypted: { salt, ...encryptPassword(pin, password, salt) },
                    created: Date.now(),
                    createdBy: "owner",
                    stats: emptyStats()
                };

                saveAccounts();
                reply({ ok: true, username });
            } catch (error) {
                console.error("ownerAccountAdd error:", error);
                reply({ ok: false, error: "Could not add the account." });
            }
        });

        /* Never sends hashes or secrets. */
        socket.on("ownerAccountList", callback => {
            const reply = typeof callback === "function" ? callback : () => {};
            if (!requireOwnerAccounts(reply)) return;

            const accounts = Object.values(accountsDb.users)
                .map(user => ({
                    username: user.username,
                    displayName: getDisplayName(user),
                    created: user.created || 0,
                    createdByOwner: user.createdBy === "owner"
                }))
                .sort((a, b) => b.created - a.created || a.username.localeCompare(b.username));

            reply({ ok: true, accounts });
        });

        /* Edit: a new username and/or a NEW password and/or a NEW PIN (blank = unchanged).
           A new username keeps everything else: points, items, uploads, Help posts. */
        socket.on("ownerAccountEdit", async (data, callback) => {
            const reply = typeof callback === "function" ? callback : () => {};

            try {
                if (!requireOwnerAccounts(reply)) return;

                const key = String(data?.username || "").trim().toLowerCase();
                const user = accountsDb.users[key];
                if (!user) return reply({ ok: false, error: "Account not found." });

                const wantedName = String(data?.newUsername ?? "").trim();
                const renaming = wantedName !== "" && wantedName !== user.username;
                const password = String(data?.password || "");
                const pin = String(data?.pin || "");

                if (!renaming && !password && !pin) {
                    return reply({ ok: false, error: "Change the username, or type a new password or a new PIN." });
                }

                const problem = checkNewCredentials({
                    username: renaming ? wantedName : undefined,
                    password,
                    pin
                }, false);
                if (problem) return reply({ ok: false, error: problem });

                const newKey = renaming ? wantedName.toLowerCase() : key;

                if (renaming && ((newKey !== key && accountsDb.users[newKey]) || isNameTaken(wantedName, key))) {
                    return reply({ ok: false, error: "That username is already taken." });
                }

                let newSalt = null, newHash = null, newPinSalt = null, newPinHash = null;

                if (password) {
                    newSalt = crypto.randomBytes(16).toString("hex");
                    newHash = await hashPassword(password, newSalt);
                }

                if (pin) {
                    newPinSalt = crypto.randomBytes(16).toString("hex");
                    newPinHash = await hashPassword(pin, newPinSalt);
                }

                // Check again: something may have changed while hashing.
                if (accountsDb.users[key] !== user) return reply({ ok: false, error: "Account not found." });
                if (renaming && newKey !== key && accountsDb.users[newKey]) {
                    return reply({ ok: false, error: "That username is already taken." });
                }

                // The player's uploaded files live in a folder named after the username: move it first.
                // If that fails nothing has been changed yet.
                if (renaming && newKey !== key) {
                    try {
                        const from = userUploadDir(key);
                        const to = userUploadDir(newKey);

                        if (fs.existsSync(from)) {
                            if (fs.existsSync(to)) {
                                return reply({ ok: false, error: "That username already has a files folder. Pick another." });
                            }
                            fs.renameSync(from, to);
                        }
                    } catch (error) {
                        console.error("ownerAccountEdit: could not move uploads:", error);
                        return reply({ ok: false, error: "Could not move the player's files. Nothing was changed." });
                    }
                }

                if (password) { user.salt = newSalt; user.hash = newHash; }
                if (pin) { user.pinSalt = newPinSalt; user.pinHash = newPinHash; }

                if (password || pin) {
                    if (password && pin) {
                        user.passwordEncrypted = { salt: user.pinSalt, ...encryptPassword(password, pin, user.pinSalt) };
                        user.pinEncrypted = { salt: user.salt, ...encryptPassword(pin, password, user.salt) };
                    } else {
                        // Only one changed: the other credential is unknown here, so the
                        // "show" secrets are rebuilt the next time the player logs in.
                        user.passwordEncrypted = null;
                        user.pinEncrypted = null;
                    }

                    dropSessionsOf(key);   // a changed password / PIN signs the player out everywhere
                }

                if (renaming) {
                    user.username = wantedName;

                    if (newKey !== key) {
                        accountsDb.users[newKey] = user;
                        delete accountsDb.users[key];

                        // Everything that points at the old username now points at the new one,
                        // so the player stays signed in and keeps their room seat.
                        for (const [token, accountKey] of accountSessions.entries()) {
                            if (accountKey === key) accountSessions.set(token, newKey);
                        }

                        for (const [socketId, accountKey] of socketAccounts.entries()) {
                            if (accountKey === key) socketAccounts.set(socketId, newKey);
                        }

                        for (const room of Object.values(rooms)) {
                            if (!room?.players) continue;
                            for (const player of room.players) {
                                if (player.account === key) player.account = newKey;
                            }
                        }

                        let questionsChanged = false;

                        for (const question of questionsDb) {
                            if (question.authorAccountKey === key) {
                                question.authorAccountKey = newKey;
                                question.author = wantedName;
                                questionsChanged = true;
                            }

                            for (const answer of (Array.isArray(question.replies) ? question.replies : [])) {
                                if (answer.authorAccountKey === key) {
                                    answer.authorAccountKey = newKey;
                                    answer.author = wantedName;
                                    questionsChanged = true;
                                }
                            }
                        }

                        if (questionsChanged) {
                            saveQuestions();
                            emitQuestionsUpdate();
                        }
                    }

                    // Tell the player's open game so it shows the new name straight away.
                    for (const [socketId, accountKey] of socketAccounts.entries()) {
                        if (accountKey === newKey) {
                            io.sockets.sockets.get(socketId)?.emit("accountRenamed", {
                                username: user.username,
                                displayName: getDisplayName(user)
                            });
                        }
                    }
                }

                saveAccounts();
                reply({ ok: true, username: user.username });
            } catch (error) {
                console.error("ownerAccountEdit error:", error);
                reply({ ok: false, error: "Could not save the account." });
            }
        });

        socket.on("ownerAccountDelete", (data, callback) => {
            const reply = typeof callback === "function" ? callback : () => {};
            if (!requireOwnerAccounts(reply)) return;

            const key = String(data?.username || "").trim().toLowerCase();
            const user = accountsDb.users[key];
            if (!user) return reply({ ok: false, error: "Account not found." });

            if (getSocketAccountKey(socket) === key) {
                return reply({ ok: false, error: "You can't delete the account you are signed in with." });
            }

            for (const room of Object.values(rooms)) {
                if (!room?.players) continue;
                for (const player of room.players) {
                    if (player.account === key) player.account = null;
                }
            }

            dropSessionsOf(key);

            for (const [socketId, accountKey] of socketAccounts.entries()) {
                if (accountKey === key) socketAccounts.delete(socketId);
            }

            try {
                fs.rmSync(userUploadDir(key), { recursive: true, force: true });
            } catch (_) { /* nothing to remove */ }

            delete accountsDb.users[key];
            saveAccounts();
            reply({ ok: true });
        });

        /* =================================================
           OWNER ONLY: VIEW ACCOUNT (points) + GIVE GIFT
        ================================================= */

        const MAX_OWNER_POINTS = 1000000;

        function ownerTarget(data, reply) {
            if (!requireOwnerAccounts(reply)) return null;

            const key = String(data?.username || "").trim().toLowerCase();
            const user = accountsDb.users[key];

            if (!user) {
                reply({ ok: false, error: "Account not found." });
                return null;
            }

            return { key, user };
        }

        function ownerAccountSummary(user) {
            const p = ensureProgress(user);

            return {
                ok: true,
                username: user.username,
                displayName: getDisplayName(user),
                badge: user.badge || "member",
                level: levelInfo(p.xp).level,
                rankPoints: totalStats(user.stats),
                shopPoints: p.shop.points,
                itemsOwned: p.shop.owned.length + p.shop.ownedMinecraftSkins.length + p.shop.ownedSongs.length
            };
        }

        /* Tells the player's open game (if they are online) so they see it straight away. */
        function tellPlayer(accountKey, event, payload) {
            for (const [socketId, key] of socketAccounts.entries()) {
                if (key === accountKey) io.sockets.sockets.get(socketId)?.emit(event, payload);
            }
        }

        function readPoints(value, label) {
            if (value === undefined || value === null || String(value).trim() === "") return { skip: true };

            const number = Number(value);

            if (!Number.isInteger(number) || number < 0 || number > MAX_OWNER_POINTS) {
                return { error: `${label} must be a whole number from 0 to ${MAX_OWNER_POINTS.toLocaleString("en-US")}.` };
            }

            return { value: number };
        }

        socket.on("ownerAccountView", (data, callback) => {
            const reply = typeof callback === "function" ? callback : () => {};
            const target = ownerTarget(data, reply);
            if (!target) return;

            reply(ownerAccountSummary(target.user));
        });

        /* Rank points and/or shop points. Rank points = what they earned + an Owner adjustment. */
        socket.on("ownerAccountSetPoints", (data, callback) => {
            const reply = typeof callback === "function" ? callback : () => {};
            const target = ownerTarget(data, reply);
            if (!target) return;

            const rank = readPoints(data?.rankPoints, "Rank points");
            const shop = readPoints(data?.shopPoints, "Shop points");

            if (rank.error || shop.error) return reply({ ok: false, error: rank.error || shop.error });
            if (rank.skip && shop.skip) return reply({ ok: false, error: "Type the new rank points or shop points." });

            const user = target.user;

            if (!rank.skip) {
                user.stats = { ...emptyStats(), ...(user.stats || {}) };
                user.stats.bonusPoints = rank.value - baseStatPoints(user.stats);
            }

            if (!shop.skip) {
                ensureProgress(user).shop.points = shop.value;
            }

            saveAccounts();
            tellPlayer(target.key, "ownerPointsChanged", {});
            reply(ownerAccountSummary(user));
        });

        /* Everything in the shop, with a flag for what this player already owns. */
        socket.on("ownerGiftCatalog", (data, callback) => {
            const reply = typeof callback === "function" ? callback : () => {};
            const target = ownerTarget(data, reply);
            if (!target) return;

            const user = target.user;
            const p = ensureProgress(user);

            const categories = [
                ...SHOP_CATEGORIES.map(c => ({ key: c.key, label: c.label, icon: c.icon })),
                { key: "skin", label: "Minecraft Skins", icon: "⛏️" },
                { key: "song", label: "Songs", icon: "🎵" }
            ];

            const items = [];

            SHOP_CATALOG.forEach(item => {
                if (item.free) return;
                items.push({ kind: "item", id: item.id, cat: item.cat, name: item.name || item.id, owned: shopOwns(user, item) });
            });

            publicSkins().forEach(skin => {
                items.push({ kind: "skin", id: skin.file, cat: "skin", name: skin.name, owned: p.shop.ownedMinecraftSkins.includes(skin.file) });
            });

            MUSIC_SONGS.forEach(song => {
                items.push({ kind: "song", id: song.id, cat: "song", name: song.name, owned: ownsSong(user, song.id) });
            });

            reply({ ok: true, username: user.username, categories, items });
        });

        /* Gives one shop item for free. Never takes points and never equips it for the player. */
        socket.on("ownerGiftGive", (data, callback) => {
            const reply = typeof callback === "function" ? callback : () => {};
            const target = ownerTarget(data, reply);
            if (!target) return;

            const user = target.user;
            const p = ensureProgress(user);
            const kind = String(data?.kind || "");
            const id = String(data?.id || "");
            let name = "";

            if (kind === "item") {
                const item = SHOP_ITEMS.get(id);
                if (!item || item.free) return reply({ ok: false, error: "That item can't be given." });
                if (shopOwns(user, item)) return reply({ ok: false, error: "They already own that." });
                p.shop.owned.push(item.id);
                name = item.name || item.id;
            } else if (kind === "skin") {
                const skin = getSkinInfo(id);
                if (!skin) return reply({ ok: false, error: "Unknown Minecraft skin." });
                if (p.shop.ownedMinecraftSkins.includes(skin.file)) return reply({ ok: false, error: "They already own that." });
                p.shop.ownedMinecraftSkins.push(skin.file);
                name = skin.name;
            } else if (kind === "song") {
                const song = MUSIC_SONGS.find(entry => entry.id === id);
                if (!song) return reply({ ok: false, error: "Unknown song." });
                if (ownsSong(user, song.id)) return reply({ ok: false, error: "They already own that." });
                p.shop.ownedSongs.push(song.id);
                name = song.name;
            } else {
                return reply({ ok: false, error: "Unknown gift." });
            }

            saveAccounts();
            tellPlayer(target.key, "ownerGiftReceived", { name });
            reply({ ok: true, name });
        });

        /* =================================================
           ACCOUNT SETTINGS: details, Display Name, Show PIN
        ================================================= */

        socket.on("getMyAccountDetails", callback => {
            const reply = typeof callback === "function" ? callback : () => {};
            const key = getSocketAccountKey(socket);
            const user = key ? accountsDb.users[key] : null;
            if (!user) return reply({ ok: false });

            reply({
                ok: true,
                username: user.username,
                displayName: getDisplayName(user)
            });
        });

        socket.on("setDisplayName", (data, callback) => {
            const reply = typeof callback === "function" ? callback : () => {};
            const key = getSocketAccountKey(socket);
            const user = key ? accountsDb.users[key] : null;
            if (!user) return reply({ ok: false, error: "Sign in first." });

            const name = cleanDisplayName(data?.displayName);

            if (!isValidDisplayName(name)) {
                return reply({ ok: false, error: "Display Name: 3-20 letters, numbers, spaces, _ . or -" });
            }

            if (isNameTaken(name, key)) {
                return reply({ ok: false, error: "That name is already used by another player." });
            }

            // Back to exactly the original username = no custom name.
            user.displayName = name === user.username ? undefined : name;
            saveAccounts();
            reply({ ok: true, displayName: getDisplayName(user) });
        });

        /* Show PIN: the PASSWORD is checked on the server before the PIN is decrypted. */
        socket.on("showMyPin", async data => {
            try {
                const key = getSocketAccountKey(socket);
                const user = key ? accountsDb.users[key] : null;
                const password = String(data?.password || "");

                if (!user) {
                    return socket.emit("showMyPinResult", { ok: false, error: "Sign in first." });
                }

                if (socket.data.secretLockUntil && Date.now() < socket.data.secretLockUntil) {
                    return socket.emit("showMyPinResult", { ok: false, error: "Too many wrong attempts. Wait 30 seconds." });
                }

                const valid = password.length > 0 && password.length <= 72 &&
                    await verifyHash(password, user.salt, user.hash);

                if (!valid) {
                    socket.data.secretFails = (socket.data.secretFails || 0) + 1;

                    if (socket.data.secretFails >= 5) {
                        socket.data.secretFails = 0;
                        socket.data.secretLockUntil = Date.now() + 30000;
                    }

                    return socket.emit("showMyPinResult", { ok: false, error: "Wrong password." });
                }

                socket.data.secretFails = 0;

                const pin = decryptSecret(user.pinEncrypted, password);

                if (!pin) {
                    return socket.emit("showMyPinResult", {
                        ok: false,
                        error: "PIN is not available yet. Log in once with your PIN to enable this."
                    });
                }

                socket.emit("showMyPinResult", { ok: true, pin });
            } catch (error) {
                console.error("showMyPin error:", error);
                socket.emit("showMyPinResult", { ok: false, error: "Could not show the PIN." });
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
                displayName: getDisplayName(accountsDb.users[key]),
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
                displayName: getDisplayName(user),
                badge: user.badge || "member",
                tier: getEquippedTierKey(user),
                level: levelInfo(ensureProgress(user).xp).level,
                look: getLookOfUser(user),
                points: totalStats(user.stats),
                stats: { ...emptyStats(), ...(user.stats || {}) }
            });
        });

        /* =================================================
           VIEW ACCOUNT (lobby + game)
           Shows the PUBLIC card of a player who is in the SAME room:
           rank, rank points, level, stats. Never shows the login name,
           shop points, owned items, or anything about the game roles.
        ================================================= */

        socket.on("getAccountCard", data => {
            const now = Date.now();
            if (now - (socket.data.accountCardAt || 0) < 250) return;
            socket.data.accountCardAt = now;

            const roomCode = findRoomCodeBySocket(socket.id);
            const room = roomCode ? rooms[roomCode] : null;
            const target = room
                ? room.players.find(p => p.id === String(data?.playerId || "") && p.connected !== false)
                : null;

            if (!room || !target) {
                return socket.emit("accountCardData", { ok: false, error: "That player is no longer in the room." });
            }

            const base = {
                ok: true,
                playerId: target.id,
                name: target.name,
                isHost: room.host === target.id,
                look: getLookOfPlayer(target)
            };

            const user = target.account ? accountsDb.users[target.account] : null;

            if (!user) {
                return socket.emit("accountCardData", { ...base, guest: true });
            }

            const prog = ensureProgress(user);
            const info = levelInfo(prog.xp);
            const points = totalStats(user.stats);
            const stats = { ...emptyStats(), ...(user.stats || {}) };
            const board = getLeaderboardPosition(user);
            const nextTier = TIERS.find(tier => tier.min > points) || null;

            socket.emit("accountCardData", {
                ...base,
                guest: false,
                name: getDisplayName(user),
                badge: user.badge || "member",
                tier: getEquippedTierKey(user),
                points,
                position: board.position,
                accounts: board.count,
                nextTier: nextTier ? { key: nextTier.key, min: nextTier.min } : null,
                level: info.level,
                xpIntoLevel: info.xpIntoLevel,
                xpNeeded: info.xpNeeded,
                medals: Object.keys(LEVEL_REWARDS)
                    .map(Number)
                    .filter(level => level <= info.level)
                    .map(level => ({ level, icon: LEVEL_REWARDS[level].icon, name: LEVEL_REWARDS[level].name })),
                memberSince: Number(user.created) || null,
                stats: {
                    kills: Number(stats.kills) || 0,
                    saves: Number(stats.saves) || 0,
                    detects: Number(stats.detects) || 0,
                    civilianVotes: Number(stats.civilianVotes) || 0,
                    jesterWins: Number(stats.jesterWins) || 0,
                    mafiaWins: Number(stats.mafiaWins) || 0,
                    civilianWins: Number(stats.civilianWins) || 0
                }
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
                winBonus: SHOP_POINTS_WIN_BONUS,
                winPoints: SHOP_POINTS_PER_GAME + SHOP_POINTS_WIN_BONUS,
                losePoints: SHOP_POINTS_PER_GAME,
                ...shopConfigPayload()
            });
        });

        // Minecraft skins are server-authoritative: price and ownership are never trusted from the browser.
        const MINECRAFT_SKIN_SHOP = {
            clownpierce: { name: "ClownPierce", price: 100 },
            flamefrags: { name: "FlameFrags", price: 100 },
            "gloden king": { name: "Golden King", price: 100 },
            jaden_man: { name: "Jaden Man", price: 100 },
            jamatop: { name: "Jamatop", price: 100 },
            maifa: { name: "Mafia", price: 100 },
            mafia: { name: "Mafia", price: 100 },
            manepear: { name: "ManePear", price: 100 },
            minetech: { name: "MineTech", price: 100 },
            ninja: { name: "Ninja", price: 100 },
            parrot: { name: "Parrot", price: 100 },
            "parrotx2 king": { name: "ParrotX2 King", price: 100 },
            spoke: { name: "Spoke", price: 100 },
            steve: { name: "Steve", price: 100 },
            technoblade: { name: "Technoblade", price: 100 },
            theobalthebird: { name: "TheobaldTheBird", price: 100 },
            warroir: { name: "Warrior", price: 100 },
            "wemmbu tech": { name: "Wemmbu Tech", price: 100 },
            wemmbu: { name: "Wemmbu", price: 100 },
            wifize: { name: "Wifize", price: 100 },
            wizerd: { name: "Wizard", price: 100 }
        };

        socket.on("minecraftSkinBuy", (data, callback) => {
            const ctx = progressionUser();
            const reply = typeof callback === "function" ? callback : () => {};
            if (!ctx) return reply({ ok: false, error: "Sign in to buy skins." });
            const file = String(data?.file || "");
            const skin = getSkinInfo(file);   // price + name always come from the server catalog
            if (!skin) return reply({ ok: false, error: "Unknown Minecraft skin." });
            if (!skin.enabled) return reply({ ok: false, error: "This skin is not for sale right now." });
            const progress = ensureProgress(ctx.user);
            if (progress.shop.ownedMinecraftSkins.includes(file)) {
                return reply({ ok: false, error: "You already own this skin." });
            }
            const price = skin.price;
            if (progress.shop.points < price) {
                return reply({ ok: false, error: `Not enough shop points. You need ${price - progress.shop.points} more.` });
            }
            progress.shop.points -= price;
            progress.shop.ownedMinecraftSkins.push(file);
            progress.equipped.minecraftSkin = file;
            progress.equipped.characterStyle = "minecraft";
            saveAccounts();
            sendProgress(ctx, false);
            refreshLookInRoom();
            return reply({ ok: true, file, name: skin.name, price, balance: progress.shop.points, ownedMinecraftSkins: progress.shop.ownedMinecraftSkins.slice() });
        });

        socket.on("minecraftSkinEquip", (data, callback) => {
            const ctx = progressionUser();
            const reply = typeof callback === "function" ? callback : () => {};
            if (!ctx) return reply({ ok: false, error: "Sign in first." });
            const file = String(data?.file || "");
            const progress = ensureProgress(ctx.user);
            if (!progress.shop.ownedMinecraftSkins.includes(file)) return reply({ ok: false, error: "Buy this skin before equipping it." });
            progress.equipped.minecraftSkin = file;
            progress.equipped.characterStyle = "minecraft";
            saveAccounts();
            sendProgress(ctx, false);
            refreshLookInRoom();
            return reply({ ok: true, file });
        });

        /* Switch between the normal character and the Minecraft skin (Inventory -> Character). */
        socket.on("characterStyleSet", (data, callback) => {
            const ctx = progressionUser();
            const reply = typeof callback === "function" ? callback : () => {};
            if (!ctx) return reply({ ok: false, error: "Sign in first." });
            const progress = ensureProgress(ctx.user);
            const style = data?.style === "minecraft" ? "minecraft" : "current";
            if (style === "minecraft") {
                const file = String(data?.file || progress.equipped.minecraftSkin || "");
                if (!progress.shop.ownedMinecraftSkins.includes(file)) {
                    return reply({ ok: false, error: "Buy a Minecraft skin in the Shop first." });
                }
                progress.equipped.minecraftSkin = file;
            }
            progress.equipped.characterStyle = style;
            saveAccounts();
            sendProgress(ctx, false);
            refreshLookInRoom();
            return reply({ ok: true, style });
        });

        socket.on("shopBuy", (data, callback) => {
            const ctx = progressionUser();
            const reply = typeof callback === "function" ? callback : () => {};
            if (!ctx) return reply({ ok: false, error: "Sign in to buy items." });

            const item = SHOP_ITEMS.get(String(data?.id || ""));
            if (!item || item.free) return reply({ ok: false, error: "That item is not for sale." });
            if (isShopDisabled(item.id)) return reply({ ok: false, error: "That item is not for sale right now." });

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

        /* Edit a sound: set EXACTLY which game moments it plays on (can be changed any time).
           Works for bought shop sounds and for the game's original sounds. */
        socket.on("setSoundEvents", (data, callback) => {
            const ctx = progressionUser();
            const reply = typeof callback === "function" ? callback : () => {};
            if (!ctx) return reply({ ok: false, error: "Sign in first." });

            const id = String(data?.id || "");
            const isDefault = DEFAULT_SOUND_IDS.includes(id);
            const item = SHOP_ITEMS.get(id);

            if (!isDefault && (!item || item.cat !== "sound" || !shopOwns(ctx.user, item))) {
                return reply({ ok: false, error: "You do not own that sound." });
            }

            const chosen = Array.isArray(data?.events) ? data.events.map(String) : [];
            if (chosen.some(ev => !SOUND_EVENTS.includes(ev))) return reply({ ok: false, error: "Choose a game event." });

            const p = ensureProgress(ctx.user);
            SOUND_EVENTS.forEach(ev => {
                if (chosen.includes(ev)) p.equipped.sounds[ev] = id;
                else if (p.equipped.sounds[ev] === id) delete p.equipped.sounds[ev];
            });

            saveAccounts();
            sendProgress(ctx, false);
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

        /* =================================================
           MUSIC: buy + choose a song (account players only)
        ================================================= */

        socket.on("musicBuy", (data, callback) => {
            const ctx = progressionUser();
            const reply = typeof callback === "function" ? callback : () => {};
            if (!ctx) return reply({ ok: false, error: "Sign in to buy songs." });

            const song = MUSIC_SONGS.find(s => s.id === String(data?.id || ""));
            if (!song) return reply({ ok: false, error: "Unknown song." });
            if (ownsSong(ctx.user, song.id)) return reply({ ok: false, error: "You already own this song." });
            if (isShopDisabled(song.id)) return reply({ ok: false, error: "This song is not for sale right now." });

            const shop = ensureProgress(ctx.user).shop;
            const price = songPriceOf(song);   // always the CURRENT server price

            if (shop.points < price) {
                return reply({ ok: false, error: `Not enough points. You need ${price - shop.points} more.` });
            }

            shop.points -= price;
            shop.ownedSongs.push(song.id);

            saveAccounts();
            sendProgress(ctx, false);
            reply({ ok: true, id: song.id, name: song.name, price, balance: shop.points });
        });

        socket.on("musicEquip", (data, callback) => {
            const ctx = progressionUser();
            const reply = typeof callback === "function" ? callback : () => {};
            if (!ctx) return reply({ ok: false, error: "Sign in first." });

            const song = MUSIC_SONGS.find(s => s.id === String(data?.id || ""));
            if (!song || !ownsSong(ctx.user, song.id)) {
                return reply({ ok: false, error: "You do not own that song." });
            }

            ensureProgress(ctx.user).equipped.song = song.id;
            saveAccounts();
            sendProgress(ctx, false);
            reply({ ok: true, id: song.id });
        });

        /* =================================================
           OWNER ONLY: manage songs, skins and shop items
           The badge is stored on the server-side socket, so the browser
           cannot fake it.
        ================================================= */

        function requireOwner(reply) {
            if (socket.badge !== "owner" || !getSocketAccountKey(socket)) {
                reply({ ok: false, error: "Only the signed-in Owner can do this." });
                return false;
            }
            return true;
        }

        function ownerDone(reply) {
            saveAccounts();
            io.emit("shopConfigUpdated", shopConfigPayload());
            reply({ ok: true, ...shopConfigPayload() });
        }

        function validPriceInput(value) {
            const price = Math.floor(Number(value));
            return Number.isFinite(price) && price >= 0 && price <= MAX_SHOP_PRICE ? price : null;
        }

        /* Enable / disable ONE shop item (catalog item id, song id, or "skin:<file>"). */
        socket.on("ownerSetEnabled", (data, callback) => {
            const reply = typeof callback === "function" ? callback : () => {};
            if (!requireOwner(reply)) return;

            const id = String(data?.id || "");
            const enabled = Boolean(data?.enabled);
            const shopDb = ensureShopDb();

            const catalogItem = SHOP_ITEMS.get(id);
            const song = MUSIC_SONGS.find(s => s.id === id);
            const skinFile = id.startsWith("skin:") ? id.slice(5) : null;

            if (catalogItem) {
                if (catalogItem.free) return reply({ ok: false, error: "A free default item cannot be disabled." });
            } else if (song) {
                if (!enabled && song.id === freeSongId()) return reply({ ok: false, error: "The free song cannot be disabled." });
            } else if (skinFile !== null) {
                if (!getSkinInfo(skinFile)) return reply({ ok: false, error: "Unknown skin." });
            } else {
                return reply({ ok: false, error: "Unknown shop item." });
            }

            if (enabled) delete shopDb.disabled[id];
            else shopDb.disabled[id] = true;

            ownerDone(reply);
        });

        /* Change a song price and / or choose which song is the FREE one. */
        socket.on("ownerMusicSet", (data, callback) => {
            const reply = typeof callback === "function" ? callback : () => {};
            if (!requireOwner(reply)) return;

            const song = MUSIC_SONGS.find(s => s.id === String(data?.id || ""));
            if (!song) return reply({ ok: false, error: "Unknown song." });

            const musicDb = ensureShopDb().music;

            if (data?.reset) {
                delete musicDb.prices[song.id];
            } else if (data?.price !== undefined) {
                const price = validPriceInput(data.price);
                if (price === null) return reply({ ok: false, error: `Price must be a number from 0 to ${MAX_SHOP_PRICE}.` });
                musicDb.prices[song.id] = price;
            }

            if (data?.free === true) {
                musicDb.freeId = song.id;
                delete ensureShopDb().disabled[song.id];   // the free song is always available
            }

            ownerDone(reply);
        });

        /* Skins: add a new one (picture goes in public/skins/<file>.png), edit, or remove. */
        socket.on("ownerSkinAdd", (data, callback) => {
            const reply = typeof callback === "function" ? callback : () => {};
            if (!requireOwner(reply)) return;

            const file = String(data?.file || "").trim().replace(/\.png$/i, "");
            const name = String(data?.name || "").trim().slice(0, 30);
            const price = validPriceInput(data?.price);

            if (!/^[A-Za-z0-9_ \-]{1,40}$/.test(file)) {
                return reply({ ok: false, error: "File name: 1-40 letters, numbers, spaces, _ or - (no .png)." });
            }
            if (!name) return reply({ ok: false, error: "Enter a skin name." });
            if (price === null) return reply({ ok: false, error: `Price must be a number from 0 to ${MAX_SHOP_PRICE}.` });
            if (getSkinInfo(file)) return reply({ ok: false, error: "A skin with that file name already exists." });

            ensureShopDb().skins[file] = { name, price, custom: true };
            ownerDone(reply);
        });

        socket.on("ownerSkinSet", (data, callback) => {
            const reply = typeof callback === "function" ? callback : () => {};
            if (!requireOwner(reply)) return;

            const file = String(data?.file || "");
            if (!getSkinInfo(file)) return reply({ ok: false, error: "Unknown skin." });

            const skins = ensureShopDb().skins;
            const cfg = skins[file] = skins[file] && typeof skins[file] === "object" ? skins[file] : {};

            if (data?.name !== undefined) {
                const name = String(data.name || "").trim().slice(0, 30);
                if (!name) return reply({ ok: false, error: "Enter a skin name." });
                cfg.name = name;
            }

            if (data?.reset) {
                delete cfg.price;
            } else if (data?.price !== undefined) {
                const price = validPriceInput(data.price);
                if (price === null) return reply({ ok: false, error: `Price must be a number from 0 to ${MAX_SHOP_PRICE}.` });
                cfg.price = price;
            }

            ownerDone(reply);
        });

        socket.on("ownerSkinRemove", (data, callback) => {
            const reply = typeof callback === "function" ? callback : () => {};
            if (!requireOwner(reply)) return;

            const file = String(data?.file || "");
            if (!getSkinInfo(file)) return reply({ ok: false, error: "Unknown skin." });

            const shopDb = ensureShopDb();

            // Players who already own it keep it; it just disappears from the Shop.
            if (Object.prototype.hasOwnProperty.call(DEFAULT_MINECRAFT_SKINS, file)) shopDb.skins[file] = { removed: true };
            else delete shopDb.skins[file];

            delete shopDb.disabled["skin:" + file];
            ownerDone(reply);
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
           LOBBY CHAT
           lobbyChatRequest: send the saved messages to this player.
           sendLobbyMessage: send one message to the whole room.
        ================================================= */

        socket.on("lobbyChatRequest", () => {
            const roomCode = findRoomCodeBySocket(socket.id);
            const room = roomCode ? rooms[roomCode] : null;

            if (!room) return;

            socket.emit("lobbyChatHistory", room.lobbyChat || []);
        });

        socket.on("sendLobbyMessage", data => {
            // The room comes from where this socket really is, never from the browser.
            const roomCode = findRoomCodeBySocket(socket.id);
            const room = roomCode ? rooms[roomCode] : null;

            if (!room) return;

            const player = room.players.find(p => p.id === socket.id);
            if (!player) return;

            if (room.phase !== "lobby") {
                return socket.emit("lobbyChatError", "Lobby chat is only open before the game starts.");
            }

            const text = String(data?.message || "")
                .replace(/[\u0000-\u001f\u007f]/g, " ")
                .replace(/\s+/g, " ")
                .trim()
                .substring(0, LOBBY_CHAT_MAX_LENGTH);

            if (!text) return;

            const now = Date.now();

            if (now - (player.lastChatAt || 0) < LOBBY_CHAT_MIN_GAP_MS) {
                return socket.emit("lobbyChatError", "You are typing too fast.");
            }

            player.chatTimes = (player.chatTimes || [])
                .filter(time => now - time < LOBBY_CHAT_BURST_WINDOW_MS);

            if (player.chatTimes.length >= LOBBY_CHAT_BURST_LIMIT) {
                return socket.emit("lobbyChatError", "Slow down! Too many messages in a short time.");
            }

            player.lastChatAt = now;
            player.chatTimes.push(now);

            const entry = {
                id: (room.lobbyChatSeq = (room.lobbyChatSeq || 0) + 1),
                fromId: player.id,
                name: player.name,
                text,
                time: now
            };

            room.lobbyChat = room.lobbyChat || [];
            room.lobbyChat.push(entry);

            if (room.lobbyChat.length > LOBBY_CHAT_HISTORY) {
                room.lobbyChat.splice(0, room.lobbyChat.length - LOBBY_CHAT_HISTORY);
            }

            io.to(roomCode).emit("lobbyMessage", entry);
        });


        /* =================================================
           SOUNDBOARD
           setSoundboardPermissions: the host picks the registered
           players who may play sounds (lobby or during the game).
           soundboardPlay: a permitted player plays one of the 12
           sounds for everyone in THEIR OWN room only.
        ================================================= */

        socket.on("setSoundboardPermissions", data => {
            const roomCode = String(data?.roomCode || "").trim().toUpperCase();
            const room = rooms[roomCode];

            if (!room || room.host !== socket.id) return;

            const error = setRoomSoundboardPermissions(
                room,
                Array.isArray(data?.players) ? data.players : []
            );

            if (error) {
                return socket.emit("soundboardError", error);
            }

            if (room.phase === "lobby") {
                emitLobby(roomCode);
            } else {
                sendGameInformation(roomCode);
            }
        });

        socket.on("soundboardPlay", data => {
            // The room comes from where this socket really is, never from the browser.
            let roomCode = null;

            for (const code of Object.keys(rooms)) {
                if (rooms[code]?.players?.some(p => p.id === socket.id && p.connected !== false)) {
                    roomCode = code;
                    break;
                }
            }

            const room = roomCode ? rooms[roomCode] : null;
            if (!room) return;

            const player = room.players.find(p => p.id === socket.id);
            if (!player) return;

            const soundId = String(data?.soundId || "");

            if (!SOUNDBOARD_IDS.has(soundId)) {
                return socket.emit("soundboardError", "Unknown sound.");
            }

            if (!canPlaySoundboard(room, player)) {
                return socket.emit("soundboardError", "The host has not given you permission to use the soundboard.");
            }

            const now = Date.now();

            if (now - (player.lastSoundAt || 0) < SOUNDBOARD_COOLDOWN_MS) {
                return socket.emit("soundboardError", "Wait a moment before playing another sound.");
            }

            player.soundTimes = (player.soundTimes || [])
                .filter(time => now - time < SOUNDBOARD_BURST_WINDOW_MS);

            if (player.soundTimes.length >= SOUNDBOARD_BURST_LIMIT) {
                return socket.emit("soundboardError", "Slow down! You played too many sounds in a short time.");
            }

            if (now - (room.lastSoundAt || 0) < SOUNDBOARD_ROOM_GAP_MS) {
                return socket.emit("soundboardError", "Another sound just played. Try again.");
            }

            player.lastSoundAt = now;
            player.soundTimes.push(now);
            room.lastSoundAt = now;

            io.to(roomCode).emit("soundboardPlayed", {
                soundId,
                fromId: player.id,
                fromName: player.name
            });
        });


        /* =================================================
           HOST DETECTIVE-CHECK ANNOUNCEMENT OPTION
           YES = morning message adds "The detective knows one of the mafia."
        ================================================= */

        socket.on("setDetectiveCheckSetting", data => {
            const roomCode = String(data?.roomCode || "").trim().toUpperCase();
            const room = rooms[roomCode];

            if (!room || room.host !== socket.id) return;
            if (typeof data?.enabled !== "boolean") return;

            room.detectiveCheckAnnounce = data.enabled;

            if (room.phase === "lobby") {
                emitLobby(roomCode);
            } else {
                sendGameInformation(roomCode);
            }
        });

        /* =================================================
           CREATE ROOM
        ================================================= */

        socket.on(
            "createRoom",
            data => {

                const playerName =
                    resolvePlayerName(socket, String(
                        typeof data === "string"
                            ? data
                            : data?.playerName || ""
                    ).trim());

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

                    // Host option: show "The detective knows one of the mafia"
                    // in the morning announcement.
                    detectiveCheckAnnounce: true,

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
                    resolvePlayerName(socket, String(
                        data?.playerName || ""
                    ).trim());

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
            const playerName = resolvePlayerName(socket, String(data?.playerName || "").trim());
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

            // Account players are found by their account, so changing the Display Name never breaks Rejoin.
            const rejoinAccountKey = getSocketAccountKey(socket);
            const oldPlayer =
                (rejoinAccountKey && room.players.find(p => p.account === rejoinAccountKey)) ||
                room.players.find(
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

                        fromId:
                            player.id,

                        time:
                            Date.now(),

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

                                    fromId:
                                        sender.id,

                                    time:
                                        Date.now(),

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
