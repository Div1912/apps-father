import { Bot } from "grammy";
import { BotContext, AttachedFile } from "../../types";
import { publishReport } from "../../services/telegraph.service";
import { projectService } from "../../services/project.service";
import { claudeService } from "../../services/claude.service";
import { agentService } from "../../services/agent.service";
import { billingService } from "../../services/billing.service";
import { config } from "../../config";
import { planActionKeyboard, projectActionsKeyboard } from "../keyboards";
import { commitService } from "../../services/commit.service";
import { hasPendingForChat, resolveByChat, setPending } from "../agent-questions";
import { getProjectFeatures } from "../../services/features.service";
import { processMessage, doneMessage, errorMessage, costLine, truncSummary, mdToTgHtml, checklistMessage, ChecklistItem } from "../progress";
import { EMOJI, ce } from "../emoji";
import { formatPlanForUser } from "../plan-formatter";
import { Lang, t } from "../i18n";
import fs from "fs";
import path from "path";
import https from "https";
import http from "http";

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function getLang(ctx: BotContext): Lang {
  return ctx.session.language || "en";
}

import { processingProjects } from "../processing";
const PROJECTS_DIR = path.join(process.cwd(), "projects");

const tgApi = (method: string, body: any) =>
  fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});

function createConvAskUser(projectId: string, chatId: number, statusMsgId: number, lang: Lang = "en") {
  return async (question: string, options: string[]): Promise<string> => {
    const answer = await new Promise<string>((resolve) => {
      setPending(projectId, chatId, options, resolve);

      const keyboard: any[][] = options.map((opt, i) => [
        { text: opt, callback_data: `aq:${projectId}:${i}` },
      ]);
      keyboard.push([{ text: t(lang, "btn_skip"), callback_data: `aq:${projectId}:skip` }]);

      const questionHtml =
        `❓ <b>${t(lang, "ai_question")}</b>\n\n${esc(question)}` +
        (options.length === 0 ? `\n\n<i>${t(lang, "ai_question_hint")}</i>` : "");

      tgApi("editMessageText", {
        chat_id: chatId,
        message_id: statusMsgId,
        text: questionHtml,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboard },
      });
    });

    await tgApi("editMessageText", {
      chat_id: chatId,
      message_id: statusMsgId,
      text: processMessage(t(lang, "continuing"), undefined, lang),
      parse_mode: "HTML",
    });

    return answer;
  };
}

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
  const lang = getLang(ctx);
  return ctx.reply(
    `📎 ${t(lang, "file_saved", { path: esc(projectPath) })}`,
    { parse_mode: "HTML" }
  );
}

export function registerConversationHandlers(bot: Bot<BotContext>) {
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
      await ctx.reply(`❌ ${t(getLang(ctx), "file_download_failed")}`);
    }
  });

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
      await ctx.reply(`❌ ${t(getLang(ctx), "file_doc_failed")}`);
    }
  });

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
      await ctx.reply(`❌ ${t(getLang(ctx), "file_audio_failed")}`);
    }
  });

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
      await ctx.reply(`❌ ${t(getLang(ctx), "file_video_failed")}`);
    }
  });

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
      await ctx.reply(`❌ ${t(getLang(ctx), "file_voice_failed")}`);
    }
  });

  bot.on("message:text", async (ctx) => {
    const session = ctx.session;
    const text = ctx.message.text;

    if (ctx.chat && hasPendingForChat(ctx.chat.id)) {
      if (resolveByChat(ctx.chat.id, text, ctx.message.date)) {
        return;
      }
    }

    if (!session.awaitingInput && ctx.from) {
      const user = await projectService.getOrCreateUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
      const projects = await projectService.getProjectsByUser(user.id);
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
  const lang = getLang(ctx);

  const from = ctx.from!;
  const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);

  if (!(await billingService.hasBalance(user.id))) {
    await ctx.reply(
      errorMessage(t(lang, "insufficient_balance"), lang),
      { parse_mode: "HTML" }
    );
    ctx.session.awaitingInput = "description";
    return;
  }

  await projectService.updateProjectDescription(projectId, description);

  const statusMsg = await ctx.reply(processMessage(t(lang, "generating_plan"), undefined, lang), { parse_mode: "HTML" });

  try {
    const assets = await projectService.getProjectAssets(projectId);
    const assetPaths = assets.map((a) => a.filePath).filter(Boolean) as string[];

    const result = await claudeService.generatePlan(description, assetPaths, lang);
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
      `${ce(EMOJI.idea)} <b>${t(lang, "plan_title")}</b>\n\n${formatPlanForUser(result.plan)}\n\n${costLine(usage.costUsd, usage.newBalance, lang)}`,
      {
        parse_mode: "HTML",
        reply_markup: planActionKeyboard(projectId, lang),
      }
    );
  } catch (err) {
    console.error("[Conversation] Error generating plan:", err);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      statusMsg.message_id,
      errorMessage(t(lang, "plan_error"), lang),
      { parse_mode: "HTML" }
    );
    ctx.session.awaitingInput = "description";
  }
}

async function handlePlanFeedback(ctx: BotContext, projectId: string, feedback: string) {
  ctx.session.awaitingInput = null;
  const lang = getLang(ctx);

  const from = ctx.from!;
  const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);

  if (!(await billingService.hasBalance(user.id))) {
    await ctx.reply(
      errorMessage(t(lang, "insufficient_balance"), lang),
      { parse_mode: "HTML" }
    );
    ctx.session.awaitingInput = "plan_feedback";
    return;
  }

  const project = await projectService.getProject(projectId);
  if (!project) return;

  const statusMsg = await ctx.reply(processMessage(t(lang, "updating_plan"), undefined, lang), { parse_mode: "HTML" });

  try {
    const updatedDescription = `${project.description}\n\nAdditional feedback: ${feedback}`;
    const result = await claudeService.generatePlan(updatedDescription, undefined, lang);
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
      `${ce(EMOJI.idea)} <b>${t(lang, "plan_updated")}</b>\n\n${formatPlanForUser(result.plan)}\n\n${costLine(usage.costUsd, usage.newBalance, lang)}`,
      {
        parse_mode: "HTML",
        reply_markup: planActionKeyboard(projectId, lang),
      }
    );
  } catch (err) {
    console.error("[Conversation] Error updating plan:", err);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      statusMsg.message_id,
      errorMessage(t(lang, "plan_update_error"), lang),
      { parse_mode: "HTML" }
    );
    ctx.session.awaitingInput = "plan_feedback";
  }
}

async function handleUpdateDescription(ctx: BotContext, projectId: string, updateText: string, attachments?: AttachedFile[]) {
  ctx.session.awaitingInput = null;
  const lang = getLang(ctx);

  const from = ctx.from!;
  const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);

  if (!(await billingService.hasBalance(user.id, 5))) {
    await ctx.reply(
      errorMessage(t(lang, "balance_required_5_update"), lang),
      { parse_mode: "HTML" }
    );
    ctx.session.awaitingInput = "update_description";
    return;
  }

  if (processingProjects.has(projectId)) {
    await ctx.reply(errorMessage(t(lang, "already_processing"), lang), { parse_mode: "HTML" });
    return;
  }

  processingProjects.add(projectId);

  let checklistItems: string[] = [];
  try {
    checklistItems = await agentService.generateChecklist(updateText, undefined, lang);
  } catch {}

  const items: ChecklistItem[] = checklistItems.map(t => ({ text: t, done: false }));
  const useChecklist = items.length > 0;

  const statusMsg = await ctx.reply(
    useChecklist
      ? checklistMessage(t(lang, "updating_app"), items, undefined, lang)
      : processMessage(t(lang, "starting_agent"), undefined, lang),
    { parse_mode: "HTML" },
  );
  let lastUpdate = Date.now();

  try {
    await projectService.updateProjectStatus(projectId, "building");

    const onCheckTodo = useChecklist ? async (id: number) => {
      if (id >= 1 && id <= items.length) {
        items[id - 1].done = true;
        try {
          await ctx.api.editMessageText(
            ctx.chat!.id,
            statusMsg.message_id,
            checklistMessage(t(lang, "updating_app"), items, undefined, lang),
            { parse_mode: "HTML" }
          );
          lastUpdate = Date.now();
        } catch {}
      }
    } : undefined;

    const progress = async (p: { action: string; detail: string; percent?: number }) => {
      if (Date.now() - lastUpdate < 2000) return;
      lastUpdate = Date.now();
      try {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          statusMsg.message_id,
          useChecklist
            ? checklistMessage(t(lang, "updating_app"), items, `${p.action} ${esc(p.detail)}`, lang)
            : processMessage(`${p.action} ${esc(p.detail)}`, p.percent, lang),
          { parse_mode: "HTML" }
        );
      } catch {}
    };

    const askUser = createConvAskUser(projectId, ctx.chat!.id, statusMsg.message_id, lang);
    const result = await agentService.updateApp(projectId, updateText, progress, attachments, askUser, useChecklist ? checklistItems : undefined, onCheckTodo, lang);

    const usage = await billingService.recordUsage(
      user.id, projectId, result.model,
      { input_tokens: result.inputTokens, output_tokens: result.outputTokens, cache_creation_input_tokens: result.cacheWriteTokens, cache_read_input_tokens: result.cacheReadTokens },
      "update"
    );

    await projectService.updateProjectStatus(projectId, "deployed");

    try {
      await commitService.createCommit(projectId, `Update: ${updateText.substring(0, 80)}`, result.logPath);
    } catch (commitErr) {
      console.error("[Conversation] Commit error:", commitErr);
    }
    try { await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id); } catch {}

    try {
      const reportUrl = await publishReport(
        t(lang, "app_updated"),
        result.summary,
        `${t(lang, "cost_label")} $${usage.costUsd.toFixed(4)} | ${t(lang, "balance_label")} $${usage.newBalance.toFixed(2)}`
      );
      await ctx.reply(
        doneMessage(t(lang, "app_updated"), `${costLine(usage.costUsd, usage.newBalance, lang)}\n\n<a href="${reportUrl}">${t(lang, "view_report")}</a>`),
        {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [
            [{ text: t(lang, "btn_open_app"), callback_data: `dash:${projectId}` }],
          ]},
        }
      );
    } catch (reportErr) {
      console.error("[Conversation] Telegraph report error:", reportErr);
      const updatedProject = await projectService.getProject(projectId);
      await ctx.reply(
        doneMessage(t(lang, "app_updated"), `${mdToTgHtml(truncSummary(result.summary, 2000, lang))}\n\n${costLine(usage.costUsd, usage.newBalance, lang)}`),
        {
          parse_mode: "HTML",
          reply_markup: projectActionsKeyboard(projectId, "deployed", await getProjectFeatures(projectId), updatedProject?.botUsername || undefined, lang),
        }
      );
    }
  } catch (err) {
    console.error("[Conversation] Error updating app:", err);
    await projectService.updateProjectStatus(projectId, "error");
    await ctx.api.editMessageText(
      ctx.chat!.id,
      statusMsg.message_id,
      errorMessage(t(lang, "update_error"), lang),
      { parse_mode: "HTML" }
    ).catch(() => {});
    ctx.session.awaitingInput = "update_description";
  } finally {
    processingProjects.delete(projectId);
  }
}

async function handleTopupAmount(ctx: BotContext, text: string) {
  ctx.session.awaitingInput = null;
  const lang = getLang(ctx);

  const amount = parseFloat(text.replace(/[^0-9.]/g, ""));
  if (isNaN(amount) || amount < 10) {
    await ctx.reply(
      errorMessage(t(lang, "topup_min_error"), lang),
      { parse_mode: "HTML" }
    );
    ctx.session.awaitingInput = "topup_amount";
    return;
  }

  await ctx.reply(
    `${ce(EMOJI.dollar, "💲")} <b>${t(lang, "btn_topup")} $${amount.toFixed(2)}</b>\n\n` +
    t(lang, "topup_choose_method"),
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: t(lang, "btn_crypto_bot"), callback_data: `cryptobot_pay:${amount.toFixed(2)}`, icon_custom_emoji_id: EMOJI.crypto_bot },
            { text: t(lang, "btn_other_crypto"), callback_data: `nowpay:${amount.toFixed(2)}`, icon_custom_emoji_id: EMOJI.usdt },
          ],
          [
            { text: t(lang, "btn_stars"), callback_data: `stars_pay:${amount.toFixed(2)}`, icon_custom_emoji_id: EMOJI.stars },
          ],
          [{ text: t(lang, "btn_cancel"), callback_data: "nav_welcome" }],
        ],
      },
    }
  );
}


async function handleTonWallet(ctx: BotContext, projectId: string, address: string) {
  ctx.session.awaitingInput = null;
  const lang = getLang(ctx);
  const trimmed = address.trim();

  if (!/^(UQ|EQ|0:)[A-Za-z0-9_\-+/]{30,}$/.test(trimmed)) {
    await ctx.reply(
      errorMessage(t(lang, "wallet_invalid"), lang),
      { parse_mode: "HTML" }
    );
    ctx.session.awaitingInput = "ton_wallet";
    return;
  }

  try {
    await projectService.setTonWallet(projectId, trimmed);
    await ctx.reply(
      doneMessage(t(lang, "wallet_saved"), t(lang, "wallet_saved_detail", { address: esc(trimmed) })),
      { parse_mode: "HTML" }
    );
  } catch (err) {
    console.error("[Conversation] Error saving wallet:", err);
    await ctx.reply(
      errorMessage(t(lang, "wallet_error"), lang),
      { parse_mode: "HTML" }
    );
    ctx.session.awaitingInput = "ton_wallet";
  }
}

async function handleTransferOwner(ctx: BotContext, projectId: string, username: string) {
  ctx.session.awaitingInput = null;
  const lang = getLang(ctx);
  const trimmed = username.trim().replace(/^@/, "");

  if (!trimmed) {
    await ctx.reply(
      errorMessage(t(lang, "transfer_invalid"), lang),
      { parse_mode: "HTML" }
    );
    ctx.session.awaitingInput = "transfer_owner";
    return;
  }

  try {
    const targetUser = await projectService.getUserByUsername(trimmed);
    if (!targetUser) {
      await ctx.reply(
        errorMessage(t(lang, "transfer_not_found", { username: esc(trimmed) }), lang),
        { parse_mode: "HTML" }
      );
      ctx.session.awaitingInput = "transfer_owner";
      return;
    }

    const from = ctx.from!;
    const currentUser = await projectService.getOrCreateUser(from.id, from.username, from.first_name);
    if (targetUser.id === currentUser.id) {
      await ctx.reply(
        errorMessage(t(lang, "transfer_self"), lang),
        { parse_mode: "HTML" }
      );
      ctx.session.awaitingInput = "transfer_owner";
      return;
    }

    const project = await projectService.getProject(projectId);
    if (!project) return;

    await ctx.reply(
      `${ce(EMOJI.indicator_warning)} <b>${t(lang, "transfer_confirm")}</b>\n\n` +
      `${t(lang, "transfer_confirm_body", { name: esc(project.name), username: esc(trimmed) })}\n\n` +
      `<blockquote>${t(lang, "transfer_warning")}</blockquote>`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: t(lang, "btn_confirm_transfer"), callback_data: `confirm_transfer:${projectId}:${targetUser.id}` }],
            [{ text: t(lang, "btn_cancel"), callback_data: `project:${projectId}` }],
          ],
        },
      }
    );
  } catch (err) {
    console.error("[Conversation] Error finding user for transfer:", err);
    await ctx.reply(
      errorMessage(t(lang, "transfer_error"), lang),
      { parse_mode: "HTML" }
    );
    ctx.session.awaitingInput = "transfer_owner";
  }
}
