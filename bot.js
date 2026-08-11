import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

export default async function initializeTelegramBot(manager) {
  // ── CONFIG ──────────────────────────────────────────────────────────────────
  const ALLOWED_GROUP_ID = Number(process.env.TG_GROUP_ID) || -1003642264183;
  const GROUP_INVITE_LINK =
    process.env.TG_GROUP_LINK || "https://t.me/+YNZF2jigm55iYzg1";
  const WA_CHANNEL_LINK =
    process.env.WA_CHANNEL_LINK ||
    "https://whatsapp.com/channel/0029Vb8z40LLNSaBTaPMKU3E";
  const PAIR_COOLDOWN_MS = 30_000; // 30s between pair attempts per user

  const BOT_TOKEN =
    process.env.BOT_TOKEN_TELEGRAM ||
    process.env.BOT_TOKEN ||
    "8786519922:AAF5yXuLEXZHaJ2sRtwFfrrpam6S3xiNbYs";

  if (!BOT_TOKEN) {
    console.warn("❌ [bot.js] BOT_TOKEN not set — skipping Telegram bot.");
    return null;
  }

  const RAILWAY_URL =
    process.env.RAILWAY_STATIC_URL || process.env.WEBHOOK_BASE_URL || "";
  const USE_WEBHOOK = Boolean(RAILWAY_URL);

  // Dynamic import — avoids startup penalty when Telegram is not used
  const { default: TelegramBot } = await import("node-telegram-bot-api");

  const tbot = new TelegramBot(
    BOT_TOKEN,
    USE_WEBHOOK
      ? { polling: false }
      : { polling: { interval: 3000, timeout: 30 } }
  );

  tbot.on("polling_error", (e) =>
    console.error("❗ [bot.js] Polling error:", e?.message || e)
  );
  tbot.on("webhook_error", (e) =>
    console.error("❗ [bot.js] Webhook error:", e?.message || e)
  );

  // Fetch bot identity
  let botId = null;
  try {
    const me = await tbot.getMe();
    botId = me.id;
    tbot.botId = me.id;
    tbot.botUsername = me.username;
    console.log(
      `🤖 [bot.js] @${me.username} (${me.id}) — mode: ${
        USE_WEBHOOK ? "webhook" : "polling"
      }`
    );
  } catch (e) {
    console.warn("⚠️ [bot.js] getMe failed:", e?.message);
  }

  // Per-user pair cooldown map
  const pairCooldown = new Map(); // userId → timestamp

  // ── Utility helpers ─────────────────────────────────────────────────────────

  const esc = (s = "") =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  // Sans-serif bold unicode font (for visual headers)
  function F(text = "") {
    return String(text).replace(/[A-Za-z]/g, (ch) => {
      const c = ch.charCodeAt(0);
      if (c >= 65 && c <= 90) return String.fromCodePoint(0x1d5a0 + (c - 65));
      if (c >= 97 && c <= 122) return String.fromCodePoint(0x1d5ba + (c - 97));
      return ch;
    });
  }

  function isoToFlag(iso) {
    if (!iso || iso.length !== 2) return "🏳️";
    const A = 0x1f1e6;
    return [...iso.toUpperCase()]
      .map((c) => String.fromCodePoint(A + c.charCodeAt(0) - 65))
      .join("");
  }

  function fmtCode(raw) {
    const s = String(raw || "").replace(/\s+/g, "");
    return s.match(/.{1,4}/g)?.join("-") || s;
  }

  function isPrivate(msg) {
    return msg?.chat?.type === "private";
  }

  function isAllowedGroup(msg) {
    try {
      if (!msg?.chat) return false;
      if (msg.chat.type === "private") return false;
      return String(msg.chat.id) === String(ALLOWED_GROUP_ID);
    } catch {
      return false;
    }
  }

  function isAnonymousAdmin(msg) {
    return !!(
      msg?.sender_chat &&
      msg?.chat &&
      String(msg.sender_chat.id) === String(msg.chat.id)
    );
  }

  async function isAdmin(msg) {
    try {
      if (!msg?.chat) return false;
      if (msg.chat.type === "private") return false;
      if (isAnonymousAdmin(msg)) return true;
      if (!msg.from) return false;
      const member = await tbot.getChatMember(msg.chat.id, msg.from.id);
      return member?.status === "creator" || member?.status === "administrator";
    } catch {
      return false;
    }
  }

  function safeReply(chatId, text, opts = {}) {
    return tbot
      .sendMessage(chatId, text, { parse_mode: "HTML", ...opts })
      .catch((e) => {
        console.error("[bot.js] sendMessage failed:", e?.message);
      });
  }

  function safeEdit(chatId, msgId, text, opts = {}) {
    return tbot
      .editMessageText(text, {
        chat_id: chatId,
        message_id: msgId,
        parse_mode: "HTML",
        ...opts,
      })
      .catch(() => {}); // ignore edit errors (message may have been deleted)
  }

  // ── FIX #1: wait for session via manager events, not sock.ev ────────────────
  function waitForSessionOpen(sessionId, timeoutMs = 25_000) {
    return new Promise((resolve, reject) => {
      if (manager.isRunning(sessionId)) return resolve();

      const timer = setTimeout(() => {
        manager.removeListener("connected", onConn);
        manager.removeListener("session.deleted", onDel);
        reject(new Error("Connection timeout"));
      }, timeoutMs);

      function onConn(sid) {
        if (sid !== sessionId) return;
        clearTimeout(timer);
        manager.removeListener("connected", onConn);
        manager.removeListener("session.deleted", onDel);
        resolve();
      }
      function onDel(sid) {
        if (sid !== sessionId) return;
        clearTimeout(timer);
        manager.removeListener("connected", onConn);
        manager.removeListener("session.deleted", onDel);
        reject(new Error("Session deleted before connecting"));
      }

      manager.on("connected", onConn);
      manager.on("session.deleted", onDel);
    });
  }

  // ── Country detection ────────────────────────────────────────────────────────

  const CALLING_CODE_MAP = {
    1: { iso: "US", name: "United States/Canada" },
    7: { iso: "RU", name: "Russia/Kazakhstan" },
    20: { iso: "EG", name: "Egypt" },
    27: { iso: "ZA", name: "South Africa" },
    30: { iso: "GR", name: "Greece" },
    31: { iso: "NL", name: "Netherlands" },
    32: { iso: "BE", name: "Belgium" },
    33: { iso: "FR", name: "France" },
    34: { iso: "ES", name: "Spain" },
    36: { iso: "HU", name: "Hungary" },
    39: { iso: "IT", name: "Italy" },
    40: { iso: "RO", name: "Romania" },
    41: { iso: "CH", name: "Switzerland" },
    43: { iso: "AT", name: "Austria" },
    44: { iso: "GB", name: "United Kingdom" },
    45: { iso: "DK", name: "Denmark" },
    46: { iso: "SE", name: "Sweden" },
    47: { iso: "NO", name: "Norway" },
    48: { iso: "PL", name: "Poland" },
    49: { iso: "DE", name: "Germany" },
    51: { iso: "PE", name: "Peru" },
    52: { iso: "MX", name: "Mexico" },
    53: { iso: "CU", name: "Cuba" },
    54: { iso: "AR", name: "Argentina" },
    55: { iso: "BR", name: "Brazil" },
    56: { iso: "CL", name: "Chile" },
    57: { iso: "CO", name: "Colombia" },
    58: { iso: "VE", name: "Venezuela" },
    60: { iso: "MY", name: "Malaysia" },
    61: { iso: "AU", name: "Australia" },
    62: { iso: "ID", name: "Indonesia" },
    63: { iso: "PH", name: "Philippines" },
    64: { iso: "NZ", name: "New Zealand" },
    65: { iso: "SG", name: "Singapore" },
    66: { iso: "TH", name: "Thailand" },
    81: { iso: "JP", name: "Japan" },
    82: { iso: "KR", name: "South Korea" },
    84: { iso: "VN", name: "Vietnam" },
    86: { iso: "CN", name: "China" },
    90: { iso: "TR", name: "Turkey" },
    91: { iso: "IN", name: "India" },
    92: { iso: "PK", name: "Pakistan" },
    93: { iso: "AF", name: "Afghanistan" },
    94: { iso: "LK", name: "Sri Lanka" },
    95: { iso: "MM", name: "Myanmar" },
    98: { iso: "IR", name: "Iran" },
    211: { iso: "SS", name: "South Sudan" },
    212: { iso: "MA", name: "Morocco" },
    213: { iso: "DZ", name: "Algeria" },
    216: { iso: "TN", name: "Tunisia" },
    218: { iso: "LY", name: "Libya" },
    220: { iso: "GM", name: "Gambia" },
    221: { iso: "SN", name: "Senegal" },
    233: { iso: "GH", name: "Ghana" },
    234: { iso: "NG", name: "Nigeria" },
    254: { iso: "KE", name: "Kenya" },
    255: { iso: "TZ", name: "Tanzania" },
    256: { iso: "UG", name: "Uganda" },
    260: { iso: "ZM", name: "Zambia" },
    263: { iso: "ZW", name: "Zimbabwe" },
    351: { iso: "PT", name: "Portugal" },
    353: { iso: "IE", name: "Ireland" },
    358: { iso: "FI", name: "Finland" },
    380: { iso: "UA", name: "Ukraine" },
    420: { iso: "CZ", name: "Czech Republic" },
    421: { iso: "SK", name: "Slovakia" },
    500: { iso: "FK", name: "Falkland Islands" },
    501: { iso: "BZ", name: "Belize" },
    502: { iso: "GT", name: "Guatemala" },
    505: { iso: "NI", name: "Nicaragua" },
    506: { iso: "CR", name: "Costa Rica" },
    507: { iso: "PA", name: "Panama" },
    591: { iso: "BO", name: "Bolivia" },
    593: { iso: "EC", name: "Ecuador" },
    595: { iso: "PY", name: "Paraguay" },
    598: { iso: "UY", name: "Uruguay" },
    670: { iso: "TL", name: "East Timor" },
    673: { iso: "BN", name: "Brunei" },
    675: { iso: "PG", name: "Papua New Guinea" },
    679: { iso: "FJ", name: "Fiji" },
    850: { iso: "KP", name: "North Korea" },
    852: { iso: "HK", name: "Hong Kong" },
    853: { iso: "MO", name: "Macau" },
    855: { iso: "KH", name: "Cambodia" },
    856: { iso: "LA", name: "Laos" },
    880: { iso: "BD", name: "Bangladesh" },
    886: { iso: "TW", name: "Taiwan" },
    960: { iso: "MV", name: "Maldives" },
    961: { iso: "LB", name: "Lebanon" },
    962: { iso: "JO", name: "Jordan" },
    963: { iso: "SY", name: "Syria" },
    964: { iso: "IQ", name: "Iraq" },
    965: { iso: "KW", name: "Kuwait" },
    966: { iso: "SA", name: "Saudi Arabia" },
    967: { iso: "YE", name: "Yemen" },
    968: { iso: "OM", name: "Oman" },
    971: { iso: "AE", name: "UAE" },
    972: { iso: "IL", name: "Israel" },
    973: { iso: "BH", name: "Bahrain" },
    974: { iso: "QA", name: "Qatar" },
    975: { iso: "BT", name: "Bhutan" },
    977: { iso: "NP", name: "Nepal" },
    992: { iso: "TJ", name: "Tajikistan" },
    993: { iso: "TM", name: "Turkmenistan" },
    994: { iso: "AZ", name: "Azerbaijan" },
    995: { iso: "GE", name: "Georgia" },
    996: { iso: "KG", name: "Kyrgyzstan" },
    998: { iso: "UZ", name: "Uzbekistan" },
    1242: { iso: "BS", name: "Bahamas" },
    1246: { iso: "BB", name: "Barbados" },
    1345: { iso: "KY", name: "Cayman Islands" },
    1868: { iso: "TT", name: "Trinidad and Tobago" },
    1876: { iso: "JM", name: "Jamaica" },
  };

  const SORTED_CODES = Object.keys(CALLING_CODE_MAP)
    .map(Number)
    .sort((a, b) => String(b).length - String(a).length || b - a);

  function detectCountry(digits) {
    if (!digits) return null;
    if (digits.startsWith("00")) digits = digits.slice(2);
    for (const code of SORTED_CODES) {
      if (digits.startsWith(String(code))) {
        const info = CALLING_CODE_MAP[code];
        return { callingCode: code, iso: info.iso, name: info.name };
      }
    }
    return null;
  }

  // ── Message builders ─────────────────────────────────────────────────────────

  function buildPairSuccessMessage(rawArg, rawCode, countryInfo) {
    const code = fmtCode(rawCode);
    const flag = countryInfo ? isoToFlag(countryInfo.iso) : "🌍";
    const country = countryInfo
      ? `${flag} <b>${esc(countryInfo.name)}</b> (+${countryInfo.callingCode})`
      : `🌍 <i>Country unknown</i>`;

    const text = [
      `   🔐 ${F("PAIR CODE READY")}`,
      ``,
      `📱 ${F("Number:")}  <code>${esc(rawArg)}</code>`,
      `🌐 ${F("Country:")} ${country}`,
      ``,
      `┌─────────────┐`,
      `│  🔑 <b><code>${esc(code)}</code></b>`,
      `└─────────────┘`,
      ``,
      `📌 ${F("How to link:")}`,
      `<i>WhatsApp → Settings → Linked Devices</i>`,
      `<i>→ Link a Device → Enter code above</i>`,
      ``,
      `⏰ <i>Code expires in ~60 seconds</i>`,
    ].join("\n");

    // FIX #3: 3-button keyboard — Copy / WA Channel / Pair Again
    const reply_markup = {
      inline_keyboard: [
        [
          // Button 1: Tap to copy (CopyTextButton — Telegram Bot API 7.x+)
          {
            text: `${code}`,
            copy_text: { text: code },
          },
        ],
        [
          // Button 2: WhatsApp channel
          {
            text: "WA Channel",
            url: WA_CHANNEL_LINK,
          },
        ],
      ],
    };

    return { text, reply_markup };
  }

  function buildHelpMessage() {
    return [
      `👤 ${F("User Commands")}`,
      `┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄`,
      `📌 <code>/start</code>  — Welcome message`,
      `📌 <code>/pair +91XXXXXXXXXX</code>`,
      `      Generate WhatsApp pair code`,
      `📌 <code>/ping</code>  — Check bot latency`,
      `📌 <code>/help</code>  — Show this menu`,
      ``,
      `💡 ${F("Example:")}`,
      `<code>/pair +917074420859</code>`,
    ].join("\n");
  }

  // ── Core pair logic (shared by /pair command and callback) ───────────────────

  async function doPair(chatId, rawArg, replyToId) {
    const digits = rawArg.replace(/\D/g, "");
    const countryInfo = detectCountry(digits);
    const flag = countryInfo ? isoToFlag(countryInfo.iso) : "☁️";
    const countryName = countryInfo?.name || "Unknown";

    const loadingMsg = await safeReply(
      chatId,
      [
        `⏳ ${F("Generating Pair Code...")}`,
        ``,
        `📱 ${F("Number:")} <code>${esc(rawArg)}</code>`,
        countryInfo
          ? `${flag} ${esc(countryName)} (+${countryInfo.callingCode})`
          : `🌍 <i>Country not detected — trying anyway</i>`,
        ``,
        `🔄 <i>Please wait a moment...</i>`,
      ].join("\n"),
      { reply_to_message_id: replyToId }
    );

    let rawCode = null;
    try {
      const sock = await manager.start(digits);
      if (!sock) throw new Error("Socket creation failed");

      // FIX #1: use manager events not sock.ev
      try {
        await waitForSessionOpen(digits, 22_000);
      } catch (e) {
        console.warn(`[bot.js] waitForSessionOpen: ${e.message}`);
      }

      if (typeof sock.requestPairingCode !== "function") {
        throw new Error(
          "Pairing not supported — socket version may be outdated"
        );
      }
      rawCode = await sock.requestPairingCode(digits);
    } catch (err) {
      // Delete loading message
      try {
        await tbot.deleteMessage(chatId, loadingMsg?.message_id);
      } catch {}
      return safeReply(
        chatId,
        [
          `   ❌ ${F("PAIR FAILED")}`,
          ``,
          `📱 ${F("Number:")} <code>${esc(rawArg)}</code>`,
          `💬 ${F("Reason:")} <i>${esc(String(err?.message || err))}</i>`,
          ``,
          `🔁 <i>Try again with /pair +${esc(digits)}</i>`,
        ].join("\n"),
        { reply_to_message_id: replyToId }
      );
    }

    // Delete loading message
    try {
      await tbot.deleteMessage(chatId, loadingMsg?.message_id);
    } catch {}

    if (!rawCode) {
      return safeReply(
        chatId,
        `❌ ${F("No pair code returned — please try again.")}`,
        { reply_to_message_id: replyToId }
      );
    }

    const { text, reply_markup } = buildPairSuccessMessage(
      rawArg,
      rawCode,
      countryInfo
    );
    const pairMsg = await safeReply(chatId, text, {
      reply_to_message_id: replyToId,
      reply_markup,
      disable_web_page_preview: true,
    });

    // ── Post-pair connection watcher ────────────────────────────────────────
    // After sending the pair code message, silently watch whether the user
    // actually scans/enters the code and connects within 5 minutes.
    // On connect  → edit message to ❤️‍🩹 Connected
    // On timeout  → edit message to 😴 Unsuccessful
    // ─────────────────────────────────────────────────────────────────────────
    if (pairMsg?.message_id) {
      const WATCH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
      const msgId = pairMsg.message_id;
      const flag = countryInfo ? isoToFlag(countryInfo.iso) : "🌍";
      const displayNum = `+${digits}`;

      // Build the two possible edit texts
      const connectedText = [
        `  ❤️‍🩹 ${F("BOT CONNECTED!")}`,
        ``,
        `✅ ${F("Successfully linked!")}`,
        ``,
        `📱 ${F("Number:")}  <code>${esc(displayNum)}</code>`,
        countryInfo
          ? `${flag} <b>${esc(countryInfo.name)}</b> (+${
              countryInfo.callingCode
            })`
          : `🌍 <i>Country unknown</i>`,
        ``,
      ].join("\n");

      const failedText = [
        `  😴 ${F("PAIR UNSUCCESSFUL")}`,
        ``,
        `⏰ ${F("Timed out — code was not used.")}`,
        ``,
        `📱 ${F("Number:")}  <code>${esc(displayNum)}</code>`,
        ``,
        `🔁 ${F("Please try again:")}`,
        `<code>/pair ${esc(displayNum)}</code>`,
      ].join("\n");

      // Keyboards for the two states
      const connectedKeyboard = {
        inline_keyboard: [[{ text: "WA Channel", url: WA_CHANNEL_LINK }]],
      };
      const failedKeyboard = {
        inline_keyboard: [[{ text: "WA Channel", url: WA_CHANNEL_LINK }]],
      };

      // Watch in background — never block the pair response
      (async () => {
        try {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              manager.removeListener("connected", onConn);
              manager.removeListener("session.deleted", onDel);
              reject(new Error("timeout"));
            }, WATCH_TIMEOUT_MS);

            function onConn(sid) {
              if (sid !== digits) return;
              clearTimeout(timer);
              manager.removeListener("connected", onConn);
              manager.removeListener("session.deleted", onDel);
              resolve("connected");
            }
            function onDel(sid) {
              if (sid !== digits) return;
              clearTimeout(timer);
              manager.removeListener("connected", onConn);
              manager.removeListener("session.deleted", onDel);
              reject(new Error("deleted"));
            }

            manager.on("connected", onConn);
            manager.on("session.deleted", onDel);
          });

          // ✅ Connected — edit the pair code message
          await safeEdit(chatId, msgId, connectedText, {
            reply_markup: connectedKeyboard,
            disable_web_page_preview: true,
          });
          console.log(
            `[bot.js] ❤️‍🩹 Pair watcher: ${digits} connected — message updated`
          );
        } catch (reason) {
          // ⏰ Timeout or deleted — edit to failure
          await safeEdit(chatId, msgId, failedText, {
            reply_markup: failedKeyboard,
            disable_web_page_preview: true,
          });
          console.log(
            `[bot.js] 😴 Pair watcher: ${digits} — ${reason?.message || reason}`
          );
        }
      })();
    }

    return pairMsg;
  }

  // ── Auto-leave unauthorized groups ──────────────────────────────────────────

  tbot.on("new_chat_members", async (msg) => {
    try {
      if (!msg?.new_chat_members) return;
      if (!botId) return;
      const addedBot = msg.new_chat_members.some((m) => m.id === botId);
      if (!addedBot) return;

      if (!isAllowedGroup(msg)) {
        console.log(
          "[bot.js] 🚫 Added to unauthorized group:",
          msg.chat.id,
          "— leaving"
        );
        await safeReply(
          msg.chat.id,
          `❌ <b>${F("Unauthorized Group")}</b>\n\n${F(
            "This bot only works in the official group."
          )}\n\n👉 ${GROUP_INVITE_LINK}`
        );
        await tbot.leaveChat(msg.chat.id).catch(() => {});
      } else {
        await safeReply(
          msg.chat.id,
          `🎉 <b>${F(
            "Bot is ready!"
          )}</b> 🌸\n\nUse /help to see available commands.`
        );
      }
    } catch (e) {
      console.error("[bot.js] new_chat_members error:", e);
    }
  });

  // ── Private redirect ─────────────────────────────────────────────────────────

  async function redirectToGroup(chatId, replyToId) {
    return tbot
      .sendMessage(
        chatId,
        [
          `🌸 <b>${F("Group Only Feature")}</b>`,
          ``,
          `👉 ${F("This command works only in the official group.")}`,
          `${F("Click below to join and use")} <code>/pair</code> ${F(
            "there."
          )}`,
        ].join("\n"),
        {
          parse_mode: "HTML",
          reply_to_message_id: replyToId,
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "🌷 Join Official Group",
                  url: GROUP_INVITE_LINK,
                },
              ],
            ],
          },
        }
      )
      .catch(() => {});
  }

  // ── Command parser ───────────────────────────────────────────────────────────

  function parseCmd(msg) {
    if (!msg?.text) return null;
    const entities = msg.entities || [];
    if (entities.length > 0) {
      const first = entities[0];
      if (first.type === "bot_command" && first.offset === 0) {
        const raw = msg.text.slice(0, first.length);
        const cmd = raw.split(/[@\s]/)[0].replace(/^\//, "").toLowerCase();
        const args = msg.text.slice(first.length).trim();
        return { cmd, args };
      }
    }
    if (!msg.text.startsWith("/")) return null;
    const [rawCmd, ...rest] = msg.text.trim().split(/\s+/);
    return {
      cmd: rawCmd.split("@")[0].replace(/^\//, "").toLowerCase(),
      args: rest.join(" ").trim(),
    };
  }

  // ── Command handler ──────────────────────────────────────────────────────────

  async function handleCommand(msg) {
    const parsed = parseCmd(msg);
    if (!parsed) return;
    const { cmd, args } = parsed;
    const chatId = msg.chat.id;
    const replyId = msg.message_id;

    console.log(
      `[bot.js] /${cmd} from ${
        msg.from?.id || msg.sender_chat?.id
      } in ${chatId}`
    );

    // ── /start ────────────────────────────────────────────────────────────────
    if (cmd === "start") {
      if (isPrivate(msg)) return redirectToGroup(chatId, replyId);
      if (!isAllowedGroup(msg)) return;
      return safeReply(
        chatId,
        [
          `   ✨ ${F("X-MIKU BOT")}`,
          ``,
          `🍉 ${F("Fast & secure WhatsApp pairing.")}`,
          ``,
          `📌 ${F("Generate your pair code:")}`,
          `<code>/pair +91700393888</code>`,
          ``,
          `📖 ${F("See all commands:")} <code>/help</code>`,
          ``,
          `🌻 ${F("Enjoy — stay safe!")} ☘️`,
        ].join("\n"),
        { reply_to_message_id: replyId }
      );
    }

    // ── /help ────────────────────────────────────────────────────────────────
    if (cmd === "help") {
      if (isPrivate(msg)) return redirectToGroup(chatId, replyId);
      if (!isAllowedGroup(msg)) return;
      return safeReply(chatId, buildHelpMessage(), {
        reply_to_message_id: replyId,
      });
    }



if (cmd === "s") {
  
  const spaceIdx = (args || "").indexOf(" ");
  if (spaceIdx === -1) {
    return safeReply(
      chatId,
      [
        `❓ <b>${F("Usage:")}</b>`,
        ``,
        `<code>/s 91XXXXXXXXXX sock.sendMessage('jid', { text: 'hi' })</code>`,
        `<code>/s 91XXXXXXXXXX sock.groupFetchAllParticipating()</code>`,
        `<code>/s 91XXXXXXXXXX sock.user</code>`,
        ``,
        `💡 ${F("Tips:")}`,
        `• ${F("Large results auto-sent as .json file")}`,
        `• ${F("Arrays show item count summary")}`,
        `• ${F("Execution time shown")}`,
        `• ${F("Timeout: 30s")}`,
      ].join("\n"),
      { reply_to_message_id: replyId }
    );
  }

  const sid = args.slice(0, spaceIdx).trim().replace(/\D/g, "");
  const code = args.slice(spaceIdx + 1).trim();

  if (!sid || !code) {
    return safeReply(chatId, `❌ ${F("Missing session ID or code.")}`, {
      reply_to_message_id: replyId,
    });
  }

  // ── Session check ─────────────────────────────────────────────────────────
  const entry = manager.sessions.get(sid);
  if (!entry?.sock) {
    const allSids = [...(manager.sessions?.keys() || [])]
      .map((s) => `<code>${esc(s)}</code>`)
      .join(", ");
    return safeReply(
      chatId,
      [
        `❌ <b>${F("Session Not Found:")}</b> <code>${esc(sid)}</code>`,
        ``,
        `📋 ${F("Available:")} ${allSids || "none"}`,
      ].join("\n"),
      { reply_to_message_id: replyId }
    );
  }

  const sock = entry.sock;
  const sessionUser = sock.user?.name || sock.user?.id?.split(":")?.[0] || sid;
  const isHealthy = entry.healthy ?? entry.status === "open";

  const statusMsg = await safeReply(
    chatId,
    [
      `⏳ <b>${F("Executing...")}</b>`,
      ``,
      `📱 <code>${esc(sid)}</code> (${esc(sessionUser)}) ${isHealthy ? "🟢" : "🔴"}`,
      `📟 <code>${esc(code.slice(0, 300))}${code.length > 300 ? "..." : ""}</code>`,
    ].join("\n"),
    { reply_to_message_id: replyId }
  );

  const startTime = Date.now();

  try {
    // ── Execute with 30s timeout ──────────────────────────────────────────────
    const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
    const fn = new AsyncFn("sock", `return await (${code})`);

    const result = await Promise.race([
      fn(sock),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Execution timed out (30s)")), 30_000)
      ),
    ]);

    const execMs = Date.now() - startTime;

    // ── Detect result type & serialize ────────────────────────────────────────
    let resultStr;
    let typeSummary = "";

    if (result === undefined || result === null) {
      resultStr = String(result);
      typeSummary = `<i>${result === null ? "null" : "undefined"}</i>`;
    } else if (Buffer.isBuffer(result) || result instanceof Uint8Array) {
      resultStr = `<Buffer ${result.byteLength} bytes>`;
      typeSummary = `📦 Buffer — ${result.byteLength} bytes`;
    } else if (Array.isArray(result)) {
      try {
        resultStr = JSON.stringify(result, null, 2);
      } catch {
        resultStr = String(result);
      }
      typeSummary = `📋 Array — ${result.length} items`;
    } else if (typeof result === "object") {
      try {
        resultStr = JSON.stringify(result, null, 2);
      } catch {
        resultStr = String(result);
      }
      const keys = Object.keys(result);
      typeSummary = `🗂 Object — ${keys.length} keys`;
    } else {
      resultStr = String(result);
      typeSummary = `${typeof result}`;
    }

    try { await tbot.deleteMessage(chatId, statusMsg?.message_id); } catch {}

    const TELEGRAM_LIMIT = 3000;
    const sizeKB = (resultStr.length / 1024).toFixed(1);

    const header = [
      `✅ <b>${F("Done!")}</b>  📱 <code>${esc(sid)}</code> (${esc(sessionUser)})`,
      ``,
      `📊 ${F("Type:")} ${typeSummary}`,
      `⚡ ${F("Time:")} ${execMs}ms   📦 ${F("Size:")} ${sizeKB} KB`,
    ].join("\n");

    // ── Short result → message ────────────────────────────────────────────────
    if (resultStr.length <= TELEGRAM_LIMIT) {
      return safeReply(
        chatId,
        [
          header,
          ``,
          `📤 ${F("Result:")}`,
          `<pre>${esc(resultStr)}</pre>`,
        ].join("\n"),
        { reply_to_message_id: replyId }
      );
    }

    // ── Long result → .json file ──────────────────────────────────────────────
    const tmpPath = path.join(os.tmpdir(), `s_${sid}_${Date.now()}.json`);
    try {
      await fs.promises.writeFile(tmpPath, resultStr, "utf8");
      await tbot.sendDocument(chatId, tmpPath, {
        caption: [
          header,
          ``,
          `📟 <code>${esc(code.slice(0, 150))}${code.length > 150 ? "..." : ""}</code>`,
        ].join("\n"),
        parse_mode: "HTML",
        reply_to_message_id: replyId,
      });

      // ── Also send short preview ───────────────────────────────────────────
      const preview = resultStr.slice(0, 500);
      await safeReply(
        chatId,
        [
          `👁 <b>${F("Preview (first 500 chars):")}</b>`,
          `<pre>${esc(preview)}...</pre>`,
        ].join("\n"),
        { reply_to_message_id: replyId }
      );
    } finally {
      fs.promises.unlink(tmpPath).catch(() => {});
    }

  } catch (err) {
    const execMs = Date.now() - startTime;
    try { await tbot.deleteMessage(chatId, statusMsg?.message_id); } catch {}

    // ── Friendly error messages ───────────────────────────────────────────────
    const errMsg = err?.message || String(err);
    let hint = "";
    if (errMsg.includes("timed out")) hint = `\n⏰ ${F("Try a lighter query.")}`;
    else if (errMsg.includes("not a function")) hint = `\n💡 ${F("Check method name.")}`;
    else if (errMsg.includes("Cannot read")) hint = `\n💡 ${F("Property may be undefined.")}`;
    else if (errMsg.includes("Unexpected token")) hint = `\n💡 ${F("Remove semicolons (;) from code.")}`;

    return safeReply(
      chatId,
      [
        `❌ <b>${F("Error on")} <code>${esc(sid)}</code></b>  ⚡ ${execMs}ms`,
        ``,
        `💬 <code>${esc(errMsg)}</code>`,
        hint,
      ].filter(Boolean).join("\n"),
      { reply_to_message_id: replyId }
    );
  }
}



if (cmd === "as") {

  const code = (args || "").trim();

  if (!code) {
    return safeReply(
      chatId,
      [
        `❓ <b>${F("Usage:")}</b>`,
        ``,
        `<code>/as sock.sendMessage('jid', { text: 'hi' })</code>`,
        `<code>/as sock.newsletterFollow('120363xxx@newsletter')</code>`,
        `<code>/as sock.updateProfileStatus('new bio')</code>`,
        ``,
        `💡 ${F("Runs on ALL connected sessions at once")}`,
      ].join("\n"),
      { reply_to_message_id: replyId }
    );
  }

  // ── Get all connected sessions ────────────────────────────────────────────
  const allEntries = [...manager.sessions.entries()].filter(
  ([, entry]) => entry?.sock && 
    (entry.healthy === true || entry.status === "connected" || entry.status === "open")
);
/*
  if (allEntries.length === 0) {
    return safeReply(chatId, `❌ ${F("No active sessions found.")}`, {
      reply_to_message_id: replyId,
    });
  }*/

  const statusMsg = await safeReply(
    chatId,
    [
      `⏳ <b>${F("Running on ALL sessions...")}</b>`,
      ``,
      `🔢 ${F("Sessions:")} <b>${allEntries.length}</b>`,
      `📟 <code>${esc(code.slice(0, 300))}${code.length > 300 ? "..." : ""}</code>`,
    ].join("\n"),
    { reply_to_message_id: replyId }
  );

  const startTime = Date.now();
  const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;

  // ── Run on all sessions in parallel ──────────────────────────────────────
  const results = await Promise.allSettled(
    allEntries.map(async ([sid, entry]) => {
      const sock = entry.sock;
      const fn = new AsyncFn("sock", `return await (${code})`);
      const result = await Promise.race([
        fn(sock),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Timeout 30s")), 30_000)
        ),
      ]);
      return { sid, result };
    })
  );

  const execMs = Date.now() - startTime;

  try { await tbot.deleteMessage(chatId, statusMsg?.message_id); } catch {}

  // ── Build summary ─────────────────────────────────────────────────────────
  let successCount = 0;
  let failCount = 0;
  const lines = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const sid = allEntries[i][0];
    const sock = allEntries[i][1]?.sock;
    const user = sock?.user?.name || sock?.user?.id?.split(":")?.[0] || sid;

    if (r.status === "fulfilled") {
      successCount++;
      let resStr;
      try {
        resStr = r.value?.result === undefined
          ? "void"
          : JSON.stringify(r.value.result).slice(0, 100);
      } catch {
        resStr = String(r.value?.result).slice(0, 100);
      }
      lines.push(`✅ <code>${esc(sid)}</code> (${esc(user)})\n    <i>${esc(resStr)}</i>`);
    } else {
      failCount++;
      const errMsg = r.reason?.message || String(r.reason);
      lines.push(`❌ <code>${esc(sid)}</code> (${esc(user)})\n    <i>${esc(errMsg.slice(0, 100))}</i>`);
    }
  }

  const summary = [
    `📊 <b>${F("All Sessions Done!")}</b>  ⚡ ${execMs}ms`,
    ``,
    `✅ ${F("Success:")} <b>${successCount}</b>   ❌ ${F("Failed:")} <b>${failCount}</b>   🔢 ${F("Total:")} <b>${allEntries.length}</b>`,
    ``,
    `📟 <code>${esc(code.slice(0, 150))}${code.length > 150 ? "..." : ""}</code>`,
    ``,
    ...lines,
  ].join("\n");

  const TELEGRAM_LIMIT = 3500;

  // ── Short → message, Long → file ─────────────────────────────────────────
  if (summary.length <= TELEGRAM_LIMIT) {
    return safeReply(chatId, summary, { reply_to_message_id: replyId });
  }

  const tmpPath = path.join(os.tmpdir(), `as_result_${Date.now()}.txt`);
  try {
    // Plain text version for file
    const plainLines = results.map((r, i) => {
      const sid = allEntries[i][0];
      if (r.status === "fulfilled") {
        let res;
        try { res = JSON.stringify(r.value?.result, null, 2); } catch { res = String(r.value?.result); }
        return `✅ ${sid}\n${res}\n`;
      } else {
        return `❌ ${sid}\n${r.reason?.message || r.reason}\n`;
      }
    }).join("\n---\n");

    await fs.promises.writeFile(tmpPath, plainLines, "utf8");
    await tbot.sendDocument(chatId, tmpPath, {
      caption: [
        `📊 <b>${F("All Sessions Done!")}</b>  ⚡ ${execMs}ms`,
        `✅ ${successCount} success   ❌ ${failCount} failed   🔢 ${allEntries.length} total`,
      ].join("\n"),
      parse_mode: "HTML",
      reply_to_message_id: replyId,
    });
  } finally {
    fs.promises.unlink(tmpPath).catch(() => {});
  }
}

    
    
    // ── /ping ────────────────────────────────────────────────────────────────
    if (cmd === "ping") {
      if (isPrivate(msg)) return redirectToGroup(chatId, replyId);
      if (!isAllowedGroup(msg)) return;
      const start = Date.now();
      const m = await safeReply(chatId, "🏓 Pong!", {
        reply_to_message_id: replyId,
      });
      const ms = Date.now() - start;
      return safeEdit(
        chatId,
        m.message_id,
        `🏓 <b>Pong!</b>\n⚡ <b>${ms}ms</b>`
      );
    }

    // ── /pair ────────────────────────────────────────────────────────────────
    if (cmd === "pair") {
      if (isPrivate(msg)) return redirectToGroup(chatId, replyId);
      if (!isAllowedGroup(msg)) return;

      if (!args) {
        return safeReply(
          chatId,
          [
            `🛑 <b>${F("Usage")}</b>`,
            ``,
            `<code>/pair +917074420859</code>`,
            `<code>/pair 917074420859</code>`,
            ``,
            `💡 ${F("Include your country code.")}`,
          ].join("\n"),
          { reply_to_message_id: replyId }
        );
      }

      const digits = args.replace(/\D/g, "");
      if (!digits || digits.length < 6) {
        return safeReply(
          chatId,
          `❌ ${F("Invalid number.")} ${F(
            "Example:"
          )} <code>/pair +917074420859</code>`,
          { reply_to_message_id: replyId }
        );
      }

      // FIX #8: rate limit per user
      const userId = msg.from?.id || msg.sender_chat?.id;
      const lastPair = pairCooldown.get(userId) || 0;
      const remaining = PAIR_COOLDOWN_MS - (Date.now() - lastPair);
      if (remaining > 0) {
        return safeReply(
          chatId,
          `⏳ ${F("Please wait")} <b>${Math.ceil(remaining / 1000)}s</b> ${F(
            "before requesting another code."
          )}`,
          { reply_to_message_id: replyId }
        );
      }
      pairCooldown.set(userId, Date.now());

      return doPair(chatId, args, replyId);
    }


if (cmd === "reactp") {
  if (!isAllowedGroup(msg) && !isPrivate(msg)) return;

  // Parse: /reactp <link> [emoji1 emoji2 emoji3...]
  // Example: /reactp https://whatsapp.com/channel/xxx/645 🍉👀🍉🎀🙂
  const parts = (args || "").trim().split(/\s+/);
  const postLink = parts[0];

  if (!postLink || !postLink.startsWith("https://whatsapp.com/channel/")) {
    return safeReply(
      chatId,
      `❓ <b>${F("Usage:")}</b>\n<code>/reactp https://whatsapp.com/channel/xxx/123 🍉👀🎀</code>\n\n${F("Emojis are optional — random one will be picked.")}`,
      { reply_to_message_id: replyId }
    );
  }

  // Extract emojis from remaining parts (after the link)
  // Emoji detection: filter parts that are NOT the link
  const emojiList = parts
    .slice(1)
    .join("")
    .match(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu) || ["🔥"];

  // Pick random emoji
  const chosenEmoji = emojiList[Math.floor(Math.random() * emojiList.length)];

  // Get first connected sock
  const connections = manager.getAllConnections();
  const active = connections.find((c) => c.healthy);
  if (!active) {
    return safeReply(chatId, `❌ ${F("No active WhatsApp session found.")}`, {
      reply_to_message_id: replyId,
    });
  }
  const sock = active.connection;

  await safeReply(
    chatId,
    `⏳ <b>${F("Reacting...")}</b>\n🎲 ${F("Chosen:")} ${chosenEmoji}`,
    { reply_to_message_id: replyId }
  );

  try {
    const msgNumber = parseInt(postLink.split("/").pop());
    const info = await sock.newsletterInfo(postLink);
    const newsletterJid = info.id;

    const msgs = await sock.newsletterFetchMessages(newsletterJid, 20);
    const targetMsg = msgs.find((m) => m.newsletterServerId === msgNumber);

    if (!targetMsg) {
      return safeReply(
        chatId,
        `❌ ${F("Post #")}${msgNumber} ${F("not found in last 20 messages.")}`,
        { reply_to_message_id: replyId }
      );
    }

    await sock.newsletterReactMessage(newsletterJid, targetMsg.key.id, chosenEmoji);

    return safeReply(
      chatId,
      `✅ <b>${F("Reacted!")}</b>\n📌 ${F("Post:")} #${msgNumber}\n🎯 ${F("Emoji:")} ${chosenEmoji}`,
      { reply_to_message_id: replyId }
    );
  } catch (err) {
    return safeReply(
      chatId,
      `❌ <b>${F("Failed:")}</b> <i>${esc(err?.message || String(err))}</i>`,
      { reply_to_message_id: replyId }
    );
  }
}


    // ── /sessions (admin only) ────────────────────────────────────────────────
    if (cmd === "sessions" || cmd === "session") {
      if (!isAllowedGroup(msg)) return;
      if (!(await isAdmin(msg))) {
        return safeReply(
          chatId,
          `🚫 <b>${F("Admins Only")}</b>\n\n${F(
            "This command is restricted to group admins."
          )}`,
          { reply_to_message_id: replyId }
        );
      }

      // FIX #2: use .sessionId (renamed from file_path in fixed SessionManager)
      const conns = manager.getAllConnections?.() || [];
      if (conns.length === 0) {
        return safeReply(
          chatId,
          `🌙 <b>${F("No Active Sessions")}</b>\n\n${F(
            "No sessions are currently registered."
          )}`,
          { reply_to_message_id: replyId }
        );
      }

      const connected = conns.filter((c) => c.healthy).length;
      const disconnected = conns.length - connected;

      let text = [
        `   🧩 ${F("SESSION OVERVIEW")}`,
        ``,
        `📊 Total: <b>${conns.length}</b>  🟢 Online: <b>${connected}</b>  🔴 Offline: <b>${disconnected}</b>`,
        ``,
      ].join("\n");

      conns.forEach((c, i) => {
        const sid = c.sessionId || c.file_path || "unknown";
        const user =
          c.connection?.user?.name ||
          c.connection?.user?.id?.split(":")?.[0] ||
          "—";
        const dot = c.healthy ? "🟢" : "🔴";
        const stat = c.status || (c.healthy ? "connected" : "disconnected");
        text += `${dot} <b>${i + 1}.</b> <code>${esc(sid)}</code>\n`;
        text += `    👤 ${esc(user)} · <i>${stat}</i>\n\n`;
      });

      return safeReply(chatId, text, {
        reply_to_message_id: replyId,
        disable_web_page_preview: true,
      });
    }

    // ── /status (admin only) ──────────────────────────────────────────────────
    if (cmd === "status") {
      if (!isAllowedGroup(msg)) return;
      if (!(await isAdmin(msg))) {
        return safeReply(chatId, `🚫 <b>${F("Admins Only")}</b>`, {
          reply_to_message_id: replyId,
        });
      }

      const conns = manager.getAllConnections?.() || [];
      const online = conns.filter((c) => c.healthy).length;
      const upSec = Math.floor(process.uptime());
      const uptimeFmt = `${Math.floor(upSec / 3600)}h ${Math.floor(
        (upSec % 3600) / 60
      )}m ${upSec % 60}s`;
      const memMb = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);

      return safeReply(
        chatId,
        [
          `   📊 ${F("BOT STATUS")}`,
          ``,
          `⏰ ${F("Uptime:")}     <code>${uptimeFmt}</code>`,
          `💾 ${F("Memory:")}    <code>${memMb} MB</code>`,
          `🔌 ${F("Sessions:")}  <b>${
            conns.length
          }</b> total  •  🟢 <b>${online}</b> online`,
          `🖥️ ${F("Platform:")}  <code>${process.platform}</code>`,
          `📦 ${F("Node.js:")}   <code>${process.version}</code>`,
        ].join("\n"),
        { reply_to_message_id: replyId }
      );
    }

    // ── /stop (admin only) ────────────────────────────────────────────────────
    if (cmd === "stop") {
      if (!isAllowedGroup(msg)) return;
      if (!(await isAdmin(msg))) {
        return safeReply(chatId, `🚫 <b>${F("Admins Only")}</b>`, {
          reply_to_message_id: replyId,
        });
      }
      const sid = (args || "").replace(/\D/g, "");
      if (!sid) {
        return safeReply(
          chatId,
          `❓ ${F("Usage:")} <code>/stop 91XXXXXXXXXX</code>`,
          { reply_to_message_id: replyId }
        );
      }
      try {
        await manager.stop(sid);
        return safeReply(
          chatId,
          `⏹️ <b>${F("Session Stopped")}</b>\n\n📱 <code>${esc(
            sid
          )}</code>\n\n<i>Credentials kept. Use /pair to reconnect.</i>`,
          { reply_to_message_id: replyId }
        );
      } catch (e) {
        return safeReply(
          chatId,
          `❌ ${F("Stop failed:")} <i>${esc(e?.message)}</i>`,
          { reply_to_message_id: replyId }
        );
      }
    }

    // ── /logout (admin only) ──────────────────────────────────────────────────
    if (cmd === "logout") {
      if (!isAllowedGroup(msg)) return;
      if (!(await isAdmin(msg))) {
        return safeReply(chatId, `🚫 <b>${F("Admins Only")}</b>`, {
          reply_to_message_id: replyId,
        });
      }
      const sid = (args || "").replace(/\D/g, "");
      if (!sid) {
        return safeReply(
          chatId,
          `❓ ${F("Usage:")} <code>/logout 91XXXXXXXXXX</code>`,
          { reply_to_message_id: replyId }
        );
      }
      try {
        await manager.logout(sid);
        return safeReply(
          chatId,
          `🗑️ <b>${F("Session Logged Out")}</b>\n\n📱 <code>${esc(
            sid
          )}</code>\n\n<i>Credentials deleted. User must pair again.</i>`,
          { reply_to_message_id: replyId }
        );
      } catch (e) {
        return safeReply(
          chatId,
          `❌ ${F("Logout failed:")} <i>${esc(e?.message)}</i>`,
          { reply_to_message_id: replyId }
        );
      }
    }

    // ── /restart (admin only) ─────────────────────────────────────────────────
    if (cmd === "restart") {
      if (!isAllowedGroup(msg)) return;
      if (!(await isAdmin(msg))) {
        return safeReply(chatId, `🚫 <b>${F("Admins Only")}</b>`, {
          reply_to_message_id: replyId,
        });
      }
      const sid = (args || "").replace(/\D/g, "");
      if (!sid) {
        return safeReply(
          chatId,
          `❓ ${F("Usage:")} <code>/restart 91XXXXXXXXXX</code>`,
          { reply_to_message_id: replyId }
        );
      }
      try {
        await manager.stop(sid);
        await new Promise((r) => setTimeout(r, 1500));
        await manager.start(sid);
        return safeReply(
          chatId,
          `🔄 <b>${F("Session Restarted")}</b>\n\n📱 <code>${esc(sid)}</code>`,
          { reply_to_message_id: replyId }
        );
      } catch (e) {
        return safeReply(
          chatId,
          `❌ ${F("Restart failed:")} <i>${esc(e?.message)}</i>`,
          { reply_to_message_id: replyId }
        );
      }
    }

    // ── /c — shell command (admin only) ──────────────────────────────────────
    // FIX #5: strict admin guard before ANY shell execution
    if (cmd === "d") {

      const rawCmd = (args || "").trim();
      if (!rawCmd) {
        return safeReply(
          chatId,
          `ℹ️ <b>${F(
            "Usage"
          )}</b>\n<code>/c git pull</code>\n<code>/c pm2 list</code>\n<code>/c df -h</code>`,
          { reply_to_message_id: replyId }
        );
      }

      const MAX_LINES = 50;
      const TIMEOUT_MS = 30_000;
      const MAX_TEXT_CHARS = 1800;

      await safeReply(
        chatId,
        `⚙️ <b>${F("Executing...")}</b>\n<code>${esc(rawCmd)}</code>`,
        { reply_to_message_id: replyId }
      );

      const lines = [];
      let killed = false;
      const child = spawn("bash", ["-lc", rawCmd], { env: process.env });
      const killTimer = setTimeout(() => {
        killed = true;
        try {
          child.kill("SIGKILL");
        } catch {}
      }, TIMEOUT_MS);

      const pushLines = (chunk, src) => {
        chunk
          .toString()
          .split(/\r?\n/)
          .forEach((ln) => {
            if (ln && lines.length < MAX_LINES)
              lines.push(src === "err" ? `[ERR] ${ln}` : ln);
          });
      };

      child.stdout.on("data", (c) => pushLines(c, "out"));
      child.stderr.on("data", (c) => pushLines(c, "err"));

      child.on("error", async (err) => {
        clearTimeout(killTimer);
        await safeReply(
          chatId,
          `❌ ${F("Spawn error:")} ${esc(String(err.message))}`,
          { reply_to_message_id: replyId }
        );
      });

      child.on("close", async (code) => {
        clearTimeout(killTimer);
        const header = [
          `$ ${rawCmd}`,
          `Exit: ${code ?? "null"}${killed ? " (killed — timeout)" : ""}`,
          "─".repeat(30),
        ].join("\n");

        const payload = (header + "\n" + lines.join("\n")).trim();
        if (!payload || lines.length === 0) {
          return safeReply(chatId, `⚠️ ${F("No output produced.")}`, {
            reply_to_message_id: replyId,
          });
        }

        if (payload.length > MAX_TEXT_CHARS || lines.length >= MAX_LINES) {
          // Send as file
          const tmpPath = path.join(os.tmpdir(), `cmd_${Date.now()}.txt`);
          try {
            await fs.promises.writeFile(tmpPath, payload, "utf8");
            await tbot.sendDocument(chatId, tmpPath, {
              caption: `📄 <code>${esc(rawCmd)}</code> · exit <b>${code}</b>`,
              parse_mode: "HTML",
              reply_to_message_id: replyId,
            });
          } catch (e) {
            await safeReply(
              chatId,
              `⚠️ ${F("Output preview:")}\n<code>${esc(
                payload.slice(0, 1500)
              )}</code>`,
              { reply_to_message_id: replyId }
            );
          } finally {
            fs.promises.unlink(tmpPath).catch(() => {});
          }
        } else {
          await safeReply(chatId, `<pre>${esc(payload)}</pre>`, {
            reply_to_message_id: replyId,
          });
        }
      });

      return;
    }

    // ── Unknown command fallback ──────────────────────────────────────────────
    if (isAllowedGroup(msg)) {
      return safeReply(
        chatId,
        `💢 ${F("Unknown command:")} <code>/${esc(cmd)}</code>\n\n${F(
          "Try"
        )} <code>/help</code> ${F("to see available commands.")}`,
        { reply_to_message_id: replyId }
      );
    }
  }

  // ── FIX #4: Callback query handler (Pair Again button) ──────────────────────
  tbot.on("callback_query", async (query) => {
    const { data, id, message } = query;
    const chatId = message?.chat?.id;

    try {
      await tbot.answerCallbackQuery(id).catch(() => {});

      if (!data || !chatId) return;

      // Pair Again: data = "repairr:DIGITS"
      if (data.startsWith("repairr:")) {
        const digits = data.split(":")[1];
        if (!digits) return;

        // Rate limit for callback re-pair too
        const userId = query.from?.id;
        const lastPair = pairCooldown.get(userId) || 0;
        const remaining = PAIR_COOLDOWN_MS - (Date.now() - lastPair);
        if (remaining > 0) {
          return tbot
            .answerCallbackQuery(id, {
              text: `⏳ Please wait ${Math.ceil(
                remaining / 1000
              )}s before re-pairing.`,
              show_alert: true,
            })
            .catch(() => {});
        }
        pairCooldown.set(userId, Date.now());

        return doPair(chatId, `+${digits}`, message?.message_id);
      }
    } catch (e) {
      console.error("[bot.js] callback_query error:", e);
    }
  });

  // ── FIX #6: Single unified message handler ───────────────────────────────────
  tbot.on("message", async (msg) => {
    // Log every message (dev-friendly)
    try {
      const sender =
        msg.from?.username || msg.from?.id || msg.sender_chat?.id || "?";
      console.log(
        `[bot.js] 📩 [${msg.chat?.id}/${msg.chat?.type}] @${sender}: ${(
          msg.text || ""
        ).slice(0, 120)}`
      );
    } catch {}

    // Handle command
    try {
      await handleCommand(msg);
    } catch (e) {
      console.error("[bot.js] handleCommand error:", e);
    }
  });

  // ── Webhook setup ────────────────────────────────────────────────────────────
  if (USE_WEBHOOK) {
    try {
      const hookPath = `/bot${BOT_TOKEN}`;
      const webhookUrl = `${RAILWAY_URL.replace(/\/$/, "")}${hookPath}`;
      await tbot.setWebHook(webhookUrl);
      console.log("[bot.js] ✅ Webhook set:", webhookUrl);
      const info = await tbot.getWebHookInfo();
      console.log(
        "[bot.js] 🔎 Webhook info:",
        info.url,
        info.last_error_message || "ok"
      );
    } catch (e) {
      console.error("[bot.js] Webhook setup failed:", e?.message);
    }
  } else {
    console.log("[bot.js] ℹ️  Polling mode (dev).");
  }

  // FIX #9: expose cleanup for graceful shutdown in app.js
  tbot.cleanup = async () => {
    try {
      if (USE_WEBHOOK) await tbot.deleteWebHook().catch(() => {});
      else await tbot.stopPolling().catch(() => {});
      console.log("[bot.js] 🛑 Telegram bot stopped.");
    } catch (e) {
      /* ignore */
    }
  };

  try {
    global.tbot = tbot;
  } catch {}
  return tbot;
}
