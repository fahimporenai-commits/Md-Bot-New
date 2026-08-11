
import { Module } from "../lib/plugins.js";
import config from "../config.js";
import { getTheme } from "../Themes/themes.js";
import { jidNormalizedUser, areJidsSameUser } from "@whiskeysockets/baileys";

const theme = getTheme();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));


Module({
  command: "fwd",
  package: "owner",
  description: "Forward quoted message to a chat",
  usage: ".forward <number/jid>",
})(async (message, match) => {
  try {
    if (!message.isfromMe) return message.send(theme.isfromMe);
    if (!message.quoted)
      return message.send("❌ Reply to a message to forward");
    if (!match)
      return message.send(
        "❌ Provide target number or JID\n\nExample: .forward 1234567890\n.forward 1234567890@s.whatsapp.net\n.forward 123456789@g.us"
      );

    // Parse multiple JIDs/numbers (1st এর মতো multiple target support)
    const targets = match
      .trim()
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .map((t) => {
        if (t.includes("@")) return t; // already a JID
        const num = t.replace(/[^0-9]/g, "");
        return num ? jidNormalizedUser(`${num}@s.whatsapp.net`) : null;
      })
      .filter(Boolean);

    if (!targets.length)
      return message.send("❌ Invalid number or JID provided");

    const rawMsg = message.quoted?.raw ?? message.quoted;
    if (!rawMsg) return message.send("❌ Could not read quoted message");

    await message.react("⏳");

    for (const targetJid of targets) {
      try {
        // preferred: built-in forward
        await message.conn.sendMessage(targetJid, {
          forward: rawMsg,
          force: true,
        });
      } catch {
        // fallback: relay the message content directly
        const qt = message.quoted?.type || "";
        const body = message.quoted?.body;
        if (body) {
          await message.conn.sendMessage(targetJid, { text: body });
        } else if (qt && qt !== "conversation") {
          try {
            const buf = await message.quoted.download();
            const mime = message.quoted.msg?.mimetype || "";
            const mediaKey = qt.replace("Message", "");
            await message.conn.sendMessage(targetJid, {
              [mediaKey]: buf,
              mimetype: mime,
            });
          } catch (e2) {
            console.error("Forward fallback failed for", targetJid, e2);
          }
        }
      }

      await sleep(1234); // 1st এর মতো delay
    }

    await message.react("✅");
    const sentTo = targets
      .map((j) => {
        const num = j.split("@")[0];
        return `@${num}`;
      })
      .join(", ");
    await message.send(`✅ Message forwarded to ${sentTo}`, {
      mentions: targets,
    });
  } catch (err) {
    console.error("Forward command error:", err);
    await message.react("❌");
    await message.send("❌ Failed to forward message");
  }
});





Module({
  command: "saved",
  package: "owner",
  description: "Save quoted message (3 fallback system)",
})(async (message, match) => {
  try {
    if (!message.isfromMe)
      return message.send("❌ Only owner");

    if (!message.quoted)
      return message.send("❌ Reply to a message");

    const client = message.conn;
    const myJid = jidNormalizedUser(client.user.id);

    // JID/number support (optional target)
    let targetJid = myJid;
    if (match) {
      const input = match.trim();
      if (input.includes("@")) {
        targetJid = input;
      } else {
        const num = input.replace(/[^0-9]/g, "");
        if (num) targetJid = jidNormalizedUser(`${num}@s.whatsapp.net`);
      }
    }

    const quoted = message.quoted;
    const type = quoted.type;

    // Exact caption
    const caption =
      quoted.message?.imageMessage?.caption ||
      quoted.message?.videoMessage?.caption ||
      quoted.message?.documentMessage?.caption ||
      quoted.caption ||
      "";

    // Buttons / interactive content
    const rawMsg = quoted.message;
    const hasButtons =
      rawMsg?.buttonsMessage ||
      rawMsg?.templateMessage ||
      rawMsg?.listMessage ||
      rawMsg?.interactiveMessage ||
      rawMsg?.buttonsResponseMessage ||
      rawMsg?.listResponseMessage;

    let saved = false;

    // 🥇 Button/interactive — forward as-is (no fallback)
    if (hasButtons) {
      try {
        await client.relayMessage(targetJid, rawMsg, {});
        saved = true;
      } catch (e) {
        console.log("Button relay failed:", e.message);
        // try copyNForward as backup for buttons
        try {
          await client.copyNForward(targetJid, quoted.raw ?? rawMsg);
          saved = true;
        } catch (e2) {
          console.log("Button copyNForward failed:", e2.message);
        }
      }
    }

    // 🥈 Normal forward (non-button)
    if (!saved) {
      try {
        await client.copyNForward(targetJid, quoted.raw ?? rawMsg);
        saved = true;
      } catch (e) {
        console.log("copyNForward failed:", e.message);
      }
    }

    // 🥉 Buffer fallback (ultimate)
    if (!saved) {
      try {
        if (
          !type ||
          type === "conversation" ||
          type === "extendedTextMessage"
        ) {
          await client.sendMessage(targetJid, {
            text: quoted.body || "",
          });
          saved = true;
        } else {
          const buffer = await quoted.download();
          if (!buffer) throw new Error("Download failed");

          const mimetype = quoted.mimetype || quoted.msg?.mimetype;
          let data = {};

          if (type === "imageMessage") {
            data = { image: buffer, caption };
          } else if (type === "videoMessage") {
            data = { video: buffer, caption };
          } else if (type === "audioMessage") {
            data = {
              audio: buffer,
              mimetype: mimetype || "audio/mpeg",
              ptt: quoted.ptt || false,
            };
          } else if (type === "documentMessage") {
            data = {
              document: buffer,
              mimetype: mimetype || "application/octet-stream",
              fileName: quoted.fileName || `saved_${Date.now()}`,
              caption,
            };
          } else if (type === "stickerMessage") {
            data = { sticker: buffer };
          } else {
            data = { text: quoted.body || "Unsupported message" };
          }

          await client.sendMessage(targetJid, data);
          saved = true;
        }
      } catch (e) {
        console.log("Buffer fallback failed:", e.message);
      }
    }

    if (!saved) {
      return message.send("❌ Failed to save message");
    }

    await message.react("✅");
    await message.send(
      targetJid === myJid
        ? "✅ Saved to your chat"
        : `✅ Saved to @${targetJid.split("@")[0]}`,
      targetJid !== myJid ? { mentions: [targetJid] } : {}
    );

  } catch (err) {
    console.error("Save command error:", err);
    await message.send("❌ Error saving message");
  }
});