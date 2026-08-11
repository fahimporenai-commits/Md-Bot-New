// insta-plugin.js
import axios from "axios";
import * as cheerio from "cheerio";
import { Module } from "../lib/plugins.js";

async function igdl(targetUrl, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const { data } = await axios.get(
        `https://vdfr.app/download/?url=${targetUrl}`,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            Referer: "https://vdfr.app/",
          },
          timeout: 10000,
        }
      );

      const $ = cheerio.load(data);
      const downloads = [];

      $("table tr").each((_, row) => {
        const resolution = $(row).find("td").eq(0).text().trim();
        const url = $(row)
          .find("a.download__item__info__actions__button")
          .attr("href");
        if (resolution && url) downloads.push({ resolution, url });
      });

      if (!downloads.length) {
        $("a.download__item__info__actions__button").each((_, el) => {
          const url = $(el).attr("href");
          const resolution =
            $(el)
              .closest(".download__item")
              .find(".download__item__info__resolution")
              .text()
              .trim() || "unknown";
          if (url) downloads.push({ resolution, url });
        });
      }

      if (!downloads.length) {
        $('a[href*="acxcdn.com"], a[href*="vdfr"]').each((_, el) => {
          const url = $(el).attr("href");
          const resolution = $(el).text().trim() || "unknown";
          if (url && url.startsWith("http"))
            downloads.push({ resolution, url });
        });
      }

      if (downloads.length) return downloads;
      if (attempt < retries)
        await new Promise((r) => setTimeout(r, 1500 * attempt));
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  return [];
}

Module({
  command: "ig",
  package: "downloader",
  description: "Download Instagram photo/video",
})(async (message, match) => {
  if (!match) return await message.send("ig url required");

  const url = match.trim();

  const igRegex =
    /^(?:https?:\/\/)?(?:www\.)?(?:instagram\.com|instagr\.am)\/(?:p|reel|reels|tv|stories)\/[^\s]+/i;
  if (!igRegex.test(url)) {
    return await message.send(
      "❌ Please provide a valid Instagram post/reel/tv/story URL.\n\nExample: https://www.instagram.com/reel/DUm0aFLCTC4/"
    );
  }

  try {
    await message.react?.("🔍");

    const results = await igdl(url);

    if (!results.length) {
      await message.react?.("❌");
      return 
    }

    await message.react?.("⬇️");

    const best = results[0];

    await message.conn.sendMessage(
      message.from,
      {
        video: { url: best.url },
        //caption: `✅ *Instagram Video*\n📐 ${best.resolution}`,
        mimetype: "video/mp4",
      },
      { quoted: message.gift }
    );

    await message.react?.("✅");
  } catch (err) {
    await message.react?.("❌");
    await message.send(`❌ Error: ${err.message}`);
  }
});
