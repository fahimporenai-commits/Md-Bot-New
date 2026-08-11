// plugins/antiedit.js — Toggle antiedit
import { Module } from "../lib/plugins.js";
import { db } from "../lib/client.js";

function getBotNum(conn) {
  const raw = conn?.user?.id || "";
  return raw.split("@")[0].split(":")[0].replace(/\D/g, "") || null;
}

Module({
  command: "antiedit",
  package: "owner",
  description: "Show edited message content in same chat. .antiedit on/off",
})(async (message, match) => {
  if (!(message.isFromMe || message.isfromMe))
    return message.send("_Only bot owner can use this._");
  const botNum = getBotNum(message.conn);
  if (!botNum) return message.send("❌ Bot number not found.");

  const input = (match || "").trim().toLowerCase();
  const key = "antiedit";

  if (input === "on" || input === "off") {
    await message.react("⏳");
    if (input === "on") db.setHot(botNum, key, true);
    else db.delHot(botNum, key);
    await message.react("✅");
    return message.send(
      `✏️ *AntiEdit* is now \`${input.toUpperCase()}\`\n\n` +
        `${
          input === "on"
            ? "✅ Edited messages will show new content in same chat."
            : "❌ Disabled."
        }`
    );
  }

  const on = db.get(botNum, key, false) === true;
  return message.send(
    `✏️ *AntiEdit*\n> Status: ${
      on ? "✅ ON" : "❌ OFF"
    }\n\nUse:\n• .antiedit on\n• .antiedit off`
  );
});
