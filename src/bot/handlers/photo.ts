import { Bot } from "grammy";
import fs from "fs";
import path from "path";
import https from "https";
import http from "http";
import { BotContext } from "../../types";
import { config } from "../../config";
import { projectService } from "../../services/project.service";

export function registerPhotoHandlers(bot: Bot<BotContext>) {
  bot.on("message:photo", async (ctx) => {
    const session = ctx.session;

    if (session.awaitingInput === "update_description" || session.awaitingInput === "attach_files") return;

    if (!session.activeProjectId) {
      await ctx.reply(
        "📸 Got your image! But you need to select a project first.\n" +
        "Use /projects to select one, then send images."
      );
      return;
    }

    const projectId = session.activeProjectId;
    const photo = ctx.message.photo;
    const largestPhoto = photo[photo.length - 1];

    try {
      const file = await ctx.api.getFile(largestPhoto.file_id);
      if (!file.file_path) {
        await ctx.reply("❌ Could not download the image.");
        return;
      }

      const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
      const ext = path.extname(file.file_path) || ".jpg";
      const fileName = `asset_${Date.now()}${ext}`;

      const assetsDir = path.join(process.cwd(), "projects", projectId, "frontend", "assets");
      fs.mkdirSync(assetsDir, { recursive: true });

      const localPath = path.join(assetsDir, fileName);

      await downloadFile(fileUrl, localPath);

      const caption = ctx.message.caption || undefined;
      await projectService.saveAsset(
        projectId,
        largestPhoto.file_id,
        localPath,
        fileName,
        caption
      );

      await ctx.reply(
        `✅ Image saved as \`${fileName}\`\n` +
        `${caption ? `Description: ${caption}\n` : ""}` +
        `It will be available in your app at \`/assets/${fileName}\``,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      console.error("[Photo] Error saving image:", err);
      await ctx.reply("❌ Failed to save image. Please try again.");
    }
  });
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const client = url.startsWith("https") ? https : http;
    client.get(url, (response) => {
      response.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve();
      });
    }).on("error", (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}
