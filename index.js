import 'dotenv/config';
import express from "express";
import bodyParser from "body-parser";
import path from "path";
import fs from "fs-extra";
import getPort from "get-port";
import { fileURLToPath } from "url";
import { forceLoadPlugins, getPluginInfo } from "./lib/plugins.js";
import { manager, main, db, pluginQueueStats } from "./lib/client.js";
import initializeTelegramBot from "./bot.js";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Express setup ──────────────────────────────────────────────────────────────

const app = express();
// limit body size to 1mb
app.use(bodyParser.json({ limit: "1mb" }));

// Ensure sessions directory exists
const SESSIONS_DIR = path.join(process.cwd(), "sessions");
await fs.mkdirp(SESSIONS_DIR);

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Format a pairing code as AAAA-BBBB-CCCC-DDDD */
function fmtCode(raw) {
  if (!raw) return raw;
  const s = String(raw).replace(/\s+/g, "");
  return s.match(/.{1,4}/g)?.join("-") || s;
}

/**
 * sanitize session IDs — only alphanumeric + _ . - @
 */
function sanitizeSid(sid) {
  if (typeof sid !== "string") return null;
  const safe = sid.trim().replace(/[^A-Za-z0-9_.\-@]/g, "");
  return safe.length > 0 ? safe : null;
}

/**
 * wait for a session to reach "open" state via manager events,
 * not by attaching directly to sock.ev (which bypasses SessionManager).
 */
function waitForSessionOpen(sessionId, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    // If already connected, resolve immediately
    if (manager.isRunning(sessionId)) return resolve();

    const timer = setTimeout(() => {
      manager.removeListener("connected", onConnected);
      manager.removeListener("session.deleted", onDeleted);
      reject(new Error(`Timed out waiting for ${sessionId} to connect`));
    }, timeoutMs);

    function onConnected(sid) {
      if (sid !== sessionId) return;
      cleanup();
      resolve();
    }
    function onDeleted(sid) {
      if (sid !== sessionId) return;
      cleanup();
      reject(new Error(`Session ${sessionId} was deleted before connecting`));
    }
    function cleanup() {
      clearTimeout(timer);
      manager.removeListener("connected", onConnected);
      manager.removeListener("session.deleted", onDeleted);
    }

    manager.on("connected", onConnected);
    manager.on("session.deleted", onDeleted);
  });
}

// ── Routes ─────────────────────────────────────────────────────────────────────

/** Health check */
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    status: "Baileys Multi-Session Bot",
    sessions: manager.list().length,
    plugins: getPluginInfo().total,
    queue: pluginQueueStats(),
  });
});

/** List all known sessions */
app.get("/sessions", (_req, res) => {
  res.json({ ok: true, sessions: manager.list() });
});

/** Start / wake a session (non-blocking — socket may still be connecting) */
app.get("/start/:sessionId", async (req, res) => {
  // FIX #7: sanitize session ID
  const sid = sanitizeSid(req.params.sessionId);
  if (!sid)
    return res.status(400).json({ ok: false, error: "Invalid sessionId" });

  try {
    await manager.start(sid);
    res.json({ ok: true, sessionId: sid, running: manager.isRunning(sid) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/**
 * Pair a new session via pairing code.
 * GET /pair/:phoneNumber  — phone must be E.164 digits without +
 *
 * always uses cleanNumber as the session ID
 * uses manager events instead of sock.ev.on()
 */
app.get("/pair/:num", async (req, res) => {
  const phone = String(req.params.num || "").replace(/\D/g, "");

  if (!/^[0-9]{6,15}$/.test(phone)) {
    return res.status(400).json({
      ok: false,
      error: "phone must be digits only (E.164 without +), e.g. 919812345678",
    });
  }

  // session ID = clean phone number (no raw param used)
  const sid = phone;

  try {
    const sock = await manager.start(sid);
    if (!sock) throw new Error("Failed to create socket");

    //  wait via manager events, not sock.ev
    try {
      await waitForSessionOpen(sid, 25_000);
    } catch (waitErr) {
      console.warn(`⚠️  [${sid}] waitForSessionOpen: ${waitErr.message}`);
      // Continue anyway — requestPairingCode may still work
    }

    if (typeof sock.requestPairingCode !== "function") {
      throw new Error("Pairing code not supported by this socket version");
    }

    const rawCode = await sock.requestPairingCode(phone);
    const code = fmtCode(rawCode);

    return res.json({ ok: true, sessionId: sid, phone, code });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/** Stop a session (graceful — keeps credentials) */
app.post("/stop/:sessionId", async (req, res) => {
  const sid = sanitizeSid(req.params.sessionId);
  if (!sid)
    return res.status(400).json({ ok: false, error: "Invalid sessionId" });

  try {
    const ok = await manager.stop(sid);
    res.json({ ok, sessionId: sid });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/** Logout (permanent — deletes credentials) */
app.post("/logout/:sessionId", async (req, res) => {
  const sid = sanitizeSid(req.params.sessionId);
  if (!sid)
    return res.status(400).json({ ok: false, error: "Invalid sessionId" });

  try {
    const ok = await manager.logout(sid);
    res.json({ ok, sessionId: sid });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

/** Session detail */
app.get("/session/:sessionId", (req, res) => {
  const sid = sanitizeSid(req.params.sessionId);
  if (!sid)
    return res.status(400).json({ ok: false, error: "Invalid sessionId" });

  const entry = manager.sessions.get(sid);
  if (!entry)
    return res.status(404).json({ ok: false, error: "Session not found" });

  res.json({
    ok: true,
    sessionId: sid,
    status: entry.status,
    running: manager.isRunning(sid),
    reconnectAttempts: entry.reconnectAttempts || 0,
  });
});

/** Plugin info endpoint */
app.get("/plugins", (_req, res) => {
  res.json({ ok: true, ...getPluginInfo() });
});

// ── Graceful shutdown ──────────────────────────────────────────────────────────

// sequential shutdown with timeout guard
async function gracefulShutdown(signal) {
  console.log(`\n[app] Received ${signal} — shutting down...`);
  const timeout = setTimeout(() => {
    console.error("[app] Shutdown timed out — forcing exit");
    process.exit(1);
  }, 15_000);

  try {
    await manager.stopAll();
    await db.flush();
    await db.close();
    console.log("[app] Clean shutdown complete");
  } catch (e) {
    console.error("[app] Shutdown error:", e?.message || e);
  } finally {
    clearTimeout(timeout);
    process.exit(0);
  }
}

process.once("SIGINT", () => gracefulShutdown("SIGINT"));
process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));

// ── Startup ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || (await getPort({ port: 3000 }));

(async function init() {
  try {
    console.log("[app] Initializing...");

    await main({ autoStartAll: true });

    console.log("[app] DB ready, plugins loaded, sessions started");

    const server = app.listen(PORT, () => {
      console.log(`[app] 🚀 Server listening on port ${PORT}`);
    });

    try {
      if (!process.env.OFFTELEBOT || process.env.OFFTELEBOT === "false") {
        await initializeTelegramBot(manager);
      }
    } catch (error) {
      console.error(error);
    }

    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[app] ❌ Port ${PORT} is already in use`);
      } else {
        console.error("[app] Server error:", err.message);
      }
      process.exit(1);
    });
  } catch (err) {
    console.error("[app] Fatal initialization error:", err?.message || err);
    process.exit(1);
  }
})();
