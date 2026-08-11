// fb-plugin.js
import fs from "fs";
import axios from "axios";
import path from "path";
import stream from "stream";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { Module } from "../lib/plugins.js";

const pipeline = promisify(stream.pipeline);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* Helper: stream remote URL to a temp file and return path */
async function downloadToTemp(url, ext = "") {
  const tempDir = path.join(__dirname, "temp");
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const filename = `file_${Date.now()}${Math.random()
    .toString(36)
    .slice(2, 8)}${ext}`;
  const outPath = path.join(tempDir, filename);

  const res = await axios({
    method: "GET",
    url,
    responseType: "stream",
    timeout: 180000,
  });

  await pipeline(res.data, fs.createWriteStream(outPath));
  return outPath;
}

function safeUnlink(file) {
  try {
    if (file && fs.existsSync(file)) fs.unlinkSync(file);
  } catch (e) {}
}

/* Facebook downloader plugin (uses ootaizumi API) */
Module({
  command: "fb",
  package: "downloader",
  description: "Download Facebook videos (prefer 720p HD)",
})(async (message, match) => {
  if (!match) return await message.send("_Please provide a fb url_");

  const url = match.trim();

  // Accept only facebook links (facebook.com, fb.watch, m.facebook.com, web.facebook.com)
  const fbRegex =
    /^(?:https?:\/\/)?(?:www\.)?(?:facebook\.com|fb\.watch|m\.facebook\.com|web\.facebook\.com)\/[^\s]+/i;
  if (!fbRegex.test(url)) {
    return await message.send(
      "_Please provide a valid fb url_\n\nExample: https://www.facebook.com/watch/?v=1234567890"
    );
  }

  try {
    await message.react?.("🔍");

    const apiUrl = `https://api.ootaizumi.web.id/downloader/facebook?url=${encodeURIComponent(
      url
    )}`;
    const resp = await axios.get(apiUrl, { timeout: 45000 });
    const body = resp?.data;
    if (!body || !body.status || !body.result) {
      return await message.send(
        `_${body?.message || "Failed to fetch from API"}_`
      );
    }

    const result = body.result;
    // result.downloads is expected to be an array of { quality, url }
    const downloads = Array.isArray(result.downloads) ? result.downloads : [];

    if (!downloads.length)
      return await message.send("_❌ No downloadable video found_");

    // prefer 720p (HD)
    let chosen =
      downloads.find(
        (d) => /720/i.test(d.quality) && /hd/i.test(d.quality.toLowerCase())
      ) ||
      downloads.find((d) => /720/i.test(d.quality)) ||
      downloads.find((d) => /hd/i.test(d.quality.toLowerCase())) ||
      downloads[0];

    const downloadUrl = chosen.url;
    const qualityLabel = chosen.quality || "unknown";

    // Try sending the direct URL first (fast, doesn't use disk)
    try {
      await message.react?.("⬇️");
      await message.send({
        video: { url: downloadUrl },
        caption: `*Quality:* ${qualityLabel}`,
      });
      await message.react?.("✅");
      return;
    } catch (err) {
      console.warn(
        "[FB PLUGIN] direct URL send failed, falling back to temp download:",
        err?.message || err
      );
      // continue to streaming to disk
    }

    // Fallback: stream to temp and send buffer
    await message.react?.("⬇️");
    const tmp = await downloadToTemp(downloadUrl, ".mp4");
    const videoBuffer = fs.readFileSync(tmp);

    await message.send({
      video: videoBuffer,
      caption: `*Quality:* ${qualityLabel}`,
    });

    safeUnlink(tmp);
    await message.react?.("✅");
  } catch (err) {
    console.error("[FB PLUGIN] Error:", err?.message || err);
    await message.send(
      "_⚠️ Could not download Facebook video. Check the URL and try again._"
    );
  }
});
