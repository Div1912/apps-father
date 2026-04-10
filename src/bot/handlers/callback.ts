import { Bot } from "grammy";
import { BotContext } from "../../types";
import { publishReport } from "../../services/telegraph.service";
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
  languageKeyboard,
} from "../keyboards";
import { commitService } from "../../services/commit.service";
import { setPending, resolveByProject, getPendingByProject } from "../agent-questions";
import { getProjectFeatures, getFeatureById, purchaseFeature, PAID_FEATURES } from "../../services/features.service";
import { decryptToken } from "../../services/crypto.service";
import { prisma } from "../../db";
import { processMessage, doneMessage, errorMessage, costLine, truncSummary, mdToTgHtml, checklistMessage, ChecklistItem } from "../progress";
import { EMOJI, ce, statusIndicator } from "../emoji";
import { getNavWelcomeText } from "../commands/start";
import { Lang, t, translateStatus, translateFeatureLabel, translateFeatureDesc } from "../i18n";

import fs from "fs";
import path from "path";

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function getLang(ctx: BotContext): Lang {
  return ctx.session.language || "en";
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

function createAskUser(projectId: string, chatId: number, statusMsgId: number, lang: Lang = "en") {
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

function buildListText(projects: { name: string; status: string }[], slotUsed?: number, slotTotal?: number, lang: Lang = "en"): string {
  const slotLine = typeof slotUsed === "number" && typeof slotTotal === "number"
    ? `\n📱 <b>${t(lang, "app_slots", { used: slotUsed, total: slotTotal })}</b>\n` : "";
  let text = `${ce(EMOJI.list)} <b>${t(lang, "your_projects")}</b>${slotLine}\n`;
  for (const p of projects) {
    text += `${statusIndicator(p.status)} <b>${esc(p.name)}</b> — ${translateStatus(lang, p.status)}\n`;
  }
  return text;
}

function qualityDescription(lang: Lang = "en"): string {
  return (
    `<b>${t(lang, "quality_good")}</b> — Sonnet 4.6, 60 iterations\n` +
    `<b>${t(lang, "quality_better")}</b> — Sonnet 4.6+, 100 iterations\n` +
    `<b>${t(lang, "quality_best")}</b> — Opus 4.6, 60 iterations\n` +
    `<b>${t(lang, "quality_the_best")}</b> — Opus 4.6+, 100 iterations`
  );
}

export function registerCallbackHandlers(bot: Bot<BotContext>) {

  bot.on("callback_query:data", async (_ctx, next) => {
    try {
      await next();
    } catch (err: any) {
      if (err?.message?.includes("message is not modified")) return;
      console.error("[Callback] Error:", err.message || err);
    }
  });

  // ── Navigation ──

  bot.callbackQuery("nav_welcome", async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const from = ctx.from;
    const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);
    const balance = await billingService.getUserBalance(user.id);
    await ctx.editMessageText(getNavWelcomeText(balance, lang), {
      parse_mode: "HTML",
      reply_markup: welcomeKeyboard(lang),
    });
  });

  bot.callbackQuery("nav_list", async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const from = ctx.from;
    const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);
    const [projects, slots] = await Promise.all([
      projectService.getProjectsByUser(user.id),
      projectService.getUserSlotInfo(user.id),
    ]);

    if (projects.length === 0) {
      await ctx.editMessageText(t(lang, "no_projects"), {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: t(lang, "btn_back"), callback_data: "nav_welcome" }]] },
      });
      return;
    }

    await ctx.editMessageText(buildListText(projects, slots.used, slots.total, lang), {
      parse_mode: "HTML",
      reply_markup: projectListKeyboard(projects, slots.used < slots.total, lang),
    });
  });

  bot.callbackQuery("my_projects", async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const from = ctx.from;
    const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);
    const [projects, slots] = await Promise.all([
      projectService.getProjectsByUser(user.id),
      projectService.getUserSlotInfo(user.id),
    ]);

    if (projects.length === 0) {
      await ctx.editMessageText(t(lang, "no_projects"), {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: t(lang, "btn_back"), callback_data: "nav_welcome" }]] },
      });
      return;
    }

    await ctx.editMessageText(buildListText(projects, slots.used, slots.total, lang), {
      parse_mode: "HTML",
      reply_markup: projectListKeyboard(projects, slots.used < slots.total, lang),
    });
  });

  bot.callbackQuery("help", async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    await ctx.editMessageText(
      `${ce(EMOJI.help)} <b>${t(lang, "help_title")}</b>\n\n${t(lang, "help_body")}`,
      { parse_mode: "HTML", reply_markup: helpKeyboard(lang) }
    );
  });

  // ── Language ──

  bot.callbackQuery("language", async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    await ctx.editMessageText(
      `${ce(EMOJI.setting)} <b>${t(lang, "language_title")}</b>\n\n${t(lang, "language_desc")}`,
      { parse_mode: "HTML", reply_markup: languageKeyboard(lang) }
    );
  });

  bot.callbackQuery(/^lang:(en|ru|ua)$/, async (ctx) => {
    await ack(ctx);
    const newLang = ctx.match[1] as Lang;
    ctx.session.language = newLang;

    const from = ctx.from;
    const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);
    await prisma.user.update({ where: { id: user.id }, data: { language: newLang } });

    const balance = await billingService.getUserBalance(user.id);
    await ctx.editMessageText(
      `${ce(EMOJI.indicator_success, "✅")} ${t(newLang, "language_changed")}\n\n${getNavWelcomeText(balance, newLang)}`,
      { parse_mode: "HTML", reply_markup: welcomeKeyboard(newLang) }
    );
  });

  // ── Topup ──

  bot.callbackQuery("topup", async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    ctx.session.awaitingInput = "topup_amount";
    ctx.session.activeProjectId = undefined;
    await ctx.reply(
      `${ce(EMOJI.dollar, "💲")} <b>${t(lang, "topup_title")}</b>\n\n` +
      `${t(lang, "topup_enter_amount")}\n\n` +
      `<blockquote>${t(lang, "topup_note")}</blockquote>`,
      { parse_mode: "HTML" }
    );
  });

  bot.callbackQuery("referral", async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const from = ctx.from;
    const refLink = `https://t.me/apps_father_bot?start=${from.id}`;
    const shareText = encodeURIComponent(t(lang, "referral_share_text"));
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${shareText}`;

    await ctx.editMessageText(
      `${ce(EMOJI.idea, "🎁")} <b>${t(lang, "referral_title")}</b>\n\n` +
      t(lang, "referral_body", { link: refLink }),
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: t(lang, "btn_send_invites"), url: shareUrl }],
            [{ text: t(lang, "btn_back"), callback_data: "nav_welcome" }],
          ],
        },
      }
    );
  });

  bot.callbackQuery(/^cryptobot_pay:(.+)$/, async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const amount = parseFloat(ctx.match[1]);
    if (isNaN(amount) || amount < 10) return;

    const from = ctx.from;
    const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);

    try {
      const { invoiceUrl } = await billingService.createCryptoBotInvoice(user.id, amount);
      await ctx.editMessageText(
        doneMessage(
          t(lang, "payment_created"),
          t(lang, "payment_cryptobot_desc", { amount: amount.toFixed(2) })
        ),
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: t(lang, "btn_pay", { amount: amount.toFixed(2) }), url: invoiceUrl }],
              [{ text: t(lang, "btn_back"), callback_data: "nav_welcome" }],
            ],
          },
        }
      );
    } catch (err) {
      console.error("[Callback] CryptoBot topup error:", err);
      await ctx.editMessageText(
        errorMessage(t(lang, "payment_error"), lang),
        { parse_mode: "HTML" }
      );
    }
  });

  bot.callbackQuery(/^nowpay:(.+)$/, async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const amount = parseFloat(ctx.match[1]);
    if (isNaN(amount) || amount < 10) return;

    const from = ctx.from;
    const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);

    try {
      const { invoiceUrl } = await billingService.createTopUp(user.id, amount);
      await ctx.editMessageText(
        doneMessage(
          t(lang, "payment_created"),
          t(lang, "payment_nowpay_desc", { amount: amount.toFixed(2) })
        ),
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: t(lang, "btn_pay", { amount: amount.toFixed(2) }), url: invoiceUrl }],
              [{ text: t(lang, "btn_back"), callback_data: "nav_welcome" }],
            ],
          },
        }
      );
    } catch (err) {
      console.error("[Callback] NOWPayments topup error:", err);
      await ctx.editMessageText(
        errorMessage(t(lang, "payment_error"), lang),
        { parse_mode: "HTML" }
      );
    }
  });

  // ── Stars Payment ──

  bot.callbackQuery(/^stars_pay:(.+)$/, async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const amount = parseFloat(ctx.match[1]);
    if (isNaN(amount) || amount < 10) return;

    const STAR_RATE = 0.013;
    const rawStars = Math.ceil(amount / STAR_RATE);
    const stars = Math.floor(rawStars / 10) * 10;

    const from = ctx.from;
    const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);

    try {
      const { invoiceUrl } = await billingService.createStarsInvoice(user.id, amount, stars);
      await ctx.editMessageText(
        doneMessage(
          t(lang, "payment_created"),
          t(lang, "payment_stars_desc", { amount: amount.toFixed(2), stars: String(stars) })
        ),
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: t(lang, "btn_pay_stars", { stars: String(stars) }), url: invoiceUrl }],
              [{ text: t(lang, "btn_back"), callback_data: "nav_welcome" }],
            ],
          },
        }
      );
    } catch (err) {
      console.error("[Callback] Stars topup error:", err);
      await ctx.editMessageText(
        errorMessage(t(lang, "payment_error"), lang),
        { parse_mode: "HTML" }
      );
    }
  });

  bot.callbackQuery("buy_slot", async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const from = ctx.from;
    const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);
    const balance = await billingService.getUserBalance(user.id);
    const slots = await projectService.getUserSlotInfo(user.id);

    await ctx.editMessageText(
      `${ce(EMOJI.add, "📱")} <b>${t(lang, "buy_slot_title")}</b>\n\n` +
      t(lang, "buy_slot_info", { used: slots.used, total: slots.total, balance: balance.toFixed(2) }) + "\n\n" +
      (balance >= 25
        ? t(lang, "buy_slot_confirm")
        : `⚠️ ${t(lang, "buy_slot_insufficient", { needed: (25 - balance).toFixed(2) })}`),
      {
        parse_mode: "HTML",
        reply_markup: balance >= 25
          ? { inline_keyboard: [
              [{ text: t(lang, "btn_confirm_25"), callback_data: "confirm_slot", icon_custom_emoji_id: EMOJI.indicator_success }],
              [{ text: t(lang, "btn_cancel"), callback_data: "nav_welcome" }],
            ]}
          : { inline_keyboard: [
              [{ text: t(lang, "btn_topup"), callback_data: "topup" }],
              [{ text: t(lang, "btn_cancel"), callback_data: "nav_welcome" }],
            ]},
      }
    );
  });

  bot.callbackQuery("confirm_slot", async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const from = ctx.from;
    const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);
    try {
      const { newSlots, newBalance } = await projectService.buySlot(user.id);
      const slots = await projectService.getUserSlotInfo(user.id);
      await ctx.editMessageText(
        `${ce(EMOJI.indicator_success, "✅")} <b>${t(lang, "slot_purchased")}</b>\n\n` +
        `<blockquote>${t(lang, "slot_purchased_detail", { balance: newBalance.toFixed(2), used: slots.used, total: newSlots })}</blockquote>`,
        {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: t(lang, "btn_back"), callback_data: "nav_welcome" }]] },
        }
      );
    } catch (err: any) {
      await ctx.editMessageText(
        errorMessage(err.message || t(lang, "purchase_failed"), lang),
        { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: t(lang, "btn_back"), callback_data: "nav_welcome" }]] } }
      );
    }
  });

  bot.callbackQuery(/^project:(.+)$/, async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const projectId = ctx.match[1];
    const project = await projectService.getProject(projectId);

    if (!project) {
      await ctx.editMessageText(`❌ ${t(lang, "project_not_found")}`, {
        reply_markup: { inline_keyboard: [[{ text: t(lang, "btn_back"), callback_data: "nav_list" }]] },
      });
      return;
    }

    ctx.session.activeProjectId = projectId;

    const botInfo = project.botUsername ? `\n${t(lang, "project_bot")} @${project.botUsername}` : "";
    const versionInfo = project.currentVersion ? `\nVersion: ${project.currentVersion}` : "";
    const costInfo = Number(project.totalCostUsd) > 0 ? `\n${t(lang, "project_total_cost")} $${Number(project.totalCostUsd).toFixed(2)}` : "";

    await ctx.editMessageText(
      `${ce(EMOJI.logo)} <b>${esc(project.name)}</b>\n\n` +
      `<blockquote>${statusIndicator(project.status)} ${t(lang, "project_status")} <b>${translateStatus(lang, project.status)}</b>${botInfo}${versionInfo}${costInfo}</blockquote>\n\n` +
      `${project.description ? `${ce(EMOJI.idea)} ${esc(project.description)}\n\n` : ""}` +
      t(lang, "project_what_to_do"),
      {
        parse_mode: "HTML",
        reply_markup: projectActionsKeyboard(projectId, project.status, await getProjectFeatures(projectId), project.botUsername || undefined, lang),
      }
    );
  });

  // ── Actions ──

  bot.callbackQuery("new_project", async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const from = ctx.from;

    const CHANNEL_ID = "@apps_father";
    try {
      const member = await ctx.api.getChatMember(CHANNEL_ID, from.id);
      if (["left", "kicked"].includes(member.status)) {
        await ctx.reply(
          `${ce(EMOJI.indicator_warning)} <b>${t(lang, "subscribe_title")}</b>\n\n${t(lang, "subscribe_body")}`,
          {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [
              [{ text: t(lang, "btn_subscribe"), url: "https://t.me/apps_father" }],
              [{ text: t(lang, "btn_subscribed"), callback_data: "new_project" }],
            ]},
          }
        );
        return;
      }
    } catch (err: any) {
      console.error("[Callback] Channel check failed:", err?.message || err);
      if (err?.description?.includes("member list is inaccessible") || err?.error_code === 400) {
        await ctx.reply(
          `${ce(EMOJI.indicator_warning)} <b>${t(lang, "subscribe_title")}</b>\n\n${t(lang, "subscribe_body")}`,
          {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [
              [{ text: t(lang, "btn_subscribe"), url: "https://t.me/apps_father" }],
              [{ text: t(lang, "btn_subscribed"), callback_data: "new_project" }],
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
        `${ce(EMOJI.indicator_error)} <b>${t(lang, "slot_limit_title", { used: slots.used, total: slots.total })}</b>\n\n${t(lang, "slot_limit_body")}`,
        {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [
            [{ text: t(lang, "buy_slot_btn"), callback_data: "buy_slot", icon_custom_emoji_id: EMOJI.add }],
            [{ text: t(lang, "btn_back"), callback_data: "nav_welcome" }],
          ]},
        }
      );
      return;
    }
    await ctx.reply(
      `${ce(EMOJI.add)} <b>${t(lang, "create_app_title")}</b>\n\n${t(lang, "create_app_body")}`,
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [
          [{ text: t(lang, "btn_create_bot"), url: "https://t.me/newbot/apps_father_bot/username_bot" }],
        ]},
      }
    );
  });

  bot.callbackQuery(/^describe:(.+)$/, async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const projectId = ctx.match[1];
    ctx.session.activeProjectId = projectId;
    ctx.session.awaitingInput = "description";

    await ctx.reply(
      `${ce(EMOJI.idea)} <b>${t(lang, "describe_title")}</b>\n\n${t(lang, "describe_body")}`,
      { parse_mode: "HTML" }
    );
  });

  bot.callbackQuery(/^approve_plan:(.+)$/, async (ctx) => {
    const lang = getLang(ctx);
    try { await ctx.answerCallbackQuery(t(lang, "building_app") + "..."); } catch {}
    const projectId = ctx.match[1];

    if (processingProjects.has(projectId)) return;

    const from = ctx.from;
    const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);

    if (!(await billingService.hasBalance(user.id, 5))) {
      await ctx.reply(errorMessage(t(lang, "balance_required_5"), lang), { parse_mode: "HTML" });
      return;
    }

    const project = await projectService.getProject(projectId);
    if (!project || !project.plan) {
      await ctx.reply(errorMessage(t(lang, "no_plan_found"), lang), { parse_mode: "HTML" });
      return;
    }

    if (project.status === "building" || project.status === "deployed" || project.status === "released") {
      return;
    }

    try { await ctx.deleteMessage(); } catch {}

    processingProjects.add(projectId);
    await projectService.updateProjectStatus(projectId, "building");

    let checklistItems: string[] = [];
    try {
      checklistItems = await agentService.generateChecklist(project.description || "", project.plan, lang);
    } catch {}

    const items: ChecklistItem[] = checklistItems.map(t => ({ text: t, done: false }));
    const useChecklist = items.length > 0;

    const statusMsg = await ctx.reply(
      useChecklist
        ? checklistMessage(t(lang, "building_app"), items, undefined, lang)
        : processMessage(t(lang, "starting_agent"), undefined, lang),
      { parse_mode: "HTML" },
    );

    let lastUpdate = Date.now();

    try {
      const onCheckTodo = useChecklist ? async (id: number) => {
        if (id >= 1 && id <= items.length) {
          items[id - 1].done = true;
          try {
            await ctx.api.editMessageText(
              ctx.chat!.id, statusMsg.message_id,
              checklistMessage(t(lang, "building_app"), items, undefined, lang),
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
            ctx.chat!.id, statusMsg.message_id,
            useChecklist
              ? checklistMessage(t(lang, "building_app"), items, `${p.action} ${esc(p.detail)}`, lang)
              : processMessage(`${p.action} ${esc(p.detail)}`, p.percent, lang),
            { parse_mode: "HTML" }
          );
        } catch {}
      };

      const askUser = createAskUser(projectId, ctx.chat!.id, statusMsg.message_id, lang);

      const result = await agentService.buildApp(
        projectId,
        project.description || "",
        project.plan,
        progress,
        askUser,
        useChecklist ? checklistItems : undefined,
        onCheckTodo,
        lang,
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

      try { await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id); } catch {}

      try {
        const reportUrl = await publishReport(
          "App Created",
          result.summary,
          `${t(lang, "cost_label")} $${usage.costUsd.toFixed(4)} | ${t(lang, "balance_label")} $${usage.newBalance.toFixed(2)}`
        );
        await ctx.reply(
          doneMessage(t(lang, "app_ready"), `${costLine(usage.costUsd, usage.newBalance, lang)}\n\n<a href="${reportUrl}">${t(lang, "view_report")}</a>`),
          {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [
              [{ text: t(lang, "btn_open_app"), callback_data: `dash:${projectId}` }],
            ]},
          }
        );
      } catch (reportErr) {
        console.error("[Callback] Telegraph report error:", reportErr);
        await ctx.reply(
          doneMessage(t(lang, "app_ready"), `${mdToTgHtml(truncSummary(result.summary, 2000, lang))}\n\n${costLine(usage.costUsd, usage.newBalance, lang)}`),
          {
            parse_mode: "HTML",
            reply_markup: projectActionsKeyboard(projectId, "deployed", await getProjectFeatures(projectId), project.botUsername || undefined, lang),
          }
        );
      }
    } catch (err) {
      console.error("[Callback] Build error:", err);
      processingProjects.delete(projectId);
      await projectService.updateProjectStatus(projectId, "error");
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        errorMessage(`${t(lang, "build_failed")} ${esc(err instanceof Error ? err.message : "Unknown error")}\n\n${t(lang, "try_again")}`, lang),
        { parse_mode: "HTML", reply_markup: planActionKeyboard(projectId, lang) }
      ).catch(() => {});
    }
  });

  bot.callbackQuery(/^modify_plan:(.+)$/, async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const projectId = ctx.match[1];
    ctx.session.activeProjectId = projectId;
    ctx.session.awaitingInput = "plan_feedback";

    await ctx.reply(
      `${ce(EMOJI.update)} <b>${t(lang, "modify_plan_title")}</b>\n\n${t(lang, "modify_plan_body")}`,
      { parse_mode: "HTML" }
    );
  });

  bot.callbackQuery(/^decline_plan:(.+)$/, async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const projectId = ctx.match[1];
    ctx.session.activeProjectId = projectId;
    ctx.session.awaitingInput = "description";
    ctx.session.pendingPlan = undefined;

    await ctx.reply(
      `${ce(EMOJI.indicator_error)} <b>${t(lang, "decline_plan")}</b>\n\n${t(lang, "decline_plan_body")}`,
      { parse_mode: "HTML" }
    );
  });

  bot.callbackQuery(/^open_app:(.+)$/, async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const projectId = ctx.match[1];
    const project = await projectService.getProject(projectId);
    const botUsername = project?.botUsername;

    if (!botUsername) {
      await ctx.reply(errorMessage(t(lang, "project_not_found"), lang), { parse_mode: "HTML" });
      return;
    }

    await ctx.reply(`${ce(EMOJI.logo)} <b>${t(lang, "btn_open_app")}</b>`, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: t(lang, "btn_open_app"), url: `https://t.me/${botUsername}` }],
        ],
      },
    });
  });

  bot.callbackQuery(/^edit_code:(.+)$/, async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const projectId = ctx.match[1];
    const editorUrl = `${config.baseUrl}/editor/${projectId}/`;

    await ctx.reply(`${ce(EMOJI.setting)} <b>${t(lang, "code_editor")}</b>\n\n${t(lang, "code_editor_body")}`, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: t(lang, "btn_open_editor"), url: editorUrl }],
        ],
      },
    });
  });

  bot.callbackQuery(/^update_app:(.+)$/, async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const projectId = ctx.match[1];

    const from = ctx.from;
    const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);
    if (!(await billingService.hasBalance(user.id, 5))) {
      await ctx.reply(errorMessage(t(lang, "balance_required_5_update"), lang), { parse_mode: "HTML" });
      return;
    }

    ctx.session.activeProjectId = projectId;
    ctx.session.awaitingInput = "update_description";

    await ctx.reply(
      `${ce(EMOJI.update)} <b>${t(lang, "update_title")}</b>\n\n` +
      t(lang, "update_body") + "\n\n" +
      `${ce(EMOJI.idea)} ${t(lang, "update_attach_hint")}`,
      {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [
          [{ text: `📎 ${t(lang, "btn_attach_files")}`, callback_data: `attach_files:${projectId}` }],
        ]},
      }
    );
  });

  bot.callbackQuery(/^attach_files:(.+)$/, async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const projectId = ctx.match[1];
    ctx.session.activeProjectId = projectId;
    ctx.session.awaitingInput = "attach_files";
    ctx.session.pendingAttachments = [];

    await ctx.reply(
      `📎 <b>${t(lang, "attach_title")}</b>\n\n${t(lang, "attach_body")}`,
      { parse_mode: "HTML" }
    );
  });

  bot.callbackQuery(/^release:(.+)$/, async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const projectId = ctx.match[1];

    try {
      const commitNum = await commitService.releaseCurrentDev(projectId);
      const project = await projectService.getProject(projectId);
      const features = await getProjectFeatures(projectId);

      try {
        await ctx.editMessageReplyMarkup({
          reply_markup: projectActionsKeyboard(projectId, "released", features, project?.botUsername || undefined, lang),
        });
      } catch {}

      await ctx.reply(
        doneMessage(t(lang, "version_released"), t(lang, "version_released_detail", { num: String(commitNum) })),
        { parse_mode: "HTML" }
      );
    } catch (err) {
      console.error("[Callback] Release error:", err);
      await ctx.reply(
        errorMessage(t(lang, "release_error"), lang),
        { parse_mode: "HTML" }
      );
    }
  });

  bot.callbackQuery(/^dash:(.+)$/, async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const projectId = ctx.match[1];
    const project = await projectService.getProject(projectId);
    if (!project) return;
    const features = await getProjectFeatures(projectId);

    await ctx.reply(
      `${statusIndicator(project.status)} <b>${esc(project.name)}</b>`,
      {
        parse_mode: "HTML",
        reply_markup: projectActionsKeyboard(projectId, project.status, features, project.botUsername || undefined, lang),
      }
    );
  });

  bot.callbackQuery(/^admin:(.+)$/, async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const projectId = ctx.match[1];
    const adminUrl = `${config.baseUrl}/admin/${projectId}/`;

    await ctx.reply(`${ce(EMOJI.setting)} ${t(lang, "open_admin")}`, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: t(lang, "btn_admin_panel"), web_app: { url: adminUrl } }],
        ],
      },
    });
  });

  bot.callbackQuery(/^wallet:(.+)$/, async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const projectId = ctx.match[1];
    const wallet = await projectService.getTonWallet(projectId);

    const walletInfo = wallet
      ? `<b>${t(lang, "wallet_current")}</b>\n<code>${esc(wallet)}</code>`
      : t(lang, "wallet_not_set");

    await ctx.reply(
      `${ce(EMOJI.dollar, "💎")} <b>${t(lang, "wallet_title")}</b>\n\n${walletInfo}\n\n${t(lang, "wallet_desc")}`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: wallet ? t(lang, "btn_change_wallet") : t(lang, "btn_set_wallet"), callback_data: `sw:${projectId}` }],
            [{ text: t(lang, "btn_back"), callback_data: `project:${projectId}` }],
          ],
        },
      }
    );
  });

  bot.callbackQuery(/^sw:(.+)$/, async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const projectId = ctx.match[1];
    ctx.session.activeProjectId = projectId;
    ctx.session.awaitingInput = "ton_wallet";

    await ctx.reply(
      `${ce(EMOJI.dollar, "💎")} <b>${t(lang, "set_wallet_title")}</b>\n\n` +
      `${t(lang, "set_wallet_body")}\n\n` +
      `<blockquote>${t(lang, "set_wallet_note")}</blockquote>`,
      { parse_mode: "HTML" }
    );
  });

  bot.callbackQuery(/^suggest:(.+)$/, async (ctx) => {
    const lang = getLang(ctx);
    try { await ctx.answerCallbackQuery(t(lang, "generating_suggestions")); } catch {}
    const projectId = ctx.match[1];

    const from = ctx.from;
    const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);

    if (!(await billingService.hasBalance(user.id))) {
      await ctx.reply(errorMessage(t(lang, "insufficient_balance"), lang), { parse_mode: "HTML" });
      return;
    }

    const project = await projectService.getProject(projectId);

    if (!project?.description || !project?.plan) {
      await ctx.reply(errorMessage(t(lang, "need_desc_plan"), lang), { parse_mode: "HTML" });
      return;
    }

    const statusMsg = await ctx.reply(processMessage(t(lang, "generating_suggestions"), undefined, lang), { parse_mode: "HTML" });

    try {
      const result = await claudeService.suggestImprovements(
        project.description,
        project.plan,
        lang
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
          doneMessage(t(lang, "no_suggestions"), `${t(lang, "no_suggestions_body")}\n\n${costLine(usage.costUsd, usage.newBalance, lang)}`),
          { parse_mode: "HTML" }
        );
        return;
      }

      let text = `${ce(EMOJI.idea)} <b>${t(lang, "suggested_improvements")}</b>\n\n`;
      result.suggestions.forEach((s, i) => {
        text += `${i + 1}. ${esc(s)}\n\n`;
      });
      text += `${t(lang, "select_improvements")}\n\n${costLine(usage.costUsd, usage.newBalance, lang)}`;

      ctx.session.conversationState = "idle";
      (ctx.session as any).pendingSuggestions = result.suggestions;

      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        text,
        {
          parse_mode: "HTML",
          reply_markup: suggestionsKeyboard(projectId, result.suggestions, lang),
        }
      );
    } catch (err) {
      console.error("[Callback] Suggestions error:", err);
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        errorMessage(t(lang, "suggestion_error"), lang),
        { parse_mode: "HTML" }
      );
    }
  });

  bot.callbackQuery(/^apply_suggestion:(.+):(\d+)$/, async (ctx) => {
    const lang = getLang(ctx);
    try { await ctx.answerCallbackQuery(t(lang, "applying_suggestion") + "..."); } catch {}
    const projectId = ctx.match[1];

    if (processingProjects.has(projectId)) return;

    const suggestionIndex = parseInt(ctx.match[2]);
    const suggestions = (ctx.session as any).pendingSuggestions as string[] | undefined;

    if (!suggestions || !suggestions[suggestionIndex]) {
      await ctx.reply(errorMessage(t(lang, "suggestion_not_found"), lang), { parse_mode: "HTML" });
      return;
    }

    const from = ctx.from;
    const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);

    if (!(await billingService.hasBalance(user.id, 5))) {
      await ctx.reply(errorMessage(t(lang, "balance_required_5_suggest"), lang), { parse_mode: "HTML" });
      return;
    }

    const suggestion = suggestions[suggestionIndex];
    ctx.session.activeProjectId = projectId;

    try { await ctx.deleteMessage(); } catch {}

    processingProjects.add(projectId);

    let checklistItems: string[] = [];
    try {
      checklistItems = await agentService.generateChecklist(suggestion, undefined, lang);
    } catch {}

    const items: ChecklistItem[] = checklistItems.map(t => ({ text: t, done: false }));
    const useChecklist = items.length > 0;

    const statusMsg = await ctx.reply(
      useChecklist
        ? checklistMessage(t(lang, "applying_suggestion"), items, undefined, lang)
        : processMessage(`${t(lang, "applying_suggestion")}: ${esc(suggestion)}`, undefined, lang),
      { parse_mode: "HTML" },
    );

    let lastUpdate = Date.now();

    try {
      const onCheckTodo = useChecklist ? async (id: number) => {
        if (id >= 1 && id <= items.length) {
          items[id - 1].done = true;
          try {
            await ctx.api.editMessageText(
              ctx.chat!.id, statusMsg.message_id,
              checklistMessage(t(lang, "applying_suggestion"), items, undefined, lang),
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
            ctx.chat!.id, statusMsg.message_id,
            useChecklist
              ? checklistMessage(t(lang, "applying_suggestion"), items, `${p.action} ${esc(p.detail)}`, lang)
              : processMessage(`${p.action} ${esc(p.detail)}`, p.percent, lang),
            { parse_mode: "HTML" }
          );
        } catch {}
      };

      const askUser = createAskUser(projectId, ctx.chat!.id, statusMsg.message_id, lang);
      const result = await agentService.updateApp(projectId, suggestion, progress, undefined, askUser, useChecklist ? checklistItems : undefined, onCheckTodo, lang);

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

      try { await ctx.api.deleteMessage(ctx.chat!.id, statusMsg.message_id); } catch {}

      try {
        const reportUrl = await publishReport(
          t(lang, "suggestion_applied"),
          result.summary,
          `${t(lang, "cost_label")} $${usage.costUsd.toFixed(4)} | ${t(lang, "balance_label")} $${usage.newBalance.toFixed(2)}`
        );
        await ctx.api.sendMessage(
          ctx.chat!.id,
          doneMessage(t(lang, "suggestion_applied"), `<i>${esc(suggestion)}</i>\n\n${costLine(usage.costUsd, usage.newBalance, lang)}\n\n<a href="${reportUrl}">${t(lang, "view_report")}</a>`),
          {
            parse_mode: "HTML",
            reply_markup: { inline_keyboard: [
              [{ text: t(lang, "btn_open_app"), callback_data: `dash:${projectId}` }],
            ]},
          }
        );
      } catch (reportErr) {
        console.error("[Callback] Telegraph report error (suggestion):", reportErr);
        const project = await projectService.getProject(projectId);
        const features = await getProjectFeatures(projectId);
        await ctx.api.sendMessage(
          ctx.chat!.id,
          doneMessage(t(lang, "suggestion_applied"), `<i>${esc(suggestion)}</i>\n\n${mdToTgHtml(truncSummary(result.summary, 2000, lang))}\n\n${costLine(usage.costUsd, usage.newBalance, lang)}`),
          {
            parse_mode: "HTML",
            reply_markup: projectActionsKeyboard(projectId, project?.status || "deployed", features, project?.botUsername || undefined, lang),
          }
        );
      }
    } catch (err) {
      await ctx.api.editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        errorMessage(t(lang, "suggestion_error"), lang),
        { parse_mode: "HTML" }
      );
    } finally {
      processingProjects.delete(projectId);
    }

    ctx.session.awaitingInput = null;
  });

  bot.callbackQuery(/^skip_suggestions:(.+)$/, async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const projectId = ctx.match[1];
    const project = await projectService.getProject(projectId);
    const features = await getProjectFeatures(projectId);

    await ctx.reply(
      doneMessage(t(lang, "no_changes"), t(lang, "no_changes_body")),
      { parse_mode: "HTML", reply_markup: projectActionsKeyboard(projectId, project?.status || "deployed", features, project?.botUsername || undefined, lang) }
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
    const lang = getLang(ctx);
    const projectId = ctx.match[1];
    const project = await projectService.getProject(projectId);
    if (!project) return;

    const commits = await commitService.getCommits(projectId);
    if (commits.length === 0) {
      await ctx.editMessageText(
        `${ce(EMOJI.list)} <b>${t(lang, "versions_title")}</b>\n\n${t(lang, "no_commits")}`,
        { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: t(lang, "btn_back"), callback_data: `project:${projectId}` }]] } }
      );
      return;
    }

    await ctx.editMessageText(
      `${ce(EMOJI.list)} <b>${t(lang, "versions_title")} — ${esc(project.name)}</b>\n\n${t(lang, "versions_tap")}\n${project.releaseCommit !== null ? t(lang, "current_release", { num: String(project.releaseCommit) }) : t(lang, "no_release_yet")}`,
      { parse_mode: "HTML", reply_markup: versionsKeyboard(projectId, commits, project.releaseCommit, lang) }
    );
  });

  bot.callbackQuery(/^rv:(.+):(\d+)$/, async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const projectId = ctx.match[1];
    const commitNum = ctx.match[2];

    const commits = await commitService.getCommits(projectId);
    const commit = commits.find(c => c.version === commitNum);
    const label = commit?.changelog || `Commit #${commitNum}`;

    await ctx.editMessageText(
      `${ce(EMOJI.indicator_warning)} <b>${t(lang, "revert_confirm", { num: commitNum })}</b>\n\n<i>${esc(label)}</i>\n\n${t(lang, "revert_warning")}`,
      { parse_mode: "HTML", reply_markup: revertConfirmKeyboard(projectId, commitNum, lang) }
    );
  });

  bot.callbackQuery(/^rvc:(.+):(\d+)$/, async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const projectId = ctx.match[1];
    const commitNum = parseInt(ctx.match[2], 10);

    try {
      await commitService.revertToCommit(projectId, commitNum);
      const project = await projectService.getProject(projectId);
      const features = await getProjectFeatures(projectId);

      await ctx.editMessageText(
        doneMessage(t(lang, "reverted"), t(lang, "reverted_detail", { num: String(commitNum) })),
        {
          parse_mode: "HTML",
          reply_markup: projectActionsKeyboard(projectId, project?.status || "deployed", features, project?.botUsername || undefined, lang),
        }
      );
    } catch (err) {
      console.error("[Callback] Revert error:", err);
      await ctx.reply(
        errorMessage(`${t(lang, "revert_error")} ${esc(err instanceof Error ? err.message : "Unknown error")}`, lang),
        { parse_mode: "HTML" }
      );
    }
  });

  // === Settings ===

  bot.callbackQuery(/^settings:(.+)$/, async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const projectId = ctx.match[1];
    const project = await projectService.getProject(projectId);
    if (!project) return;

    await ctx.editMessageText(
      `${ce(EMOJI.setting)} <b>${t(lang, "settings_title")} — ${esc(project.name)}</b>`,
      { parse_mode: "HTML", reply_markup: settingsKeyboard(projectId, lang) }
    );
  });

  bot.callbackQuery(/^info:(.+)$/, async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
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
      `${ce(EMOJI.help)} <b>${t(lang, "project_info")}</b>\n\n` +
      `<b>${t(lang, "info_bot_username")}</b> ${project.botUsername ? `@${project.botUsername}` : "Not set"}\n` +
      `<b>${t(lang, "info_bot_id")}</b> ${botId}\n` +
      `<b>${t(lang, "info_bot_token")}</b> ${tokenDisplay}\n` +
      `<b>${t(lang, "info_webapp_url")}</b> <code>${appUrl}</code>`,
      { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: t(lang, "btn_back"), callback_data: `settings:${projectId}` }]] } }
    );
  });

  bot.callbackQuery(/^quality:(.+)$/, async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const projectId = ctx.match[1];
    const project = await projectService.getProject(projectId);
    if (!project) return;

    const tier = (project as any).qualityTier || 1;
    const desc = qualityDescription(lang);

    await ctx.editMessageText(
      `${ce(EMOJI.setting)} <b>${t(lang, "quality_title")}</b>\n\n` +
      `${t(lang, "quality_desc")}\n\n` + desc,
      { parse_mode: "HTML", reply_markup: qualityKeyboard(projectId, tier, lang) }
    );
  });

  bot.callbackQuery(/^qt:(.+):(\d)$/, async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const projectId = ctx.match[1];
    const tier = parseInt(ctx.match[2]);
    if (tier < 1 || tier > 4) return;

    await prisma.project.update({ where: { id: projectId }, data: { qualityTier: tier } });

    const desc = qualityDescription(lang);
    await ctx.editMessageText(
      `${ce(EMOJI.setting)} <b>${t(lang, "quality_title")}</b>\n\n` +
      `${t(lang, "quality_desc")}\n\n` + desc,
      { parse_mode: "HTML", reply_markup: qualityKeyboard(projectId, tier, lang) }
    );
  });

  bot.callbackQuery(/^transfer:(.+)$/, async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const projectId = ctx.match[1];
    ctx.session.activeProjectId = projectId;
    ctx.session.awaitingInput = "transfer_owner";

    await ctx.reply(
      `${ce(EMOJI.indicator_warning)} <b>${t(lang, "transfer_title")}</b>\n\n` +
      `${t(lang, "transfer_body")}\n\n` +
      `<blockquote>${t(lang, "transfer_note")}</blockquote>`,
      { parse_mode: "HTML" }
    );
  });

  bot.callbackQuery(/^confirm_transfer:(.+):(\d+)$/, async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const projectId = ctx.match[1];
    const newOwnerId = parseInt(ctx.match[2]);

    try {
      const project = await projectService.getProject(projectId);
      if (!project) return;

      await projectService.transferProject(projectId, newOwnerId);

      await ctx.editMessageText(
        `${ce(EMOJI.indicator_success, "✅")} <b>${t(lang, "transfer_done")}</b>\n\n` +
        t(lang, "transfer_done_body", { name: esc(project.name) }),
        {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: t(lang, "btn_back"), callback_data: "nav_list" }]] },
        }
      );
    } catch (err) {
      console.error("[Callback] Transfer error:", err);
      await ctx.editMessageText(
        errorMessage(t(lang, "transfer_error"), lang),
        { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: t(lang, "btn_back"), callback_data: `project:${projectId}` }]] } }
      );
    }
  });

  bot.callbackQuery(/^remove_project:(.+)$/, async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const projectId = ctx.match[1];
    const project = await projectService.getProject(projectId);
    if (!project) return;

    await ctx.editMessageText(
      `${ce(EMOJI.indicator_error)} <b>${t(lang, "remove_confirm_title", { name: esc(project.name) })}</b>\n\n` +
      `<blockquote>${t(lang, "remove_warning")}</blockquote>`,
      {
        parse_mode: "HTML",
        reply_markup: removeConfirmKeyboard(projectId, lang),
      }
    );
  });

  bot.callbackQuery(/^confirm_remove:(.+)$/, async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const projectId = ctx.match[1];
    const project = await projectService.getProject(projectId);
    if (!project) return;

    const projectName = project.name;

    await ctx.editMessageText(
      processMessage(t(lang, "removing"), undefined, lang),
      { parse_mode: "HTML" }
    );

    try {
      const { botRunnerService } = await import("../../services/bot-runner.service");
      try { botRunnerService.stopBot(projectId); } catch {}

      const projectDir = path.join(__dirname, "..", "..", "..", "projects", projectId);
      if (fs.existsSync(projectDir)) {
        fs.rmSync(projectDir, { recursive: true, force: true });
      }

      await projectService.deleteProject(projectId);

      const from = ctx.from;
      const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);
      const projects = await projectService.getProjectsByUser(user.id);

      if (projects.length === 0) {
        await ctx.editMessageText(
          doneMessage(t(lang, "removed", { name: esc(projectName) }), t(lang, "no_more_projects")),
          { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: t(lang, "btn_back"), callback_data: "nav_welcome" }]] } }
        );
      } else {
        await ctx.editMessageText(
          doneMessage(t(lang, "removed", { name: esc(projectName) }), buildListText(projects, undefined, undefined, lang)),
          { parse_mode: "HTML", reply_markup: projectListKeyboard(projects, true, lang) }
        );
      }
    } catch (err) {
      console.error("[Callback] Remove error:", err);
      await ctx.editMessageText(
        errorMessage(t(lang, "remove_error"), lang),
        { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: t(lang, "btn_back"), callback_data: `project:${projectId}` }]] } }
      );
    }
  });

  // ── Features Store ──

  bot.callbackQuery(/^features:(.+)$/, async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const projectId = ctx.match[1];
    const features = await getProjectFeatures(projectId);

    let text = `${ce(EMOJI.dollar, "💎")} <b>${t(lang, "premium_features")}</b>\n\n`;
    for (const f of PAID_FEATURES) {
      const owned = features.includes(f.id);
      const label = translateFeatureLabel(lang, f.id) || f.label;
      const desc = translateFeatureDesc(lang, f.id) || f.description;
      text += owned
        ? `✅ <b>${esc(label)}</b> — <i>${t(lang, "unlocked")}</i>\n`
        : `🔒 <b>${esc(label)}</b> — <b>$${f.price}</b>\n<i>${esc(desc)}</i>\n`;
      text += "\n";
    }

    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: featuresKeyboard(projectId, features, lang),
    });
  });

  bot.callbackQuery(/^fo:(.+):(.+)$/, async (ctx) => {
    const lang = getLang(ctx);
    try { await ctx.answerCallbackQuery(t(lang, "already_unlocked")); } catch {}
  });

  bot.callbackQuery(/^bf:(.+):(.+)$/, async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const projectId = ctx.match[1];
    const featureId = ctx.match[2];
    const feature = getFeatureById(featureId);
    if (!feature) return;

    const from = ctx.from;
    const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);
    const balance = await billingService.getUserBalance(user.id);

    const fLabel = translateFeatureLabel(lang, featureId) || feature.label;
    const fDesc = translateFeatureDesc(lang, featureId) || feature.description;
    await ctx.editMessageText(
      `${ce(EMOJI.dollar, "💎")} <b>${t(lang, "purchase_title", { label: esc(fLabel) })}</b>\n\n` +
      `<blockquote>${esc(fDesc)}</blockquote>\n\n` +
      `Price: <b>$${feature.price}</b>\n` +
      `${t(lang, "balance_label")} <b>$${balance.toFixed(2)}</b>\n\n` +
      (balance >= feature.price ? `${t(lang, "btn_confirm_purchase")}:` : `⚠️ ${t(lang, "feature_insufficient", { needed: (feature.price - balance).toFixed(2) })}`),
      {
        parse_mode: "HTML",
        reply_markup: balance >= feature.price
          ? confirmBuyKeyboard(projectId, featureId, lang)
          : { inline_keyboard: [[{ text: t(lang, "btn_topup"), callback_data: "topup" }], [{ text: t(lang, "btn_back"), callback_data: `features:${projectId}` }]] },
      }
    );
  });

  bot.callbackQuery(/^cb:(.+):(.+)$/, async (ctx) => {
    await ack(ctx);
    const lang = getLang(ctx);
    const projectId = ctx.match[1];
    const featureId = ctx.match[2];
    const feature = getFeatureById(featureId);
    if (!feature) return;

    const from = ctx.from;
    const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);

    try {
      const { newBalance } = await purchaseFeature(user.id, projectId, featureId);
      const features = await getProjectFeatures(projectId);
      const fLabel2 = translateFeatureLabel(lang, featureId) || feature.label;

      await ctx.editMessageText(
        `${ce(EMOJI.indicator_success, "✅")} <b>${t(lang, "feature_unlocked", { label: esc(fLabel2) })}</b>\n\n` +
        `<blockquote>${t(lang, "feature_charged", { price: String(feature.price), balance: newBalance.toFixed(2) })}</blockquote>`,
        {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: t(lang, "btn_back_features"), callback_data: `features:${projectId}` }], [{ text: t(lang, "btn_back_project"), callback_data: `project:${projectId}` }]] },
        }
      );
    } catch (err: any) {
      await ctx.editMessageText(
        errorMessage(err.message || t(lang, "purchase_failed"), lang),
        { parse_mode: "HTML", reply_markup: { inline_keyboard: [[{ text: t(lang, "btn_back"), callback_data: `features:${projectId}` }]] } }
      );
    }
  });
}
