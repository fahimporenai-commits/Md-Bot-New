import { Module } from "../lib/plugins.js";

Module({
  command: "btpn",
  package: "mics",
  description: "Replies with the bot latency",
})(async (message) => {
  const start = Date.now();

  const emojis = [
    "⛅","👻","⛄","👀","🪁","🪃","🎳","🎀","🌸","🍥","🍓","🍡","💗","🦋","💫",
    "💀","☁️","🌨️","🌧️","🌦️","🌥️","⚡","🌟","🎐","🏖️","🌊","🐚","🍒","🍇",
    "🍉","🌻","🎢","🚀","🍫","💎","🌋","🏔️","🌙","🪐","🌲","🍃","🍂","🍁",
    "🍄","🌿","🐞","🐍","🕊️","🎃","🎡","🥂","🗿","⛩️"
  ];

  const emoji = emojis[Math.floor(Math.random() * emojis.length)];
  await message.react(emoji);

  const latency = Date.now() - start;

  await message.conn.sendMessage(
    message.from,
    {
      text: `*${emoji} } Ꭾ❤️‍🩹ŇᎶ: ${latency} ๓Ş*`,
      footer: "Ᏼɪᴛᴛᴜ ⸙",
      buttons: [
        {
          buttonId: ".alive",
          buttonText: { displayText: "✅ Alive" },
          type: 1,
        },
        {
          buttonId: ".owner",
          buttonText: { displayText: "👑 Owner" },
          type: 1,
        },
      ],
      headerType: 1,
      contextInfo: {
        mentionedJid: [message.sender],
      },
    },
    { quoted: message.gift }
  );
});