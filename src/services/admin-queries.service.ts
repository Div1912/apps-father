/**
 * Shared admin queries — used by both the legacy Mini-App admin
 * (`/telegram-mini-app/api/admin/*`) and the new browser CRM
 * (`/admin/api/*`). Centralizes:
 *
 *   - Users list with filter / sort / pagination / q
 *   - User detail (balance / partner / tags / notes / projects / payments / usage)
 *   - Mutations: balance set/add, partner edit, edit-all (firstName/username/etc),
 *     tags replace, note CRUD, wipe-data, full-reset.
 *
 * Implemented as plain async functions (not a class) so they're trivial to
 * import from any router without DI ceremony.
 */
import { prisma } from "../db";
import { Decimal } from "@prisma/client/runtime/library";

// ─── helpers ────────────────────────────────────────────────────────────────

function parseTagsBlob(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      return arr
        .filter((x) => typeof x === "string" && x.trim().length)
        .map((x) => x.trim())
        .slice(0, 32);
    }
  } catch {
    /* fall through */
  }
  return [];
}

function serializeTags(tags: string[]): string {
  const cleaned = Array.from(
    new Set(tags.filter((t) => typeof t === "string").map((t) => t.trim()).filter(Boolean)),
  ).slice(0, 32);
  return JSON.stringify(cleaned);
}

// ─── Users list ─────────────────────────────────────────────────────────────

export type UserFilter = "all" | "paying" | "free" | "partner" | "has_apps" | "no_apps" | "inactive_30d";
export type UserSort   = "newest" | "balance_desc" | "apps_desc" | "spent_desc" | "oldest";

export interface UsersListParams {
  q?: string;
  filter?: UserFilter;
  sort?: UserSort;
  page?: number;
  pageSize?: number;
}

export async function listUsers(params: UsersListParams = {}) {
  const filter   = (params.filter   || "all")     as UserFilter;
  const sort     = (params.sort     || "newest")  as UserSort;
  const page     = Math.max(1, params.page || 1);
  const pageSize = Math.min(200, Math.max(1, params.pageSize || 50));
  const q        = (params.q || "").trim();

  // Build the where clause.
  const where: any = {};

  if (q) {
    const numeric = /^\d+$/.test(q) ? BigInt(q) : null;
    where.OR = [
      { username: { contains: q, mode: "insensitive" } },
      { firstName: { contains: q, mode: "insensitive" } },
      ...(numeric !== null ? [{ telegramId: numeric }] : []),
    ];
  }

  if (filter === "paying") {
    where.payments = { some: { status: "confirmed" } };
  } else if (filter === "free") {
    where.payments = { none: { status: "confirmed" } };
  } else if (filter === "partner") {
    where.isPartner = true;
  } else if (filter === "has_apps") {
    where.projects = { some: {} };
  } else if (filter === "no_apps") {
    where.projects = { none: {} };
  } else if (filter === "inactive_30d") {
    const cutoff = new Date(Date.now() - 30 * 86400_000);
    where.AND = [
      ...(where.AND || []),
      {
        OR: [
          { usageLogs: { none: { createdAt: { gte: cutoff } } } },
        ],
      },
    ];
  }

  // Order by — Prisma can natively sort by simple fields; the others (apps
  // count / total spent) need an in-memory sort after fetch.
  let orderBy: any = { createdAt: "desc" };
  let needsPostSort: null | "apps" | "spent" = null;
  if (sort === "newest")             orderBy = { createdAt: "desc" };
  else if (sort === "oldest")        orderBy = { createdAt: "asc" };
  else if (sort === "balance_desc")  orderBy = { balance: "desc" };
  else if (sort === "apps_desc")     needsPostSort = "apps";
  else if (sort === "spent_desc")    needsPostSort = "spent";

  // Pagination — for native sorts only. Post-sort (apps/spent) needs the
  // full set; we cap to 5000 rows so an unbounded admin DB never melts the
  // server. (5K users is plenty for in-memory sort.)
  const skip = needsPostSort ? 0 : (page - 1) * pageSize;
  const take = needsPostSort ? 5000 : pageSize;

  const [total, rows] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      include: {
        _count: { select: { projects: true } },
      },
      orderBy,
      skip,
      take,
    }),
  ]);

  // Optionally enrich with totalSpent in one query (useful for sort=spent and
  // also so the row can show it).
  const ids = rows.map((u) => u.id);
  let spentByUser = new Map<number, number>();
  if (ids.length) {
    const spends = await prisma.usageLog.groupBy({
      by: ["userId"],
      where: { userId: { in: ids } },
      _sum: { costUsd: true },
    });
    spentByUser = new Map(spends.map((s) => [s.userId, Number(s._sum.costUsd || 0)]));
  }

  let mapped = rows.map((u) => ({
    id: u.id,
    telegramId: u.telegramId.toString(),
    username: u.username,
    firstName: u.firstName,
    balance: Number(u.balance),
    appSlots: u.appSlots,
    isPartner: u.isPartner,
    projectCount: u._count.projects,
    totalSpent: spentByUser.get(u.id) || 0,
    adminTags: parseTagsBlob((u as any).adminTags),
    createdAt: u.createdAt,
  }));

  if (needsPostSort === "apps") {
    mapped.sort((a, b) => b.projectCount - a.projectCount);
  } else if (needsPostSort === "spent") {
    mapped.sort((a, b) => b.totalSpent - a.totalSpent);
  }

  // Apply page slice for post-sorted results.
  let pageItems = mapped;
  if (needsPostSort) {
    const start = (page - 1) * pageSize;
    pageItems = mapped.slice(start, start + pageSize);
  }

  return {
    users: pageItems,
    page,
    pageSize,
    total,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

// ─── User detail ────────────────────────────────────────────────────────────

export async function getUserDetail(userId: number) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      projects: { orderBy: { updatedAt: "desc" } },
      payments: { orderBy: { createdAt: "desc" }, take: 30 },
      usageLogs: {
        orderBy: { createdAt: "desc" },
        take: 50,
        include: { project: { select: { name: true } } },
      },
    },
  });
  if (!user) return null;

  const totalSpent = await prisma.usageLog.aggregate({
    _sum: { costUsd: true },
    where: { userId },
  });

  return {
    id: user.id,
    telegramId: user.telegramId.toString(),
    username: user.username,
    firstName: user.firstName,
    language: user.language,
    balance: Number(user.balance),
    appSlots: user.appSlots,
    referredBy: user.referredBy ? user.referredBy.toString() : null,
    utmSource: user.utmSource,
    totalSpent: Number(totalSpent._sum.costUsd || 0),
    createdAt: user.createdAt,
    isPartner: user.isPartner,
    partnerPercent: user.partnerPercent ? Number(user.partnerPercent) : null,
    partnerTag: user.partnerTag,
    partnerReferralBonus: user.partnerReferralBonus ? Number(user.partnerReferralBonus) : null,
    partnerBalance: Number(user.partnerBalance),
    adminTags: parseTagsBlob((user as any).adminTags),
    projects: user.projects.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      botUsername: p.botUsername,
      totalCost: Number(p.totalCostUsd),
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    })),
    payments: user.payments.map((p) => ({
      id: p.id,
      amount: Number(p.amountUsd),
      status: p.status,
      createdAt: p.createdAt,
      confirmedAt: p.confirmedAt,
    })),
    usageLogs: user.usageLogs.map((l) => ({
      id: l.id,
      project: l.project?.name || "-",
      operation: l.operation,
      inputTokens: l.inputTokens,
      outputTokens: l.outputTokens,
      cost: Number(l.costUsd),
      createdAt: l.createdAt,
    })),
  };
}

// ─── Mutations ──────────────────────────────────────────────────────────────

export async function setUserBalance(userId: number, action: "set" | "add", amount: number) {
  if (!Number.isFinite(amount) || amount < 0) throw new Error("Invalid amount");
  const v = new Decimal(amount.toFixed(4));
  const updated =
    action === "set"
      ? await prisma.user.update({ where: { id: userId }, data: { balance: v } })
      : await prisma.user.update({
          where: { id: userId },
          data: { balance: { increment: v } },
        });
  return { balance: Number(updated.balance) };
}

export async function updateUserPartner(
  userId: number,
  body: {
    isPartner?: boolean;
    partnerPercent?: number | null;
    partnerTag?: string | null;
    partnerReferralBonus?: number | null;
  },
) {
  const data: any = {};
  if (typeof body.isPartner === "boolean") data.isPartner = body.isPartner;
  if (body.partnerPercent !== undefined) {
    data.partnerPercent =
      body.partnerPercent === null ? null : new Decimal(Number(body.partnerPercent).toFixed(2));
  }
  if (body.partnerTag !== undefined) data.partnerTag = body.partnerTag || null;
  if (body.partnerReferralBonus !== undefined) {
    data.partnerReferralBonus =
      body.partnerReferralBonus === null
        ? null
        : new Decimal(Number(body.partnerReferralBonus).toFixed(4));
  }
  const updated = await prisma.user.update({ where: { id: userId }, data });
  return {
    isPartner: updated.isPartner,
    partnerPercent: updated.partnerPercent ? Number(updated.partnerPercent) : null,
    partnerTag: updated.partnerTag,
    partnerReferralBonus: updated.partnerReferralBonus ? Number(updated.partnerReferralBonus) : null,
    partnerBalance: Number(updated.partnerBalance),
  };
}

/**
 * Patch arbitrary editable user fields. Only whitelisted keys are accepted
 * to avoid accidentally letting an admin set telegramId etc. from the UI.
 */
export async function patchUser(
  userId: number,
  body: {
    firstName?: string | null;
    username?: string | null;
    language?: string;
    appSlots?: number;
    referredBy?: string | null;
  },
) {
  const data: any = {};
  if (body.firstName !== undefined) data.firstName = body.firstName || null;
  if (body.username  !== undefined) data.username  = body.username  || null;
  if (body.language  !== undefined) data.language  = String(body.language);
  if (body.appSlots  !== undefined) {
    const n = Number(body.appSlots);
    if (!Number.isFinite(n) || n < 0) throw new Error("appSlots must be >= 0");
    data.appSlots = Math.floor(n);
  }
  if (body.referredBy !== undefined) {
    if (body.referredBy === null || body.referredBy === "") data.referredBy = null;
    else if (/^\d+$/.test(String(body.referredBy))) data.referredBy = BigInt(String(body.referredBy));
    else throw new Error("referredBy must be a numeric Telegram ID");
  }
  if (Object.keys(data).length === 0) throw new Error("No editable fields supplied");

  const updated = await prisma.user.update({ where: { id: userId }, data });
  return {
    id: updated.id,
    firstName: updated.firstName,
    username: updated.username,
    language: updated.language,
    appSlots: updated.appSlots,
    referredBy: updated.referredBy ? updated.referredBy.toString() : null,
  };
}

export async function setUserTags(userId: number, tags: string[]) {
  const json = serializeTags(tags);
  await prisma.user.update({ where: { id: userId }, data: ({ adminTags: json } as any) });
  return { adminTags: parseTagsBlob(json) };
}

// ─── Notes ──────────────────────────────────────────────────────────────────

export async function listUserNotes(userId: number) {
  const rows = await (prisma as any).adminUserNote.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return rows.map((n: any) => ({
    id: n.id,
    body: n.body,
    authorTag: n.authorTag,
    createdAt: n.createdAt,
  }));
}

export async function addUserNote(userId: number, body: string, authorTag?: string) {
  const trimmed = String(body || "").trim();
  if (!trimmed) throw new Error("Note body is required");
  if (trimmed.length > 4000) throw new Error("Note is too long (max 4000 chars)");
  const note = await (prisma as any).adminUserNote.create({
    data: {
      userId,
      body: trimmed,
      authorTag: authorTag || "admin",
    },
  });
  return {
    id: note.id,
    body: note.body,
    authorTag: note.authorTag,
    createdAt: note.createdAt,
  };
}

export async function deleteUserNote(userId: number, noteId: number) {
  await (prisma as any).adminUserNote.deleteMany({ where: { id: noteId, userId } });
  return { ok: true };
}

// ─── Projects list / detail ─────────────────────────────────────────────────

export type ProjectFilter = "all" | "deployed" | "released" | "building" | "planning" | "created" | "error";
export type ProjectSort   = "updated_desc" | "created_desc" | "budget_desc" | "budget_asc" | "name_asc";

export interface ProjectsListParams {
  q?: string;
  filter?: ProjectFilter;
  sort?: ProjectSort;
  page?: number;
  pageSize?: number;
}

export async function listProjects(params: ProjectsListParams = {}) {
  const filter   = (params.filter || "all")          as ProjectFilter;
  const sort     = (params.sort   || "updated_desc") as ProjectSort;
  const page     = Math.max(1, params.page || 1);
  const pageSize = Math.min(200, Math.max(1, params.pageSize || 50));
  const q        = (params.q || "").trim();

  const where: any = {};
  if (filter !== "all") where.status = filter;
  if (q) {
    where.OR = [
      { name:        { contains: q, mode: "insensitive" } },
      { botUsername: { contains: q, mode: "insensitive" } },
      { id:          { contains: q, mode: "insensitive" } },
      { user: { username:  { contains: q, mode: "insensitive" } } },
      { user: { firstName: { contains: q, mode: "insensitive" } } },
    ];
  }

  let orderBy: any = { updatedAt: "desc" };
  if      (sort === "updated_desc") orderBy = { updatedAt: "desc" };
  else if (sort === "created_desc") orderBy = { createdAt: "desc" };
  else if (sort === "budget_desc")  orderBy = { totalCostUsd: "desc" };
  else if (sort === "budget_asc")   orderBy = { totalCostUsd: "asc" };
  else if (sort === "name_asc")     orderBy = { name: "asc" };

  const skip = (page - 1) * pageSize;

  const [total, rows, statusCounts] = await Promise.all([
    prisma.project.count({ where }),
    prisma.project.findMany({
      where,
      include: { user: { select: { id: true, username: true, firstName: true } } },
      orderBy,
      skip,
      take: pageSize,
    }),
    prisma.project.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
  ]);

  return {
    projects: rows.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      botUsername: p.botUsername,
      totalCost: Number(p.totalCostUsd),
      description: p.description ? p.description.substring(0, 160) : null,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      ownerId: p.userId,
      owner: p.user.username || p.user.firstName || ("User " + p.userId),
    })),
    page,
    pageSize,
    total,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    statusCounts: Object.fromEntries(statusCounts.map((s) => [s.status, s._count._all])),
  };
}

export async function getProjectDetail(projectId: string) {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    include: { user: { select: { id: true, username: true, firstName: true, telegramId: true } } },
  });
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    status: p.status,
    description: p.description,
    plan: p.plan,
    projectSummary: p.projectSummary,
    botUsername: p.botUsername,
    botUserId: p.botUserId ? p.botUserId.toString() : null,
    features: p.features,
    preferences: p.preferences,
    totalCost: Number(p.totalCostUsd),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    releaseCommit: p.releaseCommit,
    ownerId: p.userId,
    ownerTelegramId: p.user.telegramId.toString(),
    owner: p.user.username || p.user.firstName || ("User " + p.userId),
  };
}

export async function patchProject(
  projectId: string,
  body: {
    name?: string;
    description?: string | null;
    status?: string;
    features?: string | null;
    preferences?: string | null;
    totalCost?: number;
  },
) {
  const data: any = {};
  if (body.name        !== undefined) data.name = String(body.name);
  if (body.description !== undefined) data.description = body.description || null;
  if (body.status      !== undefined) data.status = String(body.status);
  if (body.features    !== undefined) data.features    = body.features    || null;
  if (body.preferences !== undefined) data.preferences = body.preferences || null;
  if (body.totalCost   !== undefined) {
    const n = Number(body.totalCost);
    if (!Number.isFinite(n) || n < 0) throw new Error("totalCost must be >= 0");
    data.totalCostUsd = new Decimal(n.toFixed(4));
  }
  if (Object.keys(data).length === 0) throw new Error("No editable fields supplied");
  await prisma.project.update({ where: { id: projectId }, data });
  return getProjectDetail(projectId);
}

// ─── Operation breakdown (Dashboard) ──────────────────────────────────────
// Aggregates the same `usage_logs` table the timeseries query uses, but groups
// by `operation` (e.g. "agent.iteration", "agent.commit", "ai.avatar"), so the
// admin can see *where* the spend & tokens go.

export interface OpBreakdownRow {
  operation: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  count: number;
}

export async function getOperationBreakdown(params: {
  from?: Date | null;
  to?: Date | null;
}): Promise<OpBreakdownRow[]> {
  const where: any = {};
  if (params.from || params.to) {
    where.createdAt = {};
    if (params.from) where.createdAt.gte = params.from;
    if (params.to)   where.createdAt.lte = params.to;
  }
  const rows = await prisma.usageLog.groupBy({
    by: ["operation"],
    _sum: { costUsd: true, inputTokens: true, outputTokens: true },
    _count: { _all: true },
    where,
    orderBy: { _sum: { costUsd: "desc" } },
  });
  return rows.map((r) => ({
    operation: r.operation || "(unknown)",
    costUsd: Number(r._sum.costUsd || 0),
    inputTokens: Number(r._sum.inputTokens || 0),
    outputTokens: Number(r._sum.outputTokens || 0),
    count: Number(r._count._all || 0),
  }));
}

// ─── Time-series (Dashboard charts) ────────────────────────────────────────

export type TimeseriesMetric =
  | "new_users"
  | "paying_users"
  | "conversion"
  | "new_projects"
  | "revenue"
  | "service_costs"
  | "dau";

export type TimeseriesInterval = "hour" | "day" | "week" | "month";

interface TimeseriesParams {
  metric: TimeseriesMetric;
  from?: Date | null;
  to?: Date | null;
  interval?: TimeseriesInterval;
}

/** Generate dense buckets so charts always have a continuous x-axis even
 *  when no events occurred in a given period. */
function denseBuckets(from: Date, to: Date, interval: TimeseriesInterval): Date[] {
  const buckets: Date[] = [];
  const cur = new Date(from);
  // Snap `cur` to the start of the interval to match SQL date_trunc output.
  if (interval === "hour")  cur.setMinutes(0, 0, 0);
  else if (interval === "day")   cur.setHours(0, 0, 0, 0);
  else if (interval === "week") {
    cur.setHours(0, 0, 0, 0);
    const dow = (cur.getDay() + 6) % 7; // Monday=0
    cur.setDate(cur.getDate() - dow);
  } else if (interval === "month") {
    cur.setHours(0, 0, 0, 0);
    cur.setDate(1);
  }
  while (cur < to) {
    buckets.push(new Date(cur));
    if (interval === "hour")  cur.setHours(cur.getHours() + 1);
    else if (interval === "day")   cur.setDate(cur.getDate() + 1);
    else if (interval === "week")  cur.setDate(cur.getDate() + 7);
    else if (interval === "month") cur.setMonth(cur.getMonth() + 1);
  }
  return buckets;
}

export async function getTimeseries(params: TimeseriesParams) {
  const metric   = params.metric;
  const interval = (params.interval || "day") as TimeseriesInterval;
  const fromDate = params.from || new Date(Date.now() - 30 * 86400_000);
  const toDate   = params.to   || new Date();

  // SQL expressions per metric — all return rows of (bucket, value).
  const trunc = `date_trunc('${interval}', $colExpr$)`.replace("$colExpr$", "$colExpr$"); // noop placeholder
  let sql = "";
  switch (metric) {
    case "new_users":
      sql = `
        SELECT date_trunc('${interval}', created_at) AS bucket, COUNT(*)::int AS value
        FROM users
        WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
        GROUP BY 1 ORDER BY 1
      `;
      break;
    case "paying_users":
      sql = `
        SELECT bucket, COUNT(DISTINCT user_id)::int AS value FROM (
          SELECT date_trunc('${interval}', p.created_at) AS bucket, p.user_id
          FROM payments p
          WHERE p.status = 'confirmed' AND p.created_at >= $1::timestamptz AND p.created_at < $2::timestamptz
        ) t
        GROUP BY 1 ORDER BY 1
      `;
      break;
    case "conversion":
      // Per bucket: paying_users / new_users (joined on bucket).
      sql = `
        WITH nu AS (
          SELECT date_trunc('${interval}', created_at) AS bucket, COUNT(*)::float AS users
          FROM users
          WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
          GROUP BY 1
        ),
        pu AS (
          SELECT date_trunc('${interval}', u.created_at) AS bucket, COUNT(DISTINCT u.id)::float AS payers
          FROM users u
          WHERE u.created_at >= $1::timestamptz AND u.created_at < $2::timestamptz
            AND EXISTS (SELECT 1 FROM payments pm WHERE pm.user_id = u.id AND pm.status = 'confirmed')
          GROUP BY 1
        )
        SELECT nu.bucket AS bucket,
               CASE WHEN nu.users > 0 THEN COALESCE(pu.payers, 0) / nu.users * 100 ELSE 0 END AS value
        FROM nu LEFT JOIN pu ON nu.bucket = pu.bucket
        ORDER BY 1
      `;
      break;
    case "new_projects":
      sql = `
        SELECT date_trunc('${interval}', created_at) AS bucket, COUNT(*)::int AS value
        FROM projects
        WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
        GROUP BY 1 ORDER BY 1
      `;
      break;
    case "revenue":
      sql = `
        SELECT date_trunc('${interval}', created_at) AS bucket, COALESCE(SUM(amount_usd), 0)::float AS value
        FROM payments
        WHERE status = 'confirmed' AND created_at >= $1::timestamptz AND created_at < $2::timestamptz
        GROUP BY 1 ORDER BY 1
      `;
      break;
    case "service_costs":
      sql = `
        SELECT date_trunc('${interval}', created_at) AS bucket, COALESCE(SUM(cost_usd), 0)::float AS value
        FROM usage_logs
        WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
        GROUP BY 1 ORDER BY 1
      `;
      break;
    case "dau":
      sql = `
        SELECT bucket, COUNT(DISTINCT user_id)::int AS value FROM (
          SELECT date_trunc('${interval}', created_at) AS bucket, user_id
          FROM usage_logs
          WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
        ) t
        GROUP BY 1 ORDER BY 1
      `;
      break;
    default:
      throw new Error("Unknown metric: " + metric);
  }

  const rows = await prisma.$queryRawUnsafe<Array<{ bucket: Date; value: number }>>(
    sql, fromDate, toDate
  );
  const map = new Map<number, number>();
  for (const r of rows) map.set(new Date(r.bucket).getTime(), Number(r.value));

  const dense = denseBuckets(fromDate, toDate, interval);
  const buckets = dense.map((d) => ({ ts: d.toISOString(), value: map.get(d.getTime()) || 0 }));

  return {
    metric,
    interval,
    from: fromDate.toISOString(),
    to:   toDate.toISOString(),
    buckets,
  };
}

// ─── Sources / Funnel ──────────────────────────────────────────────────────
// Shared so the legacy Mini-App admin and the new browser CRM produce
// byte-identical funnel cards. Avatar resolution is pluggable so callers
// can opt-in (Mini-App admin already had a cached resolver).

interface SourcesParams {
  from?: Date | null;
  to?:   Date | null;
  /** Optional async resolver. If provided, called for partner/referrer
   *  telegramIds and the returned URL is attached as `avatarUrl`. */
  resolveAvatar?: (telegramId: string) => Promise<string | null>;
}

export interface SourceMetrics {
  users: number; createdApp: number; createdPlan: number; builtApp: number;
  payingUsers: number; revenue: number;
  conversion: number; arpu: number; arppu: number;
}

function emptyMetrics(): SourceMetrics {
  return {
    users: 0, createdApp: 0, createdPlan: 0, builtApp: 0,
    payingUsers: 0, revenue: 0, conversion: 0, arpu: 0, arppu: 0,
  };
}
function finalizeMetrics(m: SourceMetrics): SourceMetrics {
  return {
    ...m,
    conversion: m.users > 0 ? (m.payingUsers / m.users) * 100 : 0,
    arpu:       m.users > 0 ? m.revenue / m.users : 0,
    arppu:      m.payingUsers > 0 ? m.revenue / m.payingUsers : 0,
  };
}

export async function getSourcesStats(params: SourcesParams = {}) {
  const fromDate = params.from || null;
  const toDate   = params.to   || null;

  const userAgg = await prisma.$queryRawUnsafe<Array<{
    id: number;
    utm_source: string | null;
    referred_by: bigint | null;
    has_app: boolean;
    has_plan: boolean;
    has_built: boolean;
    revenue: any;
  }>>(`
    SELECT
      u.id,
      NULLIF(u.utm_source, '') AS utm_source,
      u.referred_by,
      EXISTS (SELECT 1 FROM projects p WHERE p.user_id = u.id)                                AS has_app,
      EXISTS (SELECT 1 FROM projects p WHERE p.user_id = u.id AND p.plan IS NOT NULL)         AS has_plan,
      EXISTS (SELECT 1 FROM projects p WHERE p.user_id = u.id AND p.status IN ('deployed','released')) AS has_built,
      COALESCE((SELECT SUM(pm.amount_usd) FROM payments pm WHERE pm.user_id = u.id AND pm.status = 'confirmed'), 0) AS revenue
    FROM users u
    WHERE ($1::timestamptz IS NULL OR u.created_at >= $1::timestamptz)
      AND ($2::timestamptz IS NULL OR u.created_at <  $2::timestamptz)
  `, fromDate, toDate);

  const addUser = (m: SourceMetrics, r: (typeof userAgg)[number]) => {
    m.users++;
    if (r.has_app)   m.createdApp++;
    if (r.has_plan)  m.createdPlan++;
    if (r.has_built) m.builtApp++;
    const rev = Number(r.revenue);
    if (rev > 0) m.payingUsers++;
    m.revenue += rev;
  };

  const perReferrer  = new Map<string, SourceMetrics>();
  const perSource    = new Map<string, SourceMetrics>();
  const organic      = emptyMetrics();
  const all          = emptyMetrics();

  for (const r of userAgg) {
    addUser(all, r);
    if (r.referred_by) {
      const key = String(r.referred_by);
      let m = perReferrer.get(key);
      if (!m) { m = emptyMetrics(); perReferrer.set(key, m); }
      addUser(m, r);
    }
    if (r.utm_source) {
      let m = perSource.get(r.utm_source);
      if (!m) { m = emptyMetrics(); perSource.set(r.utm_source, m); }
      addUser(m, r);
    }
    if (!r.referred_by && !r.utm_source) addUser(organic, r);
  }

  const referrerIds = Array.from(perReferrer.keys()).map((k) => BigInt(k));
  const referrerUsers = referrerIds.length
    ? await prisma.user.findMany({
        where:  { telegramId: { in: referrerIds } },
        select: {
          id: true, telegramId: true, username: true, firstName: true,
          isPartner: true, partnerTag: true, partnerPercent: true,
        },
      })
    : [];

  const sources = Array.from(perSource.entries())
    .map(([source, m]) => ({ source, ...finalizeMetrics(m) }))
    .sort((a, b) => b.users - a.users);

  const partners:  any[] = [];
  const referrers: any[] = [];
  for (const user of referrerUsers) {
    const m = perReferrer.get(String(user.telegramId));
    if (!m) continue;
    const base = {
      telegramId: String(user.telegramId),
      username:   user.username,
      firstName:  user.firstName,
      avatarUrl:  null as string | null,
      ...finalizeMetrics(m),
    };
    if (user.isPartner) {
      partners.push({
        ...base,
        partnerTag:     user.partnerTag,
        partnerPercent: user.partnerPercent != null ? Number(user.partnerPercent) : null,
      });
    } else {
      referrers.push(base);
    }
  }
  partners .sort((a, b) => b.users - a.users);
  referrers.sort((a, b) => b.users - a.users);

  if (params.resolveAvatar) {
    await Promise.allSettled(
      [...partners, ...referrers].map(async (p: any) => {
        try { p.avatarUrl = await params.resolveAvatar!(p.telegramId); } catch {}
      })
    );
  }

  return {
    range: {
      from: fromDate ? fromDate.toISOString() : null,
      to:   toDate   ? toDate.toISOString()   : null,
    },
    all:     { source: "All",     ...finalizeMetrics(all) },
    organic: { source: "Organic", ...finalizeMetrics(organic) },
    sources,
    partners,
    referrers,
  };
}

export type SourceUsersKind = "all" | "organic" | "source" | "partner" | "referrer";

export async function listSourceUsers(params: {
  from?: Date | null;
  to?:   Date | null;
  kind:  SourceUsersKind;
  key?:  string;
}) {
  const fromDate = params.from || null;
  const toDate   = params.to   || null;
  const kind     = params.kind;
  const key      = params.key  || "";

  const where: any = {};
  if (fromDate || toDate) {
    where.createdAt = {};
    if (fromDate) where.createdAt.gte = fromDate;
    if (toDate)   where.createdAt.lt  = toDate;
  }

  if (kind === "organic") {
    where.AND = [
      { OR: [{ utmSource: null }, { utmSource: "" }] },
      { referredBy: null },
    ];
  } else if (kind === "source") {
    if (!key) { const e: any = new Error("key required for kind=source"); e.status = 400; throw e; }
    where.utmSource = key;
  } else if (kind === "partner" || kind === "referrer") {
    if (!key) { const e: any = new Error("key required for kind=" + kind); e.status = 400; throw e; }
    let tgId: bigint;
    try { tgId = BigInt(key); } catch { const e: any = new Error("key must be a telegramId"); e.status = 400; throw e; }
    where.referredBy = tgId;
  } else if (kind !== "all") {
    const e: any = new Error("unknown kind: " + kind); e.status = 400; throw e;
  }

  const users = await prisma.user.findMany({
    where,
    orderBy: { createdAt: "desc" },
    select: {
      id: true, telegramId: true, username: true, firstName: true,
      balance: true, createdAt: true, utmSource: true, referredBy: true,
      _count: { select: { projects: true } },
    },
  });

  const userIds = users.map((u) => u.id);
  let funnels = new Map<number, { hasApp: boolean; hasPlan: boolean; hasBuilt: boolean; revenue: number }>();
  if (userIds.length > 0) {
    const rows = await prisma.$queryRawUnsafe<Array<{
      id: number; has_app: boolean; has_plan: boolean; has_built: boolean; revenue: any;
    }>>(`
      SELECT
        u.id,
        EXISTS (SELECT 1 FROM projects p WHERE p.user_id = u.id)                                       AS has_app,
        EXISTS (SELECT 1 FROM projects p WHERE p.user_id = u.id AND p.plan IS NOT NULL)               AS has_plan,
        EXISTS (SELECT 1 FROM projects p WHERE p.user_id = u.id AND p.status IN ('deployed','released')) AS has_built,
        COALESCE((SELECT SUM(pm.amount_usd) FROM payments pm WHERE pm.user_id = u.id AND pm.status = 'confirmed'), 0) AS revenue
      FROM users u
      WHERE u.id = ANY($1::int[])
    `, userIds);
    for (const r of rows) {
      funnels.set(r.id, {
        hasApp: r.has_app, hasPlan: r.has_plan, hasBuilt: r.has_built,
        revenue: Number(r.revenue),
      });
    }
  }

  return {
    range: {
      from: fromDate ? fromDate.toISOString() : null,
      to:   toDate   ? toDate.toISOString()   : null,
    },
    kind, key,
    count: users.length,
    users: users.map((u) => {
      const f = funnels.get(u.id);
      return {
        id: u.id,
        telegramId: u.telegramId.toString(),
        username:  u.username,
        firstName: u.firstName,
        balance:   Number(u.balance),
        projectCount: u._count.projects,
        createdAt:  u.createdAt,
        utmSource:  u.utmSource,
        referredBy: u.referredBy?.toString() || null,
        hasApp:   f?.hasApp   ?? false,
        hasPlan:  f?.hasPlan  ?? false,
        hasBuilt: f?.hasBuilt ?? false,
        revenue:  f?.revenue  ?? 0,
      };
    }),
  };
}

// ─── Wipe / full reset ──────────────────────────────────────────────────────

export async function wipeUserData(userId: number) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, telegramId: true },
  });
  if (!user) throw Object.assign(new Error("User not found"), { status: 404 });

  return prisma.$transaction(async (tx) => {
    const [payments, conversations, usageLogs, withdrawals, voucherRedemptions, notes] =
      await Promise.all([
        tx.payment.deleteMany({ where: { userId } }),
        tx.conversation.deleteMany({ where: { userId } }),
        tx.usageLog.deleteMany({ where: { userId } }),
        tx.withdrawal.deleteMany({ where: { userId } }),
        tx.voucherRedemption.deleteMany({ where: { userId } }),
        (tx as any).adminUserNote.deleteMany({ where: { userId } }),
      ]);

    await tx.user.update({
      where: { id: userId },
      data: {
        username: null,
        firstName: null,
        balance: new Decimal(0),
        partnerBalance: new Decimal(0),
        isPartner: false,
        partnerPercent: null,
        partnerTag: null,
        partnerReferralBonus: null,
        firstDepositBonusGiven: false,
        utmSource: null,
        referredBy: null,
        language: "en",
        ...({ adminTags: null } as any),
      },
    });

    return {
      payments: payments.count,
      conversations: conversations.count,
      usageLogs: usageLogs.count,
      withdrawals: withdrawals.count,
      voucherRedemptions: voucherRedemptions.count,
      notes: notes.count,
    };
  });
}

export async function fullResetUser(userId: number) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, telegramId: true, projects: { select: { id: true } } },
  });
  if (!user) throw Object.assign(new Error("User not found"), { status: 404 });

  const projectIds = user.projects.map((p) => p.id);

  return prisma.$transaction(async (tx) => {
    let assets = { count: 0 };
    let versions = { count: 0 };
    if (projectIds.length) {
      [assets, versions] = await Promise.all([
        tx.asset.deleteMany({ where: { projectId: { in: projectIds } } }),
        tx.version.deleteMany({ where: { projectId: { in: projectIds } } }),
      ]);
    }

    const [payments, conversations, usageLogs, withdrawals, voucherRedemptions, notes] =
      await Promise.all([
        tx.payment.deleteMany({ where: { userId } }),
        tx.conversation.deleteMany({ where: { userId } }),
        tx.usageLog.deleteMany({ where: { userId } }),
        tx.withdrawal.deleteMany({ where: { userId } }),
        tx.voucherRedemption.deleteMany({ where: { userId } }),
        (tx as any).adminUserNote.deleteMany({ where: { userId } }),
      ]);

    const projects = await tx.project.deleteMany({ where: { userId } });
    await tx.user.delete({ where: { id: userId } });

    return {
      assets: assets.count,
      versions: versions.count,
      payments: payments.count,
      conversations: conversations.count,
      usageLogs: usageLogs.count,
      withdrawals: withdrawals.count,
      voucherRedemptions: voucherRedemptions.count,
      notes: notes.count,
      projects: projects.count,
    };
  });
}
