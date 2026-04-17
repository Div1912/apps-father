import { BotContext } from "../../types";
import { projectService } from "../../services/project.service";
import { InlineKeyboard } from "grammy";

export async function projectsCommand(ctx: BotContext) {
  const from = ctx.from;
  if (!from) return;

  const { user } = await projectService.getOrCreateUser(from.id, from.username, from.first_name);
  const projects = await projectService.getProjectsByUser(user.id);

  if (projects.length === 0) {
    await ctx.reply(
      "📂 You don't have any projects yet.\n\nUse /newproject to create your first Mini App!",
    );
    return;
  }

  const keyboard = new InlineKeyboard();
  for (const p of projects) {
    const statusIcon = getStatusIcon(p.status);
    keyboard.text(`${statusIcon} ${p.name}`, `project:${p.id}`).row();
  }
  keyboard.text("➕ New Project", "new_project");

  await ctx.reply("📂 <b>Your Projects:</b>\n\nSelect a project to manage:", {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
}

function getStatusIcon(status: string): string {
  const icons: Record<string, string> = {
    created: "🆕",
    planning: "📝",
    building: "🔨",
    deployed: "✅",
    released: "🚀",
    error: "❌",
  };
  return icons[status] || "❓";
}
