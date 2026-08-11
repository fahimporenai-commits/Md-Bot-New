import { Module } from "../lib/plugins.js";
import config from "../config.js";
import { getTheme } from "../Themes/themes.js";
import fs from "fs";
import path from "path";
import os from "os";
import axios from "axios";
import FormData from "form-data";
const theme = getTheme();

// ==================== URL UPLOADER PLUGIN ====================

Module({
  command: "url",
  package: "converter",
  description: "Convert media to URL (upload to Catbox)",
})(async (message) => {
  try {
    // Check if there's a quoted message or current message has media
    const quotedMsg = message.quoted || message;
    const mimeType = quotedMsg.content?.mimetype || quotedMsg.type;

    if (!mimeType) {
      return message.send(
        "_Reply to an image, video, audio, or document_\n\n" +
          "*Supported:*\n" +
          "• Images (JPG, PNG, GIF)\n" +
          "• Videos (MP4, MKV)\n" +
          "• Audio (MP3, WAV)\n" +
          "• Documents"
      );
    }

    // Check if it's a supported media type
    const supportedTypes = [
      "imageMessage",
      "videoMessage",
      "audioMessage",
      "documentMessage",
      "stickerMessage",
    ];

    if (!supportedTypes.includes(quotedMsg.type)) {
      return message.send(
        "❌ _Unsupported media type. Reply to image, video, audio, or document_"
      );
    }

    await message.react("⏳");
    await message.send("_Uploading to Catbox... Please wait_");

    try {
      // Download the media
      const mediaBuffer = await quotedMsg.download();

      if (!mediaBuffer || mediaBuffer.length === 0) {
        throw new Error("Failed to download media");
      }

      // Create temporary file
      const tempFilePath = path.join(
        os.tmpdir(),
        `catbox_upload_${Date.now()}`
      );
      fs.writeFileSync(tempFilePath, mediaBuffer);

      // Determine file extension
      let extension = "";
      const mime = quotedMsg.content?.mimetype || "";

      if (mime.includes("image/jpeg") || quotedMsg.type === "imageMessage") {
        extension = ".jpg";
      } else if (mime.includes("image/png")) {
        extension = ".png";
      } else if (mime.includes("image/gif")) {
        extension = ".gif";
      } else if (
        mime.includes("image/webp") ||
        quotedMsg.type === "stickerMessage"
      ) {
        extension = ".webp";
      } else if (
        mime.includes("video/mp4") ||
        quotedMsg.type === "videoMessage"
      ) {
        extension = ".mp4";
      } else if (mime.includes("video/mkv")) {
        extension = ".mkv";
      } else if (
        mime.includes("audio/mpeg") ||
        quotedMsg.type === "audioMessage"
      ) {
        extension = ".mp3";
      } else if (mime.includes("audio/wav")) {
        extension = ".wav";
      } else if (mime.includes("audio/ogg")) {
        extension = ".ogg";
      } else if (quotedMsg.content?.fileName) {
        const originalExt = path.extname(quotedMsg.content.fileName);
        extension = originalExt || ".bin";
      } else {
        extension = ".bin";
      }

      const fileName = `file_${Date.now()}${extension}`;

      // Prepare form data for Catbox
      const form = new FormData();
      form.append("fileToUpload", fs.createReadStream(tempFilePath), fileName);
      form.append("reqtype", "fileupload");

      // Upload to Catbox
      const response = await axios.post(
        "https://catbox.moe/user/api.php",
        form,
        {
          headers: {
            ...form.getHeaders(),
          },
          timeout: 30000, // 30 seconds timeout
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        }
      );

      // Clean up temp file
      fs.unlinkSync(tempFilePath);

      if (!response.data || response.data.includes("error")) {
        throw new Error("Upload failed: " + (response.data || "Unknown error"));
      }

      const mediaUrl = response.data.trim();

      // Determine media type for display
      let mediaType = "File";
      if (quotedMsg.type === "imageMessage" || mime.includes("image")) {
        mediaType = "Image";
      } else if (quotedMsg.type === "videoMessage" || mime.includes("video")) {
        mediaType = "Video";
      } else if (quotedMsg.type === "audioMessage" || mime.includes("audio")) {
        mediaType = "Audio";
      } else if (quotedMsg.type === "documentMessage") {
        mediaType = "Document";
      } else if (quotedMsg.type === "stickerMessage") {
        mediaType = "Sticker";
      }

      // Format file size
      const fileSize = formatBytes(mediaBuffer.length);

      // Send success message
      const resultMessage = `
╭━━━「 *UPLOAD SUCCESS* 」━━━┈⊷
┃
┃ ✅ *${mediaType} uploaded successfully*
┃
┃ *📊 Details:*
┃ • Type: ${mediaType}
┃ • Size: ${fileSize}
┃ • Format: ${extension.replace(".", "").toUpperCase()}
┃
┃ *🔗 URL:*
┃ ${mediaUrl}
┃
┃ _Link is permanent and can be shared_
┃
╰━━━━━━━━━━━━━━━━━━━┈⊷
      `.trim();

      await message.sendreply(resultMessage);
      await message.react("✅");
    } catch (uploadError) {
      console.error("Upload error:", uploadError);

      let errorMessage = "❌ *Upload Failed*\n\n";

      if (uploadError.code === "ETIMEDOUT") {
        errorMessage += "_Timeout: Catbox server is not responding_\n";
        errorMessage += "_Please try again later or check your connection_";
      } else if (uploadError.code === "ECONNABORTED") {
        errorMessage += "_Connection aborted_\n";
        errorMessage += "_File may be too large or connection issue_";
      } else if (uploadError.response?.status === 413) {
        errorMessage += "_File too large for upload_\n";
        errorMessage += "_Maximum size: 200MB_";
      } else {
        errorMessage += `_${
          uploadError.message || "Unknown error occurred"
        }_\n`;
        errorMessage += "_Please try again later_";
      }

      await message.send(errorMessage);
      await message.react("❌");
    }
  } catch (error) {
    console.error("URL command error:", error);
    await message.react("❌");
    await message.send(
      "❌ _Failed to process media. Make sure you replied to a valid media message_"
    );
  }
});
