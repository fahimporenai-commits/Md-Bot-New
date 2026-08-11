// insta-plugin.js
import axios from "axios";
import { Module } from "../lib/plugins.js";

Module({
  command: "insta",
  package: "downloader",
  description: "Download Instagram photo/video",
})(async (message, match) => {
  if (!match) return await message.send("ig url required");

  const url = match.trim();

  // Accept only Instagram post/reel/tv/stories links (instagram.com or instagr.am)
  const igRegex =
    /^(?:https?:\/\/)?(?:www\.)?(?:instagram\.com|instagr\.am)\/(?:p|reel|reels|tv|stories)\/[^\s]+/i;
  if (!igRegex.test(url)) {
    return await message.send(
      "❌ Please provide a valid Instagram post/reel/tv/story URL.\n\nExample: https://www.instagram.com/reel/DUm0aFLCTC4/"
    );
  }

  try {
    await message.react?.("🔍");

    const apiUrl = `https://api.ootaizumi.web.id/downloader/instagram/v1?url=${encodeURIComponent(
      url
    )}`;

    const resp = await axios.get(apiUrl, { timeout: 45000 });
    const body = resp?.data;
    if (!body || !body.status || !body.result)
      return await message.send("⚠️ Failed to fetch from API");

    const result = body.result;
    const meta = result.metadata || {};
    const media = Array.isArray(result.media) ? result.media : [];
    const ppc = result.ppc || "";

    // Normalize fields used in caption
    const description = result.description || result.caption || "";
    const profileName = meta.author || result.profileName || "";
    const likes = meta.like ?? meta.likes ?? result.likes ?? "";
    const comments =
      meta.comments ?? result.comments ?? result.commentCount ?? "";
    const timeAgo =
      (typeof meta.duration === "number"
        ? `${meta.duration}s`
        : meta.timeAgo) ||
      result.timeAgo ||
      "";

    const caption =
      (description ? `📝 ${description}\n` : "") +
      (profileName ? `👤 ${profileName}\n` : "") +
      (likes ? `❤️ ${likes}\n` : "") +
      (comments ? `💬 ${comments}\n` : "") +
      (timeAgo ? `⏰ ${timeAgo}` : "");

    if (!media.length) return await message.send("❌ No media found");

    // Send each media item returned by the API
    for (const m of media) {
      try {
        if (m.isVideo) {
          // video object — send with caption
          await message.send({ video: { url: m.url }, caption });
        } else {
          // image object — send with caption
          await message.send({ image: { url: m.url }, caption });
        }
      } catch (sendErr) {
        console.error("[INSTA SEND ERROR]", sendErr?.message || sendErr);
      }
    }

    // Optionally send profile pic as well (commented — enable if you want)
    // if (ppc) await message.send({ image: { url: ppc }, caption: `Profile picture: ${profileName}` });
  } catch (err) {
    console.error("[INSTA PLUGIN] Error:", err?.message || err);
    await message.send(
      "⚠️ Could not download Instagram media. Check the URL and try again."
    );
  }
});
