import { Bot } from "grammy";
import { BotContext } from "../../types";
import { projectService } from "../../services/project.service";
import { claudeService } from "../../services/claude.service";
import { agentService } from "../../services/agent.service";
import { billingService } from "../../services/billing.service";
import { config } from "../../config";
import {
  projectActionsKeyboard,
  planActionKeyboard,
  suggestionsKeyboard,
  projectListKeyboard,
  welcomeKeyboard,
  helpKeyboard,
  removeConfirmKeyboard,
  featuresKeyboard,
  confirmBuyKeyboard,
  settingsKeyboard,
  qualityKeyboard,
  versionsKeyboard,
  revertConfirmKeyboard,
} from "../keyboards";
import { commitService } from "../../services/commit.service";
import { setPending, resolveByProject, getPendingByProject } from "../agent-questions";
import { getProjectFeatures, getFeatureById, purchaseFeature, PAID_FEATURES } from "../../services/features.service";
import { decryptToken } from "../../services/crypto.service";
import { prisma } from "../../db";
import { processMessage, doneMessage, errorMessage, costLine, truncSummary, mdToTgHtml } from "../progress";
import { EMOJI, ce, statusIndicator } from "../emoji";
import { getNavWelcomeText } from "../commands/start";

import fs from "fs";
import path from "path";

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function qualityDescription(): string {
  return (
    `<b>Good</b> — Sonnet 4.6, 60 iterations\n` +
    `<b>Better</b> — Sonnet 4.6+, 100 iterations\n` +
    `<b>Best</b> — Opus 4.6, 60 iterations\n` +
    `<b>The Best</b> — Opus 4.6+, 100 iterations`
  );
}

async function ack(ctx: any) {
  try { await ctx.answerCallbackQuery(); } catch {}
}

import { processingProjects } from "../processing";

const tgApi = (method: string, body: any) =>
  fetch(`https://api.telegram.org/bot${config.botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});

function createAskUser(projectId: string, chatId: number, statusMsgId: number) {
  return async (question: string, options: string[]): Promise<string> => {
    const answer = await new Promise<string>((resolve) => {
      setPending(projectId, chatId, options, resolve);

      const keyboard: any[][] = options.map((opt, i) => [
        { text: opt, callback_data: `aq:${projectId}:${i}` },
      ]);
      keyboard.push([{ text: "Skip", callback_data: `aq:${projectId}:skip` }]);

      const questionHtml =
        `❓ <b>Question from AI:</b>\n\n${esc(question)}` +
        (options.length === 0 ? "\n\n<i>Type your answer below, or press Skip.</i>" : "");

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
      text: processMessage("Continuing..."),
      parse_mode: "HTML",
    });

    return answer;
  };
}

function buildListText(projects: { name: string; status: string }[], slotUsed?: number, slotTotal?: number): string {
  const slotLine = typeof slotUsed === "number" && typeof slotTotal === "number"
    ? `\n📱 <b>App Slots: ${slotUsed}/${slotTotal}</b>\n` : "";
  let text = `${ce(EMOJI.list)} <b>Your Projects:</b>${slotLine}\n`;
  for (const p of projects) {
    text += `${statusIndicator(p.status)} <b>${esc(p.name)}</b> — ${p.status}\n`;
  }
  return text;
}

const HELP_TEXT =
  `${ce(EMOJI.help)} <b>Apps Father Help</b>\n\n` +
  `I create Telegram Mini Apps for you using AI.\n\n` +
  `<b>How it works:</b>\n` +
  `1. Create a new project\n` +
  `2. A new bot will be created for your app\n` +
  `3. Describe what your app should do\n` +
  `4. I'll generate a plan for you to review\n` +
  `5. Approve the plan and I'll build the app\n` +
  `6. Test your app via the bot's Launch button\n` +
  `7. Request updates and improvements anytime\n\n` +
  `<b>Features:</b>\n` +
  `• AI-generated Mini Apps with database &amp; backend\n` +
  `• Send images to use as design references\n` +
  `• AI-powered improvement suggestions\n` +
  `• Version management &amp; releases\n` +
  `• Admin analytics panel for each project`;

export function registerCallbackHandlers(bot: Bot<BotContext>) {

  // ── Navigation (edits the current message) ──

  bot.callbackQuery("nav_welcome", async (ctx) => {
    await ack(ctx);
    const from = ctx.from;
    const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);
    const balance = await billingService.getUserBalance(user.id);
    await ctx.editMessageText(getNavWelcomeText(balance), {
      parse_mode: "HTML",
      reply_markup: welcomeKeyboard(),
    });
  });

  bot.callbackQuery("nav_list", async (ctx) => {
    await ack(ctx);
    const from = ctx.from;
    const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);
    const [projects, slots] = await Promise.all([
      projectService.getProjectsByUser(user.id),
      projectService.getUserSlotInfo(user.id),
    ]);

    if (projects.length === 0) {
      await ctx.editMessageText("You don't have any projects yet.", {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "Back", callback_data: "nav_welcome" }]] },
      });
      return;
    }

    await ctx.editMessageText(buildListText(projects, slots.used, slots.total), {
      parse_mode: "HTML",
      reply_markup: projectListKeyboard(projects, slots.used < slots.total),
    });
  });

  bot.callbackQuery("my_projects", async (ctx) => {
    await ack(ctx);
    const from = ctx.from;
    const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);
    const [projects, slots] = await Promise.all([
      projectService.getProjectsByUser(user.id),
      projectService.getUserSlotInfo(user.id),
    ]);

    if (projects.length === 0) {
      await ctx.editMessageText("You don't have any projects yet.", {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "Back", callback_data: "nav_welcome" }]] },
      });
      return;
    }

    await ctx.editMessageText(buildListText(projects, slots.used, slots.total), {
      parse_mode: "HTML",
      reply_markup: projectListKeyboard(projects, slots.used < slots.total),
    });
  });

  bot.callbackQuery("help", async (ctx) => {
    await ack(ctx);
    await ctx.editMessageText(HELP_TEXT, {
      parse_mode: "HTML",
      reply_markup: helpKeyboard(),
    });
  });

  bot.callbackQuery("topup", async (ctx) => {
    await ack(ctx);
    ctx.session.awaitingInput = "topup_amount";
    ctx.session.activeProjectId = undefined;
    await ctx.reply(
      `${ce(EMOJI.dollar, "💲")} <b>Top Up Balance</b>\n\n` +
      `Enter the amount in USD you'd like to add (minimum <b>$10</b>):\n\n` +
      `<blockquote>You can pay with any cryptocurrency via NOWPayments.\nYour balance will be credited after blockchain confirmation.</blockquote>`,
      { parse_mode: "HTML" }
    );
  });

  bot.callbackQuery("buy_slot", async (ctx) => {
    await ack(ctx);
    const from = ctx.from;
    const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);
    const balance = await billingService.getUserBalance(user.id);
    const slots = await projectService.getUserSlotInfo(user.id);

    await ctx.editMessageText(
      `${ce(EMOJI.add, "📱")} <b>Buy App Slot</b>\n\n` +
      `You currently have <b>${slots.used}/${slots.total}</b> app slots used.\n\n` +
      `Price: <b>$25</b>\n` +
      `Your balance: <b>$${balance.toFixed(2)}</b>\n\n` +
      (balance >= 25
        ? "This will add one more app slot to your account."
        : `⚠️ Insufficient balance. You need <b>$${(25 - balance).toFixed(2)}</b> more.`),
      {
        parse_mode: "HTML",
        reply_markup: balance >= 25
          ? { inline_keyboard: [
              [{ text: "Confirm — $25", callback_data: "confirm_slot", icon_custom_emoji_id: EMOJI.indicator_success }],
              [{ text: "Cancel", callback_data: "nav_welcome" }],
            ]}
          : { inline_keyboard: [
              [{ text: "Top Up", callback_data: "topup" }],
              [{ text: "Cancel", callback_data: "nav_welcome" }],
            ]},
      }
    );
  });

  bot.callbackQuery("confirm_slot", async (ctx) => {
    await ack(ctx);
    const from = ctx.from;
    const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);
    try {
      const { newSlots, newBalance } = await projectService.buySlot(user.id);
      const slots = await projectService.getUserSlotInfo(user.id);
      await ctx.editMessageText(
        `${ce(EMOJI.indicator_success, "✅")} <b>App slot purchased!</b>\n\n` +
        `<blockquote>Charged: <b>$25</b>\nNew balance: <b>$${newBalance.toFixed(2)}</b>\nApp slots: <b>${slots.used}/${newSlots}</b></blockquote>`,
        {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "Back", callback_data: "nav_welcome" }]] },
        }
      );
    } catch (err: any) {
      await ctx.editMessageText(
        errorMessage(err.message || "Failed to buy slot"),
        { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Back", callback_data: "nav_welcome" }]] } }
      );
    }
  });

  bot.callbackQuery(/^project:(.+)$/, async (ctx) => {
    await ack(ctx);
    const projectId = ctx.match[1];
    const project = await projectService.getProject(projectId);

    if (!project) {
      await ctx.editMessageText("❌ Project not found.", {
        reply_markup: { inline_keyboard: [[{ text: "Back", callback_data: "nav_list" }]] },
      });
      return;
    }

    ctx.session.activeProjectId = projectId;

    const botInfo = project.botUsername ? `\nBot: @${project.botUsername}` : "";
    const versionInfo = project.currentVersion ? `\nVersion: ${project.currentVersion}` : "";
    const costInfo = Number(project.totalCostUsd) > 0 ? `\nTotal cost: $${Number(project.totalCostUsd).toFixed(2)}` : "";

    await ctx.editMessageText(
      `${ce(EMOJI.logo)} <b>${esc(project.name)}</b>\n\n` +
      `<blockquote>${statusIndicator(project.status)} Status: <b>${project.status}</b>${botInfo}${versionInfo}${costInfo}</blockquote>\n\n` +
      `${project.description ? `${ce(EMOJI.idea)} ${esc(project.description)}\n\n` : ""}` +
      `What would you like to do?`,
      {
        parse_mode: "HTML",
        reply_markup: projectActionsKeyboard(projectId, project.status, await getProjectFeatures(projectId), project.botUsername || undefined),
      }
    );
  });

  // ── Actions (send new messages) ──

  bot.callbackQuery("new_project", async (ctx) => {
    await ack(ctx);
    const from = ctx.from;

    // Check channel subscription
    const CHANNEL_ID = "@apps_father";
    try {
      const member = await ctx.api.getChatMember(CHANNEL_ID, from.id);
      if (["left", "kicked"].includes(member.status)) {
        await ctx.reply(
          `${ce(EMOJI.indicator_warning)} <b>Subscribe to continue</b>\n\n` +
          `To create apps, please subscribe to our channel first:`,
          {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [
              [{ text: "Subscribe", url: "https://t.me/apps_father" }],
              [{ text: "I've subscribed ✓", callback_data: "new_project" }],
            ]},
          }
        );
        return;
      }
    } catch (err: any) {
      console.error("[Callback] Channel check failed:", err?.message || err);
      if (err?.description?.includes("member list is inaccessible") || err?.error_code === 400) {
        await ctx.reply(
          `${ce(EMOJI.indicator_warning)} <b>Subscribe to continue</b>\n\n` +
          `To create apps, please subscribe to our channel first:`,
          {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [
              [{ text: "Subscribe", url: "https://t.me/apps_father" }],
              [{ text: "I've subscribed ✓", callback_data: "new_project" }],
            ]},
          }
        );
        return;
      }
    }

    const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);
    const canCreate = await projectService.canCreateApp(user.id);
    if (!canCreate) {
      const slots = await projectService.getUserSlotInfo(user.id);
      await ctx.reply(
        `${ce(EMOJI.indicator_error)} <b>App slot limit reached (${slots.used}/${slots.total})</b>\n\n` +
        `You need to buy an additional app slot for <b>$25</b>.`,
        {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [
            [{ text: "Buy App Slot — $25", callback_data: "buy_slot", icon_custom_emoji_id: EMOJI.add }],
            [{ text: "Back", callback_data: "nav_welcome" }],
          ]},
        }
      );
      return;
    }
    await ctx.reply(
      `${ce(EMOJI.add)} <b>Create New App</b>\n\n` +
      `Tap the button below to create a bot for your app.\nEnter a name and username for your bot:`,
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [
          [{ text: "Create Bot", url: "https://t.me/newbot/apps_father_bot/username_bot" }],
        ]},
      }
    );
  });

  bot.callbackQuery(/^describe:(.+)$/, async (ctx) => {
    await ack(ctx);
    const projectId = ctx.match[1];
    ctx.session.activeProjectId = projectId;
    ctx.session.awaitingInput = "description";

    await ctx.reply(
      `${ce(EMOJI.idea)} <b>Describe your Mini App</b>\n\n` +
      "Tell me what your app should do. Be as detailed as you want:\n" +
      "- What features should it have?\n" +
      "- What's the main purpose?\n" +
      "- Any design preferences?\n" +
      "- Who is the target audience?\n\n" +
      "You can also send images as design references!",
      { parse_mode: "HTML" }
    );
  });

  bot.callbackQuery(/^approve_plan:(.+)$/, async (ctx) => {
    try { await ctx.answerCallbackQuery("Building your app..."); } catch {}
    const projectId = ctx.match[1];

    // Block duplicate runs
    if (processingProjects.has(projectId)) return;

    const from = ctx.from;
    const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);

    if (!(await billingService.hasBalance(user.id, 5))) {
      await ctx.reply(errorMessage("Minimum <b>$5</b> balance required to build. Please top up first."), { parse_mode: "HTML" });
      return;
    }

    const project = await projectService.getProject(projectId);
    if (!project || !project.plan) {
      await ctx.reply(errorMessage("No plan found. Please describe your app first."), { parse_mode: "HTML" });
      return;
    }

    if (project.status === "building" || project.status === "deployed" || project.status === "released") {
      try { await ctx.answerCallbackQuery("Already building or deployed!"); } catch {}
      return;
    }

    // Delete the plan message
    try { await ctx.deleteMessage(); } catch {}

    processingProjects.add(projectId);
    await projectService.updateProjectStatus(projectId, "building");

    const statusMsg = await ctx.reply(processMessage("Starting AI Agent..."), {
      parse_mode: "HTML",
    });

    let lastUpdate = Date.now();

    try {
      const progress = async (p: { action: string; detail: string; percent?: number }) => {
        if (Date.now() - lastUpdate < 2000) return;
        lastUpdate = Date.now();
        try {
          await ctx.api.editMessageText(
            ctx.chat!.id, statusMsg.message_id,
            processMessage(`${p.action} ${esc(p.detail)}`, p.percent),
            { parse_mode: "HTML" }
          );
        } catch {}
      };

      const askUser = createAskUser(projectId, ctx.chat!.id, statusMsg.message_id);

      const result = await agentService.buildApp(
        projectId,
        project.description || "",
        project.plan,
        progress,
        askUser,
      );

      const usage = await billingService.recordUsage(
        user.id, projectId, result.model,
        { input_tokens: result.inputTokens, output_tokens: result.outputTokens, cache_creation_input_tokens: result.cacheWriteTokens, cache_read_input_tokens: result.cacheReadTokens },
        "build"
      );

      await projectService.updateProjectStatus(projectId, "deployed");

      try {
        await commitService.createCommit(projectId, `App created: ${(project.description || "").substring(0, 80)}`);
        await commitService.releaseCurrentDev(projectId);
      } catch (commitErr) {
        console.error("[Callback] Commit/release error:", commitErr);
      }

      processingProjects.delete(projectId);
      const appUrl = `${config.baseUrl}/app/${projectId}/`;
      const botMention = project.botUsername ? `@${project.botUsername}` : "your project bot";

      try {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          statusMsg.message_id,
          doneMessage("Your app is ready!", `${mdToTgHtml(truncSummary(result.summary))}\n\n<blockquote>${appUrl}\n\nOpen it via ${botMention} in Telegram.</blockquote>\n\n${costLine(usage.costUsd, usage.newBalance)}`),
          {
            parse_mode: "HTML",
            reply_markup: projectActionsKeyboard(projectId, "deployed", await getProjectFeatures(projectId), project.botUsername || undefined),
          }
        );
      } catch (displayErr) {
        console.error("[Callback] Display error (app is deployed):", displayErr);
        await ctx.api.editMessageText(
          ctx.chat!.id,
          statusMsg.message_id,
          doneMessage("Your app is ready!", `<blockquote>${appUrl}\n\nOpen it via ${botMention} in Telegram.</blockquote>\n\n${costLine(usage.costUsd, usage.newBalance)}`),
          {
            parse_mode: "HTML",
            reply_markup: projectActionsKeyboard(projectId, "deployed", await getProjectFeatures(projectId), project.botUsername || undefined),
          }
        ).catch(() => {});
      }
    } catch (err) {
      console.error("[Callback] Build error:", err);
      processingProjects.delete(projectId);
      await projectService.updateProjectStatus(projectId, "error");
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        errorMessage(`Failed to build: ${esc(err instanceof Error ? err.message : "Unknown error")}\n\nPlease try again.`),
        { parse_mode: "HTML", reply_markup: planActionKeyboard(projectId) }
      ).catch(() => {});
    }
  });

  bot.callbackQuery(/^modify_plan:(.+)$/, async (ctx) => {
    await ack(ctx);
    const projectId = ctx.match[1];
    ctx.session.activeProjectId = projectId;
    ctx.session.awaitingInput = "plan_feedback";

    await ctx.reply(
      `${ce(EMOJI.update)} <b>Modify Plan</b>\n\nWhat would you like to change? Describe your modifications:`,
      { parse_mode: "HTML" }
    );
  });

  bot.callbackQuery(/^decline_plan:(.+)$/, async (ctx) => {
    await ack(ctx);
    const projectId = ctx.match[1];
    ctx.session.activeProjectId = projectId;
    ctx.session.awaitingInput = "description";
    ctx.session.pendingPlan = undefined;

    await ctx.reply(
      `${ce(EMOJI.indicator_error)} <b>Plan declined.</b>\n\nPlease describe your app again with more details:`,
      { parse_mode: "HTML" }
    );
  });

  bot.callbackQuery(/^open_app:(.+)$/, async (ctx) => {
    await ack(ctx);
    const projectId = ctx.match[1];
    const project = await projectService.getProject(projectId);
    const botUsername = project?.botUsername;

    if (!botUsername) {
      await ctx.reply(errorMessage("Bot not found for this project."), { parse_mode: "HTML" });
      return;
    }

    await ctx.reply(`${ce(EMOJI.logo)} <b>Open your app via the bot:</b>`, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "Open App", url: `https://t.me/${botUsername}` }],
        ],
      },
    });
  });

  bot.callbackQuery(/^edit_code:(.+)$/, async (ctx) => {
    await ack(ctx);
    const projectId = ctx.match[1];
    const editorUrl = `${config.baseUrl}/editor/${projectId}/`;

    await ctx.reply(`${ce(EMOJI.setting)} <b>Code Editor</b>\n\nOpen the editor to view and modify your project files:`, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "Open Editor", url: editorUrl }],
        ],
      },
    });
  });

  bot.callbackQuery(/^update_app:(.+)$/, async (ctx) => {
    await ack(ctx);
    const projectId = ctx.match[1];

    const from = ctx.from;
    const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);
    if (!(await billingService.hasBalance(user.id, 5))) {
      await ctx.reply(errorMessage("Minimum <b>$5</b> balance required to update. Please top up first."), { parse_mode: "HTML" });
      return;
    }

    ctx.session.activeProjectId = projectId;
    ctx.session.awaitingInput = "update_description";

    await ctx.reply(
      `${ce(EMOJI.update)} <b>Update Your App</b>\n\n` +
      "Describe what changes you'd like to make:\n" +
      "- New features to add\n" +
      "- UI changes\n" +
      "- Bug fixes\n" +
      "- Any modifications\n\n" +
      `${ce(EMOJI.idea)} Or attach files first (images, audio, documents) that the AI should use.`,
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [
          [{ text: "📎 Attach Files", callback_data: `attach_files:${projectId}` }],
        ]},
      }
    );
  });

  bot.callbackQuery(/^attach_files:(.+)$/, async (ctx) => {
    await ack(ctx);
    const projectId = ctx.match[1];
    ctx.session.activeProjectId = projectId;
    ctx.session.awaitingInput = "attach_files";
    ctx.session.pendingAttachments = [];

    await ctx.reply(
      `📎 <b>Attach Files</b>\n\n` +
      `Send me any files you want to attach — photos, documents, audio, video.\n\n` +
      `When you're done, type your update description to continue.`,
      { parse_mode: "HTML" }
    );
  });

  bot.callbackQuery(/^release:(.+)$/, async (ctx) => {
    await ack(ctx);
    const projectId = ctx.match[1];

    try {
      const commitNum = await commitService.releaseCurrentDev(projectId);
      const project = await projectService.getProject(projectId);
      const features = await getProjectFeatures(projectId);

      await ctx.editMessageText(
        doneMessage("Version released!", `Commit <b>#${commitNum}</b> is now live for all users.`),
        {
          parse_mode: "HTML",
          reply_markup: projectActionsKeyboard(projectId, "released", features, project?.botUsername || undefined),
        }
      );
    } catch (err) {
      console.error("[Callback] Release error:", err);
      await ctx.reply(
        errorMessage("Failed to release. Make sure you have at least one commit."),
        { parse_mode: "HTML" }
      );
    }
  });

  bot.callbackQuery(/^admin:(.+)$/, async (ctx) => {
    await ack(ctx);
    const projectId = ctx.match[1];
    const adminUrl = `${config.baseUrl}/admin/${projectId}/`;

    await ctx.reply(`${ce(EMOJI.setting)} Open admin panel:`, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "Admin Panel", web_app: { url: adminUrl } }],
        ],
      },
    });
  });

  bot.callbackQuery(/^wallet:(.+)$/, async (ctx) => {
    await ack(ctx);
    const projectId = ctx.match[1];
    const wallet = await projectService.getTonWallet(projectId);

    const walletInfo = wallet
      ? `<b>Current wallet:</b>\n<code>${esc(wallet)}</code>`
      : "No wallet address set yet.";

    await ctx.reply(
      `${ce(EMOJI.dollar, "💎")} <b>TON Wallet</b>\n\n${walletInfo}\n\nSet or update the wallet address where you'll receive TON payments from your app users.`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: wallet ? "Change Wallet" : "Set Wallet", callback_data: `sw:${projectId}` }],
            [{ text: "Back", callback_data: `project:${projectId}` }],
          ],
        },
      }
    );
  });

  bot.callbackQuery(/^sw:(.+)$/, async (ctx) => {
    await ack(ctx);
    const projectId = ctx.match[1];
    ctx.session.activeProjectId = projectId;
    ctx.session.awaitingInput = "ton_wallet";

    await ctx.reply(
      `${ce(EMOJI.dollar, "💎")} <b>Set TON Wallet</b>\n\n` +
      `Send your TON wallet address where you want to receive payments:\n\n` +
      `<blockquote>The address should look like:\nUQA... or EQA... (user-friendly format)</blockquote>`,
      { parse_mode: "HTML" }
    );
  });

  bot.callbackQuery(/^suggest:(.+)$/, async (ctx) => {
    try { await ctx.answerCallbackQuery("Generating suggestions..."); } catch {}
    const projectId = ctx.match[1];

    const from = ctx.from;
    const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);

    if (!(await billingService.hasBalance(user.id))) {
      await ctx.reply(errorMessage("Insufficient balance. Please top up first."), { parse_mode: "HTML" });
      return;
    }

    const project = await projectService.getProject(projectId);

    if (!project?.description || !project?.plan) {
      await ctx.reply(errorMessage("Need a description and plan first."), { parse_mode: "HTML" });
      return;
    }

    const statusMsg = await ctx.reply(processMessage("Generating suggestions..."), { parse_mode: "HTML" });

    try {
      const result = await claudeService.suggestImprovements(
        project.description,
        project.plan
      );

      const usage = await billingService.recordUsage(
        user.id, projectId, "claude-sonnet-4-6",
        { input_tokens: result.inputTokens, output_tokens: result.outputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        "suggest"
      );

      if (result.suggestions.length === 0) {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          statusMsg.message_id,
          doneMessage("No suggestions", `Your app looks great! No suggestions at this time.\n\n${costLine(usage.costUsd, usage.newBalance)}`),
          { parse_mode: "HTML" }
        );
        return;
      }

      let text = `${ce(EMOJI.idea)} <b>Suggested Improvements:</b>\n\n`;
      result.suggestions.forEach((s, i) => {
        text += `${i + 1}. ${esc(s)}\n\n`;
      });
      text += `Select which improvements to apply:\n\n${costLine(usage.costUsd, usage.newBalance)}`;

      ctx.session.conversationState = "idle";
      (ctx.session as any).pendingSuggestions = result.suggestions;

      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        text,
        {
          parse_mode: "HTML",
          reply_markup: suggestionsKeyboard(projectId, result.suggestions),
        }
      );
    } catch (err) {
      console.error("[Callback] Suggestions error:", err);
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        errorMessage("Failed to generate suggestions."),
        { parse_mode: "HTML" }
      );
    }
  });

  bot.callbackQuery(/^apply_suggestion:(.+):(\d+)$/, async (ctx) => {
    try { await ctx.answerCallbackQuery("Applying suggestion..."); } catch {}
    const projectId = ctx.match[1];

    if (processingProjects.has(projectId)) return;

    const suggestionIndex = parseInt(ctx.match[2]);
    const suggestions = (ctx.session as any).pendingSuggestions as string[] | undefined;

    if (!suggestions || !suggestions[suggestionIndex]) {
      await ctx.reply(errorMessage("Suggestion not found."), { parse_mode: "HTML" });
      return;
    }

    const from = ctx.from;
    const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);

    if (!(await billingService.hasBalance(user.id, 5))) {
      await ctx.reply(errorMessage("Minimum <b>$5</b> balance required. Please top up first."), { parse_mode: "HTML" });
      return;
    }

    const suggestion = suggestions[suggestionIndex];
    ctx.session.activeProjectId = projectId;

    // Delete the suggestions message
    try { await ctx.deleteMessage(); } catch {}

    const statusMsg = await ctx.reply(processMessage(`Applying: ${esc(suggestion)}`), {
      parse_mode: "HTML",
    });

    let lastUpdate = Date.now();
    processingProjects.add(projectId);

    try {
      const progress = async (p: { action: string; detail: string; percent?: number }) => {
        if (Date.now() - lastUpdate < 2000) return;
        lastUpdate = Date.now();
        try {
          await ctx.api.editMessageText(
            ctx.chat!.id, statusMsg.message_id,
            processMessage(`${p.action} ${esc(p.detail)}`, p.percent),
            { parse_mode: "HTML" }
          );
        } catch {}
      };

      const askUser = createAskUser(projectId, ctx.chat!.id, statusMsg.message_id);
      const result = await agentService.updateApp(projectId, suggestion, progress, undefined, askUser);

      const usage = await billingService.recordUsage(
        user.id, projectId, result.model,
        { input_tokens: result.inputTokens, output_tokens: result.outputTokens, cache_creation_input_tokens: result.cacheWriteTokens, cache_read_input_tokens: result.cacheReadTokens },
        "update"
      );

      try {
        await commitService.createCommit(projectId, `Update: ${suggestion.substring(0, 80)}`);
      } catch (commitErr) {
        console.error("[Callback] Commit error (suggestion):", commitErr);
      }

      const project = await projectService.getProject(projectId);
      const features = await getProjectFeatures(projectId);
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        doneMessage("Suggestion applied!", `<i>${esc(suggestion)}</i>\n\n${mdToTgHtml(truncSummary(result.summary))}\n\n${costLine(usage.costUsd, usage.newBalance)}`),
        {
          parse_mode: "HTML",
          reply_markup: projectActionsKeyboard(projectId, project?.status || "deployed", features, project?.botUsername || undefined),
        }
      );
    } catch (err) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        errorMessage("Failed to apply suggestion."),
        { parse_mode: "HTML" }
      );
    } finally {
      processingProjects.delete(projectId);
    }

    ctx.session.awaitingInput = null;
  });

  bot.callbackQuery(/^skip_suggestions:(.+)$/, async (ctx) => {
    await ack(ctx);
    const projectId = ctx.match[1];
    const project = await projectService.getProject(projectId);
    const features = await getProjectFeatures(projectId);

    await ctx.reply(
      doneMessage("No changes applied.", "Your app stays as is."),
      { parse_mode: "HTML", reply_markup: projectActionsKeyboard(projectId, project?.status || "deployed", features, project?.botUsername || undefined) }
    );
  });

  // === Agent ask_user responses ===

  bot.callbackQuery(/^aq:(.+):(.+)$/, async (ctx) => {
    try { await ctx.answerCallbackQuery(); } catch {}
    const projectId = ctx.match[1];
    const optionKey = ctx.match[2];

    const pending = getPendingByProject(projectId);
    if (!pending) return;

    let answer = "";
    if (optionKey !== "skip") {
      const idx = parseInt(optionKey, 10);
      if (!isNaN(idx) && pending.options[idx]) {
        answer = pending.options[idx];
      } else {
        answer = optionKey;
      }
    }

    resolveByProject(projectId, answer);
  });

  // === Versions ===

  bot.callbackQuery(/^versions:(.+)$/, async (ctx) => {
    await ack(ctx);
    const projectId = ctx.match[1];
    const project = await projectService.getProject(projectId);
    if (!project) return;

    const commits = await commitService.getCommits(projectId);
    if (commits.length === 0) {
      await ctx.editMessageText(
        `${ce(EMOJI.list)} <b>Versions</b>\n\nNo commits yet. Build or update your app first.`,
        { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Back", callback_data: `project:${projectId}` }]] } }
      );
      return;
    }

    await ctx.editMessageText(
      `${ce(EMOJI.list)} <b>Versions — ${esc(project.name)}</b>\n\nTap a commit to revert to it.\n${project.releaseCommit !== null ? `Current release: <b>#${project.releaseCommit}</b>` : "No release yet."}`,
      { parse_mode: "HTML", reply_markup: versionsKeyboard(projectId, commits, project.releaseCommit) }
    );
  });

  bot.callbackQuery(/^rv:(.+):(\d+)$/, async (ctx) => {
    await ack(ctx);
    const projectId = ctx.match[1];
    const commitNum = ctx.match[2];

    const commits = await commitService.getCommits(projectId);
    const commit = commits.find(c => c.version === commitNum);
    const label = commit?.changelog || `Commit #${commitNum}`;

    await ctx.editMessageText(
      `${ce(EMOJI.indicator_warning)} <b>Revert to commit #${commitNum}?</b>\n\n<i>${esc(label)}</i>\n\nThis will restore your dev environment to this commit and <b>delete all newer commits</b>.`,
      { parse_mode: "HTML", reply_markup: revertConfirmKeyboard(projectId, commitNum) }
    );
  });

  bot.callbackQuery(/^rvc:(.+):(\d+)$/, async (ctx) => {
    await ack(ctx);
    const projectId = ctx.match[1];
    const commitNum = parseInt(ctx.match[2], 10);

    try {
      await commitService.revertToCommit(projectId, commitNum);
      const project = await projectService.getProject(projectId);
      const features = await getProjectFeatures(projectId);

      await ctx.editMessageText(
        doneMessage("Reverted!", `Dev environment restored to commit <b>#${commitNum}</b>.\n\nUse <b>Release Version</b> to push this to production.`),
        {
          parse_mode: "HTML",
          reply_markup: projectActionsKeyboard(projectId, project?.status || "deployed", features, project?.botUsername || undefined),
        }
      );
    } catch (err) {
      console.error("[Callback] Revert error:", err);
      await ctx.reply(
        errorMessage(`Failed to revert: ${esc(err instanceof Error ? err.message : "Unknown error")}`),
        { parse_mode: "HTML" }
      );
    }
  });

  // === Settings sub-menu ===

  bot.callbackQuery(/^settings:(.+)$/, async (ctx) => {
    await ack(ctx);
    const projectId = ctx.match[1];
    const project = await projectService.getProject(projectId);
    if (!project) return;

    await ctx.editMessageText(
      `${ce(EMOJI.setting)} <b>Settings — ${esc(project.name)}</b>`,
      { parse_mode: "HTML", reply_markup: settingsKeyboard(projectId) }
    );
  });

  bot.callbackQuery(/^info:(.+)$/, async (ctx) => {
    await ack(ctx);
    const projectId = ctx.match[1];
    const project = await projectService.getProject(projectId);
    if (!project) return;

    let tokenDisplay = "Not set";
    let botId = "N/A";
    if (project.botTokenEncrypted) {
      try {
        const token = decryptToken(project.botTokenEncrypted);
        tokenDisplay = `<code>${esc(token)}</code>`;
        botId = token.split(":")[0];
      } catch {
        tokenDisplay = "Decryption error";
      }
    }

    const appUrl = `${config.baseUrl}/app/${projectId}/`;

    await ctx.editMessageText(
      `${ce(EMOJI.help)} <b>Project Info</b>\n\n` +
      `<b>Bot Username:</b> ${project.botUsername ? `@${project.botUsername}` : "Not set"}\n` +
      `<b>Bot ID:</b> ${botId}\n` +
      `<b>Bot Token:</b> ${tokenDisplay}\n` +
      `<b>Web App URL:</b> <code>${appUrl}</code>`,
      { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Back", callback_data: `settings:${projectId}` }]] } }
    );
  });

  bot.callbackQuery(/^quality:(.+)$/, async (ctx) => {
    await ack(ctx);
    const projectId = ctx.match[1];
    const project = await projectService.getProject(projectId);
    if (!project) return;

    const tier = (project as any).qualityTier || 1;
    const desc = qualityDescription();

    await ctx.editMessageText(
      `${ce(EMOJI.setting)} <b>AI Quality Tier</b>\n\n` +
      `Select the AI model quality for building and updating your app:\n\n` + desc,
      { parse_mode: "HTML", reply_markup: qualityKeyboard(projectId, tier) }
    );
  });

  bot.callbackQuery(/^qt:(.+):(\d)$/, async (ctx) => {
    await ack(ctx);
    const projectId = ctx.match[1];
    const tier = parseInt(ctx.match[2]);
    if (tier < 1 || tier > 4) return;

    await prisma.project.update({ where: { id: projectId }, data: { qualityTier: tier } });

    const project = await projectService.getProject(projectId);
    if (!project) return;

    const desc = qualityDescription();
    await ctx.editMessageText(
      `${ce(EMOJI.setting)} <b>AI Quality Tier</b>\n\n` +
      `Select the AI model quality for building and updating your app:\n\n` + desc,
      { parse_mode: "HTML", reply_markup: qualityKeyboard(projectId, tier) }
    );
  });

  bot.callbackQuery(/^transfer:(.+)$/, async (ctx) => {
    await ack(ctx);
    const projectId = ctx.match[1];
    ctx.session.activeProjectId = projectId;
    ctx.session.awaitingInput = "transfer_owner";

    await ctx.reply(
      `${ce(EMOJI.indicator_warning)} <b>Transfer Ownership</b>\n\n` +
      `Enter the <b>username</b> of the user you want to transfer this app to:\n\n` +
      `<blockquote>The user must have used Apps Father bot at least once.</blockquote>`,
      { parse_mode: "HTML" }
    );
  });

  bot.callbackQuery(/^confirm_transfer:(.+):(\d+)$/, async (ctx) => {
    await ack(ctx);
    const projectId = ctx.match[1];
    const newOwnerId = parseInt(ctx.match[2]);

    try {
      const project = await projectService.getProject(projectId);
      if (!project) return;

      await projectService.transferProject(projectId, newOwnerId);

      await ctx.editMessageText(
        `${ce(EMOJI.indicator_success, "✅")} <b>Ownership transferred!</b>\n\n` +
        `<b>${esc(project.name)}</b> has been transferred to the new owner.`,
        {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "Back", callback_data: "nav_list" }]] },
        }
      );
    } catch (err) {
      console.error("[Callback] Transfer error:", err);
      await ctx.editMessageText(
        errorMessage("Failed to transfer ownership. Please try again."),
        { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Back", callback_data: `project:${projectId}` }]] } }
      );
    }
  });

  bot.callbackQuery(/^remove_project:(.+)$/, async (ctx) => {
    await ack(ctx);
    const projectId = ctx.match[1];
    const project = await projectService.getProject(projectId);
    if (!project) return;

    await ctx.editMessageText(
      `${ce(EMOJI.indicator_error)} <b>Remove "${esc(project.name)}"?</b>\n\n` +
      `<blockquote>This will permanently delete:\n• All project files\n• Database schema &amp; data\n• Bot configuration\n\nThis cannot be undone.</blockquote>`,
      {
        parse_mode: "HTML",
        reply_markup: removeConfirmKeyboard(projectId),
      }
    );
  });

  bot.callbackQuery(/^confirm_remove:(.+)$/, async (ctx) => {
    await ack(ctx);
    const projectId = ctx.match[1];
    const project = await projectService.getProject(projectId);
    if (!project) return;

    const projectName = project.name;

    await ctx.editMessageText(
      processMessage("Removing project..."),
      { parse_mode: "HTML" }
    );

    try {
      // 1. Stop the bot runner
      const { botRunnerService } = await import("../../services/bot-runner.service");
      try { botRunnerService.stopBot(projectId); } catch {}

      // 2. Delete project files from disk (includes SQLite db)
      const projectDir = path.join(__dirname, "..", "..", "..", "projects", projectId);
      if (fs.existsSync(projectDir)) {
        fs.rmSync(projectDir, { recursive: true, force: true });
      }

      // 4. Delete from database
      await projectService.deleteProject(projectId);

      // Refresh the list
      const from = ctx.from;
      const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);
      const projects = await projectService.getProjectsByUser(user.id);

      if (projects.length === 0) {
        await ctx.editMessageText(
          doneMessage(`"${esc(projectName)}" removed.`, "You have no more projects."),
          { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Back", callback_data: "nav_welcome" }]] } }
        );
      } else {
        await ctx.editMessageText(
          doneMessage(`"${esc(projectName)}" removed.`, buildListText(projects)),
          { parse_mode: "HTML", reply_markup: projectListKeyboard(projects) }
        );
      }
    } catch (err) {
      console.error("[Callback] Remove error:", err);
      await ctx.editMessageText(
        errorMessage("Failed to remove project. Please try again."),
        { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Back", callback_data: `project:${projectId}` }]] } }
      );
    }
  });

  // ── Features Store ──

  bot.callbackQuery(/^features:(.+)$/, async (ctx) => {
    await ack(ctx);
    const projectId = ctx.match[1];
    const features = await getProjectFeatures(projectId);

    let text = `${ce(EMOJI.dollar, "💎")} <b>Premium Features</b>\n\n`;
    for (const f of PAID_FEATURES) {
      const owned = features.includes(f.id);
      text += owned
        ? `✅ <b>${esc(f.label)}</b> — <i>Unlocked</i>\n`
        : `🔒 <b>${esc(f.label)}</b> — <b>$${f.price}</b>\n<i>${esc(f.description)}</i>\n`;
      text += "\n";
    }

    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: featuresKeyboard(projectId, features),
    });
  });

  bot.callbackQuery(/^fo:(.+):(.+)$/, async (ctx) => {
    try { await ctx.answerCallbackQuery("Already unlocked!"); } catch {}
  });

  bot.callbackQuery(/^bf:(.+):(.+)$/, async (ctx) => {
    await ack(ctx);
    const projectId = ctx.match[1];
    const featureId = ctx.match[2];
    const feature = getFeatureById(featureId);
    if (!feature) return;

    const from = ctx.from;
    const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);
    const balance = await billingService.getUserBalance(user.id);

    await ctx.editMessageText(
      `${ce(EMOJI.dollar, "💎")} <b>Purchase: ${esc(feature.label)}</b>\n\n` +
      `<blockquote>${esc(feature.description)}</blockquote>\n\n` +
      `Price: <b>$${feature.price}</b>\n` +
      `Your balance: <b>$${balance.toFixed(2)}</b>\n\n` +
      (balance >= feature.price ? "Confirm your purchase:" : `⚠️ Insufficient balance. You need <b>$${(feature.price - balance).toFixed(2)}</b> more.`),
      {
        parse_mode: "HTML",
        reply_markup: balance >= feature.price
          ? confirmBuyKeyboard(projectId, featureId)
          : { inline_keyboard: [[{ text: "Top Up", callback_data: "topup" }], [{ text: "Back", callback_data: `features:${projectId}` }]] },
      }
    );
  });

  bot.callbackQuery(/^cb:(.+):(.+)$/, async (ctx) => {
    await ack(ctx);
    const projectId = ctx.match[1];
    const featureId = ctx.match[2];
    const feature = getFeatureById(featureId);
    if (!feature) return;

    const from = ctx.from;
    const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);

    try {
      const { newBalance } = await purchaseFeature(user.id, projectId, featureId);
      const features = await getProjectFeatures(projectId);

      await ctx.editMessageText(
        `${ce(EMOJI.indicator_success, "✅")} <b>${esc(feature.label)} unlocked!</b>\n\n` +
        `<blockquote>Charged: <b>$${feature.price}</b>\nNew balance: <b>$${newBalance.toFixed(2)}</b></blockquote>`,
        {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "Back to Features", callback_data: `features:${projectId}` }], [{ text: "Back to Project", callback_data: `project:${projectId}` }]] },
        }
      );
    } catch (err: any) {
      await ctx.editMessageText(
        errorMessage(err.message || "Purchase failed"),
        { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: "Back", callback_data: `features:${projectId}` }]] } }
      );
    }
  });
}
