// plugins/antidelete.js — Toggle antidelete
import { Module } from "../lib/plugins.js";
import { db } from "../lib/client.js";

function getBotNum(conn) {
  const raw = conn?.user?.id || "";
  return raw.split("@")[0].split(":")[0].replace(/\D/g, "") || null;
}

Module({
  command: "antidelete",
  package: "owner",
  aliases: ["antidel"],
  description: "Show deleted messages in same chat. .antidelete on/off",
})(async (message, match) => {
  if (!(message.isFromMe || message.isfromMe)) return message.send("_Only bot owner can use this._");
  const botNum = getBotNum(message.conn);
  if (!botNum) return message.send("❌ Bot number not found.");

  const input = (match || "").trim().toLowerCase();
  const key   = "antidelete";

  if (input === "on" || input === "off") {
    await message.react("⏳");
    if (input === "on") db.setHot(botNum, key, true);
    else db.delHot(botNum, key);
    await message.react("✅");
    return message.send(
      `🗑️ *AntiDelete* is now \`${input.toUpperCase()}\`\n\n` +
      `${input === "on" ? "✅ Deleted messages will appear in the same chat." : "❌ Disabled."}`
    );
  }

  const on = db.get(botNum, key, false) === true;
  return message.send(
    `🗑️ *AntiDelete*\n> Status: ${on ? "✅ ON" : "❌ OFF"}\n\nUse:\n• .antidelete on\n• .antidelete off`
  );
});