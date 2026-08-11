import fs from "fs";
import axios from "axios";
import fetch from "node-fetch";
import os from "os";
import path from "path";
import yts from "yt-search";
import { File } from "megajs";
import { promisify } from "util";
import { songdl } from "./bin/ytmp3.js";
import stream from "stream";
import { fileURLToPath } from "url";
import { Module } from "../lib/plugins.js";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import { Readable } from "stream";
import {
  proto,
  generateWAMessageFromContent,
  prepareWAMessageMedia,
} from "@whiskeysockets/baileys";

ffmpeg.setFfmpegPath(ffmpegPath);
const pipeline = promisify(stream.pipeline);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isYouTubeUrl(str) {
  return /youtu\.?be(\.com)?\//.test(str) || /^[a-zA-Z0-9_-]{11}$/.test(str);
}

function extractVideoId(url) {
  const m = url.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  return m?.[1] ?? null;
}

function toYtUrl(id) {
  return `https://youtu.be/${id}`;
}

async function searchYT(query, limit = 8) {
  const { videos } = await yts(query);
  if (!videos?.length) throw new Error("No results found for: " + query);
  return videos.slice(0, limit);
}

async function downloadMp3(url, dest) {
  const res = await axios.get(url, { responseType: "stream", timeout: 60_000 });
  await pipeline(res.data, fs.createWriteStream(dest));
}

// ─── Carousel Builder ─────────────────────────────────────────────────────────

async function sendSongCarousel(videos, message) {
  const sock = message.conn;
  const from = message.from;
  const cards = [];

  for (const v of videos) {
    let imageMessage;

    const thumb = v.thumbnail || v.image;
    if (thumb) {
      try {
        const media = await prepareWAMessageMedia(
          { image: { url: thumb } },
          { upload: sock.waUploadToServer }
        );
        imageMessage = media.imageMessage;
      } catch (_) { /* skip broken thumbnail */ }
    }

    const views =
      typeof v.views === "number"
        ? v.views.toLocaleString()
        : v.views || "N/A";

    cards.push({
      body: proto.Message.InteractiveMessage.Body.create({
        text:
          `🎵 *${v.title}*\n` +
          `⏱ ${v.duration?.timestamp || "N/A"}  👁 ${views}\n` +
          `👤 ${v.author?.name || "Unknown"}`,
      }),
      footer: proto.Message.InteractiveMessage.Footer.create({
        text: "─【 MIKU 】─",
      }),
      header: proto.Message.InteractiveMessage.Header.create({
        hasMediaAttachment: !!imageMessage,
        ...(imageMessage ? { imageMessage } : {}),
      }),
      nativeFlowMessage:
        proto.Message.InteractiveMessage.NativeFlowMessage.create({
          buttons: [
            {
              name: "quick_reply",
              buttonParamsJson: JSON.stringify({
                display_text: "▶ PLAY",
                id: `miku:song:${v.videoId}`,   // short 11-char ID only
              }),
            },
          ],
        }),
    });
  }

  const carouselMsg = generateWAMessageFromContent(
    from,
    {
      viewOnceMessage: {
        message: {
          messageContextInfo: {
            deviceListMetadata: {},
            deviceListMetadataVersion: 2,
          },
          interactiveMessage: proto.Message.InteractiveMessage.create({
            body: proto.Message.InteractiveMessage.Body.create({
              text: `🔎 Found *${videos.length}* results — tap ▶ PLAY to download`,
            }),
            footer: proto.Message.InteractiveMessage.Footer.create({
              text: "Swipe ➡️ to browse",
            }),
            carouselMessage:
              proto.Message.InteractiveMessage.CarouselMessage.create({
                cards,
              }),
          }),
        },
      },
    },
    {}
  );

  await sock.relayMessage(from, carouselMsg.message, {
    messageId: carouselMsg.key.id,
  });
}

// ─── Core Download ────────────────────────────────────────────────────────────

async function handleSongDownload(videoUrl, meta, message) {
  const sock = message.conn;
  const from = message.from;
  const result = await songdl(videoUrl, "128kbps");

  const title    = meta?.title    || result.title    || "audio";
  const duration = meta?.duration || result.duration || "N/A";
  const author   = meta?.author   || "Unknown";

  const tmpFile = path.join(os.tmpdir(), `song_${Date.now()}.mp3`);

  try {
    await downloadMp3(result.downloadUrl, tmpFile);

    const audioBuffer = fs.readFileSync(tmpFile);

    await sock.sendMessage(from, {
      audio: audioBuffer,
      mimetype: "audio/mpeg",
      ptt: false,
      fileName: `${title}.mp3`,
      caption: `🎵 *${title}*\n👤 ${author}\n⏱ ${duration}`,
    });
  } finally {
    fs.unlink(tmpFile, () => {});
  }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

for (const [cmd, desc] of [
  ["song",  "Search & download audio from YouTube"],
  ["play",  "Search & play audio from YouTube"],
  ["yta",   "YouTube audio downloader"],
  ["ytmp3", "YouTube MP3 downloader"],
]) {
  Module({ command: cmd, package: "downloader", description: desc })(
    async (message, match) => {
      if (!match)
        return message.send(`_Usage: .${cmd} <song name or YouTube URL>_`);

      const input = match.trim();

      try {
        if (isYouTubeUrl(input)) {
          // Direct URL/ID → skip search, download right away
          const id  = extractVideoId(input) ?? input;
          const url = toYtUrl(id);
          await handleSongDownload(url, null, message);
        } else {
          // Text query → search → show carousel
          await message.send(`🔍 Searching: *${input}*`);
          const videos = await searchYT(input, 8);
          await sendSongCarousel(videos, message);
        }
      } catch (err) {
        console.error(`[${cmd.toUpperCase()}]`, err?.message || err);
        await message.send(`⚠️ Error: ${err?.message || "Unknown error"}`);
      }
    }
  );
}

// ─── Interactive Response Handler (carousel PLAY tap) ─────────────────────────

Module({
  on: "text",
  package: "downloader",
  description: "Song carousel — handle PLAY button tap",
})(async (message) => {
  try {
    const reply = message.raw.message?.templateButtonReplyMessage;
    if (!reply) return;

    const id = reply.selectedId;
    if (!id?.startsWith("miku:song:")) return;

    const videoId = id.slice("miku:song:".length);
    if (!videoId) return;

    await message.react(`▶`);
    await handleSongDownload(toYtUrl(videoId), null, message);
  } catch (err) {
    console.error("[SONG:INTERACTIVE]", err?.message || err);
    await message.send(`⚠️ Error: ${err?.message || "Unknown error"}`);
  }
});
/*
Module({
  command: "ytv",
  package: "downloader",
  description: "Download YouTube Video",
})(async (message, match) => {
  if (!match) return message.send("_need a yt url or video name_");
  let input = match.trim();
  try {
    await handleVideoDownload(input, message);
  } catch (err) {
    console.error("[PLUGIN YTV] Error:", err?.message || err);
    await message.send("⚠️ Video download failed. Please try again later.");
  }
});

Module({
  command: "mp4",
  package: "downloader",
  description: "Download YouTube MP4",
})(async (message, match) => {
  if (!match) return message.send("_need a yt url or video name_");
  let input = match.trim();
  try {
    await handleVideoDownload(input, message);
  } catch (err) {
    console.error("[PLUGIN MP4] Error:", err?.message || err);
    await message.send("⚠️ Video download failed. Please try again later.");
  }
});

Module({
  command: "video",
  package: "downloader",
  description: "Download YouTube Video",
})(async (message, match) => {
  if (!match) return message.send("_need a yt url or video name_");
  let input = match.trim();
  try {
    await handleVideoDownload(input, message);
  } catch (err) {
    console.error("[PLUGIN VIDEO] Error:", err?.message || err);
    await message.send("⚠️ Video download failed. Please try again later.");
  }
});*/

Module({
  command: "yts",
  package: "search",
  description: "Search YouTube videos",
})(async (message, match) => {
  if (!match) return await message.send("Please provide a search query");
  const query = match.trim();
  const results = await (async (q) => {
    // reuse the existing ytSearch using Google API key-less fallback to yts (yt-search)
    try {
      const res = await yts(q, { pages: 1 });
      return res && res.videos
        ? res.videos.map((v) => ({
            id: v.videoId,
            title: v.title,
            url: v.url,
            thumbnail: v.thumbnail,
            channel: v.author && v.author.name,
            publishedAt: v.ago,
          }))
        : [];
    } catch (e) {
      return [];
    }
  })(query);
  if (!results.length) return await message.send("❌ No results found");
  let reply = `*YouTube results for "${query}":*\n\n`;
  results.forEach((v, i) => {
    const date = v.publishedAt || "";
    reply += `⬢ ${i + 1}. ${v.title}\n   Channel: ${
      v.channel || ""
    }\n   Published: ${date}\n   Link: ${v.url}\n\n`;
  });
  await message.send({ image: { url: results[0].thumbnail }, caption: reply });
});

/* ----------------- GitClone ----------------- */
Module({
  command: "gitclone",
  package: "downloader",
  description: "Download GitHub repository as zip",
})(async (message, match) => {
  const arg = (match || "").trim();
  if (!arg)
    return message.send(
      "❌ Provide a GitHub link.\n\nExample:\n.gitclone https://github.com/username/repository"
    );
  try {
    const link = arg.split(/\s+/)[0];
    const regex = /github\.com\/([^\/]+)\/([^\/]+)(?:\.git)?/i;
    const m = link.match(regex);
    if (!m) return message.send("⚠️ Invalid GitHub repository format.");
    const [, username, repo] = m;
    const zipUrl = `https://api.github.com/repos/${username}/${repo}/zipball`;
    // Confirm repository exists
    const head = await fetch(zipUrl, { method: "HEAD" });
    if (!head.ok) return message.send("Repository not found or private.");
    const filename = `${repo}.zip`;
    await message.conn.sendMessage(
      message.from,
      {
        document: { url: zipUrl },
        fileName: filename,
        mimetype: "application/zip",
        caption: `GitHub: ${username}/${repo}`,
      },
      { quoted: message.raw }
    );
    await message.react("✅");
  } catch (err) {
    console.error("GitClone Error:", err);
    await message.react("❌");
    return message.send(
      "❌ Failed to download repository. Please try again later."
    );
  }
});
/* ----------------- APK Downloader ----------------- */
Module({
  command: "apk",
  package: "downloader",
  description: "Download APK files using NexOracle API",
})(async (message, match) => {
  const appName = (match || "").trim();
  if (!appName) return message.send("*🏷️ Please provide an app name.*");
  try {
    await message.react("⏳");
    const apiUrl = `https://api.nexoracle.com/downloader/apk`;
    const params = { apikey: "free_key@maher_apis", q: appName };
    const res = await axios.get(apiUrl, { params }).catch(() => null);
    if (!res || !res.data || res.data.status !== 200 || !res.data.result) {
      await message.react("❌");
      return message.send("❌ Unable to find the APK. Please try again later.");
    }
    const { name, lastup, package: pkg, size, icon, dllink } = res.data.result;
    // send metadata first
    await message.conn.sendMessage(
      message.from,
      {
        image: { url: icon },
        caption: `\`「 APK DOWNLOADED 」\`\nName: ${name}\nUpdated: ${lastup}\nPackage: ${pkg}\nSize: ${size}\nSending APK...`,
      },
      { quoted: message.raw }
    );
    const apkRes = await axios
      .get(dllink, { responseType: "arraybuffer" })
      .catch(() => null);
    if (!apkRes || !apkRes.data) {
      await message.react("❌");
      return message.send("❌ Failed to download the APK.");
    }
    await message.conn.sendMessage(
      message.from,
      {
        document: Buffer.from(apkRes.data),
        mimetype: "application/vnd.android.package-archive",
        fileName: `${name}.apk`,
        caption: "APK file",
      },
      { quoted: message.raw }
    );
    await message.react("✅");
  } catch (err) {
    console.error("APK Error:", err);
    await message.react("❌");
    return message.send("❌ Unable to fetch APK details.");
  }
});

/* ----------------- Mega.nz Downloader ----------------- */
Module({
  command: "mega",
  package: "downloader",
  description: "Download files from Mega.nz",
})(async (message, match) => {
  const q = (match || "").trim();
  if (!q) return message.send("❌ Please provide a Mega.nz link!");
  try {
    await message.react("⏳");
    const file = File.fromURL(q);
    const data = await new Promise((resolve, reject) =>
      file.download((err, data) => (err ? reject(err) : resolve(data)))
    );
    const fileName = file.name || `mega_file_${Date.now()}`;
    const savePath = path.join(os.tmpdir(), fileName);
    fs.writeFileSync(savePath, data);
    await message.conn.sendMessage(
      message.from,
      {
        document: fs.readFileSync(savePath),
        fileName,
        mimetype: "application/octet-stream",
        caption: `Downloaded from Mega.nz: ${fileName}`,
      },
      { quoted: message.raw }
    );
    fs.unlinkSync(savePath);
    await message.react("✅");
  } catch (err) {
    console.error("MegaDL Error:", err);
    await message.react("❌");
    return message.send("❌ Failed to download from Mega.nz.");
  }
});
