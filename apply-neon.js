/*
  apply-neon.js
  Makes your Mafia Wars server.js save accounts, points, shop points,
  rank points, purchases and Help questions in Neon (Postgres) instead of
  data/accounts.json, which Render deletes on every restart.

  Run it ONCE in your mafia-online folder:
      node apply-neon.js

  It keeps a backup (server.before-neon.js) and checks the result.
  If anything looks wrong it puts your original file back.
*/

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const file = path.resolve(process.argv[2] || "server.js");
const backup = path.join(path.dirname(file), "server.before-neon.js");

if (!fs.existsSync(file)) {
    console.error("Could not find " + file + ". Run this inside your mafia-online folder.");
    process.exit(1);
}

const original = fs.readFileSync(file, "utf8");
const usesCrlf = original.includes("\r\n");
let src = original.replace(/\r\n/g, "\n");

if (src.includes("initDatabase")) {
    console.log("server.js already has the Neon code. Nothing to do.");
    process.exit(0);
}

/* ---------- the new code ---------- */

const HEADER = `require("dotenv").config({ path: ".env.local" });
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
        console.log("[db] Loaded " + Object.keys(accountsDb.users).length + " accounts from Neon.");
    } else {
        await writeAccountsNow();
        console.log("[db] Neon was empty. Saved the current accounts.");
    }

    const questions = await dbLoad("questions");
    if (Array.isArray(questions) && questions.length) questionsDb = questions;
    else await writeQuestionsNow();
}

`;

const WRITE_ACCOUNTS = `function writeAccountsFile() {
    try {
        const tempFile = ACCOUNTS_FILE + ".tmp";
        fs.writeFileSync(tempFile, JSON.stringify(accountsDb));
        fs.renameSync(tempFile, ACCOUNTS_FILE);
    } catch (error) {
        console.error("Could not save accounts file:", error);
    }
}

const writeAccountsNow = makeDbSaver("accounts", () => accountsDb, writeAccountsFile);`;

const FLUSH = `async function flushAccountsAndExit() {
    if (accountsSaveTimer) { clearTimeout(accountsSaveTimer); accountsSaveTimer = null; }
    if (questionsSaveTimer) { clearTimeout(questionsSaveTimer); questionsSaveTimer = null; }
    await writeAccountsNow();
    await writeQuestionsNow();
    process.exit(0);
}`;

const WRITE_QUESTIONS = `function writeQuestionsFile() {
    try {
        const tempFile = QUESTIONS_FILE + ".tmp";
        fs.writeFileSync(tempFile, JSON.stringify(questionsDb));
        fs.renameSync(tempFile, QUESTIONS_FILE);
    } catch (error) {
        console.error("Could not save questions file:", error);
    }
}

const writeQuestionsNow = makeDbSaver("questions", () => questionsDb, writeQuestionsFile);`;

const START = `const PORT = process.env.PORT || 2001;

initDatabase()
    .then(() => {
        server.listen(PORT, "0.0.0.0", () => {
            console.log("Mafia Wars is running on port " + PORT);
        });
    })
    .catch(error => {
        console.error("Could not connect to the database. Not starting, so no data is overwritten:", error);
        process.exit(1);
    });`;

/* ---------- helpers ---------- */

function fail(message) {
    console.error("\nSTOPPED: " + message);
    console.error("Your server.js was not changed.");
    process.exit(1);
}

function replaceFunction(name, replacement) {
    const start = src.indexOf("function " + name + "(");
    if (start === -1) fail("Could not find function " + name + " in server.js.");

    const open = src.indexOf("{", start);
    let depth = 0;

    for (let i = open; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}") {
            depth--;
            if (depth === 0) {
                src = src.slice(0, start) + replacement + src.slice(i + 1);
                return;
            }
        }
    }

    fail("Could not read the end of function " + name + ".");
}

/* ---------- apply ---------- */

replaceFunction("writeAccountsNow", WRITE_ACCOUNTS);
replaceFunction("flushAccountsAndExit", FLUSH);
replaceFunction("writeQuestionsNow", WRITE_QUESTIONS);

const portStart = src.indexOf("const PORT = process.env.PORT || 2001;");
if (portStart === -1) fail("Could not find the 'const PORT' line.");

const listenStart = src.indexOf("server.listen(", portStart);
if (listenStart === -1) fail("Could not find server.listen.");

const listenEnd = src.indexOf("});", listenStart);
if (listenEnd === -1) fail("Could not find the end of server.listen.");

src = src.slice(0, portStart) + START + src.slice(listenEnd + 3);
src = HEADER + src;

if (usesCrlf) src = src.replace(/\n/g, "\r\n");

fs.writeFileSync(backup, original);
fs.writeFileSync(file, src);

/* ---------- check the result ---------- */

const check = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });

if (check.status !== 0) {
    fs.writeFileSync(file, original);
    console.error("\nThe patched file had a syntax error, so your original server.js was put back:");
    console.error(check.stderr);
    process.exit(1);
}

let missing = [];
["pg", "dotenv"].forEach(name => {
    try { require.resolve(name, { paths: [path.dirname(file)] }); } catch (_) { missing.push(name); }
});

console.log("\nDone! server.js now saves everything in Neon.");
console.log("Backup of your old file: " + backup);

if (missing.length) {
    console.log("\nStill needed: run   npm install " + missing.join(" ") + "   then   npm start");
} else {
    console.log("\nNext: run   npm start   and look for the line starting with [db]");
}
