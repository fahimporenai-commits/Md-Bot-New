import axios from "axios";
import { Module } from "../lib/plugins.js";

// Loli command
Module({
  command: "loli",
  package: "anime",
  description: "Download Loli Anime Images",
})(async (message, match) => {
  try {
    const apiUrl = "https://api.lolicon.app/setu/v2?num=1&r18=0&tag=lolicon";
    const response = await axios.get(apiUrl);
    const data = response.data;

    if (data && data.data && data.data[0]) {
      await message.conn.sendMessage(message.from, {
        image: { url: data.data[0].urls.original },
        caption: "> Here is your loli anime image! 💫",
      });
    } else {
      await message.send("Error: Could not fetch image from API.");
    }
  } catch (e) {
    if (e.response) {
      await message.send(
        `API Error: ${e.response.status} - ${
          e.response.data?.message || "No message provided"
        }`
      );
    } else if (e.request) {
      await message.send(
        "Network Error: API server not responding. Please try again later."
      );
    } else {
      await message.send("Unexpected Error: Please try again later.");
    }
    console.log(e);
  }
});

// Waifu command
Module({
  command: "waifu",
  package: "anime",
  description: "Download Waifu Anime Images",
})(async (message, match) => {
  try {
    const apiUrl = "https://api.waifu.pics/sfw/waifu";
    const response = await axios.get(apiUrl);
    const data = response.data;

    if (data && data.url) {
      await message.conn.sendMessage(message.from, {
        image: { url: data.url },
        caption: "> Here is your waifu anime image! 💫",
      });
    } else {
      await message.send("Error: Could not fetch image from API.");
    }
  } catch (e) {
    if (e.response) {
      await message.send(
        `API Error: ${e.response.status} - ${
          e.response.data?.message || "No message provided"
        }`
      );
    } else if (e.request) {
      await message.send(
        "Network Error: API server not responding. Please try again later."
      );
    } else {
      await message.send("Unexpected Error: Please try again later.");
    }
    console.log(e);
  }
});

// Neko command
Module({
  command: "neko",
  package: "anime",
  description: "Download Neko Anime Images",
})(async (message, match) => {
  try {
    const apiUrl = "https://api.waifu.pics/sfw/neko";
    const response = await axios.get(apiUrl);
    const data = response.data;

    if (data && data.url) {
      await message.conn.sendMessage(message.from, {
        image: { url: data.url },
        caption: "> Here is your neko anime image! 🐱",
      });
    } else {
      await message.send("Error: Could not fetch image from API.");
    }
  } catch (e) {
    if (e.response) {
      await message.send(
        `API Error: ${e.response.status} - ${
          e.response.data?.message || "No message provided"
        }`
      );
    } else if (e.request) {
      await message.send(
        "Network Error: API server not responding. Please try again later."
      );
    } else {
      await message.send("Unexpected Error: Please try again later.");
    }
    console.log(e);
  }
});

// Megumin command
Module({
  command: "megumin",
  package: "anime",
  description: "Download Megumin Anime Images",
})(async (message, match) => {
  try {
    const apiUrl = "https://api.waifu.pics/sfw/megumin";
    const response = await axios.get(apiUrl);
    const data = response.data;

    if (data && data.url) {
      await message.conn.sendMessage(message.from, {
        image: { url: data.url },
        caption: "> Here is your Megumin anime image! 💫",
      });
    } else {
      await message.send("Error: Could not fetch image from API.");
    }
  } catch (e) {
    if (e.response) {
      await message.send(
        `API Error: ${e.response.status} - ${
          e.response.data?.message || "No message provided"
        }`
      );
    } else if (e.request) {
      await message.send(
        "Network Error: API server not responding. Please try again later."
      );
    } else {
      await message.send("Unexpected Error: Please try again later.");
    }
    console.log(e);
  }
});

// Maid command
Module({
  command: "maid",
  package: "anime",
  description: "Download Maid Anime Images",
})(async (message, match) => {
  try {
    const apiUrl = "https://api.waifu.im/search/?included_tags=maid";
    const response = await axios.get(apiUrl);
    const data = response.data;

    if (data && data.images && data.images[0]) {
      await message.conn.sendMessage(message.from, {
        image: { url: data.images[0].url },
        caption: "> Here is your maid anime image! 💫",
      });
    } else {
      await message.send("Error: Could not fetch image from API.");
    }
  } catch (e) {
    if (e.response) {
      await message.send(
        `API Error: ${e.response.status} - ${
          e.response.data?.message || "No message provided"
        }`
      );
    } else if (e.request) {
      await message.send(
        "Network Error: API server not responding. Please try again later."
      );
    } else {
      await message.send("Unexpected Error: Please try again later.");
    }
    console.log(e);
  }
});

// Anime Quote command
Module({
  command: "aquote",
  package: "anime",
  description: "Get Random Anime Quote",
})(async (message, match) => {
  try {
    const apiUrl = "https://animechan.vercel.app/api/random";
    const response = await axios.get(apiUrl);
    const data = response.data;

    if (data && data.quote) {
      const quoteText = `💬 *Quote:* "${data.quote}"\n\n👤 *Character:* ${data.character}\n📺 *Anime:* ${data.anime}`;
      await message.send(quoteText);
    } else {
      await message.sendReply("Error: Could not fetch anime quote.");
    }
  } catch (e) {
    if (e.response) {
      await message.sendReply(
        `API Error: ${e.response.status} - ${
          e.response.data?.message || "No message provided"
        }`
      );
    } else if (e.request) {
      await message.sendReply(
        "Network Error: API server not responding. Please try again later."
      );
    } else {
      await message.sendReply("Unexpected Error: Please try again later.");
    }
    console.log(e);
  }
});

// Anime Character Search command
Module({
  command: "achar",
  package: "anime",
  description: "Search Anime Character Information",
})(async (message, match) => {
  try {
    if (!match) return await message.sendReply("usage: achar <character name>");

    const query = match.trim();
    const apiUrl = `https://api.jikan.moe/v4/characters?q=${encodeURIComponent(
      query
    )}&limit=1`;
    const response = await axios.get(apiUrl);
    const data = response.data;

    if (data && data.data && data.data[0]) {
      const char = data.data[0];
      const charText = `👤 *Name:* ${char.name}\n📝 *About:* ${
        char.about
          ? char.about.substring(0, 500) + "..."
          : "No information available"
      }\n🔗 *URL:* ${char.url}`;

      await message.conn.sendMessage(message.from, {
        image: { url: char.images.jpg.image_url },
        caption: charText,
      });
    } else {
      await message.sendReply(
        "Character not found! Please try a different name."
      );
    }
  } catch (e) {
    if (e.response) {
      await message.sendReply(
        `API Error: ${e.response.status} - ${
          e.response.data?.message || "No message provided"
        }`
      );
    } else if (e.request) {
      await message.sendReply(
        "Network Error: API server not responding. Please try again later."
      );
    } else {
      await message.sendReply("Unexpected Error: Please try again later.");
    }
    console.log(e);
  }
});

// Anime Search command
Module({
  command: "asearch",
  package: "anime",
  description: "Search for Anime Information",
})(async (message, match) => {
  try {
    if (!match) return await message.sendReply("usage: asearch <anime name>");

    const query = match.trim();
    const apiUrl = `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(
      query
    )}&limit=1`;
    const response = await axios.get(apiUrl);
    const data = response.data;

    if (data && data.data && data.data[0]) {
      const anime = data.data[0];
      const animeText = `📺 *Title:* ${anime.title}\n⭐ *Rating:* ${
        anime.score || "N/A"
      }\n🎬 *Episodes:* ${anime.episodes || "Unknown"}\n📡 *Status:* ${
        anime.status
      }\n📅 *Year:* ${anime.year || "Unknown"}\n🎭 *Genres:* ${anime.genres
        .map((g) => g.name)
        .join(", ")}\n📝 *Synopsis:* ${
        anime.synopsis
          ? anime.synopsis.substring(0, 300) + "..."
          : "No synopsis available"
      }\n🔗 *URL:* ${anime.url}`;

      await message.conn.sendMessage(message.from, {
        image: { url: anime.images.jpg.image_url },
        caption: animeText,
      });
    } else {
      await message.sendReply("Anime not found! Please try a different name.");
    }
  } catch (e) {
    if (e.response) {
      await message.sendReply(
        `API Error: ${e.response.status} - ${
          e.response.data?.message || "No message provided"
        }`
      );
    } else if (e.request) {
      await message.sendReply(
        "Network Error: API server not responding. Please try again later."
      );
    } else {
      await message.sendReply("Unexpected Error: Please try again later.");
    }
    console.log(e);
  }
});

// Anime Recommendations command
Module({
  command: "arecommend",
  package: "anime",
  description: "Get Top Anime Recommendations",
})(async (message, match) => {
  try {
    const apiUrl = "https://api.jikan.moe/v4/top/anime?limit=5";
    const response = await axios.get(apiUrl);
    const data = response.data;

    if (data && data.data && data.data.length > 0) {
      let recText = "🌟 *TOP ANIME RECOMMENDATIONS:*\n\n";
      data.data.forEach((anime, index) => {
        recText += `${index + 1}. *${anime.title}*\n⭐ Rating: ${
          anime.score
        }\n📺 Episodes: ${anime.episodes || "Unknown"}\n🎭 ${anime.genres
          .slice(0, 3)
          .map((g) => g.name)
          .join(", ")}\n\n`;
      });
      recText += "> Use .asearch [anime name] for more details!";

      await message.send(recText);
    } else {
      await message.sendReply("Error: Could not fetch anime recommendations.");
    }
  } catch (e) {
    if (e.response) {
      await message.sendReply(
        `API Error: ${e.response.status} - ${
          e.response.data?.message || "No message provided"
        }`
      );
    } else if (e.request) {
      await message.sendReply(
        "Network Error: API server not responding. Please try again later."
      );
    } else {
      await message.sendReply("Unexpected Error: Please try again later.");
    }
    console.log(e);
  }
});

// Shinobu command
Module({
  command: "shinobu",
  package: "anime",
  description: "Download Shinobu Anime Images",
})(async (message, match) => {
  try {
    const apiUrl = "https://api.waifu.pics/sfw/shinobu";
    const response = await axios.get(apiUrl);
    const data = response.data;

    if (data && data.url) {
      await message.conn.sendMessage(message.from, {
        image: { url: data.url },
        caption: "> Here is your Shinobu anime image! 🦋",
      });
    } else {
      await message.send("Error: Could not fetch image from API.");
    }
  } catch (e) {
    if (e.response) {
      await message.send(
        `API Error: ${e.response.status} - ${
          e.response.data?.message || "No message provided"
        }`
      );
    } else if (e.request) {
      await message.send(
        "Network Error: API server not responding. Please try again later."
      );
    } else {
      await message.send("Unexpected Error: Please try again later.");
    }
    console.log(e);
  }
});
