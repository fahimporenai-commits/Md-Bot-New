import { Module } from "../lib/plugins.js";
import config from "../config.js";
import { getTheme } from "../Themes/themes.js";
import { db } from "../lib/client.js";


const audioUrl = "https://files.catbox.moe/004ilx.ogg";
const thumbUrl = "https://files.catbox.moe/5u80sj.jpg";
const name = "Tum Hi Ho";
const name2 = "Arijit Singh";
const link = "https://whatsapp.com/channel/0029VaoRxGmJpe8lgCqT1T2h";


const theme = getTheme();
function getBotNumberFromConn(conn) {
  const id = conn?.user?.id || conn?.user?.jid || conn?.user || null;
  if (!id) return "unknown";
  return String(id).split("@")[0];
}

Module({ on: 'text' })(async (message) => {
  try {
    if (!message.isMentioned) return
    const botNumber = getBotNumberFromConn(message.conn);
   const cfg = db.get(botNumber, "mention", false)
    if (!cfg) return;

    try {
      

await message.conn.sendMessage(message.from, {
  audio: { url: audioUrl },
  mimetype: "audio/ogg; codecs=opus",
  ptt: true,
  contextInfo: {
    externalAdReply: {
      title: name,
      body: name2,
      thumbnailUrl: thumbUrl,
      sourceUrl: link,
      mediaUrl: audioUrl,
      mediaType: 2,
      renderLargerThumbnail: true,
      showAdAttribution: false
    }
  }
},{ quoted: message.key });
    } catch (err) {
      console.error('mention module error:', err);
    }
  } catch (err) {
    console.error('mention runtime error:', err);
  }
});
