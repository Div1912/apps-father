import { prisma } from "../db";
import { config } from "../config";
import { t, Lang } from "../bot/i18n";
import { ce, EMOJI } from "../bot/emoji";

const PUSH_DELAY_MIN = 20;
const FEATURE_GRACE_DAYS = 7;
const TICK_INTERVAL_MS = 60_000;
const INITIAL_DELAY_MS = 30_000;
const PER_TICK_USER_LIMIT = 200;

const GIFT_EMOJI_ID = "5384541907051357217";

type Scenario = "joined" | "bot_created" | "plan_created";

function langOf(raw: string | null | undefined): Lang {
  return raw === "ru" || raw === "ua" ? raw : "en";
}

function buildJoinedText(lang: Lang): string {
  return (
    `${ce(EMOJI.idea, "💡")} <b>${t(lang, "retention_joined_title")}</b>\n\n` +
    `${t(lang, "retention_joined_body")}`
  );
}

function buildBotText(lang: Lang): string {
  return (
    `${ce(EMOJI.add, "✨")} <b>${t(lang, "retention_bot_title")}</b>\n\n` +
    `${t(lang, "retention_bot_body")}`
  );
}

function buildPlanText(lang: Lang, projectName: string): string {
  const safeName = (projectName || "").trim() || (lang === "ru" ? "Твоя идея" : lang === "ua" ? "Твоя ідея" : "Your idea");
  return (
    `${ce(EMOJI.indicator_success, "🔥")} ${t(lang, "retention_plan_title", { name: safeName })}\n\n` +
    `${t(lang, "retention_plan_body", { name: safeName })}\n\n` +
    `<blockquote>${ce(GIFT_EMOJI_ID, "🎁")} ${t(lang, "retention_plan_bonus")}</blockquote>`
  );
}

async function sendPush(telegramId: bigint, text: string, lang: Lang): Promise<boolean> {
  const miniAppUrl = `${config.baseUrl}/telegram-mini-app`;
  const body = {
    chat_id: String(telegramId),
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[
        {
          text: t(lang, "retention_btn_launch"),
          web_app: { url: miniAppUrl },
        },
      ]],
    },
  };

  try {
    const r = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      console.error(`[Retention] sendMessage ${r.status} for ${telegramId}: ${txt.slice(0, 200)}`);
      // 403 = user blocked the bot — mark all 3 as sent so we never retry
      if (r.status === 403) return true;
      return false;
    }
    return true;
  } catch (e: any) {
    console.error("[Retention] sendMessage err:", e?.message || e);
    return false;
  }
}

async function markSent(userId: number, scenario: Scenario): Promise<void> {
  try {
    await prisma.retentionPush.create({ data: { userId, scenario } });
  } catch (e: any) {
    // unique violation = already exists, fine
    if (e?.code !== "P2002") console.error("[Retention] markSent err:", e?.message || e);
  }
}

export async function processRetentionTick(): Promise<void> {
  const now = new Date();
  const cutoff20Min = new Date(now.getTime() - PUSH_DELAY_MIN * 60 * 1000);
  const cutoffGrace = new Date(now.getTime() - FEATURE_GRACE_DAYS * 24 * 60 * 60 * 1000);

  // Eligible = registered between (now - GRACE_DAYS) and (now - 20min),
  // and never built a deployed/released app.
  const users = await prisma.user.findMany({
    where: {
      createdAt: { gte: cutoffGrace, lte: cutoff20Min },
      projects: {
        none: { status: { in: ["deployed", "released"] } },
      },
    },
    include: {
      projects: {
        select: {
          id: true,
          name: true,
          plan: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: "desc" },
      },
      retentionPushes: { select: { scenario: true } },
    },
    take: PER_TICK_USER_LIMIT,
  });

  for (const u of users) {
    const lang = langOf(u.language);
    const sent = new Set(u.retentionPushes.map((r) => r.scenario));

    // ── Scenario 3: plan exists, not built yet ─────────────────────────────
    if (!sent.has("plan_created")) {
      const projectWithPlan = u.projects.find(
        (p) => p.plan != null && p.status !== "building",
      );
      if (projectWithPlan && projectWithPlan.updatedAt <= cutoff20Min) {
        const text = buildPlanText(lang, projectWithPlan.name);
        const ok = await sendPush(u.telegramId, text, lang);
        if (ok) {
          await markSent(u.id, "plan_created");
          console.log(`[Retention] Sent 'plan_created' to ${u.telegramId} (${u.firstName || u.username || ""})`);
        }
        continue;
      }
    }

    // ── Scenario 2: bot/project exists, no plan yet ────────────────────────
    if (!sent.has("bot_created")) {
      const hasAnyPlan = u.projects.some((p) => p.plan != null);
      if (u.projects.length > 0 && !hasAnyPlan) {
        const latest = u.projects[0];
        if (latest.createdAt <= cutoff20Min) {
          const text = buildBotText(lang);
          const ok = await sendPush(u.telegramId, text, lang);
          if (ok) {
            await markSent(u.id, "bot_created");
            console.log(`[Retention] Sent 'bot_created' to ${u.telegramId} (${u.firstName || u.username || ""})`);
          }
          continue;
        }
      }
    }

    // ── Scenario 1: joined, never created a project ────────────────────────
    if (!sent.has("joined") && u.projects.length === 0) {
      // outer query already enforces createdAt <= cutoff20Min
      const text = buildJoinedText(lang);
      const ok = await sendPush(u.telegramId, text, lang);
      if (ok) {
        await markSent(u.id, "joined");
        console.log(`[Retention] Sent 'joined' to ${u.telegramId} (${u.firstName || u.username || ""})`);
      }
    }
  }
}

let intervalHandle: NodeJS.Timeout | null = null;

export function startRetentionScheduler(): void {
  if (intervalHandle) return;
  setTimeout(() => {
    processRetentionTick().catch((e) =>
      console.error("[Retention] initial tick error:", e?.message || e),
    );
  }, INITIAL_DELAY_MS);
  intervalHandle = setInterval(() => {
    processRetentionTick().catch((e) =>
      console.error("[Retention] tick error:", e?.message || e),
    );
  }, TICK_INTERVAL_MS);
  console.log(
    `[Retention] Scheduler started — ${PUSH_DELAY_MIN}min delay, every ${TICK_INTERVAL_MS / 1000}s, ${FEATURE_GRACE_DAYS}d grace window`,
  );
}

export function stopRetentionScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
