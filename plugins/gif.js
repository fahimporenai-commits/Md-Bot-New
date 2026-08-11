import { fetchGif, gifToVideo } from '../lib/fetchGif.js';
import { Module } from '../lib/plugins.js';
import axios from 'axios';

// ─────────────────────────────────────────────
// nekos.best API v2
// GET https://nekos.best/api/v2/{category}
// Response: { results: [{ url, anime_name, dimensions }] }
// ─────────────────────────────────────────────

const BASE = "https://nekos.best/api/v2";

const reactions = {
  // ── Emotions ──
  cry:       { emoji: "😢", action: "is crying" },
  blush:     { emoji: "😊", action: "is blushing at" },
  smile:     { emoji: "😁", action: "smiled at" },
  happy:     { emoji: "😄", action: "is happy with" },
  smug:      { emoji: "😏", action: "is smug at" },
  pout:      { emoji: "😤", action: "is pouting at" },
  confused:  { emoji: "😕", action: "is confused by" },
  bored:     { emoji: "😑", action: "is bored with" },
  angry:     { emoji: "😡", action: "is angry at" },
  shocked:   { emoji: "😲", action: "is shocked by" },
  laugh:     { emoji: "😂", action: "laughed at" },
  think:     { emoji: "🤔", action: "is thinking about" },
  bleh:      { emoji: "😛", action: "goes bleh at" },
  yawn:      { emoji: "🥱", action: "yawns at" },
  teehee:    { emoji: "🤭", action: "teehees at" },

  // ── Touch / Actions ──
  hug:       { emoji: "🤗", action: "hugged" },
  cuddle:    { emoji: "🫂", action: "cuddled" },
  pat:       { emoji: "🫶", action: "patted" },
  kiss:      { emoji: "💋", action: "kissed" },
  peck:      { emoji: "😘", action: "gave a peck to" },
  bite:      { emoji: "🦷", action: "bit" },
  nom:       { emoji: "🍽️", action: "is nomming" },
  tickle:    { emoji: "🤣", action: "tickled" },
  poke:      { emoji: "👉", action: "poked" },
  handhold:  { emoji: "🤝", action: "is holding hands with" },
  handshake: { emoji: "🫱", action: "shook hands with" },
  feed:      { emoji: "🍴", action: "fed" },
  carry:     { emoji: "💪", action: "carried" },
  kabedon:   { emoji: "🫦", action: "kabedoned" },
  blowkiss:  { emoji: "💨💋", action: "blew a kiss at" },
  lappillow: { emoji: "🛌", action: "gave a lap pillow to" },

  // ── Fun / Playful ──
  bonk:      { emoji: "🔨", action: "bonked" },
  slap:      { emoji: "✊",  action: "slapped" },
  punch:     { emoji: "👊", action: "punched" },
  kick:      { emoji: "🦵", action: "kicked" },
  yeet:      { emoji: "🚀", action: "yeeted" },
  baka:      { emoji: "🙄", action: "called baka to" },

  // ── Greetings / Social ──
  wave:      { emoji: "👋", action: "waved at" },
  highfive:  { emoji: "✋", action: "high-fived" },
  clap:      { emoji: "👏", action: "clapped for" },
  salute:    { emoji: "🫡", action: "saluted" },
  thumbsup:  { emoji: "👍", action: "gave thumbs up to" },
  wink:      { emoji: "😉", action: "winked at" },
  nod:       { emoji: "🙂", action: "nodded at" },
  nope:      { emoji: "🙅", action: "said nope to" },
  shrug:     { emoji: "🤷", action: "shrugged at" },
  stare:     { emoji: "👀", action: "is staring at" },
  facepalm:  { emoji: "🤦", action: "facepalmed at" },
  tableflip: { emoji: "😤", action: "flipped the table at" },

  // ── Movement ──
  dance:     { emoji: "💃", action: "danced with" },
  spin:      { emoji: "🌀", action: "spun around with" },
  run:       { emoji: "🏃", action: "ran away from" },
  shake:     { emoji: "🤝", action: "shook" },
  wag:       { emoji: "🐾", action: "wagged tail at" },

  // ── Misc ──
  sip:       { emoji: "☕", action: "sips tea ignoring" },
  nya:       { emoji: "🐱", action: "nyas at" },
};

// ─────────────────────────────────────────────
// Fetch GIF URL from nekos.best
// ─────────────────────────────────────────────
async function fetchReactionUrl(reactionKey) {
  const res = await axios.get(`${BASE}/${reactionKey}`);
  return res.data.results[0].url;
}

// ─────────────────────────────────────────────
// Core sender
// ─────────────────────────────────────────────
async function sendReactionGif(message, reactionKey) {
  const reactionType = reactions[reactionKey];
  try {
    await message.react(reactionType.emoji);

    const senderJid     = message.sender;
    const mentionedUser = message.mentions?.[0] || message.quoted?.sender;
    const sender        = `@${senderJid.split("@")[0]}`;

    let caption;
    let mentionsList = [senderJid];

    if (mentionedUser) {
      const target = `@${mentionedUser.split("@")[0]}`;
      caption = `${sender} ${reactionType.action} ${target}`;
      mentionsList.push(mentionedUser);
    } else if (message.isGroup) {
      caption = `${sender} ${reactionType.action} everyone!`;
    } else {
      caption = "";
    }

    const gifUrl      = await fetchReactionUrl(reactionKey);
    const gifBuffer   = await fetchGif(gifUrl);
    const videoBuffer = await gifToVideo(gifBuffer);

    await message.conn.sendMessage(
      message.from,
      {
        video: videoBuffer,
        caption: caption,
        gifPlayback: true,
        mentions: mentionsList.filter(Boolean),
      },
      { quoted: message.raw }
    );
  } catch (error) {
    console.error(`❌ Reaction error [${reactionKey}]:`, error);
    await message.send("❌ Failed to send reaction GIF");
  }
}

// ─────────────────────────────────────────────
// Method 1: Auto — just type "hug", "kiss" etc.
// ─────────────────────────────────────────────
Module({ on: "text" })(async (message) => {
  try {
    const text = (message.body || "").toLowerCase().trim();
    if (!reactions[text]) return;
    await sendReactionGif(message, text);
  } catch (error) {
    console.error("❌ Auto reaction error:", error);
  }
});

// ─────────────────────────────────────────────
// Method 2: Command — .hug, .kiss, .pat etc.
// ─────────────────────────────────────────────
Object.keys(reactions).forEach((reactionName) => {
  Module({
    command: reactionName,
    package: "reactions",
    description: `Send ${reactionName} reaction GIF`,
  })(async (message) => {
    await sendReactionGif(message, reactionName);
  });
});
