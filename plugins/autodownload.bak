// plugins/autodownload.js
// Auto-detect & download FB/Instagram/TikTok/YouTube links in any chat/group
// No command needed — just send the link!

import axios from "axios";
import { Module } from "../lib/plugins.js";
import { db } from "../lib/client.js";

// ── URL patterns ─────────────────────────────────────────────────────────────
const PATTERNS = {
  facebook:  /(?:https?:\/\/)?(?:www\.|m\.|web\.)?(?:facebook\.com|fb\.watch|fb\.com)\/\S+/i,
  instagram: /(?:https?:\/\/)?(?:www\.)?(?:instagram\.com|instagr\.am)\/(?:p|reel|reels|tv|stories)\/\S+/i,
  tiktok:    /(?:https?:\/\/)?(?:www\.|vm\.|vt\.)?tiktok\.com\/\S+/i,
  youtube:   /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch|shorts)|youtu\.be)\/\S+/i,
  twitter:   /(?:https?:\/\/)?(?:www\.)?(?:twitter\.com|x\.com)\/\S+\/status\/\d+/i,
};

function detectPlatform(text) {
  for (const [platform, regex] of Object.entries(PATTERNS)) {
    const match = text.match(regex);
    if (match) return { platform, url: match[0].split("?")[0].trim() };
  }
  return null;
}

function getBotNum(conn) {
  const raw = conn?.user?.id || "";
  return raw.split("@")[0].split(":")[0].replace(/\D/g, "") || null;
}

// ── Downloaders ───────────────────────────────────────────────────────────────

async function downloadFacebook(url) {
  try {
    const res = await axios.get(
      `https://www.apiskeith.top/download/fbdown?url=${encodeURIComponent(url)}`,
      { timeout: 15000 }
    );
    const media = res.data?.result?.media;
    if (media?.hd) return { url: media.hd, type: "video", quality: "HD" };
    if (media?.sd) return { url: media.sd, type: "video", quality: "SD" };
  } catch {}
  try {
    const res = await axios.get(
      `https://www.apiskeith.top/download/fbdl?url=${encodeURIComponent(url)}`,
      { timeout: 15000 }
    );
    const v = res.data?.result;
    if (v) return { url: v, type: "video", quality: "SD" };
  } catch {}
  return null;
}

async function downloadInstagram(url) {
  try {
    const res = await axios.get(
      `https://api.ootaizumi.web.id/downloader/instagram/v1?url=${encodeURIComponent(url)}`,
      { timeout: 20000 }
    );
    const result = res.data?.result;
    if (!result) return null;
    const media = Array.isArray(result.media) ? result.media : [];
    if (!media.length) return null;
    return media.map(m => ({ url: m.url, type: m.isVideo ? "video" : "image" }));
  } catch {}
  return null;
}

async function downloadTikTok(url) {
  try {
    const res = await axios.get(
      `https://api.vreden.my.id/api/v1/download/tiktok?url=${encodeURIComponent(url)}`,
      { timeout: 15000 }
    );
    const result = res.data?.result;
    if (result) {
      const hd = result.data?.find(d => d.type === "nowatermark_hd");
      const normal = result.data?.find(d => d.type === "nowatermark");
      const videoUrl = hd?.url || normal?.url;
      if (videoUrl) return { url: videoUrl, type: "video", quality: hd ? "HD" : "SD" };
    }
  } catch {}
  try {
    const res = await axios.get(
      `https://www.apiskeith.top/download/tiktokdl3?url=${encodeURIComponent(url)}`,
      { timeout: 15000 }
    );
    const v = res.data?.result;
    if (v) return { url: v, type: "video", quality: "SD" };
  } catch {}
  return null;
}

async function downloadYouTube(url) {
  try {
    const res = await axios.get(
      `https://api.vreden.my.id/api/ytmp4?url=${encodeURIComponent(url)}`,
      { timeout: 20000 }
    );
    const dl = res.data?.result?.download?.url || res.data?.result?.url;
    if (dl) return { url: dl, type: "video", quality: "360p" };
  } catch {}
  try {
    const res = await axios.get(
      `https://www.apiskeith.top/download/ytdl?url=${encodeURIComponent(url)}`,
      { timeout: 20000 }
    );
    const v = res.data?.result;
    if (v) return { url: v, type: "video", quality: "SD" };
  } catch {}
  return null;
}

async function downloadTwitter(url) {
  try {
    const res = await axios.get(
      `https://www.apiskeith.top/download/twitter?url=${encodeURIComponent(url)}`,
      { timeout: 15000 }
    );
    const v = res.data?.result?.url || res.data?.result;
    if (v) return { url: v, type: "video", quality: "SD" };
  } catch {}
  return null;
}

async function getMedia(platform, url) {
  switch (platform) {
    case "facebook":  return downloadFacebook(url);
    case "instagram": return downloadInstagram(url);
    case "tiktok":    return downloadTikTok(url);
    case "youtube":   return downloadYouTube(url);
    case "twitter":   return downloadTwitter(url);
    default:          return null;
  }
}

// ── Platform icons ────────────────────────────────────────────────────────────
const ICONS = {
  facebook: "📘", instagram: "📸", tiktok: "🎵",
  youtube: "▶️", twitter: "🐦",
};

// ── Send media helper ─────────────────────────────────────────────────────────
async function sendMedia(message, mediaItem, platform, caption) {
  if (!mediaItem?.url) return false;
  try {
    if (mediaItem.type === "video") {
      await message.send({
        video: { url: mediaItem.url },
        mimetype: "video/mp4",
        caption,
      });
    } else {
      await message.send({
        image: { url: mediaItem.url },
        caption,
      });
    }
    return true;
  } catch (e) {
    console.error(`[autodownload] send failed:`, e?.message);
    return false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// ── Toggle command ────────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

Module({
  command: "autodownload",
  package: "owner",
  aliases: ["autodl", "autosave"],
  description: "Toggle auto download for FB/Instagram/TikTok/YouTube links",
})(async (message, match) => {
  if (!(message.isFromMe || message.isfromMe)) {
    return message.send("_Only bot owner can use this command._");
  }
  const botNum = getBotNum(message.conn);
  if (!botNum) return message.send("❌ Bot number not found.");

  const input = (match || "").trim().toLowerCase();
  const key = "autodownload";

  if (input === "on" || input === "off") {
    await message.react("⏳");
    if (input === "on") db.setHot(botNum, key, true);
    else db.delHot(botNum, key);
    await message.react("✅");
    return message.send(
      `📥 *Auto Download is now \`${input.toUpperCase()}\`*\n\n` +
      `${input === "on"
        ? "✅ Any FB/Instagram/TikTok/YouTube link in any chat will be auto-downloaded!"
        : "❌ Auto download disabled."}`
    );
  }

  const status = db.get(botNum, key, false) === true;
  return message.send(
    `📥 *Auto Download*\n` +
    `> Status: ${status ? "✅ ON" : "❌ OFF"}\n\n` +
    `*Supported:* Facebook, Instagram, TikTok, YouTube, Twitter\n\n` +
    `*Usage:*\n• .autodownload on\n• .autodownload off`
  );
});

// ══════════════════════════════════════════════════════════════════════════════
// ── Auto-detect text plugin ───────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

Module({
  on: "text",
  package: "downloader",
  description: "Auto detect and download social media links",
})(async (message) => {
  try {
    if (!message?.body) return;

    // Check if autodownload is enabled
    const botNum = getBotNum(message.conn);
    if (!botNum) return;
    if (db.get(botNum, "autodownload") !== true) return;

    // Skip if it's a bot command
    const prefix = ".";
    if (message.body.startsWith(prefix)) return;

    // Skip from own messages (to avoid loop)
    if (message.isFromMe || message.isfromMe) return;

    const detected = detectPlatform(message.body);
    if (!detected) return;

    const { platform, url } = detected;
    const icon = ICONS[platform] || "📥";

    await message.react("⏳");

    const result = await getMedia(platform, url);

    if (!result) {
      await message.react("❌");
      return;
    }

    // Instagram can return array of media
    const items = Array.isArray(result) ? result : [result];
    const caption = `${icon} *Auto Downloaded*\n_${platform.charAt(0).toUpperCase() + platform.slice(1)}_`;

    let sent = 0;
    for (const item of items) {
      const ok = await sendMedia(message, item, platform, caption);
      if (ok) sent++;
    }

    if (sent > 0) {
      await message.react("✅");
    } else {
      await message.react("❌");
    }
  } catch (err) {
    console.error("[autodownload] error:", err?.message);
  }
});