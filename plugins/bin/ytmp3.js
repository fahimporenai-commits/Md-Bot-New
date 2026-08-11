import axios from "axios"

const HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/json",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Referer: "https://ytmp3.gg/",
  Origin: "https://ytmp3.gg",
};

function extractVideoId(input) {
  const patterns = [
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/watch\?v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match) return match[1];
  }
  return null;
}

async function pollStatus(statusUrl, maxRetries = 40, intervalMs = 2000) {
  for (let i = 0; i < maxRetries; i++) {
    const { data } = await axios.get(statusUrl, { headers: HEADERS });
    if (data.status === "completed" && data.downloadUrl) return data;
    if (data.status === "error") throw new Error("Conversion failed on server side");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Timeout: Conversion took too long");
}

/**
 * YouTube URL থেকে MP3 download link বের করে
 * @param {string} rawUrl - YouTube URL বা Video ID
 * @param {string} quality - "64kbps" | "128kbps" | "192kbps" | "256kbps" | "320kbps"
 * @returns {{ title, duration, video_id, downloadUrl }}
 */
async function songdl(rawUrl, quality = "128kbps") {
  const videoId = extractVideoId(rawUrl);
  if (!videoId) throw new Error("Invalid YouTube URL or video ID");

  const cleanUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // DMCA Check
  const dmcaRes = await axios.get("https://dmca.ytmp3.gg/api/check", {
    params: { url: cleanUrl },
    headers: HEADERS,
  });
  if (dmcaRes.data.blocked) throw new Error(`DMCA blocked: ${dmcaRes.data.message}`);

  // Convert request
  const convertRes = await axios.post(
    "https://ytdl.convert1s.com/api/v2/download",
    { url: cleanUrl, output: { type: "audio", format: "mp3", quality } },
    { headers: HEADERS }
  );

  const { statusUrl, title, duration } = convertRes.data;
  if (!statusUrl) throw new Error("No statusUrl from conversion API");

  // Poll until done
  const result = await pollStatus(statusUrl);

  return {
    title,
    duration,
    video_id: videoId,
    downloadUrl: result.downloadUrl,
  };
}

export { songdl };

