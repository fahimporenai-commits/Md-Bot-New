import { Module } from "../lib/plugins.js";
import fetch from "node-fetch";

Module({
  command: "copilot",
  package: "ai",
  description: "Chat with copilot",
})(async (message, match) => {
  if (!match) return message.send("_Please provide a question_");

  try {
    const sent = await message.send("🤔 Thinking...");
    const res = await fetch(
      `https://api.yupra.my.id/api/ai/copilot?text=${encodeURIComponent(match)}`
    );
    const data = await res.json();

    if (!data.status) {
      return await message.send(
        "⚠️ Failed to get response. Please try again.",
        { edit: sent.key }
      );
    }

    const answer = data.result;
    await message.send(answer, { edit: sent.key });
  } catch (error) {
    console.error("copilot ERROR]:", error.message);
    await message.send("⚠️ An error occurred. Please try again later.");
  }
});

Module({
  command: "gpt",
  package: "ai",
  description: "Chat with GPT AI",
})(async (message, match) => {
  if (!match) return message.send("_Please provide a question_");
  try {
    const sent = await message.send("🤔 Thinking...");
    const res = await fetch(
      `https://api.yupra.my.id/api/ai/gpt5?text=${encodeURIComponent(match)}`
    );
    const data = await res.json();

    if (!data.status) {
      return await message.send(
        "⚠️ Failed to get response. Please try again.",
        { edit: sent.key }
      );
    }

    const answer = data.result;
    await message.send(answer, { edit: sent.key });
  } catch (error) {
    console.error("[gpt ERROR]:", error.message);
    await message.send("⚠️ An error occurred. Please try again later.");
  }
});
