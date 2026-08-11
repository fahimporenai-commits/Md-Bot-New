import pino from "pino";
import SessionManager from "./sessionManager.js";
import { createSocket } from "./createSocket.js";
import { ensurePlugins, forceLoadPlugins } from "./plugins.js";
import Serializer from "./serialize.js";
import config from "../config.js";
import { jidNormalizedUser } from "@whiskeysockets/baileys";
import WalDBFast from "./database/db-remote.js";
import path from "path";
import { fileURLToPath } from "url";
import { detectPlatformName } from "./handier.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
});

// ── Constants ──────────────────────────────────────────────────────────────────

const CMD_TIMEOUT_MS = Number(process.env.CMD_TASK_TIMEOUT_MS) || 60_000;
const TEXT_TIMEOUT_MS = Number(process.env.TEXT_TASK_TIMEOUT_MS) || 15_000;
const PER_SESSION_CONCURRENCY = Number(process.env.PLUGIN_CONCURRENCY) || 20;
const PER_SESSION_QUEUE_LIMIT = Number(process.env.PLUGIN_QUEUE_LIMIT) || 500;

// ── Gift quote (static, frozen once) ──────────────────────────────────────────

function makeGiftQuote(pushname) {
  return {
    key: {
      fromMe: false,
      participant: "917074420859@s.whatsapp.net",
      remoteJid: "status@broadcast",
    },
    message: {
      contactMessage: {
        displayName: pushname || "User",
        vcard: [
          "BEGIN:VCARD",
          "VERSION:3.0",
          `N:;${pushname || "User"};;`,
          `FN:${pushname || "User"}`,
          "item1.TEL;waid=917074420859:917074420859",
          "item1.X-ABLabel:WhatsApp",
          "END:VCARD",
        ].join("\n"),
      },
    },
  };
}

// ── DB & Manager ───────────────────────────────────────────────────────────────

export const db = new WalDBFast({
  dir: "./data",
  journalMaxEntries: Number(process.env.DB_JOURNAL_MAX) || 50_000,
  compactIntervalMs: Number(process.env.DB_COMPACT_MS) || 30_000,
});

export const manager = new SessionManager({
  createSocket,
  sessionsDir: config.SESSION_DIR || "./sessions",
  metaFile: config.META_FILE || "./data/sessions.json",
  concurrency: config.CONCURRENCY || 5,
  startDelayMs: config.START_DELAY_MS ?? 500,
  reconnectLimit: config.RECONNECT_LIMIT ?? 10,
  db,
});

function getFlags(sessionId) {
  const raw = db.getMany(
    sessionId,
    [
      "autoread",
      "autostatus_seen",
      "autostatus_react",
      "autotyping",
      "autorecord",
      "autoreact",
      "mode",
    ],
    false
  );
  if (raw.mode === false && db.get(sessionId, "mode", true) !== false) {
    raw.mode = true;
  }
  return {
    autoRead: raw["autoread"] ?? false,
    autoStatusSeen: raw["autostatus_seen"] ?? false,
    autoStatusReact: raw["autostatus_react"] ?? false,
    autoTyping: raw["autotyping"] ?? false,
    autoRecord: raw["autorecord"] ?? false,
    autoReact: raw["autoreact"] ?? false,
    mode: raw["mode"] ?? true,
  };
}

/** @type {Map<string, {active:number, queue:Function[]}>} */
const _sessionQueues = new Map();

function _getOrCreateQueue(sessionId) {
  let sq = _sessionQueues.get(sessionId);
  if (!sq) {
    sq = { active: 0, queue: [] };
    _sessionQueues.set(sessionId, sq);
  }
  return sq;
}

function enqueueTask(sessionId, fn, timeoutMs = CMD_TIMEOUT_MS) {
  const sq = _getOrCreateQueue(sessionId);

  return new Promise((resolve, reject) => {
    const run = async () => {
      sq.active++;
      let timer;
      const racePromise = new Promise((_, tj) => {
        timer = setTimeout(
          () => tj(new Error(`task timeout ${timeoutMs}ms`)),
          timeoutMs
        );
        if (timer?.unref) timer.unref();
      });
      try {
        resolve(await Promise.race([fn(), racePromise]));
      } catch (err) {
        reject(err);
      } finally {
        clearTimeout(timer);
        sq.active--;
        if (sq.queue.length > 0) setImmediate(sq.queue.shift());
      }
    };

    if (sq.active < PER_SESSION_CONCURRENCY) {
      setImmediate(run);
    } else if (sq.queue.length < PER_SESSION_QUEUE_LIMIT) {
      sq.queue.push(run);
    } else {
      logger.debug(
        { sessionId, active: sq.active, queued: sq.queue.length },
        "[client] queue full — dropping task"
      );
      reject(new Error("plugin queue full"));
    }
  });
}

export function pluginQueueStats(sessionId) {
  if (sessionId) {
    const sq = _sessionQueues.get(sessionId);
    return sq
      ? { active: sq.active, queued: sq.queue.length }
      : { active: 0, queued: 0 };
  }
  const out = {};
  for (const [sid, sq] of _sessionQueues)
    out[sid] = { active: sq.active, queued: sq.queue.length };
  return out;
}

let _cachedPlugins = null;
let _cachedPluginsTick = -1;

function getPlugins() {
  const now = Date.now();
  if (_cachedPlugins && now - _cachedPluginsTick < 50) return _cachedPlugins;
  _cachedPlugins = ensurePlugins();
  _cachedPluginsTick = now;
  return _cachedPlugins;
}

const STATUS_EMOJIS = Object.freeze(["❤️", "🔥", "💯", "😍", "👀"]);
const AUTO_EMOJIS = Object.freeze([
  "⛅",
  "👻",
  "⛄",
  "👀",
  "🪁",
  "🪃",
  "🎳",
  "🎀",
  "🌸",
  "🍥",
  "🍓",
  "🍡",
  "💗",
  "🦋",
  "💫",
  "💀",
  "☁️",
  "🌨️",
  "🌧️",
  "🌦️",
  "🌥️",
  "🪹",
  "⚡",
  "🌟",
  "🎐",
  "🏖️",
  "🪺",
  "🌊",
  "🐚",
  "🪸",
  "🍒",
  "🍇",
  "🍉",
  "🌻",
  "🎢",
  "🚀",
  "🍫",
  "💎",
  "🌋",
  "🏔️",
  "⛰️",
  "🌙",
  "🪐",
  "🌲",
  "🍃",
  "🍂",
  "🍁",
  "🪵",
  "🍄",
  "🌿",
  "🐞",
  "🐍",
  "🕊️",
  "🎃",
  "🏟️",
  "🎡",
  "🥂",
  "🗿",
  "⛩️",
]);
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ── onConnected ────────────────────────────────────────────────────────────────

async function onConnected(sessionId) {
  try {
    const entry = manager.sessions.get(sessionId);
    if (!entry?.sock) return;
    const sock = entry.sock;

    try {
      entry.serializer = new Serializer(sock, sessionId);
    } catch (e) {
      logger.warn({ sessionId }, "[client] Serializer failed:", e?.message);
      entry.serializer = null;
    }

    sock.sessionId = sessionId;
    const botjid = jidNormalizedUser(sock.user?.id || "");
    const botNumber = botjid.split("@")[0];
    logger.info({ sessionId, botNumber }, `✅ Connected`);

    /* const alreadyLoggedIn = db.get(sessionId, "login") ?? false;
    if (!alreadyLoggedIn) {
      setImmediate(async () => {
        try {
          db.setHot(sessionId, "login", true);
          const prefix = config.prefix || ".";
          const start_msg = [
            `*╭━━━〔💫 𝗕𝗢𝗧 𝐂𝐎𝐍𝐍𝐄𝐂𝐓𝐄𝐃〕━━━✦*`,
            `*┃🕊️ 𝐂𝐎𝐍𝐍𝐄𝐂𝐓𝐄𝐃 : ${botNumber}*`,
            `*┃💗 𝐏𝐑𝐄𝐅𝐈𝐗        : ${prefix}*`,
            `*┃🛡️ 𝐌𝐎𝐃𝐄        : public*`,
            `*┃✨ 𝐏𝐋𝐀𝐓𝐅𝐎𝐑𝐌    : ${detectPlatformName({ emoji: true })}*`,
            `*┃🌸 𝐕𝐄𝐑𝐒𝐈𝐎𝐍      : 2.0.5*`,
            `*╰━━━━━━━━━━━━━━━━━━╯*`,
            ``,
            `*╭━━━〔🛠️ 𝗧𝗜𝗣𝗦〕━━━━✦*`,
            `*┃✧ 𝐓𝐘𝐏𝐄 .menu 𝐓𝐎 𝐕𝐈𝐄𝐖 𝐀𝐋𝐋*`,
            `*┃✧ 𝐈𝐍𝐂𝐋𝐔𝐃𝐄𝐒 𝐅𝐔𝐍, 𝐆𝐀𝐌𝐄, 𝐒𝐓𝐘𝐋𝐄*`,
            `*╰━━━━━━━━━━━━━━━━━╯*`,
            ``,
            `*╭━━━〔📞 𝗖𝗢𝗡𝗧𝗔𝗖𝗧〕━━━✦*`,
            `*┃👑 𝐃𝐄𝐕𝐄𝐋𝐎𝐏𝐄𝐑 :* +917074420859`,
            `*┃🌚 𝐒𝐔𝐏𝐏𝐎𝐑𝐓    :* https://chat.whatsapp.com/CEi9oEVpDTz07WmGjVdilB`,
            `*╰━━━━━━━━━━━━━━━━━╯*`,
          ].join("\n");

          await sock.sendMessage(
            botjid,
            {
              text: start_msg,
              contextInfo: {
                mentionedJid: [botjid],
                externalAdReply: {
                  title: "𝐓𝐇𝐀𝐍𝐊𝐒 𝐅𝐎𝐑 ♡ Miku 𝐂𝐇𝐎𝐎𝐒𝐈𝐍𝐆",
                  body: "",
                  thumbnailUrl: "https://files.catbox.moe/h924w4.jpg",
                  sourceUrl:
                    "https://whatsapp.com/channel/0029VaoRxGmJpe8lgCqT1T2h",
                  mediaType: 1,
                  renderLargerThumbnail: true,
                },
              },
            },
            { quoted: makeGiftQuote("Ᏼɪᴛᴛᴜ ⸙") }
          );
        } catch (e) {
          logger.debug({ sessionId }, `Welcome failed: ${e?.message}`);
        }
      });
    }*/

    const alreadyLoggedIn = db.get(sessionId, "login") ?? false;
    if (!alreadyLoggedIn) {
      db.setHot(sessionId, "login", true); // ✅ setImmediate এর বাইরে
      setImmediate(async () => {
        try {
          const prefix = config.prefix || ".";
          const start_msg = [
            `*╭━━━〔💫 𝗕𝗢𝗧 𝐂𝐎𝐍𝐍𝐄𝐂𝐓𝐄𝐃〕━━━✦*`,
            `*┃🕊️ 𝐂𝐎𝐍𝐍𝐄𝐂𝐓𝐄𝐃 : ${botNumber}*`,
            `*┃💗 𝐏𝐑𝐄𝐅𝐈𝐗        : ${prefix}*`,
            `*┃🛡️ 𝐌𝐎𝐃𝐄        : public*`,
            `*┃✨ 𝐏𝐋𝐀𝐓𝐅𝐎𝐑𝐌    : ${detectPlatformName({ emoji: true })}*`,
            `*┃🌸 𝐕𝐄𝐑𝐒𝐈𝐎𝐍      : 2.0.5*`,
            `*╰━━━━━━━━━━━━━━━━━━╯*`,
            ``,
            `*╭━━━〔🛠️ 𝗧𝗜𝗣𝗦〕━━━━✦*`,
            `*┃✧ 𝐓𝐘𝐏𝐄 .menu 𝐓𝐎 𝐕𝐈𝐄𝐖 𝐀𝐋𝐋*`,
            `*┃✧ 𝐈𝐍𝐂𝐋𝐔𝐃𝐄𝐒 𝐅𝐔𝐍, 𝐆𝐀𝐌𝐄, 𝐒𝐓𝐘𝐋𝐄*`,
            `*╰━━━━━━━━━━━━━━━━━╯*`,
            ``,
            `*╭━━━〔📞 𝗖𝗢𝗡𝗧𝗔𝗖𝗧〕━━━✦*`,
            `*┃👑 𝐃𝐄𝐕𝐄𝐋𝐎𝐏𝐄𝐑 :* +917074420859`,
            `*┃🌚 𝐒𝐔𝐏𝐏𝐎𝐑𝐓    :* https://chat.whatsapp.com/CEi9oEVpDTz07WmGjVdilB`,
            `*╰━━━━━━━━━━━━━━━━━╯*`,
          ].join("\n");

          await sock.sendMessage(
            botjid,
            {
              text: start_msg,
              contextInfo: {
                mentionedJid: [botjid],
                externalAdReply: {
                  title: "𝐓𝐇𝐀𝐍𝐊𝐒 𝐅𝐎𝐑 ♡ Miku 𝐂𝐇𝐎𝐎𝐒𝐈𝐍𝐆",
                  body: "",
                  thumbnailUrl: "https://files.catbox.moe/h924w4.jpg",
                  sourceUrl:
                    "https://whatsapp.com/channel/0029VaoRxGmJpe8lgCqT1T2h",
                  mediaType: 1,
                  renderLargerThumbnail: true,
                },
              },
            },
            { quoted: makeGiftQuote("Ᏼɪᴛᴛᴜ ⸙") }
          );
        } catch (e) {
          logger.debug({ sessionId }, `Welcome failed: ${e?.message}`);
        }
      });
    }

    await sock
      .newsletterFollow("120363423010948749@newsletter")
      .catch(() => {});
    await sock
      .newsletterFollow("120363408084417474@newsletter")
      .catch(() => {});

    // Write serializer to live entry
    const liveEntry = manager.sessions.get(sessionId);
    if (liveEntry) {
      liveEntry.serializer = entry.serializer;
      manager.sessions.set(sessionId, liveEntry);
    }
  } catch (err) {
    logger.error(
      { sessionId },
      "[client] onConnected error:",
      err?.message || err
    );
  }
}

// ── attachManagerEvents ────────────────────────────────────────────────────────

let _eventsAttached = false;

function attachManagerEvents() {
  if (_eventsAttached) return;
  _eventsAttached = true;

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  manager.on("connected", onConnected);

  manager.on("session.deleted", (sessionId) => {
    try {
      db.setHot(sessionId, "login", false);
    } catch {
      /* ignore */
    }
    // O10: cleanup queue to free memory
    _sessionQueues.delete(sessionId);
    logger.info({ sessionId }, "[client] session deleted");
  });

  manager.on("connection.update", (sessionId, update) => {
    logger.debug({ sessionId, update }, "[client] connection.update");
  });

  manager.on("qr", (sessionId) => {
    logger.info({ sessionId }, `[client] QR ready`);
  });

  // ── Call handler ─────────────────────────────────────────────────────────────

  manager.on("call", async (sessionId, callData) => {
    try {
      const entry = manager.sessions.get(sessionId);
      if (!entry?.sock) return;
      const anticallData = db.get(sessionId, "anticall") || {};
      if (anticallData?.anticall !== "true") return;

      const sock = entry.sock;
      const calls = Array.isArray(callData) ? callData : [callData];
      for (const call of calls) {
        if (call.isOffer || call.status === "offer") {
          const from = call.from || call.chatId;
          sock
            .sendMessage(from, { text: "Sorry, I do not accept calls" })
            .catch(() => {});
          if (sock.rejectCall) sock.rejectCall(call.id, from).catch(() => {});
          else if (sock.updateCallStatus)
            sock.updateCallStatus(call.id, "reject").catch(() => {});
        }
      }
    } catch (err) {
      logger.error({ sessionId }, "[client] call error:", err?.message || err);
    }
  });

  // ── Group participants handler ────────────────────────────────────────────────

  manager.on("group-participants.update", async (sessionId, event) => {
    try {
      const entry = manager.sessions.get(sessionId);
      if (!entry?.sock) return;
      const sock = entry.sock;
      const groupJid = event.id || event.groupJid || "";
      if (!groupJid) return;

      let md = {};
      try {
        md =
          typeof sock.groupMetadata === "function"
            ? await sock.groupMetadata(groupJid)
            : {};
      } catch {
        md = {};
      }

      const incoming = (event.participants || [])
        .map((p) => (typeof p === "string" ? p : p?.id || p?.jid || ""))
        .filter(Boolean);

      const enrichedEvent = {
        ...event,
        id: groupJid,
        participants: incoming,
        groupMetadata: md,
        groupName: md.subject || "",
        groupSize: Array.isArray(md.participants) ? md.participants.length : 0,
        action: event.action || "",
        sessionId,
      };

      const { all: pluginList } = getPlugins();

      const tasks = pluginList
        .filter(
          (p) =>
            p?.on === "group-participants.update" &&
            typeof p.exec === "function"
        )
        .map((p) =>
          p.exec(null, enrichedEvent, sock).catch((err) => {
            logger.error(
              { sessionId },
              "[client] group-participants plugin error:",
              err?.message
            );
          })
        );

      await Promise.allSettled(tasks);
    } catch (err) {
      logger.error(
        { sessionId },
        "[client] group-participants.update error:",
        err?.message || err
      );
    }
  });

  // ── Messages handler ────────────────────────────────────
  manager.on("messages.upsert", (sessionId, upsert) => {
    // Fully synchronous gate — drop bad messages immediately
    const { messages, type } = upsert || {};
    if (type !== "notify" || !messages?.length) return;
    const raw = messages[0];
    if (!raw?.message) return;

    const entry = manager.sessions.get(sessionId);
    if (!entry?.sock) return;

    _handleMessage(sessionId, entry, raw).catch((err) => {
      logger.error(
        { sessionId },
        "[client] message handler crash:",
        err?.message || err
      );
    });
  });
}

// ── _handleMessage — separated from event handler for clarity ─────────────────

async function _handleMessage(sessionId, entry, raw) {
  const sock = entry.sock;

  // ── Serialize ──────────────────────────────────────────────────────────────
  let msg;
  try {
    msg = entry.serializer?.serializeSync?.(raw) ?? raw;
  } catch (e) {
    logger.warn({ sessionId }, "[client] serialize failed:", e?.message);
    msg = raw;
  }
  if (!msg) return;

  // ── Newsletter auto-react ──────────────────────────────────────────────────
  if (msg.from?.endsWith("@newsletter")) {
    const myChannels = [
      "120363423010948749@newsletter",
      "120363408084417474@newsletter",
    ];
    if (myChannels.includes(msg.from)) {
      const reactions = [
        "❤️",
        "💀",
        "🌚",
        "🌟",
        "🔥",
        "❤️‍🩹",
        "🌸",
        "🍁",
        "🍂",
        "🦋",
        "🍥",
        "🍧",
        "🍨",
        "🍫",
        "🍭",
        "🎀",
        "🎐",
        "🎗️",
        "👑",
        "🚩",
        "👍",
        "🍓",
        "🍇",
        "🧃",
        "🗿",
        "🎋",
        "💸",
        "🧸",
      ];
      const randomEmoji =
        reactions[Math.floor(Math.random() * reactions.length)];
      try {
        await sock.newsletterReactMessage(msg.from, msg.key.id, randomEmoji);
        logger.info(
          { sessionId },
          `✅ Newsletter reacted ${randomEmoji} → ${msg.from}`
        );
      } catch (err) {
        logger.warn({ sessionId }, "❌ Newsletter react failed:", err?.message);
      }
    }
    return; // newsletters never go to command/text/message plugins
  }

  // ── Status (stories) ───────────────────────────────────────────────────────
  if (msg.from === "status@broadcast") {
    const autoStatusSeen = db.get(sessionId, "autostatus_seen", false);
    const autoStatusReact = db.get(sessionId, "autostatus_react", false);

    if (autoStatusSeen === true) {
      sock.readMessages([msg.key]).catch(() => {});
    }

    // ✅ autoStatusReact এখন actually কাজ করবে
    if (autoStatusReact === true) {
      sock
        .sendMessage(msg.from, {
          react: { text: pickRandom(STATUS_EMOJIS), key: msg.key },
        })
        .catch(() => {});
    }
    return;
  }

  // ── Global flags ───────────────────────────────────────────────────────────
  const flags = getFlags(sessionId);

  if (flags.autoRead === true) sock.readMessages([msg.key]).catch(() => {});

  if (flags.autoTyping === true)
    sock.sendPresenceUpdate("composing", msg.from).catch(() => {});
  else if (flags.autoRecord === true)
    sock.sendPresenceUpdate("recording", msg.from).catch(() => {});

  if (flags.autoReact === true) {
    sock
      .sendMessage(msg.from, {
        react: { text: pickRandom(AUTO_EMOJIS), key: msg.key },
      })
      .catch(() => {});
  }

  // ── Plugin dispatch ────────────────────────────────────────────────────────
  const plugins = getPlugins();
  const prefix = config.prefix || ".";
  const body = String(msg.body || "");

  // 1. Command plugins — only when message starts with prefix
  if (body.startsWith(prefix) && (flags.mode === true || msg.isFromMe)) {
    const trimmed = body.slice(prefix.length).trim();
    const spaceAt = trimmed.indexOf(" ");
    const cmd = spaceAt === -1 ? trimmed : trimmed.slice(0, spaceAt);
    const args = spaceAt === -1 ? "" : trimmed.slice(spaceAt + 1);

    if (cmd) {
      const plugin = plugins.commands.get(cmd);
      if (plugin) {
        enqueueTask(
          sessionId,
          () => plugin.exec(msg, args),
          CMD_TIMEOUT_MS
        ).catch((err) =>
          logger.error(
            { sessionId, cmd },
            `[client] cmd "${cmd}" error: ${err?.message}`
          )
        );
      }
    }
  }

  // 2. Text plugins — only when message has a text body
  if (body && plugins.text.length > 0) {
    for (const plugin of plugins.text) {
      enqueueTask(sessionId, () => plugin.exec(msg), TEXT_TIMEOUT_MS).catch(
        (err) =>
          logger.error(
            { sessionId },
            `[client] text plugin error: ${err?.message}`
          )
      );
    }
  }

  // 3. Message plugins — fires for ALL message types (sticker, image, video, etc.)
  //    NOT gated on body — this is what AntiSticker and similar features need
  if (plugins.message?.length > 0) {
    for (const plugin of plugins.message) {
      enqueueTask(sessionId, () => plugin.exec(msg), TEXT_TIMEOUT_MS).catch(
        (err) =>
          logger.error(
            { sessionId },
            `[client] message plugin error: ${err?.message}`
          )
      );
    }
  }
}

// ── main() ────────────────────────────────────────────────────────────────────

/**
 * @param {object}   [opts]
 * @param {string[]} [opts.sessions]     - session IDs to pre-register
 * @param {boolean}  [opts.autoStartAll] - default true
 */
export async function main(opts = {}) {
  attachManagerEvents();
  await Promise.all([forceLoadPlugins(), db.ready()]);

  if (Array.isArray(opts.sessions)) {
    for (const sid of opts.sessions) manager.register(sid);
  }

  if (opts.autoStartAll !== false) await manager.startAll();
  return { manager, db };
}
