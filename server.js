require("dotenv").config({ path: ".env.local" });
require("dotenv").config();
const { Pool } = require("pg");

const pool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL, max: 4 })
    : null;

if (pool) pool.on("error", e => console.error("[db] connection error:", e.message));

async function dbSave(key, value) {
    await pool.query(
        "INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2::jsonb, now()) " +
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        [key, JSON.stringify(value)]
    );
}

async function dbLoad(key) {
    const r = await pool.query("SELECT value FROM kv_store WHERE key = $1", [key]);
    return r.rows[0] ? r.rows[0].value : null;
}

/* One save at a time, and always the newest data last. */
function makeDbSaver(key, getData, fileFallback) {
    let promise = null;
    let dirty = false;

    return function save() {
        if (!pool) { fileFallback(); return Promise.resolve(); }

        dirty = true;

        if (!promise) {
            promise = (async () => {
                try {
                    while (dirty) {
                        dirty = false;
                        await dbSave(key, getData());
                    }
                } catch (error) {
                    console.error("[db] Could not save '" + key + "' to Neon:", error);
                } finally {
                    promise = null;
                }
            })();
        }

        return promise;
    };
}

async function initDatabase() {
    if (!pool) {
        console.warn("[db] DATABASE_URL is not set. Using local files (data is lost when Render restarts).");
        return;
    }

    await pool.query(
        "CREATE TABLE IF NOT EXISTS kv_store (" +
        "key TEXT PRIMARY KEY, " +
        "value JSONB NOT NULL, " +
        "updated_at TIMESTAMPTZ NOT NULL DEFAULT now())"
    );

    const accounts = await dbLoad("accounts");
    if (accounts && typeof accounts.users === "object") {
        accountsDb = accounts;
        if (!accountsDb.guilds || typeof accountsDb.guilds !== "object") accountsDb.guilds = {};
        if (!Array.isArray(accountsDb.reports)) accountsDb.reports = [];
        console.log("[db] Loaded " + Object.keys(accountsDb.users).length + " accounts from Neon.");
    } else {
        await writeAccountsNow();
        console.log("[db] Neon was empty. Saved the current accounts.");
    }

    const questions = await dbLoad("questions");
    if (Array.isArray(questions) && questions.length) questionsDb = questions;
    else await writeQuestionsNow();

    pruneOldMatches();
}

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    // Room for custom wallpaper / sound uploads (max 4 MB file + overhead).
    maxHttpBufferSize: 6 * 1024 * 1024
});

const PUBLIC_DIR = require("path").join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));
app.get("/", (req, res) => {
    res.sendFile(require("path").join(PUBLIC_DIR, "index.html"), (err) => {
        if (err) {
            console.error("index.html not found at:", PUBLIC_DIR, err.message);
            res.status(500).send("index.html missing on server: " + PUBLIC_DIR);
        }
    });
});

const rooms = {};

/* BOTS: remember every "connection" handler. A bot is given the very same
   handlers a real player gets (through a fake socket), so every rule of the
   game - blocks, Cupid links, Godfather, votes, stats - applies to bots too. */
const BOT_CONNECTION_HANDLERS = [];
{
    const originalIoOn = io.on.bind(io);

    io.on = function (event, handler) {
        if (event === "connection" && typeof handler === "function") {
            BOT_CONNECTION_HANDLERS.push(handler);
        }

        return originalIoOn(event, handler);
    };
}

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

function writeAccountsFile() {
    try {
        const tempFile = ACCOUNTS_FILE + ".tmp";
        fs.writeFileSync(tempFile, JSON.stringify(accountsDb));
        fs.renameSync(tempFile, ACCOUNTS_FILE);
    } catch (error) {
        console.error("Could not save accounts file:", error);
    }
}

const writeAccountsNow = makeDbSaver("accounts", () => accountsDb, writeAccountsFile);

function saveAccounts() {
    if (accountsSaveTimer) return;

    accountsSaveTimer = setTimeout(() => {
        accountsSaveTimer = null;
        writeAccountsNow();
    }, 500);
}

async function flushAccountsAndExit() {
    if (accountsSaveTimer) { clearTimeout(accountsSaveTimer); accountsSaveTimer = null; }
    if (questionsSaveTimer) { clearTimeout(questionsSaveTimer); questionsSaveTimer = null; }
    await writeAccountsNow();
    await writeQuestionsNow();
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
    trackMatchAction(player, stat);   // MVP system: counts for guests too
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
            guild: getGuildOfUser(user),
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
            guild: user.guild,
            points: user.total
        }));
}

function loginSocket(socket, accountKey, silent) {
    const user = accountsDb.users[accountKey];
    if (!user) return false;

    socketAccounts.set(socket.id, accountKey);
    syncAccountBadge(socket, false);
    communityTrackOnline(socket, accountKey);

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

/* ---------- GUILDS: name + color shown under a player's name ---------- */
const GUILD_COLORS = ["#ff3b3b","#ff8a00","#ffd400","#35d36b","#00d1c1","#2f9bff","#7b61ff","#d84dff","#ff4da6","#ffffff"];
const GUILD_MAX_MEMBERS = 50;
function guildSafeColor(c) {
    c = String(c || "").toLowerCase();
    return GUILD_COLORS.includes(c) ? c : GUILD_COLORS[0];
}
function getGuildOfUser(user) {
    const g = user && user.guildId && accountsDb.guilds ? accountsDb.guilds[user.guildId] : null;
    return g ? { id: user.guildId, name: g.name, color: guildSafeColor(g.color), tag: g.tag || guildDeriveTag(g.name) } : null;
}
function getGuildOfPlayer(player) {
    const user = player && player.account ? accountsDb.users[player.account] : null;
    return getGuildOfUser(user);
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
/* iPad-only wallpapers (they only appear under the iPad button) */
shopAdd({ id: "wp_crimsonmoon", cat: "wallpaper", name: "Crimson Moon Waterfront", price: 500, base: "crimson-moon",       devices: ["ipad"] });
shopAdd({ id: "wp_neonblue",    cat: "wallpaper", name: "Neon Blue Waterfront",    price: 500, base: "neon-blue-waterfront", devices: ["ipad"] });

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
const SHOP_FILE_EXTS = ["jpg", "jpeg", "png", "webp", "gif", "avif", "apng"];
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

/* ---------- Wallpapers per device (Laptop / Mobile / iPad) ----------
   For each shop wallpaper put up to 3 files in public/wallpapers/ :
       <base>-laptop.gif   <base>-mobile.gif   <base>-ipad.gif
   (jpg / png / webp / gif / avif / apng all work, live images included).
   Also accepted: "desktop" or "pc" for laptop, "phone" for mobile, "tablet" for iPad,
   and the device word in front ("laptop-<base>").
   If a device file is missing, the plain <base>.<ext> file (old way) or another
   device's file is used instead, so nothing breaks. */
const WALLPAPER_DEVICE_WORDS = {
    laptop: ["laptop", "desktop", "pc"],
    mobile: ["mobile", "phone"],
    ipad:   ["ipad", "tablet"]
};

function shopDeviceFileUrl(item, device, opts) {
    const dirs = (opts && opts.dirs) || SHOP_FILE_DIRS[item.cat];
    const okExts = (opts && opts.exts) || shopExtsFor(item);
    const words = WALLPAPER_DEVICE_WORDS[device];
    if (!dirs || !words) return null;

    const bases = [item.base, item.name, String(item.id || "").replace(/^[a-z]+_/, "")]
        .map(shopNorm).filter(Boolean);
    const wanted = [];
    bases.forEach(base => words.forEach(word => { wanted.push(base + word); wanted.push(word + base); }));

    const roots = Array.from(new Set([path.resolve("public"), path.join(__dirname, "public")]));

    for (const dir of dirs) {
        for (const root of roots) {
            let files = [];
            try { files = fs.readdirSync(path.join(root, dir)); } catch (_) { continue; }

            for (const name of wanted) {
                const hit = files.find(file => shopNorm(file) === name && okExts.includes(file.split(".").pop().toLowerCase()));
                if (hit) return `/${dir}/${encodeURIComponent(hit)}`;
            }
        }
    }
    return null;
}

/* LIVE wallpapers: self-contained animated .html pages in public/wallpapers/live/
   named  <base>-laptop.html  <base>-mobile.html  <base>-ipad.html
   (laptop falls back to ipad/mobile and so on, if a device has none). */
function shopLiveUrls(item) {
    const opts = { dirs: ["wallpapers/live"], exts: ["html", "htm"] };
    const own = {};
    Object.keys(WALLPAPER_DEVICE_WORDS).forEach(device => { own[device] = shopDeviceFileUrl(item, device, opts); });
    const any = own.laptop || own.ipad || own.mobile;
    if (!any) return null;
    const out = {};
    Object.keys(WALLPAPER_DEVICE_WORDS).forEach(device => { out[device] = own[device] || any; });
    return out;
}

function shopWallpaperUrls(item) {
    const roots = Array.from(new Set([path.resolve("public"), path.join(__dirname, "public")]));
    const exists = url => roots.some(root => fs.existsSync(path.join(root, decodeURIComponent(url))));

    const generic = shopFileUrl(item);
    const own = {};
    Object.keys(WALLPAPER_DEVICE_WORDS).forEach(device => { own[device] = shopDeviceFileUrl(item, device); });

    const fallback = exists(generic) ? generic : (own.laptop || own.ipad || own.mobile || generic);
    const out = {};
    Object.keys(WALLPAPER_DEVICE_WORDS).forEach(device => { out[device] = own[device] || fallback; });
    return out;
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
        SHOP_CATALOG.filter(item => item.cat === "wallpaper" && item.base && !item.file && !item.css).forEach(item => {
            Object.keys(WALLPAPER_DEVICE_WORDS).forEach(device => {
                const url = shopDeviceFileUrl(item, device);
                console.log(`[shop] ${url ? "OK     " : "MISSING"} wallpaper ${device.padEnd(6)} ${item.name.padEnd(15)} -> ${url || "put a file named " + item.base + "-" + device + ".gif (or .jpg/.png/.webp) in public/wallpapers/"}`);
            });
        });
        SHOP_CATALOG.filter(item => item.cat === "wallpaper" && item.base && !item.file && !item.css).forEach(item => {
            const live = shopLiveUrls(item);
            console.log(`[shop] ${live ? "OK     " : "MISSING"} LIVE      ${item.name.padEnd(24)} -> ${live ? [...new Set(Object.values(live))].join("  ") : "put " + item.base + "-laptop.html / -mobile.html / -ipad.html in public/wallpapers/live/"}`);
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
    ["skin", "art", "emoji", "css", "tier", "icon", "devices"].forEach(key => {
        if (item[key] !== undefined) out[key] = item[key];
    });
    if (item.file) out.url = item.file;
    else if (item.base) out.url = shopFileUrl(item);
    if (item.cat === "wallpaper" && !item.file && !item.css && item.base) {
        out.urls = shopWallpaperUrls(item);
        const live = shopLiveUrls(item);
        if (live) out.live = live;
    }
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

    /* MVP + permanent profile statistics: once per completed match. */
    finalizeMatch(room, winnerTest);

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
   MVP SYSTEM + PERSISTENT PLAYER PROFILES
   - Every player's performance is tracked during the match.
   - When the match ends the SERVER scores everybody, picks the
     PLAYER OF THE MATCH and sends the announcement to the room.
   - The host has no way to change the result.
   - Account players get permanent profile statistics, saved once
     per completed match (same accounts.json file as everything else,
     so keep DATA_DIR on a persistent disk on Render).
   - Guests can be MVP for the match screen, but nothing is saved.
========================================================= */

const MVP_POINTS = {
    kill: 3,          // successful kill
    detect: 4,        // correct detective detection
    save: 4,          // successful doctor save
    win: 5,           // winning team / winning neutral
    survive: 2,       // alive when the match ended
    correctVote: 1,   // Civilian voted for a Mafia member (role-fair credit)
    soloWin: 4        // extra credit for neutral roles that win alone (Jester, Executioner...)
};

/* Level XP for being the MVP. */
XP_VALUES.mvp = 25;

const NEUTRAL_ROLES = ["Jester", "Executioner", "Amnesiac"];
const PROFILE_HISTORY_LIMIT = 50;
const PROFILE_MATCH_ID_LIMIT = 80;

function teamOfRole(role) {
    if (isMafiaTeam(role)) return "mafia";
    if (NEUTRAL_ROLES.includes(role)) return "neutral";
    return "civilian";
}

function emptyTeamStats() {
    return { games: 0, wins: 0, kills: 0, saves: 0, detects: 0 };
}

/* Persistent profile numbers. Kills / saves / detections totals keep coming from user.stats. */
function ensureProfile(user) {
    if (!user.profile || typeof user.profile !== "object") user.profile = {};
    const p = user.profile;

    p.games = Math.max(0, Math.floor(Number(p.games) || 0));
    p.wins = Math.max(0, Math.floor(Number(p.wins) || 0));
    p.mvps = Math.max(0, Math.floor(Number(p.mvps) || 0));
    p.streak = Math.max(0, Math.floor(Number(p.streak) || 0));
    p.bestStreak = Math.max(0, Math.floor(Number(p.bestStreak) || 0));

    if (!p.teams || typeof p.teams !== "object") p.teams = {};
    ["mafia", "civilian", "neutral"].forEach(team => {
        p.teams[team] = { ...emptyTeamStats(), ...(p.teams[team] || {}) };
    });

    if (!p.roles || typeof p.roles !== "object") p.roles = {};
    if (!Array.isArray(p.history)) p.history = [];
    if (!Array.isArray(p.matchIds)) p.matchIds = [];

    return p;
}

/* Called from recordStat(): counts the action for the CURRENT match (guests too). */
function trackMatchAction(player, stat) {
    if (!player || !player.matchPerf) return;

    const keys = { kills: "kills", saves: "saves", detects: "detects", civilianVotes: "votes" };
    const key = keys[stat];
    if (key) player.matchPerf[key] += 1;
}

/* Called once when a brand-new game starts (after roles are assigned). */
function beginMatchTracking(room) {
    room.match = {
        id: crypto.randomBytes(8).toString("hex"),
        startedAt: Date.now(),
        finalized: false
    };

    room.players.forEach(player => {
        if (!player) return;
        player.matchPerf = { kills: 0, saves: 0, detects: 0, votes: 0, startRole: player.role || null };
    });
}

/* Role-aware score. Every role has something it can earn. */
function scoreMatchPlayer(player, won, alive) {
    const perf = player.matchPerf || { kills: 0, saves: 0, detects: 0, votes: 0 };
    const breakdown = [];
    const add = (label, count, each) => {
        if (count > 0) breakdown.push({ label, count, points: count * each });
    };

    add("Successful kills", perf.kills, MVP_POINTS.kill);
    add("Correct detections", perf.detects, MVP_POINTS.detect);
    add("Doctor saves", perf.saves, MVP_POINTS.save);
    add("Correct votes", perf.votes, MVP_POINTS.correctVote);

    if (won) {
        add("Winning team", 1, MVP_POINTS.win);
        if (teamOfRole(perf.startRole || player.role) === "neutral") add("Won the solo objective", 1, MVP_POINTS.soloWin);
    }

    if (alive) add("Survived until the end", 1, MVP_POINTS.survive);

    return {
        score: breakdown.reduce((sum, row) => sum + row.points, 0),
        breakdown
    };
}

/* Same result for everybody: only a hash of the match id + player decides a perfect tie. */
function mvpTieKey(matchId, player) {
    return crypto
        .createHash("sha256")
        .update(String(matchId) + ":" + String(player.account || player.name || player.id))
        .digest("hex");
}

/*
   Runs ONCE per completed match (guarded by room.match.finalized):
   1. scores every player
   2. picks the MVP (score > won > actions > survived > hash tie-break)
   3. saves permanent profile stats for account players (no duplicates)
   4. sends the PLAYER OF THE MATCH announcement to the room
*/
function finalizeMatch(room, winnerTest) {
    try {
        if (!room || !room.match || room.match.finalized) return;
        room.match.finalized = true;

        const matchId = room.match.id;
        const contenders = [];

        room.players.forEach(player => {
            if (!player || !player.role || !player.matchPerf) return;

            const won = Boolean(winnerTest && winnerTest(player));
            const alive = Boolean(player.alive);
            const result = scoreMatchPlayer(player, won, alive);
            const perf = player.matchPerf;

            contenders.push({
                player,
                won,
                alive,
                score: result.score,
                breakdown: result.breakdown,
                actions: perf.kills + perf.saves + perf.detects + perf.votes,
                tie: mvpTieKey(matchId, player)
            });
        });

        if (!contenders.length) return;

        contenders.sort((a, b) =>
            b.score - a.score ||
            Number(b.won) - Number(a.won) ||
            b.actions - a.actions ||
            Number(b.alive) - Number(a.alive) ||
            (a.tie < b.tie ? -1 : a.tie > b.tie ? 1 : 0)
        );

        const mvp = contenders[0];

        /* ----- winner label + MVP name (used by Match History) ----- */
        const winnerLabel = winnerLabelOf(contenders);
        const nameOf = entry => {
            const u = entry.player.account ? accountsDb.users[entry.player.account] : null;
            return u ? getDisplayName(u) : entry.player.name;
        };
        const mvpDisplayName = nameOf(mvp);
        const unlockNotices = [];

        tlLog(room, "win", "🏁 " + winnerLabel + " won the match. MVP: " + mvpDisplayName);

        /* ----- permanent account statistics (once per match, never twice) ----- */
        contenders.forEach(entry => {
            const user = entry.player.account ? accountsDb.users[entry.player.account] : null;
            if (!user) return;

            const profile = ensureProfile(user);
            if (profile.matchIds.includes(matchId)) return;

            /* Remember what was already unlocked, so only NEW unlocks are announced. */
            syncAchievementsSeen(user);
            syncProfileCards(user);

            const perf = entry.player.matchPerf;
            const startRole = perf.startRole || entry.player.role;
            const team = teamOfRole(startRole);
            const isMvp = entry === mvp;

            profile.matchIds.push(matchId);
            if (profile.matchIds.length > PROFILE_MATCH_ID_LIMIT) {
                profile.matchIds.splice(0, profile.matchIds.length - PROFILE_MATCH_ID_LIMIT);
            }

            profile.games += 1;
            if (entry.won) {
                profile.wins += 1;
                profile.streak += 1;
                profile.bestStreak = Math.max(profile.bestStreak, profile.streak);
            } else {
                profile.streak = 0;
            }

            const teamStats = profile.teams[team];
            teamStats.games += 1;
            if (entry.won) teamStats.wins += 1;
            teamStats.kills += perf.kills;
            teamStats.saves += perf.saves;
            teamStats.detects += perf.detects;

            const roleStats = profile.roles[startRole] || { games: 0, wins: 0, mvps: 0, kills: 0, saves: 0, detects: 0 };
            roleStats.games += 1;
            if (entry.won) roleStats.wins += 1;
            if (isMvp) roleStats.mvps += 1;
            roleStats.kills += perf.kills;
            roleStats.saves += perf.saves;
            roleStats.detects += perf.detects;
            profile.roles[startRole] = roleStats;

            if (isMvp) {
                profile.mvps += 1;
                awardXp(user, "mvp");
            }

            profile.history.unshift({
                id: matchId,
                t: Date.now(),
                role: startRole,
                team,
                won: entry.won,
                alive: entry.alive,
                mvp: isMvp,
                score: entry.score,
                kills: perf.kills,
                saves: perf.saves,
                detects: perf.detects,
                players: contenders.length,
                winner: winnerLabel,
                mvpName: mvpDisplayName,
                mvpGuild: getGuildOfPlayer(mvp.player),
                nights: room.nightNumber || 1
            });
            if (profile.history.length > PROFILE_HISTORY_LIMIT) profile.history.length = PROFILE_HISTORY_LIMIT;

            /* Winning streak + new achievements / profile cards. */
            const newAch = syncAchievementsSeen(user);
            const newCards = syncProfileCards(user);
            unlockNotices.push({
                playerId: entry.player.id,
                won: entry.won,
                streak: profile.streak,
                bestStreak: profile.bestStreak,
                achievements: newAch.map(a => ({ icon: a.icon, name: a.name, desc: a.desc })),
                cards: newCards.map(c => ({ id: c.id, name: c.name }))
            });
        });

        /* ----- the full match record (timeline included), saved in Neon ----- */
        const record = {
            id: matchId,
            t: Date.now(),
            winner: winnerLabel,
            mvp: { name: mvpDisplayName, role: mvp.player.matchPerf.startRole || mvp.player.role, score: mvp.score, guild: getGuildOfPlayer(mvp.player) },
            nights: room.nightNumber || 1,
            accounts: contenders.map(entry => entry.player.account).filter(Boolean),
            players: contenders.map(entry => ({
                name: nameOf(entry),
                guild: getGuildOfPlayer(entry.player),
                role: entry.player.role,
                startRole: entry.player.matchPerf.startRole || entry.player.role,
                team: teamOfRole(entry.player.matchPerf.startRole || entry.player.role),
                won: entry.won,
                alive: entry.alive,
                mvp: entry === mvp,
                score: entry.score,
                kills: entry.player.matchPerf.kills,
                saves: entry.player.matchPerf.saves,
                detects: entry.player.matchPerf.detects
            })),
            timeline: (room.timeline || []).slice(0, 700)
        };
        saveMatchRecord(record);

        /* A moment after the MVP screen: streak / achievement / card unlock popups. */
        setTimeout(() => {
            unlockNotices.forEach(notice => {
                if (notice.won || notice.achievements.length || notice.cards.length) {
                    io.to(notice.playerId).emit("progressUnlocks", notice);
                }
            });
        }, 7000);

        saveAccounts();

        /* ----- the announcement ----- */
        const mvpUser = mvp.player.account ? accountsDb.users[mvp.player.account] : null;
        const payload = {
            matchId,
            name: mvpUser ? getDisplayName(mvpUser) : mvp.player.name,
            guest: !mvpUser,
            playerId: mvp.player.id,
            look: getLookOfPlayer(mvp.player),
            tier: mvpUser ? getEquippedTierKey(mvpUser) : null,
            guild: mvpUser ? getGuildOfUser(mvpUser) : null,
            badge: mvpUser ? (mvpUser.badge || "member") : null,
            role: mvp.player.role,
            team: teamOfRole(mvp.player.matchPerf.startRole || mvp.player.role),
            won: mvp.won,
            alive: mvp.alive,
            score: mvp.score,
            breakdown: mvp.breakdown,
            stats: {
                kills: mvp.player.matchPerf.kills,
                saves: mvp.player.matchPerf.saves,
                detects: mvp.player.matchPerf.detects,
                votes: mvp.player.matchPerf.votes
            },
            mvpCount: mvpUser ? ensureProfile(mvpUser).mvps : null,
            runnersUp: contenders.slice(1, 4).map(entry => ({
                name: entry.player.account && accountsDb.users[entry.player.account]
                    ? getDisplayName(accountsDb.users[entry.player.account])
                    : entry.player.name,
                score: entry.score
            }))
        };

        /* A moment after the victory screen appears. */
        setTimeout(() => {
            room.players.forEach(player => {
                if (player && player.connected !== false && player.id) {
                    io.to(player.id).emit("mvpResult", { ...payload, you: player === mvp.player });
                }
            });
        }, 1500);
    } catch (error) {
        console.error("MVP / profile update failed:", error);
    }
}

const PROFILE_ACHIEVEMENTS = [
    { id: "first_blood",  icon: "🔪", name: "First Blood",        desc: "Eliminate your first player",                 test: c => c.kills >= 1 },
    { id: "hitman",       icon: "💀", name: "Hitman",             desc: "25 total kills",                              test: c => c.kills >= 25 },
    { id: "guardian",     icon: "🛡️", name: "Guardian Angel",     desc: "10 successful saves",                         test: c => c.saves >= 10 },
    { id: "sherlock",     icon: "🔎", name: "Sherlock",           desc: "10 correct detections",                       test: c => c.detects >= 10 },
    { id: "first_win",    icon: "🏆", name: "First Victory",      desc: "Win a match",                                 test: c => c.wins >= 1 },
    { id: "veteran",      icon: "🎖️", name: "Veteran",            desc: "Play 50 matches",                             test: c => c.games >= 50 },
    { id: "streak3",      icon: "🔥", name: "On Fire",            desc: "Win 3 matches in a row",                      test: c => c.bestStreak >= 3 },
    { id: "streak5",      icon: "⚡", name: "Unstoppable",        desc: "Win 5 matches in a row",                      test: c => c.bestStreak >= 5 },
    { id: "streak10",     icon: "💥", name: "Untouchable",        desc: "Win 10 matches in a row",                     test: c => c.bestStreak >= 10 },
    { id: "streak25",     icon: "🌋", name: "Living Legend",      desc: "Win 25 matches in a row",                     test: c => c.bestStreak >= 25 },
    { id: "streak50",     icon: "♾️", name: "Immortal Boss",      desc: "Win 50 matches in a row",                     test: c => c.bestStreak >= 50 },
    { id: "mvp1",         icon: "⭐", name: "Player of the Match", desc: "Earn your first MVP award",                  test: c => c.mvps >= 1 },
    { id: "mvp10",        icon: "👑", name: "MVP Legend",         desc: "Earn 10 MVP awards",                          test: c => c.mvps >= 10 },
    { id: "triple",       icon: "🎭", name: "Triple Threat",      desc: "Play on the Mafia, Civilian and Neutral teams", test: c => c.teams.mafia.games > 0 && c.teams.civilian.games > 0 && c.teams.neutral.games > 0 },
    { id: "level10",      icon: "🌟", name: "Rising Star",        desc: "Reach level 10",                              test: c => c.level >= 10 }
];


/* =========================================================
   PROFILE CARDS + PLAYER TITLES + PROGRESS UNLOCKS
   - Every account has one selected animated profile card.
   - Cards unlock from real progress (wins, level, streaks, MVPs)
     and stay unlocked forever (saved on the account in Neon).
   - Titles are earned automatically from progress.
========================================================= */

const PROFILE_CARDS = [
    { id: "classic",   name: "Classic Syndicate", hint: "Your starting card",          test: () => true },
    { id: "spotlight", name: "Spotlight",         hint: "Win your first match",        test: c => c.wins >= 1 },
    { id: "nightfall", name: "Nightfall",         hint: "Reach level 5",               test: c => c.level >= 5 },
    { id: "ember",     name: "Ember Veins",       hint: "Win 5 matches in a row",      test: c => c.bestStreak >= 5 },
    { id: "crown",     name: "MVP Crown",         hint: "Earn 3 MVP awards",           test: c => c.mvps >= 3 },
    { id: "aurora",    name: "Aurora Pulse",      hint: "Win 10 matches in a row",     test: c => c.bestStreak >= 10 },
    { id: "inferno",   name: "Inferno Legend",    hint: "Win 25 matches in a row",     test: c => c.bestStreak >= 25 },
    { id: "immortal",  name: "Immortal",          hint: "Win 50 matches in a row",     test: c => c.bestStreak >= 50 }
];

/* First matching title wins (highest first). */
const PROFILE_TITLES = [
    { icon: "♾️", name: "Immortal Boss",  test: c => c.bestStreak >= 50 },
    { icon: "🌋", name: "Living Legend",  test: c => c.bestStreak >= 25 },
    { icon: "💥", name: "Untouchable",    test: c => c.bestStreak >= 10 },
    { icon: "👑", name: "MVP Legend",     test: c => c.mvps >= 10 },
    { icon: "⚡", name: "Unstoppable",    test: c => c.bestStreak >= 5 },
    { icon: "🌟", name: "Rising Star",    test: c => c.level >= 10 },
    { icon: "🎖️", name: "Made Man",       test: c => c.wins >= 10 },
    { icon: "🏆", name: "Winner",         test: c => c.wins >= 1 },
    { icon: "🎭", name: "Rookie",         test: c => c.games >= 1 },
    { icon: "👤", name: "Newcomer",       test: () => true }
];

function profileContext(user) {
    const profile = ensureProfile(user);
    const stats = { ...emptyStats(), ...(user.stats || {}) };
    const info = levelInfo(ensureProgress(user).xp);

    return {
        kills: Number(stats.kills) || 0,
        saves: Number(stats.saves) || 0,
        detects: Number(stats.detects) || 0,
        wins: profile.wins,
        games: profile.games,
        streak: profile.streak,
        bestStreak: profile.bestStreak,
        mvps: profile.mvps,
        teams: profile.teams,
        level: info.level
    };
}

function getProfileTitle(user) {
    const c = profileContext(user);
    const t = PROFILE_TITLES.find(x => x.test(c)) || PROFILE_TITLES[PROFILE_TITLES.length - 1];
    return { icon: t.icon, name: t.name };
}

/* Saved on the account: { selected, unlocked: [ids] }.  Returns the cards that unlocked just now.
   The very first time an account is checked, everything already earned is saved silently. */
function syncProfileCards(user) {
    const first = !user.cards || typeof user.cards !== "object";
    if (first) user.cards = { selected: "classic", unlocked: [] };
    if (!Array.isArray(user.cards.unlocked)) user.cards.unlocked = [];

    const c = profileContext(user);
    const fresh = [];

    PROFILE_CARDS.forEach(card => {
        if (card.test(c) && !user.cards.unlocked.includes(card.id)) {
            user.cards.unlocked.push(card.id);
            if (!first) fresh.push(card);
        }
    });

    if (!PROFILE_CARDS.some(card => card.id === user.cards.selected) || !user.cards.unlocked.includes(user.cards.selected)) {
        user.cards.selected = "classic";
    }

    return fresh;
}

/* Same idea for achievements: remember which ones the player has already been told about. */
function syncAchievementsSeen(user) {
    const first = !Array.isArray(user.achSeen);
    if (first) user.achSeen = [];

    const c = profileContext(user);
    const fresh = [];

    PROFILE_ACHIEVEMENTS.forEach(a => {
        if (a.test(c) && !user.achSeen.includes(a.id)) {
            user.achSeen.push(a.id);
            if (!first) fresh.push(a);
        }
    });

    return fresh;
}

function cardSummary(user) {
    const c = profileContext(user);
    return { level: c.level, wins: c.wins, streak: c.streak, best: c.bestStreak };
}

function getCardList(user) {
    syncProfileCards(user);
    return PROFILE_CARDS.map(card => ({
        id: card.id,
        name: card.name,
        hint: card.hint,
        unlocked: user.cards.unlocked.includes(card.id),
        selected: user.cards.selected === card.id
    }));
}

/* =========================================================
   MATCH TIMELINE + MATCH HISTORY (saved in Neon, one row per match)
========================================================= */

const MATCHES_DIR = path.join(DATA_DIR, "matches");
const matchCache = new Map();

function safeMatchId(id) {
    return String(id || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40);
}

/* One timeline entry. k = phase | death | vote | action | announce | win | info */
function tlLog(room, kind, text) {
    if (!room || !text) return;
    if (!Array.isArray(room.timeline)) room.timeline = [];
    if (room.timeline.length >= 700) return;

    room.timeline.push({
        n: room.nightNumber || 1,
        ph: room.phase === "day" ? "day" : "night",
        k: kind || "info",
        x: String(text).slice(0, 240)
    });
}

async function saveMatchRecord(record) {
    const id = safeMatchId(record && record.id);
    if (!id) return;

    matchCache.set(id, record);
    if (matchCache.size > 40) matchCache.delete(matchCache.keys().next().value);

    try {
        if (pool) {
            await dbSave("match:" + id, record);
        } else {
            fs.mkdirSync(MATCHES_DIR, { recursive: true });
            fs.writeFileSync(path.join(MATCHES_DIR, id + ".json"), JSON.stringify(record));
        }
    } catch (error) {
        console.error("[matches] Could not save match " + id + ":", error);
    }
}

async function loadMatchRecord(rawId) {
    const id = safeMatchId(rawId);
    if (!id) return null;
    if (matchCache.has(id)) return matchCache.get(id);

    try {
        let record = null;
        if (pool) record = await dbLoad("match:" + id);
        else {
            const file = path.join(MATCHES_DIR, id + ".json");
            if (fs.existsSync(file)) record = JSON.parse(fs.readFileSync(file, "utf8"));
        }
        if (record) matchCache.set(id, record);
        return record;
    } catch (error) {
        console.error("[matches] Could not load match " + id + ":", error);
        return null;
    }
}

/* Old matches are removed after 120 days so the database stays small. */
async function pruneOldMatches() {
    if (!pool) return;
    try {
        await pool.query("DELETE FROM kv_store WHERE key LIKE 'match:%' AND updated_at < now() - interval '120 days'");
    } catch (error) {
        console.error("[matches] prune failed:", error.message);
    }
}

function winnerLabelOf(contenders) {
    const winners = contenders.filter(entry => entry.won);
    if (!winners.length) return "Nobody";
    const teams = new Set(winners.map(entry => teamOfRole(entry.player.matchPerf.startRole || entry.player.role)));
    if (teams.size === 1 && teams.has("mafia")) return "Mafia Team";
    if (teams.size === 1 && teams.has("civilian")) return "Civilian Team";
    return "Neutral Team";
}

/* Public profile of one ACCOUNT (never includes passwords, PIN, shop points or owned items). */
function buildFullProfile(user) {
    const profile = ensureProfile(user);
    const stats = { ...emptyStats(), ...(user.stats || {}) };
    const info = levelInfo(ensureProgress(user).xp);

    const favourite = Object.entries(profile.roles)
        .sort((a, b) => (b[1].games - a[1].games) || a[0].localeCompare(b[0]))[0];

    const context = {
        kills: Number(stats.kills) || 0,
        saves: Number(stats.saves) || 0,
        detects: Number(stats.detects) || 0,
        wins: profile.wins,
        games: profile.games,
        bestStreak: profile.bestStreak,
        mvps: profile.mvps,
        teams: profile.teams,
        level: info.level
    };

    return {
        ok: true,
        username: user.username,
        displayName: getDisplayName(user),
        badge: user.badge || "member",
        tier: getEquippedTierKey(user),
        guild: getGuildOfUser(user),
        look: getLookOfUser(user),
        memberSince: Number(user.created) || null,
        card: (syncProfileCards(user), user.cards.selected),
        title: getProfileTitle(user),
        level: info.level,
        xpIntoLevel: info.xpIntoLevel,
        xpNeeded: info.xpNeeded,
        rankPoints: totalStats(user.stats),
        totals: {
            games: profile.games,
            wins: profile.wins,
            winRate: profile.games ? Math.round((profile.wins / profile.games) * 1000) / 10 : 0,
            kills: context.kills,
            saves: context.saves,
            detects: context.detects,
            favouriteRole: favourite ? favourite[0] : null,
            bestStreak: profile.bestStreak,
            currentStreak: profile.streak,
            mvps: profile.mvps
        },
        teams: ["mafia", "civilian", "neutral"].map(team => {
            const t = profile.teams[team];
            return {
                team,
                games: t.games,
                wins: t.wins,
                winRate: t.games ? Math.round((t.wins / t.games) * 1000) / 10 : 0,
                kills: t.kills,
                saves: t.saves,
                detects: t.detects
            };
        }),
        roles: Object.entries(profile.roles)
            .map(([role, r]) => ({
                role,
                games: r.games,
                wins: r.wins,
                mvps: r.mvps || 0,
                winRate: r.games ? Math.round((r.wins / r.games) * 1000) / 10 : 0
            }))
            .sort((a, b) => b.games - a.games || a.role.localeCompare(b.role))
            .slice(0, 12),
        history: profile.history.slice(0, 15),
        achievements: PROFILE_ACHIEVEMENTS.map(a => ({
            id: a.id,
            icon: a.icon,
            name: a.name,
            desc: a.desc,
            unlocked: Boolean(a.test(context))
        }))
    };
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
                maxPlayers: getRoomMaxPlayers(room),
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

    // Day = discussion time (chat only) + voting time. Both are set by the host.
    // Night phases keep the old fixed limit (night turns have their own timer).
    let phaseLimit = PHASE_TIME_LIMIT;
    room.votingOpensAt = null;

    if (room.phase === "day") {
        const t = getRoomTimers(room);
        phaseLimit = (t.discussion + t.voting) * 1000;
        room.votingOpensAt = t.discussion > 0 ? Date.now() + t.discussion * 1000 : null;
    }

    room.phaseEndsAt = Date.now() + phaseLimit;

    room.phaseTimer = setTimeout(() => {
        const currentRoom = rooms[roomCode];
        if (!currentRoom) return;

        currentRoom.phaseTimer = null;

        if (currentRoom.phase === "night") {
            announce(roomCode, "⏰ Time is over. Night is ending even if someone did not choose an action.", "info");
            endNight(roomCode);
        } else if (currentRoom.phase === "day") {
            announce(roomCode, "⏰ Time is over. Voting is ending even if someone did not vote.", "info");
            endVoting(roomCode);
        }
    }, phaseLimit);
}


/* =========================================================
   SEQUENTIAL NIGHT ROLE TURNS
   Mafia -> Doctor -> Detective -> Cupid
   Each active role gets 30 seconds.
========================================================= */

const NIGHT_TURN_ORDER = [
    "escort",
    "mafia",
    "framer",
    "doctor",
    "bodyguard",
    "detective",
    "sheriff",
    "vigilante",
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
    const turnDisplayMs = nightTurnDurationMs(room, room.nightTurn);

    room.nightTurnEndsAt = Date.now() + turnDisplayMs;

    const turnLengthMs = room.hiddenNightTurn
        ? randomHiddenTurnMs(turnDisplayMs)
        : turnDisplayMs;

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
        "Baby Mafia",
        "Framer"
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
        "Baby Mafia",
        "Framer"
    ].includes(role);
}

/* =========================================================
   ANNOUNCEMENT
========================================================= */

function announce(roomCode, message, type = "info") {
    if (!rooms[roomCode]) return;

    if (rooms[roomCode].gameStarted && rooms[roomCode].phase !== "lobby") {
        tlLog(rooms[roomCode], "announce", message);
    }

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

    const EXTRA_ASSIGN = [
        ["bodyguard", "Bodyguard"],
        ["vigilante", "Vigilante"],
        ["sheriff", "Sheriff"],
        ["mayor", "Mayor"],
        ["escort", "Escort"],
        ["framer", "Framer"],
        ["medium", "Medium"],
        ["executioner", "Executioner"],
        ["amnesiac", "Amnesiac"]
    ];

    EXTRA_ASSIGN.forEach(([key, roleName]) => {
        for (let i = 0; i < (Number(settings[key]) || 0); i++) {
            roles.push(roleName);
        }
    });

    for (let i = 0; i < settings.civilian; i++) {
        roles.push("Civilian");
    }

    shuffleRolesFairly(roles, players);

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

    // New match = bots forget everything from the old one.
    if (typeof botResetRoom === "function") botResetRoom(room);

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
                guild: getGuildOfPlayer(player),
                look: getLookOfPlayer(player),
                registered: Boolean(player.account),
                alive: player.alive,
                role: visibleRole,
                connected: true,
                ready: Boolean(player.ready),
                isBot: Boolean(player.isBot),
                botLevel: player.isBot ? player.botLevel : null
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

            maxPlayers:
                getRoomMaxPlayers(room),

            timers:
                getRoomTimers(room),

            botLevel:
                room.botLevel || "medium",

            roomCode,
            description: String(room.description || ""),
            readyPlayers: room.players.filter(p => p.ready && p.connected !== false).map(p => p.id),
            spectatorCount: Array.isArray(room.spectators) ? room.spectators.length : 0,
            spectatorLimit: Number(room.spectatorLimit) || 10
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

    eliminated.forEach(p => tlLog(room, "death", "☠️ " + p.name + " (" + p.role + ") was eliminated"));

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

                maxPlayers:
                    getRoomMaxPlayers(room),

                timers:
                    getRoomTimers(room),

                votingOpensAt:
                    room.votingOpensAt || null,

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
                    ),

                extra:
                    buildExtraInfo(
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
        } else if (team === "civilians" && !isMafiaTeam(p.role) && p.role !== "Jester" && p.role !== "Executioner") {
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
    /* =====================================================
       EXECUTIONER WIN
       The Executioner wins when their secret target is
       voted out by the town.
    ===================================================== */

    if (room.executionerWinnerId) {
        const executioner =
            room.players.find(
                p => p.id === room.executionerWinnerId
            );

        room.executionerWinnerId = null;

        if (executioner) {
            room.phase = "gameover";

            grantGameRewards(room, p => p === executioner);

            replayLog(room, `🪓 Executioner ${executioner.name} got their target voted out and wins!`, "win");

            announce(
                roomCode,
                `🪓 ${executioner.name} was the Executioner and wins!`,
                "special"
            );

            io.to(roomCode).emit(
                "gameOver",
                {
                    winner: "Executioner",
                    message:
                        `${executioner.name} got their target voted out and wins the game!`,
                    stats: room.stats
                }
            );

            return true;
        }
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
        grantGameRewards(room, p => !isMafiaTeam(p.role) && p.role !== "Jester" && p.role !== "Executioner");

        replayLog(room, "🎉 The Mafia team was eliminated. Civilians win!", "win");

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

        replayLog(room, "☠️ The Mafia team took control. Mafia wins!", "win");

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

    room.nightNotes = [];
    replayNightActions(room);

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
            if (isNightBlocked(room, attackerId)) return;


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
            !protectedPlayers.has(mafiaTarget) &&
            (room._guardian = findGuardian(room, mafiaTarget))
        ) {
            const guardian = room._guardian;

            eliminatedPlayers =
                eliminatePlayerWithCupid(
                    room,
                    guardian
                );

            room.nightNotes.push(
                `🛡️ ${guardian.name} (the Bodyguard) gave their life to protect ${target.name}.`
            );

            replayLog(
                room,
                `🛡️ Bodyguard ${guardian.name} died protecting ${target.name}`,
                "bodyguard"
            );
        }

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
       VIGILANTE
    ===================================================== */

    eliminatedPlayers = eliminatedPlayers.concat(
        resolveVigilantes(room, protectedPlayers)
    );


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
    tlLog(room, "phase", "☀️ Day " + (room.nightNumber || 1) + " begins");

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
            return Boolean(checked && (isDetectiveMafia(checked.role) || isNightFramed(room, checked.id)));
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

    if (doctorSavedTarget && !eliminatedPlayers.length) {
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
            nightKillText(room, names, verb, doctorLine, detectiveLine, doctorSavedTarget),
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
    tlLog(room, "phase", "🌙 Night " + room.nightNumber + " begins");

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

    replayDayVotes(room);

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
            (voteCounts[targetId] || 0) + (voter.role === "Mayor" ? 2 : 1);
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

    room._deathCause = "vote";

    const eliminatedPlayers =
        eliminatePlayerWithCupid(
            room,
            eliminatedPlayer
        );

    room._deathCause = null;

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

    // Bots never take a voice-chat slot.
    const valid = unique.filter(id =>
        room.players.some(p => p.id === id && p.connected !== false && !p.isBot)
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

function writeQuestionsFile() {
    try {
        const tempFile = QUESTIONS_FILE + ".tmp";
        fs.writeFileSync(tempFile, JSON.stringify(questionsDb));
        fs.renameSync(tempFile, QUESTIONS_FILE);
    } catch (error) {
        console.error("Could not save questions file:", error);
    }
}

const writeQuestionsNow = makeDbSaver("questions", () => questionsDb, writeQuestionsFile);

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

                if (user.banned) {
                    return socket.emit("authResult", { ok: false, error: "This account is banned." });
                }

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
                    createdByOwner: user.createdBy === "owner",
                    banned: Boolean(user.banned)
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

            if (!key || !accountsDb.users[key] || accountsDb.users[key].banned) {
                return socket.emit("authResult", {
                    ok: false,
                    resume: true,
                    error: ""
                });
            }

            socketAccounts.set(socket.id, key);
            syncAccountBadge(socket, false);
            communityTrackOnline(socket, key);

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

        /* Full statistics profile of one ACCOUNT (public: opened by clicking a username). */
        /* =================================================
           TUTORIAL / MATCH HISTORY / PROFILE CARDS
        ================================================= */

        socket.on("getTutorialState", callback => {
            const reply = typeof callback === "function" ? callback : () => {};
            const key = getSocketAccountKey(socket);
            const user = key ? accountsDb.users[key] : null;
            if (!user) return reply({ ok: true, guest: true, done: false });
            reply({ ok: true, guest: false, done: Boolean(user.tutorialDone) });
        });

        socket.on("setTutorialDone", (data, callback) => {
            const reply = typeof callback === "function" ? callback : () => {};
            const key = getSocketAccountKey(socket);
            const user = key ? accountsDb.users[key] : null;
            if (!user) return reply({ ok: false });
            user.tutorialDone = data && data.done === false ? false : true;
            saveAccounts();
            reply({ ok: true, done: user.tutorialDone });
        });

        socket.on("getMyMatchHistory", () => {
            const key = getSocketAccountKey(socket);
            const user = key ? accountsDb.users[key] : null;
            if (!user) return socket.emit("myMatchHistory", { ok: false, error: "Sign in to keep a match history." });

            const profile = ensureProfile(user);
            socket.emit("myMatchHistory", {
                ok: true,
                currentStreak: profile.streak,
                bestStreak: profile.bestStreak,
                matches: profile.history.slice(0, PROFILE_HISTORY_LIMIT)
            });
        });

        socket.on("getMatchTimeline", async data => {
            const key = getSocketAccountKey(socket);
            const user = key ? accountsDb.users[key] : null;
            if (!user) return socket.emit("matchTimeline", { ok: false, error: "Sign in first." });

            const now = Date.now();
            if (now - (socket.data.timelineAt || 0) < 400) return;
            socket.data.timelineAt = now;

            const record = await loadMatchRecord(data && data.id);
            if (!record) return socket.emit("matchTimeline", { ok: false, error: "This match is no longer saved." });

            const staff = user.badge === "owner" || user.badge === "admin";
            if (!staff && !(Array.isArray(record.accounts) && record.accounts.includes(key))) {
                return socket.emit("matchTimeline", { ok: false, error: "You were not in this match." });
            }

            socket.emit("matchTimeline", { ok: true, match: record });
        });

        socket.on("getProfileCards", () => {
            const key = getSocketAccountKey(socket);
            const user = key ? accountsDb.users[key] : null;
            if (!user) return socket.emit("profileCards", { ok: false, error: "Sign in to use profile cards." });

            const list = getCardList(user);
            saveAccounts();
            socket.emit("profileCards", { ok: true, selected: user.cards.selected, cards: list, title: getProfileTitle(user), summary: cardSummary(user) });
        });

        socket.on("selectProfileCard", data => {
            const key = getSocketAccountKey(socket);
            const user = key ? accountsDb.users[key] : null;
            if (!user) return socket.emit("profileCards", { ok: false, error: "Sign in to use profile cards." });

            syncProfileCards(user);
            const id = String(data && data.id || "");
            if (!user.cards.unlocked.includes(id)) {
                return socket.emit("profileCards", { ok: false, error: "That card is still locked." });
            }

            user.cards.selected = id;
            saveAccounts();
            socket.emit("profileCards", { ok: true, selected: id, cards: getCardList(user), title: getProfileTitle(user), summary: cardSummary(user), changed: true });
        });

        socket.on("getFullProfile", data => {
            const now = Date.now();
            if (now - (socket.data.fullProfileAt || 0) < 200) return;
            socket.data.fullProfileAt = now;

            let user = null;
            let hideLogin = false;

            if (data?.playerId) {
                /* From a room: the login name stays private, we find the account on the server. */
                const code = findRoomCodeBySocket(socket.id);
                const room = code ? rooms[code] : null;
                const target = room
                    ? room.players.find(p => p.id === String(data.playerId))
                    : null;
                user = target && target.account ? accountsDb.users[target.account] : null;
                hideLogin = true;
            } else {
                const key = String(data?.username || "").trim().toLowerCase();
                user = accountsDb.users[key];
            }

            if (!user) {
                return socket.emit("fullProfileData", { ok: false });
            }

            const profile = buildFullProfile(user);
            if (hideLogin) delete profile.username;

            socket.emit("fullProfileData", profile);
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
                guild: getGuildOfUser(user),
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
                guild: getGuildOfUser(user),
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
                mvps: ensureProfile(user).mvps,
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

                    // Host options: room size, timers (seconds) and banned players.
                    maxPlayers: DEFAULT_MAX_PLAYERS,
                    timers: { ...DEFAULT_TIMERS },
                    banned: { accounts: [], names: [], ips: [] },

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

                if (isBannedFromRoom(room, socket, playerName)) {
                    return socket.emit(
                        "joinError",
                        "You were banned from this room by the host."
                    );
                }

                if (room.players.filter(p => p.connected !== false).length >= getRoomMaxPlayers(room)) {
                    return socket.emit(
                        "joinError",
                        "This room is full."
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

            if (oldPlayer.kicked || isBannedFromRoom(room, socket, playerName)) {
                return socket.emit(
                    "rejoinError",
                    "You were removed from this room by the host."
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

            // A room that only has bots left is closed (a bot can't host).
            if (!room.players.some(player => !player.isBot)) {
                delete rooms[code];
                emitPublicMatches();
                return;
            }

            if (room.host === socket.id) {
                const nextHost = room.players.find(player => !player.isBot);
                room.host = nextHost.id;
                announce(
                    code,
                    `👑 ${nextHost.name} is now the host.`,
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

                const playersWhoMustBeReady = room.players.filter(
                    player => !player.isBot && player.connected !== false
                );
                const notReadyPlayers = playersWhoMustBeReady.filter(player => !player.ready);
                if (notReadyPlayers.length) {
                    return socket.emit(
                        "gameError",
                        `Everyone must click READY before the host starts. Waiting for: ${notReadyPlayers.map(player => player.name).join(", " )}`
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

                    bodyguard: Math.max(0, Math.floor(Number(input.bodyguard) || 0)),
                    vigilante: Math.max(0, Math.floor(Number(input.vigilante) || 0)),
                    sheriff: Math.max(0, Math.floor(Number(input.sheriff) || 0)),
                    mayor: Math.max(0, Math.floor(Number(input.mayor) || 0)),
                    escort: Math.max(0, Math.floor(Number(input.escort) || 0)),
                    framer: Math.max(0, Math.floor(Number(input.framer) || 0)),
                    medium: Math.max(0, Math.floor(Number(input.medium) || 0)),
                    executioner: Math.max(0, Math.floor(Number(input.executioner) || 0)),
                    amnesiac: Math.max(0, Math.floor(Number(input.amnesiac) || 0)),

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
                    settings.civilian +
                    extraRoleCount(settings);

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
                    settings.grandmafia +
                    settings.framer <
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

                if (settings.mayor > 1 || settings.amnesiac > 1 || settings.executioner > 1) {

                    return socket.emit(
                        "gameError",
                        "You can have at most 1 Mayor, 1 Amnesiac and 1 Executioner!"
                    );
                }

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

setupRoleExtras(room);

/* MVP system: start tracking this match. */
beginMatchTracking(room);

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
                        kind: isNightBlocked(room, socket.id) ? "blocked" : "mafia",
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

                socket.emit("nightActionPopup", { kind: "grandmafia", targetName: target.name });

                socket.emit("grandmafiaSpecialDone");

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

                if (isNightBlocked(room, socket.id)) {
                    room.nightActions.doctor[socket.id] = NIGHT_BLOCKED;
                    socket.emit("nightActionPopup", { kind: "blocked" });
                    socket.emit("extraActionDone", {
                        role: "Doctor",
                        blocked: true,
                        message: "🚫 Your ability has been blocked!"
                    });
                    checkNightActions(data.roomCode);
                    return;
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

                if (isNightBlocked(room, socket.id)) {
                    room.nightActions.detective[socket.id] = NIGHT_BLOCKED;
                    socket.emit("nightActionPopup", { kind: "blocked" });
                    socket.emit("extraActionDone", {
                        role: "Detective",
                        blocked: true,
                        message: "🚫 Your ability has been blocked!"
                    });
                    checkNightActions(data.roomCode);
                    return;
                }

                room.nightActions.detective[
                    socket.id
                ] =
                    target.id;

                room.stats.detectiveInvestigations += 1;

                const detectiveFoundMafia = isDetectiveMafia(target.role) || isNightFramed(room, target.id);

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

                // Discussion time: everybody talks first, voting opens afterwards.
                if (room.votingOpensAt && Date.now() < room.votingOpensAt) {
                    const wait = Math.ceil((room.votingOpensAt - Date.now()) / 1000);
                    return socket.emit(
                        "actionError",
                        `Discussion time! Voting opens in ${wait} second${wait === 1 ? "" : "s"}.`
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

                        // A bot can never become the host.
                        const newHost =
                            room.players.find(
                                p => p.connected !== false && !p.isBot
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
   MAFIA WARS - EXTRA ROLES AND FEATURES
   Roles:    Bodyguard, Vigilante, Sheriff, Mayor, Escort,
             Framer, Medium, Executioner, Amnesiac
   Features: dead chat, last words (will), emotes, friends list,
             game replay summary, host role setup for new roles
   Everything is validated here on the server.
   All the older roles and features keep working as before.
========================================================= */

const EXTRA_ROLE_KEYS = [
    "bodyguard", "vigilante", "sheriff", "mayor", "escort",
    "framer", "medium", "executioner", "amnesiac"
];

const EXTRA_ROLE_TURN = {
    Escort: "escort",
    Framer: "framer",
    Bodyguard: "bodyguard",
    Sheriff: "sheriff",
    Vigilante: "vigilante"
};

const EXTRA_TURN_ROLE = {
    escort: "Escort",
    framer: "Framer",
    bodyguard: "Bodyguard",
    sheriff: "Sheriff",
    vigilante: "Vigilante"
};

const NIGHT_SKIPPED = "__skip__";
const NIGHT_BLOCKED = "__blocked__";
const VIGILANTE_MAX_INNOCENT_KILLS = 2;
const EMOTE_LIST = [
    "👍", "👎", "😂", "😡", "🤔", "😱", "🔥", "🤝", "😭", "😎",
    "🤡", "💀", "👀", "🙏", "❤️", "🤫", "😈", "🕵️", "🔪", "🏆"
];
const EMOTE_COOLDOWN_MS = 1200;
const LAST_WORDS_MAX = 140;
const DEAD_CHAT_MAX = 200;

function extraRoleCount(settings) {
    return EXTRA_ROLE_KEYS.reduce(
        (sum, key) => sum + (Number(settings && settings[key]) || 0),
        0
    );
}

function isNightBlocked(room, playerId) {
    return Boolean(room && room.nightBlocked && room.nightBlocked[playerId]);
}

function isNightFramed(room, playerId) {
    return Boolean(room && room.nightFramed && room.nightFramed[playerId]);
}

function playerNameById(room, id) {
    const p = room && room.players.find(x => x.id === id);
    return p ? p.name : "Someone";
}

/* ---------- Game replay log ---------- */

function replayLog(room, text, kind) {
    if (!room) return;
    tlLog(room, kind === "vote" ? "vote" : kind === "win" ? "win" : "action", text);
    if (!Array.isArray(room.replay)) room.replay = [];
    if (room.replay.length >= 500) return;

    room.replay.push({
        night: room.nightNumber || 1,
        phase: room.phase === "day" ? "day" : "night",
        kind: kind || "info",
        text: String(text).slice(0, 240)
    });
}

function replayNightActions(room) {
    const na = room.nightActions || {};
    const nm = id => playerNameById(room, id);

    const log = (map, icon, verb, role) => {
        Object.entries(map || {}).forEach(([actorId, targetId]) => {
            if (targetId === NIGHT_SKIPPED) return;

            if (targetId === NIGHT_BLOCKED) {
                replayLog(room, `🚫 ${role} ${nm(actorId)} was blocked and did nothing`, "block");
                return;
            }

            replayLog(room, `${icon} ${role} ${nm(actorId)} ${verb} ${nm(targetId)}`, role.toLowerCase());
        });
    };

    log(na.escort, "🚧", "blocked", "Escort");

    const attackers = {};
    Object.entries(na.mafia || {}).forEach(([attackerId, targetId]) => {
        if (isNightBlocked(room, attackerId)) {
            replayLog(room, `🚫 Mafia ${nm(attackerId)} was blocked`, "block");
            return;
        }
        (attackers[targetId] = attackers[targetId] || []).push(attackerId);
    });

    Object.entries(attackers).forEach(([targetId, ids]) => {
        replayLog(
            room,
            `🔪 Mafia (${ids.map(nm).join(", ")}) attacked ${nm(targetId)}`,
            "mafia"
        );
    });

    log(na.framer, "🎭", "framed", "Framer");
    log(na.doctor, "💚", "protected", "Doctor");
    log(na.bodyguard, "🛡️", "guarded", "Bodyguard");
    log(na.detective, "🔎", "investigated", "Detective");
    log(na.sheriff, "⭐", "investigated", "Sheriff");

    Object.entries(na.cupid || {}).forEach(([cupidId, pair]) => {
        if (pair && pair.firstId && pair.secondId) {
            replayLog(
                room,
                `💘 Cupid ${nm(cupidId)} linked ${nm(pair.firstId)} ❤️ ${nm(pair.secondId)}`,
                "cupid"
            );
        }
    });
}

function replayDayVotes(room) {
    const tally = {};

    Object.entries(room.votes || {}).forEach(([voterId, targetId]) => {
        const voter = room.players.find(p => p.id === voterId);
        if (!voter || !voter.alive) return;
        (tally[targetId] = tally[targetId] || []).push(voter.name + (voter.role === "Mayor" ? " (Mayor x2)" : ""));
    });

    Object.entries(tally).forEach(([targetId, voters]) => {
        replayLog(
            room,
            `🗳️ ${playerNameById(room, targetId)} got votes from: ${voters.join(", ")}`,
            "vote"
        );
    });
}

/* ---------- Night turn length: 20 seconds per acting player ---------- */

const NIGHT_TURN_BASE_MS = 20 * 1000;
const NIGHT_TURN_MAX_MS = 60 * 1000;

function nightTurnActorCount(room, turn) {
    const roleByTurn = { doctor: "Doctor", detective: "Detective", cupid: "Cupid", ...EXTRA_TURN_ROLE };

    const living = room.players.filter(p => p.alive && p.connected !== false);

    let count;

    if (turn === "mafia") {
        count = living.filter(p => isMafiaTeam(p.role)).length;
    } else {
        count = living.filter(p => p.role === roleByTurn[turn]).length;

        // A hidden turn (the role is dead) must look exactly like a living one.
        if (!count) count = room.players.filter(p => p.role === roleByTurn[turn]).length;
    }

    return Math.max(1, count);
}

// 1 player = 20 seconds, 2 players = 40 seconds, 3 or more = 60 seconds.
function nightTurnDurationMs(room, turn) {
    // Every night turn lasts the same time (default 30 seconds, host can change it in the lobby),
    // no matter how many players have that role.
    return getRoomTimers(room).turn * 1000;
}

randomHiddenTurnMs = function (limit) {
    const max = Math.max(5000, Number(limit) || NIGHT_TURN_BASE_MS);

    // Sometimes run the full length, like a living player who is slow.
    if (Math.random() < 0.15) return max;

    return Math.round(4000 + Math.random() * (max - 4000 - 1000));
};

/* ---------- Much more random roles ---------- */

shuffle = function (array) {
    // Cryptographic random numbers, three full passes.
    for (let pass = 0; pass < 3; pass++) {
        for (let i = array.length - 1; i > 0; i--) {
            const j = crypto.randomInt(0, i + 1);
            [array[i], array[j]] = [array[j], array[i]];
        }
    }

    return array;
};

// Nobody gets the same special role twice in a row if it can be avoided.
function shuffleRolesFairly(roles, players) {
    let best = null;
    let bestRepeats = Infinity;

    for (let attempt = 0; attempt < 40; attempt++) {
        shuffle(roles);

        const repeats = players.reduce((n, p, i) =>
            n + (p.lastGameRole && p.lastGameRole !== "Civilian" && roles[i] === p.lastGameRole ? 1 : 0), 0);

        if (repeats < bestRepeats) {
            bestRepeats = repeats;
            best = roles.slice();
            if (!repeats) break;
        }
    }

    best.forEach((r, i) => { roles[i] = r; });
    return roles;
}

/* ---------- Per-game setup / reset ---------- */

function clearRoleExtras(room) {
    room.replay = [];
    room.timeline = [];
    room.vigilanteInnocent = {};
    room.firstDeathHandled = false;
    room.executionerWinnerId = null;
    room.executionerTargets = {};
    room.nightBlocked = {};
    room.nightFramed = {};
    room.nightNotes = [];
    room.deadChatLog = [];
    room._guardian = null;
    room._deathCause = null;

    room.players.forEach(player => {
        player.will = "";
    });
}

function assignExecutionerTarget(room, executioner) {
    const candidates = room.players.filter(p =>
        p.id !== executioner.id &&
        p.alive &&
        p.connected !== false &&
        !isMafiaTeam(p.role) &&
        !["Jester", "Executioner", "Amnesiac"].includes(p.role)
    );

    if (!candidates.length) {
        // Nobody to hunt: play as a normal Civilian.
        executioner.role = "Civilian";
        io.to(executioner.id).emit("roleChanged", { role: "Civilian" });
        return;
    }

    const target = candidates[Math.floor(Math.random() * candidates.length)];
    room.executionerTargets[executioner.id] = target.id;
}

function setupRoleExtras(room) {
    clearRoleExtras(room);

    replayLog(room, "🎬 The game started.", "info");
    tlLog(room, "phase", "🌙 Night 1 begins");

    room.players.forEach(p => { p.lastGameRole = p.role; });

    room.players
        .filter(p => p.role === "Executioner")
        .forEach(p => assignExecutionerTarget(room, p));
}

/* ---------- Wrappers around the existing game functions ---------- */

const _origHasLivingRoleForTurn = hasLivingRoleForTurn;
hasLivingRoleForTurn = function (room, turn) {
    const role = EXTRA_TURN_ROLE[turn];

    if (role) {
        return Boolean(room) && room.players.some(
            p => p.alive && p.connected !== false && p.role === role
        );
    }

    return _origHasLivingRoleForTurn(room, turn);
};

const _origHasHiddenTurn = hasHiddenTurn;
hasHiddenTurn = function (room, turn) {
    const role = EXTRA_TURN_ROLE[turn];

    // Same rule as Doctor/Detective: if the role exists in this game but is
    // dead, the turn still happens so nobody can tell who is dead.
    if (role) {
        return Boolean(room) && room.players.some(p => p.role === role);
    }

    return _origHasHiddenTurn(room, turn);
};

const _origNightTurnName = nightTurnName;
nightTurnName = function (turn) {
    if (EXTRA_TURN_ROLE[turn]) return EXTRA_TURN_ROLE[turn].toUpperCase();
    return _origNightTurnName(turn);
};

const _origCurrentTurnActionsDone = currentTurnActionsDone;
currentTurnActionsDone = function (room) {
    if (
        room &&
        room.phase === "night" &&
        !room.hiddenNightTurn &&
        EXTRA_TURN_ROLE[room.nightTurn]
    ) {
        const role = EXTRA_TURN_ROLE[room.nightTurn];
        const done = (room.nightActions && room.nightActions[room.nightTurn]) || {};

        return !room.players.some(
            p => p.alive && p.connected !== false && p.role === role && !done[p.id]
        );
    }

    return _origCurrentTurnActionsDone(room);
};

const _origGetActionTargets = getActionTargets;
getActionTargets = function (room, player) {
    if (room && player && player.alive && room.phase === "night") {
        const turn = EXTRA_ROLE_TURN[player.role];

        // The Framer is also a Mafia member, so only take over during the
        // Framer's own turn; the Mafia kill turn uses the original code.
        if (turn && (player.role !== "Framer" || room.nightTurn === "framer")) {
            if (room.nightTurn !== turn) return [];

            const done = room.nightActions && room.nightActions[turn] && room.nightActions[turn][player.id];
            if (done) return [];

            return room.players
                .filter(p =>
                    p.alive &&
                    p.connected !== false &&
                    p.id !== player.id &&
                    !(turn === "framer" && isMafiaTeam(p.role))
                )
                .map(p => p.id);
        }
    }

    return _origGetActionTargets(room, player);
};

const _origResetNightActions = resetNightActions;
resetNightActions = function (room) {
    _origResetNightActions(room);

    room.nightActions.escort = {};
    room.nightActions.framer = {};
    room.nightActions.bodyguard = {};
    room.nightActions.sheriff = {};
    room.nightActions.vigilante = {};

    room.nightBlocked = {};
    room.nightFramed = {};
};

const _origResetGameState = resetGameState;
resetGameState = function (room) {
    _origResetGameState(room);
    clearRoleExtras(room);
};

const _origMigratePlayerReferences = migratePlayerReferences;
migratePlayerReferences = function (room, oldId, newId) {
    _origMigratePlayerReferences(room, oldId, newId);

    if (!room || oldId === newId) return;

    ["nightBlocked", "nightFramed", "vigilanteInnocent", "executionerTargets"].forEach(key => {
        const map = room[key];
        if (!map) return;

        if (Object.prototype.hasOwnProperty.call(map, oldId)) {
            map[newId] = map[oldId];
            delete map[oldId];
        }

        Object.keys(map).forEach(k => {
            if (map[k] === oldId) map[k] = newId;
        });
    });

    if (room.executionerWinnerId === oldId) room.executionerWinnerId = newId;
};

/* ---------- Extra data sent to each player ---------- */

function canUseDeadChat(room, player) {
    if (!room || !player || !room.gameStarted) return false;
    if (room.phase === "lobby" || room.phase === "gameover") return false;

    if (!player.alive) return true;

    return player.role === "Medium" && room.phase === "night";
}

function buildExtraInfo(room, player) {
    const targetId = room.executionerTargets && room.executionerTargets[player.id];
    const target = targetId ? room.players.find(p => p.id === targetId) : null;

    return {
        execTarget: player.role === "Executioner" && target ? target.name : null,
        will: player.will || "",
        execTargetId: player.role === "Executioner" && target ? target.id : null,
        vigilanteInnocent:
            player.role === "Vigilante"
                ? (room.vigilanteInnocent && room.vigilanteInnocent[player.id]) || 0
                : 0,
        vigilanteMax: VIGILANTE_MAX_INNOCENT_KILLS,
        canDeadChat: canUseDeadChat(room, player),
        emotes: EMOTE_LIST
    };
}

/* ---------- Night resolution helpers (used by endNight) ---------- */

function findGuardian(room, targetId) {
    return room.players.find(p =>
        p.alive &&
        p.role === "Bodyguard" &&
        p.id !== targetId &&
        room.nightActions.bodyguard &&
        room.nightActions.bodyguard[p.id] === targetId
    ) || null;
}

function resolveVigilantes(room, protectedPlayers) {
    const out = [];

    Object.entries(room.nightActions.vigilante || {}).forEach(([vigilanteId, targetId]) => {
        if (targetId === NIGHT_SKIPPED || targetId === NIGHT_BLOCKED) return;

        const vigilante = room.players.find(p => p.id === vigilanteId);
        const target = room.players.find(p => p.id === targetId);

        if (!vigilante || !vigilante.alive || !target || !target.alive) return;

        if (protectedPlayers.has(targetId)) {
            replayLog(room, `💚 The doctor stopped ${vigilante.name}'s shot at ${target.name}`, "save");
            return;
        }

        const dead = eliminatePlayerWithCupid(room, target);
        if (!dead.length) return;

        dead.forEach(p => out.push(p));
        trackMatchAction(vigilante, "kills");

        room.nightNotes.push("🔫 Someone was shot during the night.");
        replayLog(
            room,
            `🔫 Vigilante ${vigilante.name} shot ${target.name} (${target.role})`,
            "vigilante"
        );

        if (!isMafiaTeam(target.role)) {
            const count = (room.vigilanteInnocent[vigilante.id] || 0) + 1;
            room.vigilanteInnocent[vigilante.id] = count;

            if (count >= VIGILANTE_MAX_INNOCENT_KILLS) {
                if (vigilante.alive) {
                    const guilt = eliminatePlayerWithCupid(room, vigilante);
                    guilt.forEach(p => out.push(p));

                    room.nightNotes.push(
                        `💔 ${vigilante.name} (the Vigilante) died of guilt after killing ${VIGILANTE_MAX_INNOCENT_KILLS} innocent players.`
                    );
                    replayLog(
                        room,
                        `💔 Vigilante ${vigilante.name} died of guilt (${count} innocent kills)`,
                        "vigilante"
                    );
                }
            } else {
                io.to(vigilante.id).emit("extraNotice", {
                    message: `⚠️ You killed an innocent player (${count}/${VIGILANTE_MAX_INNOCENT_KILLS}). One more and you die!`
                });
            }
        }
    });

    return out;
}

function nightKillText(room, names, verb, doctorLine, detectiveLine, doctorSaved) {
    const notes = (room.nightNotes || []).join(" ");
    const guarded = Boolean(room._guardian);
    room._guardian = null;

    let line = guarded && notes
        ? "☀️ " + notes
        : `☀️ ${names.join(", ")} ${verb} killed.` + (notes ? " " + notes : "");

    if (doctorSaved) {
        line += " The doctor saved the attacked person.";
    } else if (!guarded) {
        line += doctorLine;
    }

    return line + detectiveLine;
}

/* ---------- Everything that happens after somebody dies ---------- */

function afterEliminations(room, eliminated) {
    if (!room || !Array.isArray(eliminated) || !eliminated.length) return;

    const cause = room._deathCause || "night";

    eliminated.forEach(dead => {
        replayLog(
            room,
            cause === "vote"
                ? `⚰️ ${dead.name} (${dead.role}) was voted out`
                : `⚰️ ${dead.name} (${dead.role}) died`,
            "death"
        );

        startLastWords(room, dead);
    });

    // Executioner: the target was voted out by the town -> the Executioner wins.
    // If the target dies any other way, the Executioner becomes a Civilian.
    room.players
        .filter(p => p.role === "Executioner" && p.alive)
        .forEach(executioner => {
            const targetId = room.executionerTargets[executioner.id];
            if (!targetId) return;

            if (eliminated[0] && eliminated[0].id === targetId && cause === "vote") {
                room.executionerWinnerId = executioner.id;
                return;
            }

            if (eliminated.some(p => p.id === targetId)) {
                executioner.role = "Civilian";
                delete room.executionerTargets[executioner.id];

                io.to(executioner.id).emit("roleChanged", { role: "Civilian" });
                io.to(executioner.id).emit("extraNotice", {
                    message: "Your target died, so you are now a plain Civilian."
                });
            }
        });

    // Amnesiac: takes the role (and abilities) of the FIRST player who dies.
    if (!room.firstDeathHandled) {
        room.firstDeathHandled = true;

        const first = eliminated[0];

        room.players
            .filter(p => p.role === "Amnesiac" && p.alive && !eliminated.some(d => d.id === p.id))
            .forEach(amnesiac => {
                if (!first || !first.role || first.role === "Amnesiac") return;

                amnesiac.role = first.role;

                io.to(amnesiac.id).emit("roleChanged", { role: amnesiac.role });
                io.to(amnesiac.id).emit("amnesiacStole", {
                    fromName: first.name,
                    role: amnesiac.role
                });

                replayLog(room, `🧠 Amnesiac ${amnesiac.name} became ${amnesiac.role}`, "amnesiac");

                if (amnesiac.role === "Executioner") {
                    assignExecutionerTarget(room, amnesiac);
                }
            });
    }
}

const LAST_WORDS_SECONDS = 20;

function startLastWords(room, dead) {
    dead.lastWordsUntil = Date.now() + LAST_WORDS_SECONDS * 1000;
    dead.lastWordsUsed = false;

    io.to(dead.id).emit("lastWordsPrompt", {
        seconds: LAST_WORDS_SECONDS,
        endsAt: dead.lastWordsUntil
    });

    setTimeout(() => {
        if (!dead.lastWordsUsed) io.to(dead.id).emit("lastWordsClosed", {});
        dead.lastWordsUntil = 0;
    }, LAST_WORDS_SECONDS * 1000 + 300);
}

function findRoomCodeOfRoom(room) {
    for (const code of Object.keys(rooms)) {
        if (rooms[code] === room) return code;
    }
    return null;
}

const _origEliminatePlayerWithCupid = eliminatePlayerWithCupid;
eliminatePlayerWithCupid = function (room, player) {
    const eliminated = _origEliminatePlayerWithCupid(room, player);

    try {
        afterEliminations(room, eliminated);
    } catch (error) {
        console.error("afterEliminations error:", error);
    }

    return eliminated;
};

/* ---------- Sheriff rules ---------- */

function isSheriffSuspicious(room, target) {
    if (!target) return false;

    // The Godfather looks innocent (same as with the Detective).
    if (target.role === "Godfather") return false;

    if (isMafiaTeam(target.role)) return true;
    if (isNightFramed(room, target.id)) return true;

    // Unlike the Detective, the Sheriff also finds chaotic neutral players.
    return ["Jester", "Executioner"].includes(target.role);
}

const publicChatLog = [];
const pendingJoinRequests = new Map();   // requester socket id -> { hostId, roomCode }
const CHAT_TEXT_MAX = 200;
const CHAT_HISTORY_MAX = 80;
const GROUP_MEMBERS_MAX = 10;

/* =========================================================
   SOCKET EVENTS FOR THE NEW ROLES AND FEATURES
========================================================= */

io.on("connection", socket => {

    /* ---------- One generic night action for the new roles ---------- */

    socket.on("roleChoose", data => {
        const room = rooms[String(data?.roomCode || "")];

        if (!room || room.phase !== "night") return;

        const player = room.players.find(p => p.id === socket.id && p.alive);
        if (!player) return;

        const turn = EXTRA_ROLE_TURN[player.role];

        if (!turn || room.nightTurn !== turn) {
            return socket.emit("actionError", "It is not your turn!");
        }

        const actions = room.nightActions[turn] || (room.nightActions[turn] = {});

        if (actions[socket.id]) {
            return socket.emit("actionError", "You already used your action tonight!");
        }

        const roomCode = String(data.roomCode);

        // Skip tonight.
        if (data.skip) {
            actions[socket.id] = NIGHT_SKIPPED;
            socket.emit("extraActionDone", { role: player.role, message: "You skipped tonight." });
            checkNightActions(roomCode);
            return;
        }

        const target = room.players.find(p => p.id === data.targetId);

        if (
            !target ||
            !target.alive ||
            target.connected === false ||
            target.id === socket.id ||
            (turn === "framer" && isMafiaTeam(target.role))
        ) {
            return socket.emit("actionError", "You cannot choose that player.");
        }

        // The Escort blocked this player earlier tonight.
        if (isNightBlocked(room, socket.id)) {
            actions[socket.id] = NIGHT_BLOCKED;
            socket.emit("nightActionPopup", { kind: "blocked" });
            socket.emit("extraActionDone", {
                role: player.role,
                blocked: true,
                message: "🚫 Your ability has been blocked!"
            });
            checkNightActions(roomCode);
            return;
        }

        actions[socket.id] = target.id;

        if (turn === "escort") {
            room.nightBlocked[target.id] = true;
            socket.emit("nightActionPopup", { kind: "escort", targetName: target.name });
            socket.emit("extraActionDone", { role: player.role, message: `🚧 You blocked ${target.name}.` });
        } else if (turn === "framer") {
            room.nightFramed[target.id] = true;
            socket.emit("nightActionPopup", { kind: "framer", targetName: target.name });
            socket.emit("extraActionDone", { role: player.role, message: `🎭 You framed ${target.name}.` });
        } else if (turn === "bodyguard") {
            socket.emit("nightActionPopup", { kind: "bodyguard", targetName: target.name });
            socket.emit("extraActionDone", { role: player.role, message: `🛡️ You are guarding ${target.name}.` });
        } else if (turn === "vigilante") {
            socket.emit("nightActionPopup", { kind: "vigilante", targetName: target.name });
            socket.emit("extraActionDone", { role: player.role, message: `🔫 You will shoot ${target.name} tonight.` });
        } else if (turn === "sheriff") {
            const suspicious = isSheriffSuspicious(room, target);

            socket.emit("sheriffResult", {
                playerName: target.name,
                result: suspicious ? "SUSPICIOUS" : "NOT SUSPICIOUS"
            });

            // Same behaviour as the Detective: 3 seconds to read the result.
            clearNightTurnTimer(room);
            room.nightTurnTimer = setTimeout(() => {
                const current = rooms[roomCode];

                if (!current || current.phase !== "night" || current.nightTurn !== "sheriff") return;

                current.nightTurnTimer = null;
                checkNightActions(roomCode);
            }, 3000);

            return;
        }

        checkNightActions(roomCode);
    });

    /* ---------- Dead chat (dead players + the Medium at night) ---------- */

    function deadChatRecipients(room) {
        return room.players.filter(p =>
            p.connected !== false &&
            (!p.alive || (p.role === "Medium" && p.alive && room.phase === "night"))
        );
    }

    socket.on("deadChatSend", data => {
        const roomCode = String(data?.roomCode || "");
        const room = rooms[roomCode];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player || !canUseDeadChat(room, player)) return;

        const message = String(data.message || "").trim().slice(0, DEAD_CHAT_MAX);
        if (!message) return;

        const entry = {
            fromId: socket.id,
            playerName: player.name,
            fromMedium: player.alive,
            message,
            time: Date.now()
        };

        room.deadChatLog = room.deadChatLog || [];
        room.deadChatLog.push(entry);
        if (room.deadChatLog.length > 80) room.deadChatLog.shift();

        deadChatRecipients(room).forEach(p => io.to(p.id).emit("deadChatMessage", entry));
    });

    socket.on("deadChatHistory", data => {
        const room = rooms[String(data?.roomCode || "")];
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player || !canUseDeadChat(room, player)) return;

        socket.emit("deadChatHistory", room.deadChatLog || []);
    });

    /* ---------- Last words: 20 seconds after you die ---------- */

    socket.on("lastWordsSend", (data, callback) => {
        const reply = typeof callback === "function" ? callback : () => {};
        const code = String(data?.roomCode || "");
        const room = rooms[code];

        if (!room) return reply({ ok: false });

        const player = room.players.find(p => p.id === socket.id);

        if (
            !player ||
            player.alive ||
            player.lastWordsUsed ||
            !player.lastWordsUntil ||
            Date.now() > player.lastWordsUntil
        ) {
            return reply({ ok: false, message: "Your time for last words is over." });
        }

        const message = String(data.message || "").replace(/\s+/g, " ").trim().slice(0, LAST_WORDS_MAX);

        if (!message) return reply({ ok: false, message: "Write something first." });

        player.lastWordsUsed = true;
        player.lastWordsUntil = 0;

        io.to(code).emit("lastWords", { playerName: player.name, message });
        announce(code, `📜 ${player.name}'s last words: "${message}"`, "info");
        replayLog(room, `📜 ${player.name}'s last words: "${message}"`, "info");

        reply({ ok: true });
    });

    /* ---------- Old pre-written will (kept for older clients) ---------- */

    socket.on("setWill", (data, callback) => {
        const reply = typeof callback === "function" ? callback : () => {};
        const room = rooms[String(data?.roomCode || "")];

        if (!room || !room.gameStarted || room.phase === "gameover") {
            return reply({ ok: false, message: "You can only write last words during a game." });
        }

        const player = room.players.find(p => p.id === socket.id);

        if (!player || !player.alive) {
            return reply({ ok: false, message: "Only living players can write last words." });
        }

        player.will = String(data.message || "").replace(/\s+/g, " ").trim().slice(0, LAST_WORDS_MAX);

        reply({ ok: true, will: player.will });
    });

    /* ---------- Quick emotes during the day / voting ---------- */

    socket.on("sendEmote", data => {
        const room = rooms[String(data?.roomCode || "")];
        if (!room || room.phase !== "day") return;

        const player = room.players.find(p => p.id === socket.id && p.alive);
        if (!player) return;

        const emote = String(data.emote || "");
        if (!EMOTE_LIST.includes(emote)) return;

        const now = Date.now();
        if (player._lastEmoteAt && now - player._lastEmoteAt < EMOTE_COOLDOWN_MS) return;
        player._lastEmoteAt = now;

        io.to(String(data.roomCode)).emit("emote", {
            fromId: player.id,
            playerName: player.name,
            emote
        });
    });

    /* ---------- Game replay summary ---------- */

    socket.on("getReplay", data => {
        const room = rooms[String(data?.roomCode || "")];
        if (!room || room.phase !== "gameover") return;

        if (!room.players.some(p => p.id === socket.id)) return;

        socket.emit("gameReplay", {
            entries: room.replay || [],
            players: room.players
                .filter(p => p.connected !== false)
                .map(p => ({ name: p.name, role: p.role, alive: p.alive, guild: getGuildOfPlayer(p) }))
        });
    });

    /* ---------- Friends list (registered accounts only) ---------- */

    function myAccount() {
        const key = getSocketAccountKey(socket);
        const user = key ? accountsDb.users[key] : null;

        if (!user) return null;

        if (!Array.isArray(user.friends)) user.friends = [];
        if (!Array.isArray(user.friendRequests)) user.friendRequests = [];

        return { key, user };
    }

    function accountKeyByName(name) {
        const lower = String(name || "").trim().toLowerCase();
        if (!lower) return null;

        for (const [key, user] of Object.entries(accountsDb.users)) {
            if (String(user.username).toLowerCase() === lower) return key;
        }

        for (const [key, user] of Object.entries(accountsDb.users)) {
            if (user.displayName && String(user.displayName).toLowerCase() === lower) return key;
        }

        return null;
    }

    function onlineSocketIds(accountKey) {
        const ids = [];

        socketAccounts.forEach((key, id) => {
            if (key === accountKey && io.of("/").sockets.has(id)) ids.push(id);
        });

        return ids;
    }

    function friendRoomInfo(accountKey) {
        const ids = onlineSocketIds(accountKey);

        if (!ids.length) return { online: false, status: "Offline", roomCode: null };

        for (const id of ids) {
            const code = findRoomCodeBySocket(id);
            const room = code ? rooms[code] : null;

            if (room) {
                if (room.gameStarted) {
                    return { online: true, status: "In a game", roomCode: null };
                }

                if (room.allowPeopleToJoin !== false) {
                    return { online: true, status: "In a lobby", roomCode: code };
                }

                return { online: true, status: "In a lobby (closed)", roomCode: null };
            }
        }

        return { online: true, status: "Online", roomCode: null };
    }

    function publicFriend(key) {
        const user = accountsDb.users[key];
        if (!user) return null;

        return {
            username: user.username,
            displayName: getDisplayName(user),
            convo: "dm:" + key,
            ...friendRoomInfo(key)
        };
    }

    function unreadOf(user) {
        if (!user.chatUnread || typeof user.chatUnread !== "object") user.chatUnread = {};
        return user.chatUnread;
    }

    function groupsOf(accountKey) {
        const all = accountsDb.friendGroups || {};
        return Object.values(all).filter(g => g.members.includes(accountKey));
    }

    function sendFriends(targetSocketId, accountKey) {
        const user = accountsDb.users[accountKey];
        if (!user) return;

        const unread = unreadOf(user);
        const friends = (user.friends || []).map(publicFriend).filter(Boolean);

        const groups = groupsOf(accountKey).map(g => ({
            id: g.id,
            name: g.name,
            convo: "grp:" + g.id,
            members: g.members.map(k => accountsDb.users[k] ? getDisplayName(accountsDb.users[k]) : "?")
        }));

        const unreadTotal = Object.values(unread).reduce((sum, n) => sum + (Number(n) || 0), 0);

        io.to(targetSocketId).emit("friendsData", {
            ok: true,
            friends,
            groups,
            unread,
            unreadTotal,
            requests: (user.friendRequests || []).map(publicFriend).filter(Boolean)
        });
    }

    function refreshFriendsOf(accountKey) {
        onlineSocketIds(accountKey).forEach(id => sendFriends(id, accountKey));
    }

    function notice(message) {
        socket.emit("friendsNotice", { message });
    }

    socket.on("friendsGet", () => {
        const me = myAccount();

        if (!me) {
            return socket.emit("friendsData", { ok: false, guest: true, friends: [], requests: [] });
        }

        sendFriends(socket.id, me.key);
    });

    socket.on("friendAdd", data => {
        const me = myAccount();
        if (!me) return notice("Sign in with an account to use friends.");

        const otherKey = accountKeyByName(data?.username);

        if (!otherKey) return notice("No player with that username was found.");
        if (otherKey === me.key) return notice("You cannot add yourself.");

        const other = accountsDb.users[otherKey];
        if (!Array.isArray(other.friends)) other.friends = [];
        if (!Array.isArray(other.friendRequests)) other.friendRequests = [];

        if (me.user.friends.includes(otherKey)) return notice("You are already friends.");

        // They already asked me -> accept right away.
        if (me.user.friendRequests.includes(otherKey)) {
            me.user.friendRequests = me.user.friendRequests.filter(k => k !== otherKey);
            me.user.friends.push(otherKey);
            if (!other.friends.includes(me.key)) other.friends.push(me.key);

            saveAccounts();
            notice(`You and ${getDisplayName(other)} are now friends!`);
            refreshFriendsOf(me.key);
            refreshFriendsOf(otherKey);
            return;
        }

        if (other.friendRequests.includes(me.key)) return notice("Friend request already sent.");

        other.friendRequests.push(me.key);
        saveAccounts();

        notice(`Friend request sent to ${getDisplayName(other)}.`);

        onlineSocketIds(otherKey).forEach(id => {
            io.to(id).emit("friendsNotice", {
                message: `👥 ${getDisplayName(me.user)} sent you a friend request!`
            });
        });

        refreshFriendsOf(otherKey);
    });

    socket.on("friendRespond", data => {
        const me = myAccount();
        if (!me) return;

        const otherKey = accountKeyByName(data?.username);
        if (!otherKey || !me.user.friendRequests.includes(otherKey)) return;

        const other = accountsDb.users[otherKey];
        if (!Array.isArray(other.friends)) other.friends = [];

        me.user.friendRequests = me.user.friendRequests.filter(k => k !== otherKey);

        if (data.accept) {
            if (!me.user.friends.includes(otherKey)) me.user.friends.push(otherKey);
            if (!other.friends.includes(me.key)) other.friends.push(me.key);

            onlineSocketIds(otherKey).forEach(id => {
                io.to(id).emit("friendsNotice", {
                    message: `✅ ${getDisplayName(me.user)} accepted your friend request!`
                });
            });
        }

        saveAccounts();
        refreshFriendsOf(me.key);
        refreshFriendsOf(otherKey);
    });

    socket.on("friendRemove", data => {
        const me = myAccount();
        if (!me) return;

        const otherKey = accountKeyByName(data?.username);
        if (!otherKey) return;

        me.user.friends = me.user.friends.filter(k => k !== otherKey);

        const other = accountsDb.users[otherKey];
        if (other && Array.isArray(other.friends)) {
            other.friends = other.friends.filter(k => k !== me.key);
        }

        saveAccounts();
        refreshFriendsOf(me.key);
        refreshFriendsOf(otherKey);
    });

    /* ----- join a friend's room: the room owner must say yes ----- */

    socket.on("friendJoin", data => {
        const me = myAccount();
        if (!me) return notice("Sign in with an account to use friends.");

        const otherKey = accountKeyByName(data?.username);

        if (!otherKey || !me.user.friends.includes(otherKey)) {
            return notice("That player is not in your friends list.");
        }

        const info = friendRoomInfo(otherKey);

        if (!info.roomCode) {
            return notice(
                info.online
                    ? `Your friend is "${info.status}" - you cannot join right now.`
                    : "Your friend is offline."
            );
        }

        if (findRoomCodeBySocket(socket.id) === info.roomCode) {
            return notice("You are already in that room.");
        }

        const room = rooms[info.roomCode];
        const hostSocket = room && io.of("/").sockets.get(room.host);

        if (!room || !hostSocket) return notice("The room owner is not available.");

        const existing = pendingJoinRequests.get(socket.id);
        if (existing && existing.roomCode === info.roomCode) {
            return notice("You already asked to join. Wait for the host to answer.");
        }

        pendingJoinRequests.set(socket.id, { hostId: room.host, roomCode: info.roomCode });

        setTimeout(() => {
            const current = pendingJoinRequests.get(socket.id);
            if (current && current.roomCode === info.roomCode) {
                pendingJoinRequests.delete(socket.id);
                io.to(socket.id).emit("friendsNotice", { message: "⌛ The host did not answer your join request." });
            }
        }, 30000);

        io.to(room.host).emit("friendJoinRequest", {
            requesterId: socket.id,
            name: getDisplayName(me.user),
            roomCode: info.roomCode
        });

        notice("📨 Join request sent. Waiting for the host...");
    });

    socket.on("friendJoinRespond", data => {
        const requesterId = String(data?.requesterId || "");
        const request = pendingJoinRequests.get(requesterId);

        if (!request || request.hostId !== socket.id) return;

        pendingJoinRequests.delete(requesterId);

        const room = rooms[request.roomCode];

        if (!data.accept) {
            io.to(requesterId).emit("friendsNotice", { message: "❌ The host declined your join request." });
            return;
        }

        if (!room || room.host !== socket.id || room.gameStarted) {
            io.to(requesterId).emit("friendsNotice", { message: "That room is no longer open." });
            return;
        }

        io.to(requesterId).emit("friendJoinReady", { roomCode: request.roomCode });
    });

    /* ----- private chat between friends ----- */

    function mapMessages(list, myKey) {
        return (list || []).map(m => ({
            mine: m.from === myKey,
            name: accountsDb.users[m.from] ? getDisplayName(accountsDb.users[m.from]) : "?",
            text: m.text,
            time: m.time
        }));
    }

    function cleanText(value) {
        return String(value || "").replace(/\s+/g, " ").trim().slice(0, CHAT_TEXT_MAX);
    }

    function socketOf(id) {
        return io.of("/").sockets.get(id);
    }

    function dmKey(a, b) {
        return [a, b].sort().join("|");
    }

    socket.on("dmOpen", data => {
        const me = myAccount();
        if (!me) return;

        const otherKey = accountKeyByName(data?.username);
        if (!otherKey || !me.user.friends.includes(otherKey)) return;

        socket._openConvo = "dm:" + otherKey;

        const unread = unreadOf(me.user);
        if (unread["dm:" + otherKey]) {
            delete unread["dm:" + otherKey];
            saveAccounts();
        }

        const list = (accountsDb.friendChats && accountsDb.friendChats[dmKey(me.key, otherKey)]) || [];

        socket.emit("dmHistory", {
            username: accountsDb.users[otherKey].username,
            messages: mapMessages(list, me.key)
        });

        sendFriends(socket.id, me.key);
    });

    socket.on("dmSend", data => {
        const me = myAccount();
        if (!me) return;

        const otherKey = accountKeyByName(data?.username);
        if (!otherKey || !me.user.friends.includes(otherKey)) return;

        const text = cleanText(data.text);
        if (!text) return;

        const now = Date.now();
        if (socket._lastChatAt && now - socket._lastChatAt < 500) return;
        socket._lastChatAt = now;

        if (!accountsDb.friendChats) accountsDb.friendChats = {};

        const key = dmKey(me.key, otherKey);
        const list = accountsDb.friendChats[key] || (accountsDb.friendChats[key] = []);

        list.push({ from: me.key, text, time: now });
        while (list.length > CHAT_HISTORY_MAX) list.shift();

        const other = accountsDb.users[otherKey];

        const payload = (mine, withUser) => ({
            scope: "dm",
            with: withUser.username,
            mine,
            name: getDisplayName(me.user),
            text,
            time: now
        });

        onlineSocketIds(me.key).forEach(id => io.to(id).emit("chatMessage", payload(true, other)));

        const recipients = onlineSocketIds(otherKey);
        let seen = false;

        recipients.forEach(id => {
            const target = socketOf(id);

            if (target && target._openConvo === "dm:" + me.key) {
                seen = true;
                io.to(id).emit("chatMessage", payload(false, me.user));
            }
        });

        if (!seen) {
            const unread = unreadOf(other);
            unread["dm:" + me.key] = (unread["dm:" + me.key] || 0) + 1;

            recipients.forEach(id => {
                io.to(id).emit("chatNotify", { fromName: getDisplayName(me.user), text });
            });

            refreshFriendsOf(otherKey);
        }

        saveAccounts();
    });

    /* ----- group chats ----- */

    socket.on("groupCreate", data => {
        const me = myAccount();
        if (!me) return notice("Sign in with an account to use groups.");

        const name = cleanText(data?.name).slice(0, 24);
        if (!name) return notice("Give your group a name.");

        const keys = [];

        (Array.isArray(data?.usernames) ? data.usernames : []).forEach(u => {
            const k = accountKeyByName(u);
            if (k && me.user.friends.includes(k) && !keys.includes(k)) keys.push(k);
        });

        if (!keys.length) return notice("Pick at least one friend for the group.");

        const members = [me.key, ...keys].slice(0, GROUP_MEMBERS_MAX);

        if (!accountsDb.friendGroups) accountsDb.friendGroups = {};

        const id = Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);

        accountsDb.friendGroups[id] = { id, name, owner: me.key, members, messages: [] };
        saveAccounts();

        members.forEach(k => {
            if (k !== me.key) {
                onlineSocketIds(k).forEach(sid => io.to(sid).emit("friendsNotice", {
                    message: `👥 ${getDisplayName(me.user)} added you to the group "${name}"`
                }));
            }
            refreshFriendsOf(k);
        });

        notice(`👥 Group "${name}" created!`);
    });

    function groupFor(id, key) {
        const g = accountsDb.friendGroups && accountsDb.friendGroups[String(id || "")];
        return g && g.members.includes(key) ? g : null;
    }

    socket.on("groupOpen", data => {
        const me = myAccount();
        if (!me) return;

        const g = groupFor(data?.id, me.key);
        if (!g) return;

        socket._openConvo = "grp:" + g.id;

        const unread = unreadOf(me.user);
        if (unread["grp:" + g.id]) {
            delete unread["grp:" + g.id];
            saveAccounts();
        }

        socket.emit("groupHistory", {
            id: g.id,
            name: g.name,
            messages: mapMessages(g.messages, me.key)
        });

        sendFriends(socket.id, me.key);
    });

    socket.on("groupSend", data => {
        const me = myAccount();
        if (!me) return;

        const g = groupFor(data?.id, me.key);
        if (!g) return;

        const text = cleanText(data.text);
        if (!text) return;

        const now = Date.now();
        if (socket._lastChatAt && now - socket._lastChatAt < 500) return;
        socket._lastChatAt = now;

        g.messages.push({ from: me.key, text, time: now });
        while (g.messages.length > CHAT_HISTORY_MAX) g.messages.shift();

        g.members.forEach(k => {
            const u = accountsDb.users[k];
            if (!u) return;

            let seen = false;

            onlineSocketIds(k).forEach(sid => {
                const target = socketOf(sid);

                if (target && target._openConvo === "grp:" + g.id) {
                    seen = true;
                    io.to(sid).emit("chatMessage", {
                        scope: "group",
                        id: g.id,
                        mine: k === me.key,
                        name: getDisplayName(me.user),
                        text,
                        time: now
                    });
                }
            });

            if (!seen && k !== me.key) {
                const unread = unreadOf(u);
                unread["grp:" + g.id] = (unread["grp:" + g.id] || 0) + 1;

                onlineSocketIds(k).forEach(sid => io.to(sid).emit("chatNotify", {
                    fromName: `${getDisplayName(me.user)} (${g.name})`,
                    text
                }));

                refreshFriendsOf(k);
            }
        });

        saveAccounts();
    });

    socket.on("groupLeave", data => {
        const me = myAccount();
        if (!me) return;

        const g = groupFor(data?.id, me.key);
        if (!g) return;

        g.members = g.members.filter(k => k !== me.key);

        if (!g.members.length) delete accountsDb.friendGroups[g.id];

        const unread = unreadOf(me.user);
        delete unread["grp:" + g.id];

        saveAccounts();
        refreshFriendsOf(me.key);
        g.members.forEach(refreshFriendsOf);
    });

    socket.on("chatClose", () => {
        socket._openConvo = null;
    });

    /* ----- public chat (everybody who opened the Chat tab) ----- */

    socket.on("pubChatJoin", () => {
        socket.join("mw:pubchat");
        socket.emit("pubChatHistory", publicChatLog.slice(-50));
    });

    socket.on("pubChatLeave", () => {
        socket.leave("mw:pubchat");
    });

    socket.on("pubChatSend", data => {
        const me = myAccount();
        if (!me) return notice("Sign in with an account to chat.");

        const text = cleanText(data?.text);
        if (!text) return;

        const now = Date.now();
        if (socket._lastPubAt && now - socket._lastPubAt < 700) return;
        socket._lastPubAt = now;

        const entry = { name: getDisplayName(me.user), text, time: now };

        publicChatLog.push(entry);
        while (publicChatLog.length > 100) publicChatLog.shift();

        io.to("mw:pubchat").emit("pubChatMessage", entry);
    });
});


/* =========================================================
   SERVER START
========================================================= */

const PORT = process.env.PORT || 2001;

initDatabase()
    .then(() => {
        server.listen(PORT, "0.0.0.0", () => {
            console.log("Mafia Wars is running on port " + PORT);
        });
    })
    .catch(error => {
        console.error("Could not connect to the database. Not starting, so no data is overwritten:", error);
        process.exit(1);
    });


/* =========================================================
   MAFIA WARS - ROOM OPTIONS, KICK / BAN, PACKAGES
   - Host: room size (max players), adjustable timers
   - Host: kick / ban (lobby and during the game)
   - Owner: role "Packages" (presets) every host can load in the lobby
   Everything is validated here on the server.
========================================================= */

const DEFAULT_MAX_PLAYERS = 20;
const MIN_MAX_PLAYERS = 4;
const MAX_MAX_PLAYERS = 30;

// All values are SECONDS.
const DEFAULT_TIMERS = { turn: 30, discussion: 60, voting: 60 };
const TIMER_LIMITS = {
    turn:       { min: 10, max: 120 },
    discussion: { min: 0,  max: 300 },
    voting:     { min: 15, max: 300 }
};

function getRoomMaxPlayers(room) {
    const n = Math.floor(Number(room && room.maxPlayers));
    return Number.isFinite(n) && n >= MIN_MAX_PLAYERS && n <= MAX_MAX_PLAYERS ? n : DEFAULT_MAX_PLAYERS;
}

function getRoomTimers(room) {
    const saved = (room && room.timers) || {};
    const out = {};

    Object.keys(DEFAULT_TIMERS).forEach(key => {
        const n = Math.floor(Number(saved[key]));
        const lim = TIMER_LIMITS[key];
        out[key] = Number.isFinite(n) && n >= lim.min && n <= lim.max ? n : DEFAULT_TIMERS[key];
    });

    return out;
}

function socketIp(socket) {
    try {
        const fwd = String(socket.handshake.headers["x-forwarded-for"] || "").split(",")[0].trim();
        return fwd || socket.handshake.address || "";
    } catch (_) {
        return "";
    }
}

function isBannedFromRoom(room, socket, name) {
    const ban = room && room.banned;
    if (!ban) return false;

    const account = getSocketAccountKey(socket);
    if (account && ban.accounts.includes(account)) return true;

    if (ban.names.includes(String(name || "").trim().toLowerCase())) return true;

    // IP bans only apply to guests, so a shared network never blocks a signed-in player.
    if (!account && ban.ips.includes(socketIp(socket))) return true;

    return false;
}

io.on("connection", socket => {

    /* ---------- Host: room size + timers (lobby only) ---------- */

    socket.on("setRoomOptions", data => {
        const roomCode = String(data?.roomCode || "").trim().toUpperCase();
        const room = rooms[roomCode];

        if (!room || room.host !== socket.id) return;

        if (room.phase !== "lobby") {
            return socket.emit("gameError", "Room options can only be changed in the lobby.");
        }

        if (data.maxPlayers !== undefined) {
            const n = Math.floor(Number(data.maxPlayers));
            const connected = room.players.filter(p => p.connected !== false).length;

            if (!Number.isFinite(n) || n < MIN_MAX_PLAYERS || n > MAX_MAX_PLAYERS) {
                return socket.emit("gameError", `Players must be from ${MIN_MAX_PLAYERS} to ${MAX_MAX_PLAYERS}.`);
            }

            if (n < connected) {
                return socket.emit("gameError", `${connected} players are already in the room. Kick someone first or pick a bigger number.`);
            }

            room.maxPlayers = n;
        }

        if (data.timers && typeof data.timers === "object") {
            const next = { ...getRoomTimers(room) };

            for (const key of Object.keys(DEFAULT_TIMERS)) {
                if (data.timers[key] === undefined) continue;

                const n = Math.floor(Number(data.timers[key]));
                const lim = TIMER_LIMITS[key];

                if (!Number.isFinite(n) || n < lim.min || n > lim.max) {
                    return socket.emit("gameError", `${key} time must be ${lim.min}-${lim.max} seconds.`);
                }

                next[key] = n;
            }

            room.timers = next;
        }

        emitLobby(roomCode);
        emitPublicMatches();
    });

    /* ---------- Host: kick / ban ---------- */

    socket.on("kickPlayer", data => {
        const roomCode = String(data?.roomCode || "").trim().toUpperCase();
        const room = rooms[roomCode];

        if (!room || room.host !== socket.id) return;

        const targetId = String(data?.targetId || "");
        const ban = false; // banning is Owner-only (account edit screen)

        if (!targetId || targetId === socket.id) {
            return socket.emit("gameError", "You cannot kick yourself.");
        }

        const index = room.players.findIndex(p => p.id === targetId);
        if (index === -1) return;

        const target = room.players[index];
        const targetSocket = io.sockets.sockets.get(targetId);

        if (!room.banned) room.banned = { accounts: [], names: [], ips: [] };

        if (ban) {
            if (target.account && !room.banned.accounts.includes(target.account)) room.banned.accounts.push(target.account);

            const lowerName = String(target.name || "").trim().toLowerCase();
            if (lowerName && !room.banned.names.includes(lowerName)) room.banned.names.push(lowerName);

            if (targetSocket && !target.account) {
                const ip = socketIp(targetSocket);
                if (ip && !room.banned.ips.includes(ip)) room.banned.ips.push(ip);
            }
        }

        if (targetSocket) {
            targetSocket.emit("kickedFromRoom", {
                banned: ban,
                message: ban
                    ? "You were banned from the room by the host."
                    : "You were kicked from the room by the host."
            });
            targetSocket.leave(roomCode);
        }

        const inGame = room.gameStarted && room.phase !== "lobby";

        if (!inGame) {
            // LOBBY: the player simply leaves the room.
            room.players.splice(index, 1);

            announce(roomCode, `${ban ? "⛔" : "🥾"} ${target.name} was ${ban ? "banned" : "kicked"} by the host.`, "danger");
            emitLobby(roomCode);
            broadcastVoiceState(roomCode);
            emitPublicMatches();
            return;
        }

        /* IN GAME: the player object stays (roles / votes / Cupid links keep working),
           exactly like a disconnected player who is never allowed to rejoin.
           It is NOT marked dead, so a kicked Jester can never "win" by being kicked. */
        target.connected = false;
        target.kicked = true;
        target.voiceAllowed = false;

        // Remove their pending actions / vote so nothing waits for them.
        Object.values(room.nightActions || {}).forEach(group => { delete group[targetId]; });
        if (room.votes) delete room.votes[targetId];

        announce(roomCode, `${ban ? "⛔" : "🥾"} ${target.name} was ${ban ? "banned" : "kicked"} by the host.`, "danger");

        broadcastVoiceState(roomCode);

        if (checkWinner(roomCode)) {
            clearPhaseTimer(room);
            sendGameInformation(roomCode);
            return;
        }

        emitLobby(roomCode);
        emitPublicMatches();
        sendGameInformation(roomCode);

        if (room.phase === "night") {
            checkNightActions(roomCode);
        }

        if (room.phase === "day") {
            const aliveIds = new Set(room.players.filter(p => p.alive && p.connected !== false).map(p => p.id));
            const validVoteCount = Object.keys(room.votes || {}).filter(id => aliveIds.has(id)).length;

            if (aliveIds.size && validVoteCount >= aliveIds.size) {
                endVoting(roomCode);
            }
        }
    });

    /* ---------- Owner: ban / unban an ACCOUNT (Edit Account screen) ---------- */

    socket.on("ownerAccountBan", (data, callback) => {
        const reply = typeof callback === "function" ? callback : () => {};

        if (socket.badge !== "owner" || !getSocketAccountKey(socket)) {
            return reply({ ok: false, error: "Only the Owner can ban accounts." });
        }

        const key = String(data?.username || "").trim().toLowerCase();
        const user = accountsDb.users[key];
        if (!user) return reply({ ok: false, error: "Account not found." });

        if (getSocketAccountKey(socket) === key) {
            return reply({ ok: false, error: "You can't ban your own account." });
        }

        const banned = Boolean(data?.banned);
        user.banned = banned ? true : undefined;

        if (banned) {
            dropSessionsOf(key);

            for (const [socketId, accountKey] of socketAccounts.entries()) {
                if (accountKey !== key) continue;
                const target = io.sockets.sockets.get(socketId);

                if (target) {
                    target.emit("accountBanned", { message: "Your account was banned by the Owner." });
                    const code = findRoomCodeBySocket(socketId);
                    if (code) target.emit("kickedFromRoom", { banned: true, message: "Your account was banned by the Owner." });
                }

                socketAccounts.delete(socketId);
            }
        }

        saveAccounts();
        reply({ ok: true, banned });
    });

    /* ---------- Owner packages: free text offers (like Discord price lists) ---------- */

    socket.on("packagesGet", callback => {
        if (typeof callback === "function") callback({ ok: true, packages: getPackagesPayload() });
    });

    socket.on("ownerPackageSave", (data, callback) => {
        const reply = typeof callback === "function" ? callback : () => {};

        if (!requirePackageOwner(socket, reply)) return;

        const name = String(data?.name || "").replace(/\s+/g, " ").trim().slice(0, 40);
        const text = String(data?.text || "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim().slice(0, 1000);

        if (!name) return reply({ ok: false, error: "Write a package name." });
        if (!text) return reply({ ok: false, error: "Write what the package includes." });

        const list = ensurePackagesDb();
        const id = String(data?.id || "");
        const existing = id ? list.find(p => p.id === id) : null;

        if (id && !existing) return reply({ ok: false, error: "Package not found." });

        if (existing) {
            existing.name = name;
            existing.text = text;
            existing.updated = Date.now();
        } else {
            list.push({ id: crypto.randomBytes(6).toString("hex"), name, text, created: Date.now(), updated: Date.now() });
        }

        saveAccounts();
        io.emit("packagesUpdated", getPackagesPayload());
        reply({ ok: true, packages: getPackagesPayload() });
    });

    socket.on("ownerPackageDelete", (data, callback) => {
        const reply = typeof callback === "function" ? callback : () => {};

        if (!requirePackageOwner(socket, reply)) return;

        const list = ensurePackagesDb();
        const index = list.findIndex(p => p.id === String(data?.id || ""));

        if (index === -1) return reply({ ok: false, error: "Package not found." });

        list.splice(index, 1);
        saveAccounts();
        io.emit("packagesUpdated", getPackagesPayload());
        reply({ ok: true, packages: getPackagesPayload() });
    });
});

function ensurePackagesDb() {
    if (!Array.isArray(accountsDb.packages)) accountsDb.packages = [];
    return accountsDb.packages;
}

function getPackagesPayload() {
    return ensurePackagesDb().map(p => ({ id: p.id, name: p.name, text: p.text || "" }));
}

function requirePackageOwner(socket, reply) {
    if (socket.badge !== "owner" || !getSocketAccountKey(socket)) {
        reply({ ok: false, error: "Only the signed-in Owner can manage packages." });
        return false;
    }
    return true;
}


/* =========================================================
   MAFIA WARS - BOTS (Easy / Medium / Hard)

   How it works
   - A bot is a normal entry in room.players (isBot: true) with a fake
     socket that owns the SAME event handlers a real player gets.
     So when a bot picks a target it goes through mafiaChoose,
     doctorChoose, votePlayer ... and every game rule still applies.
   - One timer (botTick) looks at each room that has bots and lets
     every living bot act after a human-like delay.
   - Bots never earn account points / ranks (they have no account),
     never take a voice-chat slot and can never be the host.
   - The host adds / removes bots and picks the level in the lobby:
       botAdd { roomCode, count, level }
       botRemove { roomCode, botId } or { roomCode, all: true }
       botSetLevel { roomCode, level, botId? }  (no botId = all bots)

   Levels
     easy   - slow, mostly random, rarely uses what it knows
     medium - uses what it knows, follows the crowd, teammates agree
     hard   - fast, uses everything, holds grudges, talks like a player
========================================================= */

const BOT_LEVELS = ["easy", "medium", "hard"];
const BOT_LEVEL_LABEL = { easy: "Easy", medium: "Medium", hard: "Hard" };
const BOT_MAX_ADD_AT_ONCE = 10;
const BOT_TICK_MS = 500;
const BOT_ROOM_IDLE_MS = 5 * 60 * 1000;

/* Seconds a bot waits before acting: [min, max]. */
const BOT_TIMING = {
    easy:   { night: [4.0, 9.0], vote: [8, 22] },
    medium: { night: [3.0, 7.0], vote: [5, 17] },
    hard:   { night: [2.0, 5.5], vote: [3, 13] }
};

const BOT_NAMES = [
    "Sam", "Alex", "Jordan", "Riley", "Casey", "Morgan", "Taylor", "Jamie",
    "Quinn", "Avery", "Drew", "Blake", "Reese", "Skyler", "Cameron", "Parker",
    "Rowan", "Sage", "Kai", "Nico", "Remy", "Zane", "Luca", "Milo",
    "Nova", "Ivy", "Leo", "Max", "Ruby", "Finn"
];

const BOT_LINES = {
    greet: [
        "Hey everyone 👋", "Ready to play! 🎭", "Don't trust me, I'm a bot 🤖",
        "Let's go! 🔥", "Who's the Mafia tonight? 😈"
    ],
    generic: [
        "Hmm... who do we trust?", "I'm town, I promise 😅", "Anyone have any info?",
        "Let's think before we vote.", "This is getting tense 😬",
        "Who was acting weird last night?", "I have a bad feeling about this round."
    ],
    accuse: [
        "I don't trust {n}.", "{n} has been very quiet... suspicious.",
        "My gut says {n} is Mafia.", "Why is nobody talking about {n}?",
        "I'm voting {n}. Change my mind.", "{n}, care to explain yourself?"
    ],
    defend: [
        "I'm not Mafia, vote someone else!", "Please don't vote me, I'm town!",
        "Why me? I haven't done anything!"
    ],
    jester: [
        "Yeah okay, I'm totally Mafia 😈 vote me!", "Vote me out, I dare you 🤡",
        "I might be the Mafia... or not. 😏"
    ],
    detectiveFound: [
        "🔎 I investigated {n} and they are MAFIA! Vote {n}!",
        "Trust me, {n} is Mafia. I checked. 🔎"
    ],
    sheriffFound: [
        "⭐ {n} came back SUSPICIOUS for me. Let's vote {n}.",
        "The Sheriff says {n} looks suspicious. ⭐"
    ]
};

/* ---------- small helpers ---------- */

function botRand(min, max) {
    return min + Math.random() * (max - min);
}

function botPick(list) {
    return list && list.length ? list[Math.floor(Math.random() * list.length)] : null;
}

function botChance(probability) {
    return Math.random() < probability;
}

function botLine(kind, name) {
    return String(botPick(BOT_LINES[kind]) || "").replace(/\{n\}/g, name || "someone");
}

/* Weighted random: higher score = more likely. */
function botWeighted(list, scoreOf) {
    if (!list.length) return null;

    const weights = list.map(item => Math.max(0.01, Number(scoreOf(item)) || 0));
    let roll = Math.random() * weights.reduce((sum, w) => sum + w, 0);

    for (let i = 0; i < list.length; i++) {
        roll -= weights[i];
        if (roll <= 0) return list[i];
    }

    return list[list.length - 1];
}

/* Highest score wins (ties are random). */
function botBest(list, scoreOf) {
    if (!list.length) return null;

    let best = -Infinity;
    let top = [];

    list.forEach(item => {
        const score = Number(scoreOf(item)) || 0;

        if (score > best + 1e-9) {
            best = score;
            top = [item];
        } else if (Math.abs(score - best) <= 1e-9) {
            top.push(item);
        }
    });

    return botPick(top);
}

/* easy = random, medium = weighted random, hard = best score. */
function botChoose(level, list, scoreOf) {
    if (level === "easy") return botPick(list);
    if (level === "medium") return botWeighted(list, scoreOf);
    return botBest(list, scoreOf);
}

function botOthers(room, bot) {
    return room.players.filter(
        p => p.alive && p.connected !== false && p.id !== bot.id
    );
}

function botFindByName(room, name) {
    return room.players.find(p => p.name === name) || null;
}

/* ---------- the fake socket ---------- */

const BOT_SOCKETS = new Map();

function createBotSocket(id, roomCode) {
    const handlers = {};

    const sock = {
        id,
        roomCode,
        isBot: true,
        badge: "member",
        data: {},
        rooms: new Set([roomCode]),
        handshake: { headers: {}, address: "" },
        handlers,

        on(event, handler) {
            handlers[event] = handler;
            return sock;
        },

        emit(event, payload) {
            try {
                botReceive(sock, event, payload);
            } catch (error) {
                console.error("[bots] receive failed:", error);
            }
            return true;
        },

        join() {},
        leave() {},
        disconnect() {}
    };

    BOT_CONNECTION_HANDLERS.forEach(handler => {
        try {
            handler(sock);
        } catch (error) {
            console.error("[bots] could not attach handlers:", error);
        }
    });

    BOT_SOCKETS.set(id, sock);

    return sock;
}

function botSend(bot, event, data) {
    const sock = BOT_SOCKETS.get(bot.id);
    const handler = sock && sock.handlers[event];

    if (!handler) return false;

    try {
        handler(data);
        return true;
    } catch (error) {
        console.error("[bots] " + event + " failed:", error);
        return false;
    }
}

/* What the server tells a player privately, a bot "hears" too. */
function botReceive(sock, event, payload) {
    const room = rooms[sock.roomCode];
    const bot = room && room.players.find(p => p.id === sock.id);

    if (!bot) return;

    const mem = botMemory(room, bot);

    if (event === "detectiveResult" && payload) {
        const target = botFindByName(room, payload.playerName);
        if (target) mem.known[target.id] = payload.result === "MAFIA" ? "mafia" : "clear";
    }

    if (event === "sheriffResult" && payload) {
        const target = botFindByName(room, payload.playerName);
        if (target) mem.known[target.id] = payload.result === "SUSPICIOUS" ? "sus" : "clear";
    }
}

/* Everything a bot remembers. It starts fresh for every new game. */
function botMemory(room, bot) {
    if (!bot.mem || bot.memGame !== room.settings) {
        bot.mem = {
            known: {},      // playerId -> "mafia" | "sus" | "clear"
            checked: {},    // playerId -> true (already investigated)
            shared: {},     // playerId -> true (already told the chat)
            lastSave: null,
            lastGuard: null,
            plan: null,
            chat: null
        };
        bot.memGame = room.settings;
    }

    return bot.mem;
}

/* Called when the host restarts the game: bots start the next match with a clean head. */
function botResetRoom(room) {
    room._botLastVotes = {};
    room._botClaims = [];
    room._botClaimsGame = null;
    room._botPhaseSig = null;
    room.players.forEach(p => { if (p.isBot) { p.mem = null; p.memGame = null; } });
}

/* ---------- what the bot saw during the last vote ---------- */

/* Votes of the last finished day: { voterId: targetId }. */
function botLastVotes(room) {
    return room._botLastVotes || {};
}

function botVotesReceived(room) {
    const counts = {};

    Object.values(botLastVotes(room)).forEach(targetId => {
        counts[targetId] = (counts[targetId] || 0) + 1;
    });

    return counts;
}

/* ---------- public claims ("I checked X, they are Mafia") ----------
   Everybody can read the public chat, so every bot hears these claims. */

function botClaims(room) {
    if (room._botClaimsGame !== room.settings) {
        room._botClaims = [];
        room._botClaimsGame = room.settings;
    }

    return room._botClaims;
}

function botAddClaim(room, fromId, targetId) {
    botClaims(room).push({ from: fromId, target: targetId });
}

/* Living players who publicly accused a Mafia-team member. */
function botClaimersAgainstMafia(room) {
    const out = new Set();

    botClaims(room).forEach(claim => {
        const from = room.players.find(p => p.id === claim.from);
        const target = room.players.find(p => p.id === claim.target);

        if (from && from.alive && target && isMafiaTeam(target.role)) out.add(from.id);
    });

    return out;
}

/* Remember the votes right before they are counted and cleared. */
const botOriginalEndVoting = endVoting;

endVoting = function (roomCode) {
    const room = rooms[roomCode];

    if (room && room.phase === "day" && room.votes) {
        room._botLastVotes = Object.assign({}, room.votes);
    }

    return botOriginalEndVoting.apply(this, arguments);
};

/* ---------- choosing targets ---------- */

function botPickMafiaTarget(room, bot) {
    const level = bot.botLevel;
    const allowed = new Set(getActionTargets(room, bot));

    let pool = room.players.filter(p => allowed.has(p.id));

    if (!pool.length) {
        pool = botOthers(room, bot).filter(p => !isMafiaTeam(p.role));
    }

    if (!pool.length) return null;

    // Medium / Hard: join the target a teammate already chose.
    if (level !== "easy") {
        const tally = {};

        Object.values(room.nightActions.mafia || {}).forEach(id => {
            if (typeof id === "string" && id !== NIGHT_SKIPPED && id !== NIGHT_BLOCKED) {
                tally[id] = (tally[id] || 0) + 1;
            }
        });

        const chosen = pool
            .filter(p => tally[p.id])
            .sort((a, b) => tally[b.id] - tally[a.id])[0];

        if (chosen && botChance(level === "hard" ? 1 : 0.7)) return chosen.id;
    }

    // People who voted against a Mafia member are the biggest threat.
    const last = botLastVotes(room);

    const accusers = new Set(
        Object.keys(last).filter(voterId => {
            const target = room.players.find(p => p.id === last[voterId]);
            return target && isMafiaTeam(target.role);
        })
    );

    // ...and so is anyone who publicly called a Mafia member out.
    const claimers = botClaimersAgainstMafia(room);

    const bonus = level === "hard" ? 9 : 4;
    const claimBonus = level === "hard" ? 25 : 8;

    const pick = botChoose(
        level,
        pool,
        p => 1 + (accusers.has(p.id) ? bonus : 0) + (claimers.has(p.id) ? claimBonus : 0)
    );

    return pick ? pick.id : null;
}

function botPickGrandmafiaTarget(room, bot) {
    const allowed = new Set(getGrandmafiaTargets(room, bot));
    const pool = room.players.filter(p => allowed.has(p.id));

    return pool.length ? botPick(pool).id : null;
}

function botPickDoctorTarget(room, bot, mem) {
    const level = bot.botLevel;
    const alive = room.players.filter(p => p.alive && p.connected !== false);

    if (!alive.length) return null;

    let pick;

    if (level === "easy") {
        pick = botPick(alive);
    } else {
        const selfBonus = level === "hard" ? (alive.length <= 5 ? 3 : 1.5) : 1.2;

        // Someone who exposed a Mafia member is the Mafia's next target.
        const exposers = botClaims(room)
            .filter(claim => claim.from !== bot.id)
            .map(claim => claim.from);

        pick = botWeighted(alive, p => {
            let weight = p.id === bot.id ? selfBonus : 1;
            if (exposers.includes(p.id)) weight += level === "hard" ? 5 : 1.5;
            if (p.id === mem.lastSave) weight *= level === "hard" ? 0.1 : 0.3;
            return weight;
        });
    }

    if (pick) mem.lastSave = pick.id;

    return pick ? pick.id : null;
}

function botPickInvestigateTarget(room, bot, mem) {
    const level = bot.botLevel;
    const others = botOthers(room, bot);
    const fresh = others.filter(p => !mem.checked[p.id]);
    const pool = level === "easy" || !fresh.length ? others : fresh;
    const received = botVotesReceived(room);

    const pick = botChoose(
        level,
        pool,
        p => 1 + (level === "hard" ? 2 * (received[p.id] || 0) : 0)
    );

    if (pick) mem.checked[pick.id] = true;

    return pick ? pick.id : null;
}

function botPickCupidPair(room, bot) {
    const pool = botOthers(room, bot);

    if (pool.length < 2) return null;

    const first = botPick(pool);
    const second = botPick(pool.filter(p => p.id !== first.id));

    return { first: first.id, second: second.id };
}

/* Escort, Framer, Bodyguard, Sheriff, Vigilante. Returns { skip } or { targetId }. */
function botPickExtraTarget(room, bot, mem, turn) {
    const level = bot.botLevel;
    const known = id => mem.known[id];
    let pool = botOthers(room, bot);

    if (turn === "framer") {
        pool = pool.filter(p => !isMafiaTeam(p.role));
    }

    if (!pool.length) return { skip: true };

    if (turn === "vigilante") {
        const mafia = pool.filter(p => known(p.id) === "mafia");

        // Only shoot who it KNOWS is Mafia (a wrong shot costs the Vigilante).
        if (mafia.length && (level !== "easy" || botChance(0.5))) {
            return { targetId: botPick(mafia).id };
        }

        // Easy bots are trigger-happy.
        if (level === "easy" && botChance(0.25)) {
            return { targetId: botPick(pool).id };
        }

        return { skip: true };
    }

    if (turn === "sheriff") {
        const fresh = pool.filter(p => !mem.checked[p.id]);
        const choices = level === "easy" || !fresh.length ? pool : fresh;
        const pick = botPick(choices);

        mem.checked[pick.id] = true;

        return { targetId: pick.id };
    }

    if (turn === "escort") {
        const bad = pool.filter(p => known(p.id) === "mafia" || known(p.id) === "sus");

        if (bad.length && level !== "easy" && botChance(level === "hard" ? 1 : 0.7)) {
            return { targetId: botPick(bad).id };
        }

        const choices = level === "hard" ? pool.filter(p => known(p.id) !== "clear") : pool;
        return { targetId: botPick(choices.length ? choices : pool).id };
    }

    if (turn === "bodyguard") {
        const pick = botWeighted(pool, p => {
            let weight = 1;
            if (p.id === mem.lastGuard) weight *= level === "easy" ? 1 : 0.2;
            if (level === "hard" && known(p.id) === "clear") weight += 3;
            return weight;
        });

        mem.lastGuard = pick.id;

        return { targetId: pick.id };
    }

    // Framer: frame the people most dangerous to the Mafia.
    const last = botLastVotes(room);

    const accusers = new Set(
        Object.keys(last).filter(voterId => {
            const target = room.players.find(p => p.id === last[voterId]);
            return target && isMafiaTeam(target.role);
        })
    );

    const pick = botChoose(level, pool, p => 1 + (accusers.has(p.id) ? 6 : 0));

    return { targetId: pick.id };
}

/* ---------- day vote ---------- */

function botPickVote(room, bot, mem) {
    const level = bot.botLevel;
    const mafiaSide = isMafiaTeam(bot.role);

    // A clumsy Easy Mafia bot sometimes votes for its own teammate.
    const blunder = mafiaSide && level === "easy" && botChance(0.2);

    let pool = botOthers(room, bot).filter(p => blunder || !(mafiaSide && isMafiaTeam(p.role)));

    if (!pool.length) pool = botOthers(room, bot);
    if (!pool.length) return null;

    const useKnowledge =
        level === "hard" ||
        (level === "medium" && botChance(0.9)) ||
        (level === "easy" && botChance(0.4));

    // Votes cast so far today.
    const tally = {};

    Object.values(room.votes || {}).forEach(targetId => {
        tally[targetId] = (tally[targetId] || 0) + 1;
    });

    // Players who voted against a Mafia teammate today.
    const accusersNow = new Set();

    if (mafiaSide) {
        Object.entries(room.votes || {}).forEach(([voterId, targetId]) => {
            const target = room.players.find(p => p.id === targetId);
            if (target && target.id !== bot.id && isMafiaTeam(target.role)) accusersNow.add(voterId);
        });
    }

    // What the others said in public chat: claim -> suspicion (Hard trusts it most).
    const claimWeight = level === "hard" ? 40 : level === "medium" ? 15 : 0;
    const claimed = {};

    if (!mafiaSide && claimWeight) {
        botClaims(room).forEach(claim => {
            const from = room.players.find(p => p.id === claim.from);

            if (from && from.alive && from.id !== bot.id) {
                claimed[claim.target] = (claimed[claim.target] || 0) + claimWeight;
            }
        });
    }

    // Mafia: whoever called a teammate out becomes the vote target.
    if (mafiaSide && level !== "easy") {
        botClaimersAgainstMafia(room).forEach(id => accusersNow.add(id));
    }

    // Players who voted against me last time.
    const grudges = new Set(
        Object.entries(botLastVotes(room))
            .filter(([, targetId]) => targetId === bot.id)
            .map(([voterId]) => voterId)
    );

    const executionerTarget =
        bot.role === "Executioner" ? buildExtraInfo(room, bot).execTargetId : null;

    const bandwagon = level === "hard" ? 4 : level === "medium" ? 2 : 0;
    const grudge = level === "hard" ? 5 : level === "medium" ? 2 : 0;

    const score = p => {
        let s = 1;

        if (!mafiaSide && useKnowledge) {
            if (mem.known[p.id] === "mafia") s += 1000;
            else if (mem.known[p.id] === "sus") s += 30;
        }

        if (executionerTarget && p.id === executionerTarget) {
            s += level === "easy" ? 15 : 1000;
        }

        s += bandwagon * (tally[p.id] || 0);

        s += claimed[p.id] || 0;

        if (grudges.has(p.id)) s += grudge;

        if (accusersNow.has(p.id)) s += level === "hard" ? 12 : level === "medium" ? 4 : 0;

        if (!mafiaSide && useKnowledge && mem.known[p.id] === "clear") s *= 0.02;

        return s;
    };

    const pick = botChoose(level, pool, score);

    return pick ? pick.id : null;
}

/* ---------- chat ---------- */

function botChatText(room, bot, mem) {
    const level = bot.botLevel;
    const others = botOthers(room, bot);

    if (!others.length) return "";

    // Share findings once (Medium sometimes, Hard always).
    if (level !== "easy") {
        const mafiaId = Object.keys(mem.known).find(
            id => mem.known[id] === "mafia" && !mem.shared[id] &&
                others.some(p => p.id === id)
        );

        const susId = Object.keys(mem.known).find(
            id => mem.known[id] === "sus" && !mem.shared[id] &&
                others.some(p => p.id === id)
        );

        if (mafiaId && (level === "hard" || botChance(0.6))) {
            mem.shared[mafiaId] = true;
            botAddClaim(room, bot.id, mafiaId);
            return botLine("detectiveFound", room.players.find(p => p.id === mafiaId).name);
        }

        if (susId && (level === "hard" || botChance(0.6))) {
            mem.shared[susId] = true;
            botAddClaim(room, bot.id, susId);
            return botLine("sheriffFound", room.players.find(p => p.id === susId).name);
        }

        if (bot.role === "Jester" && botChance(0.8)) {
            return botLine("jester");
        }

        const votedAgainstMe = Object.values(room.votes || {}).includes(bot.id);

        if (votedAgainstMe && botChance(0.7)) {
            return botLine("defend");
        }
    }

    if (level === "easy" || botChance(0.35)) {
        return botLine("generic");
    }

    const suspect = botPick(others.filter(p => !(isMafiaTeam(bot.role) && isMafiaTeam(p.role))));

    return suspect ? botLine("accuse", suspect.name) : botLine("generic");
}

function botSay(roomCode, bot, text) {
    if (!text) return;

    botSend(bot, "sendMessage", { roomCode, message: text });
}

/* ---------- the timer that makes bots act ---------- */

function botNightJobs(room, bot, turn) {
    const jobs = [];
    const actions = room.nightActions || {};

    if (turn === "mafia" && isMafiaTeam(bot.role)) {
        if (!(actions.mafia && actions.mafia[bot.id])) jobs.push("mafia");

        if (
            bot.role === "Grandmafia" &&
            room.nightNumber === 1 &&
            !room.grandmafiaUsed &&
            !(actions.grandmafia && actions.grandmafia[bot.id])
        ) {
            jobs.push("grandmafia");
        }
    }

    if (turn === "doctor" && bot.role === "Doctor" && !(actions.doctor && actions.doctor[bot.id])) {
        jobs.push("doctor");
    }

    if (turn === "detective" && bot.role === "Detective" && !(actions.detective && actions.detective[bot.id])) {
        jobs.push("detective");
    }

    if (turn === "cupid" && bot.role === "Cupid" && room.nightNumber === 1 && !room.cupidUsed[bot.id]) {
        jobs.push("cupid");
    }

    if (EXTRA_ROLE_TURN[bot.role] === turn && !(actions[turn] && actions[turn][bot.id])) {
        jobs.push("extra");
    }

    return jobs;
}

function botRunNightJob(roomCode, room, bot, job, turn) {
    const mem = botMemory(room, bot);

    if (job === "mafia") {
        const targetId = botPickMafiaTarget(room, bot);
        if (targetId) botSend(bot, "mafiaChoose", { roomCode, targetId });
    }

    if (job === "grandmafia") {
        const targetId = botPickGrandmafiaTarget(room, bot);
        if (targetId) botSend(bot, "grandmafiaChoose", { roomCode, targetId });
    }

    if (job === "doctor") {
        const targetId = botPickDoctorTarget(room, bot, mem);
        if (targetId) botSend(bot, "doctorChoose", { roomCode, targetId });
    }

    if (job === "detective") {
        const targetId = botPickInvestigateTarget(room, bot, mem);
        if (targetId) botSend(bot, "detectiveChoose", { roomCode, targetId });
    }

    if (job === "cupid") {
        const pair = botPickCupidPair(room, bot);
        if (pair) botSend(bot, "cupidChoose", { roomCode, cupid1: pair.first, cupid2: pair.second });
    }

    if (job === "extra") {
        const choice = botPickExtraTarget(room, bot, mem, turn);

        botSend(
            bot,
            "roleChoose",
            choice.skip ? { roomCode, skip: true } : { roomCode, targetId: choice.targetId }
        );
    }
}

function botNightTick(roomCode, room, now) {
    const turn = room.nightTurn;

    // Between two turns nobody acts. A hidden turn belongs to a dead player.
    if (!turn || room.hiddenNightTurn) return;

    room.players.forEach(bot => {
        if (!bot.isBot || !bot.alive || bot.connected === false) return;

        const jobs = botNightJobs(room, bot, turn);

        if (!jobs.length) return;

        const mem = botMemory(room, bot);
        const job = jobs[0];
        const key = `n|${room.nightNumber}|${turn}|${job}`;

        if (!mem.plan || mem.plan.key !== key) {
            const range = BOT_TIMING[bot.botLevel].night;
            const remaining = room.nightTurnEndsAt ? room.nightTurnEndsAt - now : 20000;
            const delay = Math.min(botRand(range[0], range[1]) * 1000, Math.max(800, remaining - 2500));

            mem.plan = { key, at: now + delay, tries: 0 };
            return;
        }

        if (now < mem.plan.at || mem.plan.tries >= 3) return;

        mem.plan.tries += 1;
        mem.plan.at = now + 1500;

        botRunNightJob(roomCode, room, bot, job, turn);
    });
}

function botDayTick(roomCode, room, now) {
    const dayKey = String(room.phaseEndsAt || "");
    const discussion = room.votingOpensAt && now < room.votingOpensAt;

    room.players.forEach(bot => {
        if (!bot.isBot || !bot.alive || bot.connected === false) return;

        const mem = botMemory(room, bot);

        /* ----- chat (public chat is open all day) ----- */
        if (!mem.chat || mem.chat.key !== dayKey) {
            const level = bot.botLevel;
            const messages =
                level === "easy" ? (botChance(0.4) ? 1 : 0) :
                level === "medium" ? (botChance(0.3) ? 2 : 1) :
                (botChance(0.5) ? 2 : 1);

            const span = Math.max(6000, Math.min(40000, (room.phaseEndsAt || now) - now - 12000));
            const times = [];

            for (let i = 0; i < messages; i++) times.push(now + 4000 + Math.random() * span);

            mem.chat = { key: dayKey, times: times.sort((a, b) => a - b) };
        }

        if (mem.chat.times.length && now >= mem.chat.times[0]) {
            mem.chat.times.shift();
            botSay(roomCode, bot, botChatText(room, bot, mem));
        }

        /* ----- vote (only once voting has opened) ----- */
        if (discussion || room.votes[bot.id]) return;

        const key = `v|${dayKey}`;

        if (!mem.plan || mem.plan.key !== key) {
            const range = BOT_TIMING[bot.botLevel].vote;
            const latest = (room.phaseEndsAt || now + 30000) - 5000;
            const at = Math.min(now + botRand(range[0], range[1]) * 1000, Math.max(now + 500, latest));

            mem.plan = { key, at, tries: 0 };
            return;
        }

        if (now < mem.plan.at || mem.plan.tries >= 3) return;

        mem.plan.tries += 1;
        mem.plan.at = now + 1500;

        const targetId = botPickVote(room, bot, mem);

        if (targetId) botSend(bot, "votePlayer", { roomCode, targetId });
    });
}

function destroyBotRoom(roomCode, room) {
    clearPhaseTimer(room);
    clearNightTurnTimer(room);

    delete rooms[roomCode];
    emitPublicMatches();
}

function botTick() {
    const now = Date.now();

    Object.keys(rooms).forEach(roomCode => {
        const room = rooms[roomCode];

        try {
            if (!room || !room.players || !room.players.some(p => p.isBot)) return;

            const humans = room.players.filter(p => !p.isBot && p.connected !== false);

            // Nobody is here: bots wait, and the room is closed after a while.
            if (!humans.length) {
                room._botNoHumanSince = room._botNoHumanSince || now;

                if (now - room._botNoHumanSince > BOT_ROOM_IDLE_MS) {
                    destroyBotRoom(roomCode, room);
                }

                return;
            }

            room._botNoHumanSince = null;

            // A new phase / turn / day always starts with a clean plan, so an old
            // plan can never stop a bot from acting in round 2, 3, 4 ...
            const phaseSig = [room.phase, room.nightNumber, room.nightTurn, room.phaseEndsAt, room.hiddenNightTurn].join("|");

            if (room._botPhaseSig !== phaseSig) {
                room._botPhaseSig = phaseSig;
                room.players.forEach(p => { if (p.isBot && p.mem) p.mem.plan = null; });
            }

            if (room.phase === "night") botNightTick(roomCode, room, now);
            else if (room.phase === "day") botDayTick(roomCode, room, now);
        } catch (error) {
            console.error("[bots] tick failed:", error);
        }
    });
}

setInterval(botTick, BOT_TICK_MS);

/* ---------- host controls ---------- */

function botMakeName(room) {
    const used = new Set(room.players.map(p => String(p.name || "").toLowerCase()));
    const free = BOT_NAMES.filter(n => !used.has(("🤖 " + n).toLowerCase()));
    const base = botPick(free.length ? free : BOT_NAMES);

    let name = "🤖 " + base;
    let number = 2;

    while (used.has(name.toLowerCase())) {
        name = `🤖 ${base} ${number}`;
        number += 1;
    }

    return name;
}

function botCreate(roomCode, room, level) {
    const id = "bot_" + crypto.randomBytes(6).toString("hex");

    createBotSocket(id, roomCode);

    const bot = {
        id,
        account: null,
        name: botMakeName(room),
        role: null,
        alive: true,
        connected: true,
        isBot: true,
        botLevel: level
    };

    room.players.push(bot);

    return bot;
}

function botCleanLevel(value, fallback) {
    const level = String(value || "").toLowerCase();
    return BOT_LEVELS.includes(level) ? level : fallback;
}

io.on("connection", socket => {
    if (socket.isBot) return;

    function hostRoom(data) {
        const roomCode = String(data?.roomCode || "").trim().toUpperCase();
        const room = rooms[roomCode];

        if (!room || room.host !== socket.id) return null;

        if (room.phase !== "lobby") {
            socket.emit("gameError", "Bots can only be changed in the lobby.");
            return null;
        }

        return { roomCode, room };
    }

    socket.on("botAdd", data => {
        const found = hostRoom(data);
        if (!found) return;

        const { roomCode, room } = found;
        const level = botCleanLevel(data?.level, room.botLevel || "medium");
        const connected = room.players.filter(p => p.connected !== false).length;
        const free = getRoomMaxPlayers(room) - connected;

        if (free <= 0) {
            return socket.emit("gameError", "This room is full. Raise the player limit or remove someone first.");
        }

        const count = Math.max(1, Math.min(
            Math.floor(Number(data?.count)) || 1,
            BOT_MAX_ADD_AT_ONCE,
            free
        ));

        room.botLevel = level;

        const added = [];

        for (let i = 0; i < count; i++) added.push(botCreate(roomCode, room, level));

        announce(
            roomCode,
            `🤖 ${count} ${BOT_LEVEL_LABEL[level]} bot${count === 1 ? "" : "s"} joined the room.`,
            "info"
        );

        emitLobby(roomCode);
        emitPublicMatches();

        // Some bots say hi in the lobby chat.
        added.forEach((bot, index) => {
            if (!botChance(0.6)) return;

            setTimeout(() => {
                const current = rooms[roomCode];

                if (!current || current.phase !== "lobby") return;
                if (!current.players.some(p => p.id === bot.id)) return;

                botSend(bot, "sendLobbyMessage", { message: botLine("greet") });
            }, 1200 + index * 1500 + Math.random() * 1500);
        });
    });

    socket.on("botRemove", data => {
        const found = hostRoom(data);
        if (!found) return;

        const { roomCode, room } = found;
        const before = room.players.length;

        room.players = room.players.filter(p => {
            const remove = p.isBot && (data?.all === true || p.id === data?.botId);

            if (remove) BOT_SOCKETS.delete(p.id);

            return !remove;
        });

        if (room.players.length === before) return;

        announce(roomCode, data?.all === true ? "🤖 All bots were removed." : "🤖 A bot was removed.", "info");

        emitLobby(roomCode);
        emitPublicMatches();
    });

    socket.on("botSetLevel", data => {
        const found = hostRoom(data);
        if (!found) return;

        const { roomCode, room } = found;
        const level = botCleanLevel(data?.level, null);

        if (!level) return;

        room.botLevel = level;

        room.players.forEach(p => {
            if (p.isBot && (!data?.botId || p.id === data.botId)) p.botLevel = level;
        });

        emitLobby(roomCode);
    });
});


/* =========================================================
   MAFIA WARS COMMUNITY + LOBBY EXPANSION
   Persistent social data lives in the existing accounts KV record.
   Existing account and room mechanics remain the source of truth.
========================================================= */
if (!accountsDb.guilds || typeof accountsDb.guilds !== "object") accountsDb.guilds = {};
if (!Array.isArray(accountsDb.reports)) accountsDb.reports = [];
const communityOnline = new Map(); // account key -> Set(socket ids)
const communityChatLimits = new Map();

function communityTrackOnline(socket, accountKey) {
    if (!accountKey || !accountsDb.users[accountKey]) return;
    if (!communityOnline.has(accountKey)) communityOnline.set(accountKey, new Set());
    communityOnline.get(accountKey).add(socket.id);
    communityEmitFriendPresence(accountKey, true);
    socket.emit("communityOnline", { friends: (accountsDb.users[accountKey].friends || []).map(k => ({ account: k, player: communityPublicUser(k) })).filter(x => x.player) });
}

function communityUser(socket) {
    const key = getSocketAccountKey(socket);
    return key && accountsDb.users[key] ? { key, user: accountsDb.users[key] } : null;
}
function communityReply(callback, payload) {
    if (typeof callback === "function") callback(payload);
}
function communityPublicUser(key) {
    const u = accountsDb.users[key];
    if (!u) return null;
    const prog = ensureProgress(u);
    const profile = ensureProfile(u);
    return {
        username: getDisplayName(u),
        level: levelInfo(prog.xp).level,
        online: Boolean(communityOnline.get(key)?.size),
        badge: u.badge || "member",
        guildId: u.guildId || null,
        guild: getGuildOfUser(u),
        wins: Number(profile.wins) || 0,
        games: Number(profile.games) || 0
    };
}
function communityEmitFriendPresence(key, online) {
    const u = accountsDb.users[key];
    (u?.friends || []).forEach(friendKey => {
        for (const sid of communityOnline.get(friendKey) || []) {
            io.to(sid).emit("friendPresence", { account: key, player: communityPublicUser(key), online });
        }
    });
}
function communityGetRoom(socket) {
    const code = findRoomCodeBySocket(socket.id);
    return code ? { code, room: rooms[code] } : null;
}
function communityIsStaff(socket) {
    return socket.badge === "owner" || socket.badge === "admin";
}

/* ---------- GUILD SYSTEM: roles, requests, invites, announcement, stats, leaderboard ---------- */
const GUILD_DESC_MAX = 140;
const GUILD_ANNOUNCE_MAX = 200;
const GUILD_CHAT_KEEP = 100;
const GUILD_REQUESTS_MAX = 50;
const GUILD_INVITES_PER_USER = 15;
const GUILD_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function guildCleanText(v, max) {
    return String(v ?? "").replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
function guildDeriveTag(name) {
    return String(name || "").replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 3) || "GLD";
}
function guildCleanTag(v) {
    return String(v || "").replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 4);
}
function guildNewCode() {
    let code;
    do {
        code = Array.from({ length: 6 }, () => GUILD_CODE_CHARS[crypto.randomInt(GUILD_CODE_CHARS.length)]).join("");
    } while (Object.values(accountsDb.guilds).some(g => g.inviteCode === code));
    return code;
}
/* Gives older guilds (created before this update) every new field. Safe to call any time. */
function guildNormalize(g) {
    if (!g) return g;
    if (!Array.isArray(g.members)) g.members = [];
    if (typeof g.description !== "string") g.description = "";
    if (typeof g.open !== "boolean") g.open = true;
    if (!Array.isArray(g.officers)) g.officers = [];
    g.officers = g.officers.filter(k => g.members.includes(k) && k !== g.leader);
    if (!Array.isArray(g.requests)) g.requests = [];
    g.requests = g.requests.filter(r => r && accountsDb.users[r.account] && !g.members.includes(r.account));
    if (!Array.isArray(g.chat)) g.chat = [];
    if (!g.tag) g.tag = guildDeriveTag(g.name);
    if (!g.inviteCode) g.inviteCode = guildNewCode();
    if (g.announcement && !g.announcement.text) g.announcement = null;
    return g;
}
function guildOfCtx(ctx) {
    const id = ctx && ctx.user ? ctx.user.guildId : null;
    const g = id ? accountsDb.guilds[id] : null;
    return g ? { id, g: guildNormalize(g) } : null;
}
function guildRoleOf(g, key) {
    return g.leader === key ? "leader" : (g.officers.includes(key) ? "officer" : "member");
}
function guildCanManage(g, key) {
    return g.leader === key || g.officers.includes(key);
}
function guildStatsOf(g) {
    let wins = 0, games = 0, points = 0;
    g.members.forEach(k => {
        const u = accountsDb.users[k];
        if (!u) return;
        const p = ensureProfile(u);
        wins += p.wins;
        games += p.games;
        points += totalStats(u.stats);
    });
    return { wins, games, points, members: g.members.length, winRate: games ? Math.round((wins / games) * 100) : 0 };
}
function guildBroadcast(g, event, payload) {
    g.members.forEach(k => { for (const sid of communityOnline.get(k) || []) io.to(sid).emit(event, payload); });
}
function guildTouch(g) { guildBroadcast(g, "guildRefresh", {}); }
function guildSystemLine(g, text) {
    const item = { system: true, message: guildCleanText(text, 160), at: Date.now() };
    g.chat.push(item);
    g.chat = g.chat.slice(-GUILD_CHAT_KEEP);
    guildBroadcast(g, "guildChatMessage", item);
}
function guildRefreshRooms(accountKey) {
    for (const sid of communityOnline.get(accountKey) || []) {
        const code = findRoomCodeBySocket(sid);
        if (code && rooms[code] && rooms[code].phase === "lobby") emitLobby(code);
    }
}
function guildNotify(accountKey) {
    for (const sid of communityOnline.get(accountKey) || []) io.to(sid).emit("guildChanged", getGuildOfUser(accountsDb.users[accountKey]));
}
function guildToast(accountKey, text, bad) {
    for (const sid of communityOnline.get(accountKey) || []) io.to(sid).emit("guildToast", { text, bad: Boolean(bad) });
}
function guildFindUser(name) {
    const q = String(name || "").trim().toLowerCase();
    if (!q) return null;
    if (accountsDb.users[q]) return q;
    for (const [key, u] of Object.entries(accountsDb.users)) {
        if (String(getDisplayName(u)).toLowerCase() === q) return key;
    }
    return null;
}
function guildMemberView(g, key) {
    const u = accountsDb.users[key];
    if (!u) return null;
    const p = ensureProfile(u);
    return {
        account: key,
        username: getDisplayName(u),
        online: Boolean(communityOnline.get(key)?.size),
        role: guildRoleOf(g, key),
        level: levelInfo(ensureProgress(u).xp).level,
        wins: p.wins,
        games: p.games,
        points: totalStats(u.stats)
    };
}
function guildCard(id, g) {
    const s = guildStatsOf(g);
    return {
        id, name: g.name, tag: g.tag, color: guildSafeColor(g.color), description: g.description, open: g.open,
        members: g.members.length, max: GUILD_MAX_MEMBERS, full: g.members.length >= GUILD_MAX_MEMBERS,
        wins: s.wins, points: s.points
    };
}
function guildMineView(id, g, key) {
    const order = { leader: 0, officer: 1, member: 2 };
    const members = g.members.map(k => guildMemberView(g, k)).filter(Boolean)
        .sort((a, b) => order[a.role] - order[b.role] || Number(b.online) - Number(a.online) || a.username.localeCompare(b.username));
    const staff = guildCanManage(g, key);
    return {
        ...guildCard(id, g),
        me: key,
        role: guildRoleOf(g, key),
        isLeader: g.leader === key,
        canManage: staff,
        createdAt: g.createdAt || 0,
        stats: guildStatsOf(g),
        announcement: g.announcement || null,
        members,
        chat: g.chat.slice(-60),
        inviteCode: staff ? g.inviteCode : null,
        requests: staff ? g.requests.map(r => ({ account: r.account, username: getDisplayName(accountsDb.users[r.account]), at: r.at })) : []
    };
}
/* Removes someone from a guild (leave / kick). Handles leader hand-over and empty guilds. */
function guildDropMember(id, g, key) {
    g.members = g.members.filter(k => k !== key);
    g.officers = g.officers.filter(k => k !== key);
    const u = accountsDb.users[key];
    if (u && u.guildId === id) delete u.guildId;
    if (!g.members.length) {
        delete accountsDb.guilds[id];
    } else if (g.leader === key) {
        g.leader = g.officers[0] || g.members[0];
        g.officers = g.officers.filter(k => k !== g.leader);
        guildSystemLine(g, getDisplayName(accountsDb.users[g.leader]) + " is the new guild leader.");
    }
    guildRefreshRooms(key);
    guildNotify(key);
}
/* Puts someone in a guild and clears their other pending requests and invites. */
function guildAddMember(id, g, key) {
    const u = accountsDb.users[key];
    g.members.push(key);
    g.requests = g.requests.filter(r => r.account !== key);
    u.guildId = id;
    u.guildInvites = [];
    Object.values(accountsDb.guilds).forEach(other => {
        if (Array.isArray(other.requests)) other.requests = other.requests.filter(r => r.account !== key);
    });
    guildSystemLine(g, getDisplayName(u) + " joined the guild.");
    guildRefreshRooms(key);
    guildNotify(key);
    guildTouch(g);
}

io.on("connection", socket => {
    if (socket.isBot) return;
    const key = getSocketAccountKey(socket);
    if (key) {
        if (!communityOnline.has(key)) communityOnline.set(key, new Set());
        communityOnline.get(key).add(socket.id);
        communityEmitFriendPresence(key, true);
        socket.emit("communityOnline", { friends: (accountsDb.users[key].friends || []).map(k => ({ account: k, player: communityPublicUser(k) })).filter(x => x.player) });
    }

    socket.on("communityFriends", (data, callback) => {
        const ctx = communityUser(socket);
        if (!ctx) return communityReply(callback, { ok: false, error: "Sign in to use friends." });
        const u = ctx.user;
        if (!Array.isArray(u.friends)) u.friends = [];
        if (!Array.isArray(u.friendRequests)) u.friendRequests = [];
        communityReply(callback, {
            ok: true,
            friends: u.friends.map(k => ({ account: k, player: communityPublicUser(k) })).filter(x => x.player),
            incoming: u.friendRequests.map(k => ({ account: k, player: communityPublicUser(k) })).filter(x => x.player)
        });
    });

    socket.on("friendRequest", (data, callback) => {
        const ctx = communityUser(socket);
        if (!ctx) return communityReply(callback, { ok: false, error: "Sign in first." });
        const targetName = String(data?.username || "").trim().toLowerCase();
        const target = accountsDb.users[targetName];
        if (!target || targetName === ctx.key) return communityReply(callback, { ok: false, error: "Player not found." });
        if (!Array.isArray(target.friendRequests)) target.friendRequests = [];
        if (!Array.isArray(ctx.user.friends)) ctx.user.friends = [];
        if (ctx.user.friends.includes(targetName)) return communityReply(callback, { ok: false, error: "Already friends." });
        if (!target.friendRequests.includes(ctx.key)) target.friendRequests.push(ctx.key);
        saveAccounts();
        for (const sid of communityOnline.get(targetName) || []) io.to(sid).emit("friendRequestReceived", { player: communityPublicUser(ctx.key) });
        communityReply(callback, { ok: true, message: "Friend request sent." });
    });

    socket.on("friendRequestRespond", (data, callback) => {
        const ctx = communityUser(socket);
        if (!ctx) return communityReply(callback, { ok: false, error: "Sign in first." });
        const from = String(data?.account || "").toLowerCase();
        const accept = Boolean(data?.accept);
        if (!Array.isArray(ctx.user.friendRequests)) ctx.user.friendRequests = [];
        ctx.user.friendRequests = ctx.user.friendRequests.filter(k => k !== from);
        if (accept && accountsDb.users[from]) {
            if (!Array.isArray(ctx.user.friends)) ctx.user.friends = [];
            if (!Array.isArray(accountsDb.users[from].friends)) accountsDb.users[from].friends = [];
            if (!ctx.user.friends.includes(from)) ctx.user.friends.push(from);
            if (!accountsDb.users[from].friends.includes(ctx.key)) accountsDb.users[from].friends.push(ctx.key);
        }
        saveAccounts();
        communityReply(callback, { ok: true });
    });

    socket.on("friendRemove", (data, callback) => {
        const ctx = communityUser(socket);
        if (!ctx) return communityReply(callback, { ok: false, error: "Sign in first." });
        const other = String(data?.account || "").toLowerCase();
        ctx.user.friends = (ctx.user.friends || []).filter(k => k !== other);
        if (accountsDb.users[other]) accountsDb.users[other].friends = (accountsDb.users[other].friends || []).filter(k => k !== ctx.key);
        saveAccounts(); communityReply(callback, { ok: true });
    });

    /* ---------- GUILD EVENTS ---------- */
    socket.on("communityGuild", (data, callback) => {
        const ctx = communityUser(socket);
        if (!ctx) return communityReply(callback, { ok: false, error: "Sign in to use guilds." });
        const guilds = accountsDb.guilds;
        Object.values(guilds).forEach(guildNormalize);
        const list = Object.entries(guilds).map(([id, g]) => guildCard(id, g)).sort((a, b) => b.members - a.members || a.name.localeCompare(b.name));
        const mine = guildOfCtx(ctx);
        /* invites addressed to me (drop invites whose guild no longer exists) */
        if (!Array.isArray(ctx.user.guildInvites)) ctx.user.guildInvites = [];
        ctx.user.guildInvites = ctx.user.guildInvites.filter(i => i && guilds[i.guildId]);
        const invites = mine ? [] : ctx.user.guildInvites.map(i => ({ guildId: i.guildId, guildName: guilds[i.guildId].name, color: guildSafeColor(guilds[i.guildId].color), by: i.by, at: i.at }));
        const requested = mine ? [] : Object.entries(guilds).filter(([, g]) => g.requests.some(r => r.account === ctx.key)).map(([id]) => id);
        communityReply(callback, {
            ok: true, colors: GUILD_COLORS, guilds: list,
            mine: mine ? guildMineView(mine.id, mine.g, ctx.key) : null,
            invites, requested
        });
    });

    socket.on("guildLeaderboard", (data, callback) => {
        const ctx = communityUser(socket);
        if (!ctx) return communityReply(callback, { ok: false, error: "Sign in to use guilds." });
        const by = data?.by === "points" ? "points" : "wins";
        const rows = Object.entries(accountsDb.guilds).map(([id, g]) => {
            guildNormalize(g);
            const s = guildStatsOf(g);
            return { id, name: g.name, tag: g.tag, color: guildSafeColor(g.color), members: s.members, wins: s.wins, games: s.games, points: s.points, winRate: s.winRate };
        }).sort((a, b) => b[by] - a[by] || b[by === "wins" ? "points" : "wins"] - a[by === "wins" ? "points" : "wins"] || a.name.localeCompare(b.name));
        rows.forEach((r, i) => { r.rank = i + 1; });
        communityReply(callback, { ok: true, by, rows: rows.slice(0, 50), myGuildId: ctx.user.guildId || null });
    });

    socket.on("guildCreate", (data, callback) => {
        const ctx = communityUser(socket);
        if (!ctx) return communityReply(callback, { ok: false, error: "Sign in first." });
        if (guildOfCtx(ctx)) return communityReply(callback, { ok: false, error: "Leave your current guild first." });
        const name = guildCleanText(data?.name, 16);
        if (name.length < 3) return communityReply(callback, { ok: false, error: "Guild name must be 3 to 16 characters." });
        if (Object.values(accountsDb.guilds).some(g => g.name.toLowerCase() === name.toLowerCase())) return communityReply(callback, { ok: false, error: "That guild name is already taken." });
        const id = crypto.randomBytes(6).toString("hex");
        accountsDb.guilds[id] = {
            name, color: guildSafeColor(data?.color), tag: guildCleanTag(data?.tag).length >= 2 ? guildCleanTag(data?.tag) : guildDeriveTag(name),
            description: guildCleanText(data?.description, GUILD_DESC_MAX), open: data?.open !== false,
            leader: ctx.key, officers: [], members: [ctx.key], requests: [], chat: [], announcement: null,
            inviteCode: guildNewCode(), createdAt: Date.now()
        };
        ctx.user.guildId = id;
        ctx.user.guildInvites = [];
        saveAccounts();
        guildRefreshRooms(ctx.key); guildNotify(ctx.key);
        communityReply(callback, { ok: true, id });
    });

    /* Open guild -> join straight away. Invite-only guild -> sends a join request. */
    socket.on("guildJoin", (data, callback) => {
        const ctx = communityUser(socket);
        if (!ctx) return communityReply(callback, { ok: false, error: "Sign in first." });
        if (guildOfCtx(ctx)) return communityReply(callback, { ok: false, error: "Leave your current guild first." });
        const id = String(data?.id || "");
        const g = guildNormalize(accountsDb.guilds[id]);
        if (!g) return communityReply(callback, { ok: false, error: "Guild not found." });
        if (g.members.length >= GUILD_MAX_MEMBERS) return communityReply(callback, { ok: false, error: "This guild is full." });
        if (g.open) {
            guildAddMember(id, g, ctx.key);
            saveAccounts();
            return communityReply(callback, { ok: true, joined: true, name: g.name });
        }
        if (g.requests.some(r => r.account === ctx.key)) return communityReply(callback, { ok: false, error: "You already asked to join this guild." });
        if (g.requests.length >= GUILD_REQUESTS_MAX) return communityReply(callback, { ok: false, error: "This guild has too many pending requests." });
        g.requests.push({ account: ctx.key, at: Date.now() });
        saveAccounts();
        g.members.filter(k => guildCanManage(g, k)).forEach(k => guildToast(k, getDisplayName(ctx.user) + " wants to join " + g.name + "."));
        guildTouch(g);
        communityReply(callback, { ok: true, joined: false, requested: true, name: g.name });
    });

    socket.on("guildJoinByCode", (data, callback) => {
        const ctx = communityUser(socket);
        if (!ctx) return communityReply(callback, { ok: false, error: "Sign in first." });
        if (guildOfCtx(ctx)) return communityReply(callback, { ok: false, error: "Leave your current guild first." });
        const code = String(data?.code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
        const entry = code ? Object.entries(accountsDb.guilds).find(([, g]) => g.inviteCode === code) : null;
        if (!entry) return communityReply(callback, { ok: false, error: "That invite code is not valid." });
        const [id, raw] = entry;
        const g = guildNormalize(raw);
        if (g.members.length >= GUILD_MAX_MEMBERS) return communityReply(callback, { ok: false, error: "This guild is full." });
        guildAddMember(id, g, ctx.key);
        saveAccounts();
        communityReply(callback, { ok: true, name: g.name });
    });

    socket.on("guildCancelRequest", (data, callback) => {
        const ctx = communityUser(socket);
        if (!ctx) return communityReply(callback, { ok: false, error: "Sign in first." });
        const g = accountsDb.guilds[String(data?.id || "")];
        if (g && Array.isArray(g.requests)) { g.requests = g.requests.filter(r => r.account !== ctx.key); guildTouch(guildNormalize(g)); }
        saveAccounts();
        communityReply(callback, { ok: true });
    });

    socket.on("guildRequestRespond", (data, callback) => {
        const ctx = communityUser(socket);
        const mine = ctx && guildOfCtx(ctx);
        if (!mine) return communityReply(callback, { ok: false, error: "You are not in a guild." });
        const { id, g } = mine;
        if (!guildCanManage(g, ctx.key)) return communityReply(callback, { ok: false, error: "Only the leader or an officer can answer join requests." });
        const target = String(data?.account || "").toLowerCase();
        const req = g.requests.find(r => r.account === target);
        if (!req) return communityReply(callback, { ok: false, error: "That request no longer exists." });
        if (data?.accept) {
            if (g.members.length >= GUILD_MAX_MEMBERS) return communityReply(callback, { ok: false, error: "The guild is full." });
            if (accountsDb.users[target]?.guildId && accountsDb.guilds[accountsDb.users[target].guildId]) {
                g.requests = g.requests.filter(r => r.account !== target); saveAccounts(); guildTouch(g);
                return communityReply(callback, { ok: false, error: "That player already joined another guild." });
            }
            guildAddMember(id, g, target);
            guildToast(target, "Your request was accepted. Welcome to " + g.name + "!");
        } else {
            g.requests = g.requests.filter(r => r.account !== target);
            guildToast(target, g.name + " declined your join request.", true);
            guildTouch(g);
        }
        saveAccounts();
        communityReply(callback, { ok: true });
    });

    socket.on("guildInvite", (data, callback) => {
        const ctx = communityUser(socket);
        const mine = ctx && guildOfCtx(ctx);
        if (!mine) return communityReply(callback, { ok: false, error: "You are not in a guild." });
        const { id, g } = mine;
        if (!guildCanManage(g, ctx.key)) return communityReply(callback, { ok: false, error: "Only the leader or an officer can invite players." });
        const targetKey = guildFindUser(data?.username);
        if (!targetKey) return communityReply(callback, { ok: false, error: "No player with that username." });
        const target = accountsDb.users[targetKey];
        if (g.members.includes(targetKey)) return communityReply(callback, { ok: false, error: "That player is already in your guild." });
        if (target.guildId && accountsDb.guilds[target.guildId]) return communityReply(callback, { ok: false, error: "That player is already in another guild." });
        if (g.members.length >= GUILD_MAX_MEMBERS) return communityReply(callback, { ok: false, error: "Your guild is full." });
        if (!Array.isArray(target.guildInvites)) target.guildInvites = [];
        if (target.guildInvites.some(i => i.guildId === id)) return communityReply(callback, { ok: false, error: "That player already has an invite from your guild." });
        if (target.guildInvites.length >= GUILD_INVITES_PER_USER) return communityReply(callback, { ok: false, error: "That player has too many pending invites." });
        target.guildInvites.push({ guildId: id, by: getDisplayName(ctx.user), at: Date.now() });
        saveAccounts();
        for (const sid of communityOnline.get(targetKey) || []) io.to(sid).emit("guildInviteReceived", { guildId: id, guildName: g.name, by: getDisplayName(ctx.user) });
        communityReply(callback, { ok: true, name: getDisplayName(target) });
    });

    socket.on("guildInviteRespond", (data, callback) => {
        const ctx = communityUser(socket);
        if (!ctx) return communityReply(callback, { ok: false, error: "Sign in first." });
        const id = String(data?.guildId || "");
        if (!Array.isArray(ctx.user.guildInvites)) ctx.user.guildInvites = [];
        const invite = ctx.user.guildInvites.find(i => i.guildId === id);
        if (!invite) return communityReply(callback, { ok: false, error: "That invite is no longer valid." });
        const g = guildNormalize(accountsDb.guilds[id]);
        if (!data?.accept || !g) {
            ctx.user.guildInvites = ctx.user.guildInvites.filter(i => i.guildId !== id);
            saveAccounts();
            return communityReply(callback, { ok: true, declined: true });
        }
        if (guildOfCtx(ctx)) return communityReply(callback, { ok: false, error: "Leave your current guild first." });
        if (g.members.length >= GUILD_MAX_MEMBERS) return communityReply(callback, { ok: false, error: "This guild is full." });
        guildAddMember(id, g, ctx.key);
        saveAccounts();
        communityReply(callback, { ok: true, name: g.name });
    });

    socket.on("guildLeave", (data, callback) => {
        const ctx = communityUser(socket);
        if (!ctx) return communityReply(callback, { ok: false, error: "Sign in first." });
        const mine = guildOfCtx(ctx);
        if (!mine) { delete ctx.user.guildId; saveAccounts(); return communityReply(callback, { ok: false, error: "You are not in a guild." }); }
        const { id, g } = mine;
        const name = getDisplayName(ctx.user);
        guildDropMember(id, g, ctx.key);
        if (accountsDb.guilds[id]) { guildSystemLine(g, name + " left the guild."); guildTouch(g); }
        saveAccounts();
        communityReply(callback, { ok: true });
    });

    socket.on("guildKick", (data, callback) => {
        const ctx = communityUser(socket);
        const mine = ctx && guildOfCtx(ctx);
        if (!mine) return communityReply(callback, { ok: false, error: "You are not in a guild." });
        const { id, g } = mine;
        const target = String(data?.account || "").toLowerCase();
        if (target === ctx.key || !g.members.includes(target)) return communityReply(callback, { ok: false, error: "Member not found." });
        const myRole = guildRoleOf(g, ctx.key), theirRole = guildRoleOf(g, target);
        if (myRole === "member") return communityReply(callback, { ok: false, error: "Only the leader or an officer can kick members." });
        if (myRole === "officer" && theirRole !== "member") return communityReply(callback, { ok: false, error: "Officers can only kick regular members." });
        const name = getDisplayName(accountsDb.users[target]);
        guildDropMember(id, g, target);
        guildSystemLine(g, name + " was kicked from the guild.");
        guildToast(target, "You were kicked from " + g.name + ".", true);
        guildTouch(g);
        saveAccounts();
        communityReply(callback, { ok: true });
    });

    /* Promote / demote between Officer and Member (leader only). */
    socket.on("guildSetRole", (data, callback) => {
        const ctx = communityUser(socket);
        const mine = ctx && guildOfCtx(ctx);
        if (!mine) return communityReply(callback, { ok: false, error: "You are not in a guild." });
        const { g } = mine;
        if (g.leader !== ctx.key) return communityReply(callback, { ok: false, error: "Only the guild leader can change roles." });
        const target = String(data?.account || "").toLowerCase();
        if (target === ctx.key || !g.members.includes(target)) return communityReply(callback, { ok: false, error: "Member not found." });
        const role = data?.role === "officer" ? "officer" : "member";
        g.officers = g.officers.filter(k => k !== target);
        if (role === "officer") g.officers.push(target);
        const name = getDisplayName(accountsDb.users[target]);
        guildSystemLine(g, name + (role === "officer" ? " was promoted to Officer." : " was demoted to Member."));
        guildToast(target, role === "officer" ? "You are now an Officer of " + g.name + "." : "You are now a Member of " + g.name + ".");
        guildTouch(g); saveAccounts();
        communityReply(callback, { ok: true });
    });

    socket.on("guildTransferLeader", (data, callback) => {
        const ctx = communityUser(socket);
        const mine = ctx && guildOfCtx(ctx);
        if (!mine) return communityReply(callback, { ok: false, error: "You are not in a guild." });
        const { g } = mine;
        if (g.leader !== ctx.key) return communityReply(callback, { ok: false, error: "Only the guild leader can transfer leadership." });
        const target = String(data?.account || "").toLowerCase();
        if (target === ctx.key || !g.members.includes(target)) return communityReply(callback, { ok: false, error: "Member not found." });
        g.officers = g.officers.filter(k => k !== target);
        if (!g.officers.includes(ctx.key)) g.officers.push(ctx.key);
        g.leader = target;
        guildSystemLine(g, getDisplayName(accountsDb.users[target]) + " is now the guild leader.");
        guildToast(target, "You are now the leader of " + g.name + "!");
        guildTouch(g); saveAccounts();
        communityReply(callback, { ok: true });
    });

    socket.on("guildEdit", (data, callback) => {
        const ctx = communityUser(socket);
        const mine = ctx && guildOfCtx(ctx);
        if (!mine) return communityReply(callback, { ok: false, error: "You are not in a guild." });
        const { id, g } = mine;
        if (g.leader !== ctx.key) return communityReply(callback, { ok: false, error: "Only the guild leader can edit the guild." });
        if (data?.name !== undefined) {
            const name = guildCleanText(data.name, 16);
            if (name.length < 3) return communityReply(callback, { ok: false, error: "Guild name must be 3 to 16 characters." });
            if (Object.entries(accountsDb.guilds).some(([gid, x]) => gid !== id && x.name.toLowerCase() === name.toLowerCase())) return communityReply(callback, { ok: false, error: "That guild name is already taken." });
            g.name = name;
        }
        if (data?.tag !== undefined) {
            const tag = guildCleanTag(data.tag);
            if (tag.length < 2) return communityReply(callback, { ok: false, error: "The guild tag needs 2 to 4 letters or numbers." });
            g.tag = tag;
        }
        if (data?.color !== undefined) g.color = guildSafeColor(data.color);
        if (data?.description !== undefined) g.description = guildCleanText(data.description, GUILD_DESC_MAX);
        if (data?.open !== undefined) g.open = Boolean(data.open);
        guildTouch(g); saveAccounts();
        g.members.forEach(k => { guildRefreshRooms(k); guildNotify(k); });
        communityReply(callback, { ok: true });
    });

    socket.on("guildRegenCode", (data, callback) => {
        const ctx = communityUser(socket);
        const mine = ctx && guildOfCtx(ctx);
        if (!mine) return communityReply(callback, { ok: false, error: "You are not in a guild." });
        if (!guildCanManage(mine.g, ctx.key)) return communityReply(callback, { ok: false, error: "Only the leader or an officer can change the invite code." });
        mine.g.inviteCode = guildNewCode();
        guildTouch(mine.g); saveAccounts();
        communityReply(callback, { ok: true, code: mine.g.inviteCode });
    });

    /* Leader pins (or clears, with empty text) the guild announcement. */
    socket.on("guildAnnounce", (data, callback) => {
        const ctx = communityUser(socket);
        const mine = ctx && guildOfCtx(ctx);
        if (!mine) return communityReply(callback, { ok: false, error: "You are not in a guild." });
        const { g } = mine;
        if (g.leader !== ctx.key) return communityReply(callback, { ok: false, error: "Only the guild leader can pin an announcement." });
        const text = guildCleanText(data?.text, GUILD_ANNOUNCE_MAX);
        g.announcement = text ? { text, by: getDisplayName(ctx.user), at: Date.now() } : null;
        if (text) guildSystemLine(g, "📌 New announcement pinned by the leader.");
        guildTouch(g); saveAccounts();
        communityReply(callback, { ok: true });
    });

    socket.on("guildDisband", (data, callback) => {
        const ctx = communityUser(socket);
        const mine = ctx && guildOfCtx(ctx);
        if (!mine) return communityReply(callback, { ok: false, error: "You are not in a guild." });
        const { id, g } = mine;
        if (g.leader !== ctx.key) return communityReply(callback, { ok: false, error: "Only the guild leader can disband the guild." });
        if (String(data?.confirmName || "").trim().toLowerCase() !== g.name.toLowerCase()) return communityReply(callback, { ok: false, error: "Type the guild name exactly to confirm." });
        const members = g.members.slice();
        delete accountsDb.guilds[id];
        members.forEach(k => { const u = accountsDb.users[k]; if (u && u.guildId === id) delete u.guildId; });
        Object.values(accountsDb.users).forEach(u => { if (Array.isArray(u.guildInvites)) u.guildInvites = u.guildInvites.filter(i => i.guildId !== id); });
        saveAccounts();
        members.forEach(k => { guildRefreshRooms(k); guildNotify(k); if (k !== ctx.key) guildToast(k, g.name + " was disbanded by the leader.", true); for (const sid of communityOnline.get(k) || []) io.to(sid).emit("guildRefresh", {}); });
        communityReply(callback, { ok: true });
    });

    socket.on("guildChatSend", (data, callback) => {
        const ctx = communityUser(socket);
        if (!ctx) return communityReply(callback, { ok: false, error: "Sign in first." });
        const mine = guildOfCtx(ctx);
        if (!mine) return communityReply(callback, { ok: false, error: "Join a guild first." });
        const { g } = mine;
        const now = Date.now(), last = communityChatLimits.get(socket.id) || 0;
        if (now - last < 1200) return communityReply(callback, { ok: false, error: "Slow down before sending another message." });
        communityChatLimits.set(socket.id, now);
        const message = String(data?.message || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 220);
        if (!message) return communityReply(callback, { ok: false, error: "Message is empty." });
        const item = { username: getDisplayName(ctx.user), role: guildRoleOf(g, ctx.key), message, at: now };
        g.chat.push(item);
        g.chat = g.chat.slice(-GUILD_CHAT_KEEP);
        saveAccounts();
        guildBroadcast(g, "guildChatMessage", item);
        communityReply(callback, { ok: true });
    });

    socket.on("playerReport", (data, callback) => {
        const ctx=communityUser(socket); if(!ctx) return communityReply(callback,{ok:false,error:"Sign in to report players."});
        const target=String(data?.username||"").trim().slice(0,20); const reason=String(data?.reason||"").trim().slice(0,40); const details=String(data?.details||"").trim().slice(0,500);
        if(!target || !reason) return communityReply(callback,{ok:false,error:"Choose a player and reason."});
        if(target.toLowerCase()===ctx.key) return communityReply(callback,{ok:false,error:"You cannot report yourself."});
        accountsDb.reports.push({ id:crypto.randomBytes(8).toString("hex"), reporter:ctx.key, target, reason, details, status:"pending", createdAt:Date.now() });
        saveAccounts(); communityReply(callback,{ok:true,message:"Report submitted for review."});
    });

    socket.on("ownerReportResolve", (data, callback) => {
        if (!communityIsStaff(socket) || !getSocketAccountKey(socket)) return communityReply(callback,{ok:false,error:"Staff access required."});
        const report=(accountsDb.reports||[]).find(r=>r.id===String(data?.id||""));
        if(!report) return communityReply(callback,{ok:false,error:"Report not found."});
        report.status="resolved"; report.resolvedAt=Date.now(); report.resolvedBy=getSocketAccountKey(socket); saveAccounts(); communityReply(callback,{ok:true});
    });

    socket.on("ownerCommunityDashboard", (data, callback) => {
        if (!communityIsStaff(socket) || !getSocketAccountKey(socket)) return communityReply(callback,{ok:false,error:"Staff access required."});
        const activeRooms=Object.values(rooms).filter(r=>r && r.phase!="gameover");
        const roleCounts={}; activeRooms.forEach(r=>(r.players||[]).forEach(p=>{if(p.role) roleCounts[p.role]=(roleCounts[p.role]||0)+1;}));
        communityReply(callback,{ok:true,registeredAccounts:Object.keys(accountsDb.users).length,onlinePlayers:[...communityOnline.values()].reduce((n,s)=>n+s.size,0),activeMatches:activeRooms.filter(r=>r.phase!=="lobby").length,totalMatches:Object.values(accountsDb.users).reduce((n,u)=>n+(Number(ensureProfile(u).games)||0),0),popularRoles:Object.entries(roleCounts).sort((a,b)=>b[1]-a[1]).slice(0,8),bannedAccounts:Object.values(accountsDb.users).filter(u=>u.banned).length,pendingReports:(accountsDb.reports||[]).filter(r=>r.status==="pending").length,reports:accountsDb.reports||[]});
    });

    socket.on("lobbySetReady", (data, callback) => {
        const found=communityGetRoom(socket); if(!found || found.room.phase!=="lobby") return communityReply(callback,{ok:false,error:"Not in a lobby."});
        const player=found.room.players.find(p=>p.id===socket.id); if(!player || player.isBot) return communityReply(callback,{ok:false,error:"Player unavailable."});
        player.ready=Boolean(data?.ready); emitLobby(found.code); communityReply(callback,{ok:true,ready:player.ready});
    });

    socket.on("lobbySetDescription", (data, callback) => {
        const found=communityGetRoom(socket); if(!found || found.room.host!==socket.id || found.room.phase!=="lobby") return communityReply(callback,{ok:false,error:"Only the host can edit the room description."});
        found.room.description=String(data?.description||"").replace(/[\u0000-\u001f\u007f]/g," ").trim().slice(0,120); emitLobby(found.code); communityReply(callback,{ok:true});
    });

    socket.on("lobbyTransferHost", (data, callback) => {
        const found=communityGetRoom(socket); if(!found || found.room.host!==socket.id || found.room.phase!=="lobby") return communityReply(callback,{ok:false,error:"Only the current host can transfer hosting."});
        const target=found.room.players.find(p=>p.id===String(data?.playerId||"") && p.connected!==false && !p.isBot);
        if(!target) return communityReply(callback,{ok:false,error:"Choose a connected player."});
        found.room.host=target.id; emitLobby(found.code); communityReply(callback,{ok:true});
    });

    socket.on("lobbyInviteFriend", (data, callback) => {
        const ctx=communityUser(socket); const found=communityGetRoom(socket); if(!ctx || !found) return communityReply(callback,{ok:false,error:"Sign in and join a room first."});
        const target=String(data?.account||"").toLowerCase(); if(!(ctx.user.friends||[]).includes(target)) return communityReply(callback,{ok:false,error:"That player is not your friend."});
        let sent=0; for(const sid of communityOnline.get(target)||[]){io.to(sid).emit("roomFriendInvite",{roomCode:found.code,from:getDisplayName(ctx.user)});sent++;}
        communityReply(callback,{ok:true,sent});
    });

    socket.on("joinAsSpectator", (data, callback) => {
        const code=String(data?.roomCode||"").trim().toUpperCase(), room=rooms[code];
        if(!room || room.phase==="gameover") return communityReply(callback,{ok:false,error:"Room is unavailable."});
        if(room.players.some(p=>p.id===socket.id)) return communityReply(callback,{ok:false,error:"You are already a player."});
        if(!Array.isArray(room.spectators)) room.spectators=[];
        const max=Math.max(0,Math.min(20,Number(room.spectatorLimit)||10));
        if(room.spectators.length>=max) return communityReply(callback,{ok:false,error:"Spectator slots are full."});
        room.spectators=room.spectators.filter(x=>x.id!==socket.id); room.spectators.push({id:socket.id,name:communityUser(socket)?.user ? getDisplayName(communityUser(socket).user) : "Guest",joinedAt:Date.now()});
        socket.join(code); io.to(code).emit("spectatorCount",{count:room.spectators.length});
        try { if (typeof sendGameInformation === "function" && room.phase !== "lobby") sendGameInformation(code); } catch (_) {}
        communityReply(callback,{ok:true,roomCode:code});
    });

    socket.on("disconnect", () => {
        const ctx=communityOnline;
        for(const [account,sockets] of ctx){ if(sockets.delete(socket.id) && sockets.size===0){ctx.delete(account); communityEmitFriendPresence(account,false);} }
        communityChatLimits.delete(socket.id);
        for(const room of Object.values(rooms)){ if(Array.isArray(room.spectators)){ const before=room.spectators.length; room.spectators=room.spectators.filter(x=>x.id!==socket.id); if(before!==room.spectators.length) io.emit("spectatorCount",{count:room.spectators.length}); } }
    });
});
