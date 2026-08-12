import { Module } from "../lib/plugins.js";
import crypto from "crypto";
import {
  generateWAMessageContent,
  generateWAMessageFromContent,
  downloadContentFromMessage,
} from "@whiskeysockets/baileys";
import { PassThrough } from "stream";
import ffmpeg from "fluent-ffmpeg";

// স্ট্যাটাসের ডিফল্ট পারপল কালার
const PURPLE_COLOR = "#9C27B0";

Module({
  command: "groupstatus",
  package: "admin",
  description: "Post text or media as WhatsApp group status",
})(async (message, match) => {
  try {
    const sock = message.conn;
    const from = message.from;

    // ১. শুধুমাত্র গ্রুপ চ্যাটে কাজ করবে
    if (!message.isGroup) {
      return await message.conn.sendMessage(from, {
        text: "👥  এই কমান্ডটি কেবল গ্রুপেই ব্যবহার করা যাবে।",
      }, { quoted: message.gift || message });
    }

    const caption = (match || "").trim();
    const ctxInfo = message.message?.extendedTextMessage?.contextInfo || message.ctxInfo;
    const hasQuoted = !!ctxInfo?.quotedMessage;

    // ২. যদি কোনো মিডিয়াতে রিপ্লাই না থাকে -> টেক্সট স্ট্যাটাস
    if (!hasQuoted) {
      if (!caption) {
        return await message.conn.sendMessage(from, {
          text:
            "📝 *Group Status Usage*\n\n" +
            "• ছবি/ভিডিও/অডিওতে রিপ্লাই দিয়ে লিখুন:\n" +
            "  `.groupstatus [ক্যাপশন]`\n" +
            "• অথবা শুধু টেক্সট স্ট্যাটাস দিতে লিখুন:\n" +
            "  `.groupstatus আপনার টেক্সট`",
        }, { quoted: message.gift || message });
      }

      await message.react("⏳");

      try {
        await groupStatus(sock, from, {
          text: caption,
          backgroundColor: PURPLE_COLOR,
        });
        await message.react("✅");
        return await message.conn.sendMessage(from, {
          text: "✅ *GROUP STATUS PUSHED!*\n\n, গ্রুপ টেক্সট স্ট্যাটাস পোস্ট হয়েছে! 🔥",
        }, { quoted: message.gift || message });
      } catch (e) {
        console.error("groupstatus text error:", e);
        await message.react("❌");
        return await message.conn.sendMessage(from, {
          text: "❌ স্ট্যাটাস পোস্ট করতে ব্যর্থ: " + (e.message || e),
        }, { quoted: message.gift || message });
      }
    }

    // ৩. রিপ্লাই করা মেসেজ থেকে মিডিয়া প্রসেসিং
    const quotedMsg = ctxInfo.quotedMessage;
    const mtype = Object.keys(quotedMsg)[0] || "";

    const downloadBuf = async (type) => {
      const mediaMsg = quotedMsg[`${type}Message`] || quotedMsg;
      const stream = await downloadContentFromMessage(mediaMsg, type);
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    };

    // 🖼️ ছবি বা স্টিকার
    if (/image|sticker/i.test(mtype)) {
      await message.react("⏳");
      let buf;
      try {
        buf = await downloadBuf(/image/i.test(mtype) ? "image" : "sticker");
      } catch {
        await message.react("❌");
        return await message.conn.sendMessage(from, { text: "❌ ছবি ডাউনলোড করতে সমস্যা হয়েছে!" });
      }

      try {
        await groupStatus(sock, from, {
          image: buf,
          caption: caption || "",
        });
        await message.react("✅");
        return await message.conn.sendMessage(from, {
          text: "✅ *GROUP STATUS PUSHED!*\n\n ইমেজ স্ট্যাটাস পোস্ট হয়ে গেছে! 🖼️",
        }, { quoted: message.gift || message });
      } catch (e) {
        console.error("groupstatus image error:", e);
        await message.react("❌");
        return await message.conn.sendMessage(from, { text: "❌ এরর: " + (e.message || e) });
      }
    }

    // 🎥 ভিডিও
    if (/video/i.test(mtype)) {
      await message.react("⏳");
      let buf;
      try {
        buf = await downloadBuf("video");
      } catch {
        await message.react("❌");
        return await message.conn.sendMessage(from, { text: "❌ ভিডিও ডাউনলোড করতে সমস্যা হয়েছে!" });
      }

      try {
        await groupStatus(sock, from, {
          video: buf,
          caption: caption || "",
        });
        await message.react("✅");
        return await message.conn.sendMessage(from, {
          text: "✅ *GROUP STATUS PUSHED!*\n\nওরে ভাই ফাহিম, ভিডিও স্ট্যাটাস পোস্ট হয়ে গেছে! 🎥",
        }, { quoted: message.gift || message });
      } catch (e) {
        console.error("groupstatus video error:", e);
        await message.react("❌");
        return await message.conn.sendMessage(from, { text: "❌ এরর: " + (e.message || e) });
      }
    }

    // 🎙️ অডিও (ভয়েস স্ট্যাটাস)
    if (/audio/i.test(mtype)) {
      await message.react("⏳");
      let buf;
      try {
        buf = await downloadBuf("audio");
      } catch {
        await message.react("❌");
        return await message.conn.sendMessage(from, { text: "❌ অডিও ডাউনলোড করতে সমস্যা হয়েছে!" });
      }

      let vn;
      try {
        vn = await toVN(buf);
      } catch {
        vn = buf;
      }

      let waveform;
      try {
        waveform = await generateWaveform(buf);
      } catch {
        waveform = undefined;
      }

      try {
        await groupStatus(sock, from, {
          audio: vn,
          mimetype: "audio/ogg; codecs=opus",
          ptt: true,
          waveform,
        });
        await message.react("✅");
        return await message.conn.sendMessage(from, {
          text: "✅ *GROUP STATUS PUSHED!*\n\nওরে ভাই ফাহিম, অডিও স্ট্যাটাস পোস্ট হয়ে গেছে! 🎙️",
        }, { quoted: message.gift || message });
      } catch (e) {
        console.error("groupstatus audio error:", e);
        await message.react("❌");
        return await message.conn.sendMessage(from, { text: "❌ এরর: " + (e.message || e) });
      }
    }

    await message.react("❌");
    return await message.conn.sendMessage(from, {
      text: "❌ সাপোর্ট করে না এমন ফাইল! ছবি, ভিডিও বা অডিও মেসেজে রিপ্লাই দিন।",
    });

  } catch (e) {
    console.error("groupstatus error:", e);
    return await message.conn.sendMessage(message.from, {
      text: "❌ Error: " + (e.message || e),
    });
  }
});

// ---- Helper Functions ----

async function groupStatus(sock, jid, content) {
  const { backgroundColor } = content;
  delete content.backgroundColor;

  const inside = await generateWAMessageContent(content, {
    upload: sock.waUploadToServer || sock.upload,
    backgroundColor: backgroundColor || PURPLE_COLOR,
  });

  const secret = crypto.randomBytes(32);

  const msg = generateWAMessageFromContent(
    jid,
    {
      messageContextInfo: { messageSecret: secret },
      groupStatusMessageV2: {
        message: {
          ...inside,
          messageContextInfo: { messageSecret: secret },
        },
      },
    },
    {}
  );

  await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
  return msg;
}

function toVN(buffer) {
  return new Promise((resolve, reject) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks = [];

    input.end(buffer);

    ffmpeg(input)
      .noVideo()
      .audioCodec("libopus")
      .format("ogg")
      .audioChannels(1)
      .audioFrequency(48000)
      .on("error", reject)
      .on("end", () => resolve(Buffer.concat(chunks)))
      .pipe(output);

    output.on("data", (c) => chunks.push(c));
  });
}

function generateWaveform(buffer, bars = 64) {
  return new Promise((resolve, reject) => {
    const input = new PassThrough();
    input.end(buffer);

    const chunks = [];

    ffmpeg(input)
      .audioChannels(1)
      .audioFrequency(16000)
      .format("s16le")
      .on("error", reject)
      .on("end", () => {
        const raw = Buffer.concat(chunks);
        const samples = raw.length / 2;
        const amps = [];

        for (let i = 0; i < samples; i++) {
          amps.push(Math.abs(raw.readInt16LE(i * 2)) / 32768);
        }

        const size = Math.floor(amps.length / bars);
        if (size === 0) return resolve(undefined);

        const avg = Array.from({ length: bars }, (_, i) =>
          amps
            .slice(i * size, (i + 1) * size)
            .reduce((a, b) => a + b, 0) / size
        );

        const max = Math.max(...avg);
        if (max === 0) return resolve(undefined);

        resolve(
          Buffer.from(
            avg.map((v) => Math.floor((v / max) * 100))
          ).toString("base64")
        );
      })
      .pipe()
      .on("data", (c) => chunks.push(c));
  });
}
