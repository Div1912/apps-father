import { Bot } from "grammy";
import { BotContext, AttachedFile } from "../../types";
import { projectService } from "../../services/project.service";
import { claudeService } from "../../services/claude.service";
import { agentService } from "../../services/agent.service";
import { billingService } from "../../services/billing.service";
import { config } from "../../config";
import { planActionKeyboard, projectActionsKeyboard } from "../keyboards";
import { commitService } from "../../services/commit.service";
import { getProjectFeatures } from "../../services/features.service";
import { processMessage, doneMessage, errorMessage, costLine, truncSummary, mdToTgHtml } from "../progress";
import { EMOJI, ce } from "../emoji";
import { formatPlanForUser } from "../plan-formatter";
import fs from "fs";
import path from "path";
import https from "https";
import http from "http";

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

import { processingProjects } from "../processing";
const PROJECTS_DIR = path.join(process.cwd(), "projects");

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const client = url.startsWith("https") ? https : http;
    client.get(url, (response) => {
      response.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
    }).on("error", (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

async function downloadTelegramFile(
  ctx: BotContext,
  fileId: string,
  projectId: string,
  suggestedName: string,
): Promise<AttachedFile> {
  const tgFile = await ctx.api.getFile(fileId);
  if (!tgFile.file_path) throw new Error("Could not get file path");

  const ext = path.extname(tgFile.file_path) || path.extname(suggestedName) || "";
  const fileName = `upload_${Date.now()}${ext}`;
  const assetsDir = path.join(PROJECTS_DIR, projectId, "frontend", "assets");
  fs.mkdirSync(assetsDir, { recursive: true });

  const localPath = path.join(assetsDir, fileName);
  const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${tgFile.file_path}`;
  await downloadFile(fileUrl, localPath);

  return {
    localPath,
    projectPath: `frontend/assets/${fileName}`,
    originalName: suggestedName || fileName,
  };
}

const ATTACH_STATES = ["update_description", "attach_files"] as const;

function isAttachState(state: string | null | undefined): boolean {
  return state === "update_description" || state === "attach_files";
}

function fileSavedReply(ctx: BotContext, projectPath: string) {
  return ctx.reply(
    `📎 File saved: <code>${esc(projectPath)}</code>\n\nSend more files, or type your update description to continue.`,
    { parse_mode: "HTML" }
  );
}

export function registerConversationHandlers(bot: Bot<BotContext>) {
  // Handle photos
  bot.on("message:photo", async (ctx) => {
    const session = ctx.session;
    if (!isAttachState(session.awaitingInput) || !session.activeProjectId) return;

    const projectId = session.activeProjectId;
    const photo = ctx.message.photo;
    const largest = photo[photo.length - 1];

    try {
      const attached = await downloadTelegramFile(ctx, largest.file_id, projectId, "photo.jpg");
      if (ctx.message.caption) attached.caption = ctx.message.caption;
      if (!session.pendingAttachments) session.pendingAttachments = [];
      session.pendingAttachments.push(attached);
      await fileSavedReply(ctx, attached.projectPath);
    } catch (err) {
      console.error("[Conversation] Error downloading photo:", err);
      await ctx.reply("❌ Failed to download photo. Please try again.");
    }
  });

  // Handle documents
  bot.on("message:document", async (ctx) => {
    const session = ctx.session;
    if (!isAttachState(session.awaitingInput) || !session.activeProjectId) return;

    const projectId = session.activeProjectId;
    const doc = ctx.message.document;

    try {
      const attached = await downloadTelegramFile(ctx, doc.file_id, projectId, doc.file_name || "file");
      if (ctx.message.caption) attached.caption = ctx.message.caption;
      if (!session.pendingAttachments) session.pendingAttachments = [];
      session.pendingAttachments.push(attached);
      await fileSavedReply(ctx, attached.projectPath);
    } catch (err) {
      console.error("[Conversation] Error downloading document:", err);
      await ctx.reply("❌ Failed to download file. Please try again.");
    }
  });

  // Handle audio files
  bot.on("message:audio", async (ctx) => {
    const session = ctx.session;
    if (!isAttachState(session.awaitingInput) || !session.activeProjectId) return;

    const projectId = session.activeProjectId;
    const audio = ctx.message.audio;

    try {
      const attached = await downloadTelegramFile(ctx, audio.file_id, projectId, audio.file_name || "audio.mp3");
      if (ctx.message.caption) attached.caption = ctx.message.caption;
      if (!session.pendingAttachments) session.pendingAttachments = [];
      session.pendingAttachments.push(attached);
      await fileSavedReply(ctx, attached.projectPath);
    } catch (err) {
      console.error("[Conversation] Error downloading audio:", err);
      await ctx.reply("❌ Failed to download audio. Please try again.");
    }
  });

  // Handle video files
  bot.on("message:video", async (ctx) => {
    const session = ctx.session;
    if (!isAttachState(session.awaitingInput) || !session.activeProjectId) return;

    const projectId = session.activeProjectId;
    const video = ctx.message.video;

    try {
      const attached = await downloadTelegramFile(ctx, video.file_id, projectId, video.file_name || "video.mp4");
      if (ctx.message.caption) attached.caption = ctx.message.caption;
      if (!session.pendingAttachments) session.pendingAttachments = [];
      session.pendingAttachments.push(attached);
      await fileSavedReply(ctx, attached.projectPath);
    } catch (err) {
      console.error("[Conversation] Error downloading video:", err);
      await ctx.reply("❌ Failed to download video. Please try again.");
    }
  });

  // Handle voice messages
  bot.on("message:voice", async (ctx) => {
    const session = ctx.session;
    if (!isAttachState(session.awaitingInput) || !session.activeProjectId) return;

    const projectId = session.activeProjectId;
    const voice = ctx.message.voice;

    try {
      const attached = await downloadTelegramFile(ctx, voice.file_id, projectId, `voice_${Date.now()}.ogg`);
      if (!session.pendingAttachments) session.pendingAttachments = [];
      session.pendingAttachments.push(attached);
      await fileSavedReply(ctx, attached.projectPath);
    } catch (err) {
      console.error("[Conversation] Error downloading voice:", err);
      await ctx.reply("❌ Failed to download voice message. Please try again.");
    }
  });

  bot.on("message:text", async (ctx) => {
    const session = ctx.session;
    const text = ctx.message.text;

    // Fallback: if no active session, check if user has a project awaiting description
    if (!session.awaitingInput && ctx.from) {
      const user = await projectService.getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
      const projects = await projectService.getProjectsByUser(user.id);
      // Find newest project in "planning" state with no description (created in last hour)
      const pending = projects.find((p) => {
        const age = Date.now() - new Date(p.createdAt).getTime();
        return p.status === "planning" && !p.description && age < 3600_000;
      });
      if (pending) {
        session.awaitingInput = "description";
        session.activeProjectId = pending.id;
      }
    }

    if (!session.awaitingInput) return;

    // topup_amount doesn't need a project
    if (session.awaitingInput === "topup_amount") {
      await handleTopupAmount(ctx, text);
      return;
    }

    if (!session.activeProjectId) return;
    const projectId = session.activeProjectId;

    switch (session.awaitingInput) {
      case "description":
        await handleDescription(ctx, projectId, text);
        break;
      case "plan_feedback":
        await handlePlanFeedback(ctx, projectId, text);
        break;
      case "update_description":
      case "attach_files": {
        const attachments = ctx.session.pendingAttachments;
        ctx.session.pendingAttachments = undefined;
        await handleUpdateDescription(ctx, projectId, text, attachments);
        break;
      }
      case "version_name":
        break;
      case "ton_wallet":
        await handleTonWallet(ctx, projectId, text);
        break;
      case "transfer_owner":
        await handleTransferOwner(ctx, projectId, text);
        break;
    }
  });
}

async function handleDescription(ctx: BotContext, projectId: string, description: string) {
  ctx.session.awaitingInput = null;

  const from = ctx.from!;
  const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);

  if (!(await billingService.hasBalance(user.id))) {
    await ctx.reply(
      errorMessage("Insufficient balance. Please top up first."),
      { parse_mode: "HTML" }
    );
    ctx.session.awaitingInput = "description";
    return;
  }

  await projectService.updateProjectDescription(projectId, description);

  const statusMsg = await ctx.reply(processMessage("Generating plan..."), { parse_mode: "HTML" });

  try {
    const assets = await projectService.getProjectAssets(projectId);
    const assetPaths = assets.map((a) => a.filePath).filter(Boolean) as string[];

    const result = await claudeService.generatePlan(description, assetPaths);
    await projectService.updateProjectPlan(projectId, result.plan);

    const usage = await billingService.recordUsage(
      user.id, projectId, "claude-sonnet-4-6",
      { input_tokens: result.inputTokens, output_tokens: result.outputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      "plan"
    );

    ctx.session.pendingPlan = result.plan;
    ctx.session.pendingDescription = description;

    await ctx.api.editMessageText(
      ctx.chat!.id,
      statusMsg.message_id,
      `${ce(EMOJI.idea)} <b>Here's the plan for your app:</b>\n\n${formatPlanForUser(result.plan)}\n\n${costLine(usage.costUsd, usage.newBalance)}`,
      {
        parse_mode: "HTML",
        reply_markup: planActionKeyboard(projectId),
      }
    );
  } catch (err) {
    console.error("[Conversation] Error generating plan:", err);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      statusMsg.message_id,
      errorMessage("Failed to generate plan. Please try describing your app again."),
      { parse_mode: "HTML" }
    );
    ctx.session.awaitingInput = "description";
  }
}

async function handlePlanFeedback(ctx: BotContext, projectId: string, feedback: string) {
  ctx.session.awaitingInput = null;

  const from = ctx.from!;
  const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);

  if (!(await billingService.hasBalance(user.id))) {
    await ctx.reply(
      errorMessage("Insufficient balance. Please top up first."),
      { parse_mode: "HTML" }
    );
    ctx.session.awaitingInput = "plan_feedback";
    return;
  }

  const project = await projectService.getProject(projectId);
  if (!project) return;

  const statusMsg = await ctx.reply(processMessage("Updating plan..."), { parse_mode: "HTML" });

  try {
    const updatedDescription = `${project.description}\n\nAdditional feedback: ${feedback}`;
    const result = await claudeService.generatePlan(updatedDescription);
    await projectService.updateProjectPlan(projectId, result.plan);

    const usage = await billingService.recordUsage(
      user.id, projectId, "claude-sonnet-4-6",
      { input_tokens: result.inputTokens, output_tokens: result.outputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      "plan"
    );

    ctx.session.pendingPlan = result.plan;

    await ctx.api.editMessageText(
      ctx.chat!.id,
      statusMsg.message_id,
      `${ce(EMOJI.idea)} <b>Updated plan:</b>\n\n${formatPlanForUser(result.plan)}\n\n${costLine(usage.costUsd, usage.newBalance)}`,
      {
        parse_mode: "HTML",
        reply_markup: planActionKeyboard(projectId),
      }
    );
  } catch (err) {
    console.error("[Conversation] Error updating plan:", err);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      statusMsg.message_id,
      errorMessage("Failed to update plan. Please try again."),
      { parse_mode: "HTML" }
    );
    ctx.session.awaitingInput = "plan_feedback";
  }
}

async function handleUpdateDescription(ctx: BotContext, projectId: string, updateText: string, attachments?: AttachedFile[]) {
  ctx.session.awaitingInput = null;

  const from = ctx.from!;
  const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);

  if (!(await billingService.hasBalance(user.id, 5))) {
    await ctx.reply(
      errorMessage("Minimum <b>$5</b> balance required to update. Please top up first."),
      { parse_mode: "HTML" }
    );
    ctx.session.awaitingInput = "update_description";
    return;
  }

  if (processingProjects.has(projectId)) {
    await ctx.reply(errorMessage("This project is already being processed."), { parse_mode: "HTML" });
    return;
  }

  const statusMsg = await ctx.reply(processMessage("Starting AI Agent..."), { parse_mode: "HTML" });
  let lastUpdate = Date.now();
  processingProjects.add(projectId);

  try {
    await projectService.updateProjectStatus(projectId, "building");

    const progress = async (p: { action: string; detail: string; percent?: number }) => {
      if (Date.now() - lastUpdate < 2000) return;
      lastUpdate = Date.now();
      try {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          statusMsg.message_id,
          processMessage(`${p.action} ${esc(p.detail)}`, p.percent),
          { parse_mode: "HTML" }
        );
      } catch {}
    };

    const result = await agentService.updateApp(projectId, updateText, progress, attachments);

    const usage = await billingService.recordUsage(
      user.id, projectId, result.model,
      { input_tokens: result.inputTokens, output_tokens: result.outputTokens, cache_creation_input_tokens: result.cacheWriteTokens, cache_read_input_tokens: result.cacheReadTokens },
      "update"
    );

    await projectService.updateProjectStatus(projectId, "deployed");

    try {
      await commitService.createCommit(projectId, `Update: ${updateText.substring(0, 80)}`);
    } catch (commitErr) {
      console.error("[Conversation] Commit error:", commitErr);
    }
    const appUrl = `${config.baseUrl}/app/${projectId}/`;
    const updatedProject = await projectService.getProject(projectId);

    try {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        doneMessage("App updated!", `${mdToTgHtml(truncSummary(result.summary))}\n\n<blockquote>${appUrl}</blockquote>\n\n${costLine(usage.costUsd, usage.newBalance)}`),
        {
          parse_mode: "HTML",
          reply_markup: projectActionsKeyboard(projectId, "deployed", await getProjectFeatures(projectId), updatedProject?.botUsername || undefined),
        }
      );
    } catch (displayErr) {
      console.error("[Conversation] Display error (app is deployed):", displayErr);
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        doneMessage("App updated!", `<blockquote>${appUrl}</blockquote>\n\n${costLine(usage.costUsd, usage.newBalance)}`),
        {
          parse_mode: "HTML",
          reply_markup: projectActionsKeyboard(projectId, "deployed", await getProjectFeatures(projectId), updatedProject?.botUsername || undefined),
        }
      ).catch(() => {});
    }
  } catch (err) {
    console.error("[Conversation] Error updating app:", err);
    await projectService.updateProjectStatus(projectId, "error");
    await ctx.api.editMessageText(
      ctx.chat!.id,
      statusMsg.message_id,
      errorMessage("Failed to update app. Please try again."),
      { parse_mode: "HTML" }
    ).catch(() => {});
    ctx.session.awaitingInput = "update_description";
  } finally {
    processingProjects.delete(projectId);
  }
}

async function handleTopupAmount(ctx: BotContext, text: string) {
  ctx.session.awaitingInput = null;

  const amount = parseFloat(text.replace(/[^0-9.]/g, ""));
  if (isNaN(amount) || amount < 10) {
    await ctx.reply(
      errorMessage("Minimum top-up is <b>$10</b>. Please enter a valid amount."),
      { parse_mode: "HTML" }
    );
    ctx.session.awaitingInput = "topup_amount";
    return;
  }

  const from = ctx.from!;
  const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);

  try {
    const { invoiceUrl } = await billingService.createTopUp(user.id, amount);

    await ctx.reply(
      doneMessage(
        "Payment link created!",
        `Amount: <b>$${amount.toFixed(2)}</b>\n\nPay with any cryptocurrency via the link below.\nYour balance will be credited automatically after confirmation.`
      ),
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: `Pay $${amount.toFixed(2)}`, url: invoiceUrl }],
            [{ text: "Back", callback_data: "nav_welcome" }],
          ],
        },
      }
    );
  } catch (err) {
    console.error("[Conversation] Topup error:", err);
    await ctx.reply(
      errorMessage("Failed to create payment link. Please try again."),
      { parse_mode: "HTML" }
    );
  }
}


async function handleTonWallet(ctx: BotContext, projectId: string, address: string) {
  ctx.session.awaitingInput = null;
  const trimmed = address.trim();

  if (!/^(UQ|EQ|0:)[A-Za-z0-9_\-+/]{30,}$/.test(trimmed)) {
    await ctx.reply(
      errorMessage("Invalid TON wallet address.\n\nPlease send a valid address (starts with <code>UQ</code> or <code>EQ</code>):"),
      { parse_mode: "HTML" }
    );
    ctx.session.awaitingInput = "ton_wallet";
    return;
  }

  try {
    await projectService.setTonWallet(projectId, trimmed);
    await ctx.reply(
      doneMessage("Wallet saved!", `<b>Address:</b>\n<code>${esc(trimmed)}</code>\n\nYour app will receive TON payments to this wallet.`),
      { parse_mode: "HTML" }
    );
  } catch (err) {
    console.error("[Conversation] Error saving wallet:", err);
    await ctx.reply(
      errorMessage("Failed to save wallet. Please try again."),
      { parse_mode: "HTML" }
    );
    ctx.session.awaitingInput = "ton_wallet";
  }
}

async function handleTransferOwner(ctx: BotContext, projectId: string, username: string) {
  ctx.session.awaitingInput = null;
  const trimmed = username.trim().replace(/^@/, "");

  if (!trimmed) {
    await ctx.reply(
      errorMessage("Please enter a valid username."),
      { parse_mode: "HTML" }
    );
    ctx.session.awaitingInput = "transfer_owner";
    return;
  }

  try {
    const targetUser = await projectService.getUserByUsername(trimmed);
    if (!targetUser) {
      await ctx.reply(
        errorMessage(`User <b>@${esc(trimmed)}</b> not found.\n\nThey must have used Apps Father bot at least once.`),
        { parse_mode: "HTML" }
      );
      ctx.session.awaitingInput = "transfer_owner";
      return;
    }

    const from = ctx.from!;
    const currentUser = await projectService.getOrCreateUser(from.id, from.username, from.first_name);
    if (targetUser.id === currentUser.id) {
      await ctx.reply(
        errorMessage("You can't transfer to yourself."),
        { parse_mode: "HTML" }
      );
      ctx.session.awaitingInput = "transfer_owner";
      return;
    }

    const project = await projectService.getProject(projectId);
    if (!project) return;

    await ctx.reply(
      `${ce(EMOJI.indicator_warning)} <b>Confirm Transfer</b>\n\n` +
      `Transfer <b>${esc(project.name)}</b> to <b>@${esc(trimmed)}</b>?\n\n` +
      `<blockquote>This action cannot be undone. The new owner will have full control over this app.</blockquote>`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "Confirm Transfer", callback_data: `confirm_transfer:${projectId}:${targetUser.id}` }],
            [{ text: "Cancel", callback_data: `project:${projectId}` }],
          ],
        },
      }
    );
  } catch (err) {
    console.error("[Conversation] Error finding user for transfer:", err);
    await ctx.reply(
      errorMessage("Failed to look up user. Please try again."),
      { parse_mode: "HTML" }
    );
    ctx.session.awaitingInput = "transfer_owner";
  }
}
