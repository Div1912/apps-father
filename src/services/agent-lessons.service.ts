/**
 * Agent training knowledge — lessons (runtime rules) and code patches (manual IDE fixes).
 *
 * Two storage models share one import/export pipeline:
 *   - AgentLesson    — text rule injected into buildSystemPrompt() when enabled.
 *   - AgentCodePatch — text suggestion for editing agent.service.ts / agent_knowledge/*.md.
 *                      Never applied automatically; admin copies cursorPrompt to IDE.
 *
 * Per-env state (enabled flag, status transitions, timestamps, importedFrom, sourceCaseId,
 * appliedCommit) is preserved on the local environment and never overwritten by import.
 */

import crypto from "crypto";
import { prisma } from "../db";

// ──────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────

export type LessonAction = "create" | "update" | "skip";
export type PatchAction = "create" | "update" | "skip";

export interface LessonInput {
  rule: string;
  context?: string | null;
  tags?: string[];
  notes?: string | null;
}

export interface PatchInput {
  title: string;
  problem: string;
  targetFiles?: string[];
  suggestion: string;
  cursorPrompt: string;
  tags?: string[];
  notes?: string | null;
}

export interface ExportedLesson {
  id: string;
  rule: string;
  context: string | null;
  tags: string[];
  notes: string | null;
  contentHash: string;
}

export interface ExportedPatch {
  id: string;
  title: string;
  problem: string;
  targetFiles: string[];
  suggestion: string;
  cursorPrompt: string;
  tags: string[];
  notes: string | null;
  contentHash: string;
}

export interface ExportFile {
  exportVersion: 1;
  exportedAt: string;
  exportedFrom: string;
  counts: { lessons: number; patches: number };
  lessons: ExportedLesson[];
  patches: ExportedPatch[];
}

export interface ImportDiff {
  exportedFrom: string;
  exportedAt: string;
  lessons: {
    new: ExportedLesson[];
    updated: Array<{ local: any; incoming: ExportedLesson; fieldsChanged: string[] }>;
    identical: ExportedLesson[];
    localOnly: any[];
  };
  patches: {
    new: ExportedPatch[];
    updated: Array<{ local: any; incoming: ExportedPatch; fieldsChanged: string[] }>;
    identical: ExportedPatch[];
    localOnly: any[];
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Cache for runtime injection — invalidated on every lesson mutation.
// ──────────────────────────────────────────────────────────────────────────

let cachedLessonsBlock: string | null = null;

export function invalidateCache(): void {
  cachedLessonsBlock = null;
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function makeId(prefix: "lsn" | "pat"): string {
  // Compact, URL-safe stable id. Prisma's cuid would be fine too; rolling our
  // own keeps the prefix obvious in logs and JSON files.
  return `${prefix}_${crypto.randomBytes(9).toString("base64url")}`;
}

function normalizeTags(tags: string[] | null | undefined): string[] {
  if (!Array.isArray(tags)) return [];
  return Array.from(
    new Set(
      tags
        .map((t) => String(t || "").trim().toLowerCase())
        .filter(Boolean),
    ),
  ).sort();
}

function normalizeFiles(files: string[] | null | undefined): string[] {
  if (!Array.isArray(files)) return [];
  return Array.from(
    new Set(
      files
        .map((f) => String(f || "").trim())
        .filter(Boolean),
    ),
  ).sort();
}

function hashLesson(rule: string, context: string | null, tags: string[]): string {
  const payload = JSON.stringify({
    rule: String(rule || "").trim(),
    context: String(context || "").trim(),
    tags: normalizeTags(tags),
  });
  return "sha256:" + crypto.createHash("sha256").update(payload).digest("hex");
}

function hashPatch(p: {
  title: string;
  problem: string;
  targetFiles: string[];
  suggestion: string;
  cursorPrompt: string;
  tags: string[];
}): string {
  const payload = JSON.stringify({
    title: String(p.title || "").trim(),
    problem: String(p.problem || "").trim(),
    targetFiles: normalizeFiles(p.targetFiles),
    suggestion: String(p.suggestion || "").trim(),
    cursorPrompt: String(p.cursorPrompt || "").trim(),
    tags: normalizeTags(p.tags),
  });
  return "sha256:" + crypto.createHash("sha256").update(payload).digest("hex");
}

function envName(): string {
  // Heuristic: the existing deploy script names PM2 processes "apps-father"
  // (prod) and "apps-father-dev" (dev). Allow override via env var.
  const explicit = process.env.AGENT_ENV_NAME;
  if (explicit) return explicit;
  if ((process.env.NODE_ENV || "").toLowerCase() === "development") return "dev";
  if (process.env.PM2_HOME && /dev/i.test(process.env.PM2_HOME)) return "dev";
  return "prod";
}

// ──────────────────────────────────────────────────────────────────────────
// Lessons CRUD
// ──────────────────────────────────────────────────────────────────────────

export async function listLessons(filter?: {
  enabled?: boolean;
  tag?: string;
  q?: string;
}) {
  const where: any = {};
  if (typeof filter?.enabled === "boolean") where.enabled = filter.enabled;
  if (filter?.tag) where.tags = { has: filter.tag };
  if (filter?.q) {
    const q = filter.q;
    where.OR = [
      { rule: { contains: q, mode: "insensitive" } },
      { context: { contains: q, mode: "insensitive" } },
      { notes: { contains: q, mode: "insensitive" } },
    ];
  }
  return prisma.agentLesson.findMany({
    where,
    orderBy: [{ enabled: "desc" }, { updatedAt: "desc" }],
  });
}

export async function getLesson(id: string) {
  return prisma.agentLesson.findUnique({ where: { id } });
}

export async function createLesson(input: LessonInput) {
  const rule = String(input.rule || "").trim();
  if (!rule) throw Object.assign(new Error("rule is required"), { status: 400 });
  const context = input.context ? String(input.context).trim() || null : null;
  const tags = normalizeTags(input.tags);
  const notes = input.notes ? String(input.notes).trim() || null : null;
  const contentHash = hashLesson(rule, context, tags);

  const lesson = await prisma.agentLesson.create({
    data: {
      id: makeId("lsn"),
      rule,
      context,
      tags,
      notes,
      contentHash,
      enabled: false,
    },
  });
  invalidateCache();
  return lesson;
}

export async function updateLesson(
  id: string,
  patch: Partial<LessonInput>,
) {
  const existing = await prisma.agentLesson.findUnique({ where: { id } });
  if (!existing) throw Object.assign(new Error("Lesson not found"), { status: 404 });

  const next = {
    rule:
      patch.rule !== undefined
        ? String(patch.rule).trim()
        : existing.rule,
    context:
      patch.context !== undefined
        ? patch.context
          ? String(patch.context).trim() || null
          : null
        : existing.context,
    tags:
      patch.tags !== undefined ? normalizeTags(patch.tags) : (existing.tags as string[]),
    notes:
      patch.notes !== undefined
        ? patch.notes
          ? String(patch.notes).trim() || null
          : null
        : existing.notes,
  };

  if (!next.rule) throw Object.assign(new Error("rule is required"), { status: 400 });

  const contentHash = hashLesson(next.rule, next.context, next.tags);

  const updated = await prisma.agentLesson.update({
    where: { id },
    data: { ...next, contentHash },
  });
  invalidateCache();
  return updated;
}

export async function deleteLesson(id: string) {
  await prisma.agentLesson.delete({ where: { id } });
  invalidateCache();
}

export async function setLessonEnabled(id: string, enabled: boolean) {
  const now = new Date();
  const updated = await prisma.agentLesson.update({
    where: { id },
    data: {
      enabled,
      enabledAt: enabled ? now : undefined,
      disabledAt: enabled ? undefined : now,
    },
  });
  invalidateCache();
  return updated;
}

export async function bulkSetLessonEnabled(ids: string[], enabled: boolean) {
  if (!Array.isArray(ids) || ids.length === 0) return { count: 0 };
  const now = new Date();
  const result = await prisma.agentLesson.updateMany({
    where: { id: { in: ids } },
    data: {
      enabled,
      enabledAt: enabled ? now : undefined,
      disabledAt: enabled ? undefined : now,
    },
  });
  invalidateCache();
  return result;
}

// ──────────────────────────────────────────────────────────────────────────
// Code Patches CRUD
// ──────────────────────────────────────────────────────────────────────────

export async function listPatches(filter?: {
  status?: string;
  tag?: string;
  q?: string;
}) {
  const where: any = {};
  if (filter?.status) where.status = filter.status;
  if (filter?.tag) where.tags = { has: filter.tag };
  if (filter?.q) {
    const q = filter.q;
    where.OR = [
      { title: { contains: q, mode: "insensitive" } },
      { problem: { contains: q, mode: "insensitive" } },
      { suggestion: { contains: q, mode: "insensitive" } },
      { cursorPrompt: { contains: q, mode: "insensitive" } },
      { notes: { contains: q, mode: "insensitive" } },
    ];
  }
  return prisma.agentCodePatch.findMany({
    where,
    orderBy: [{ status: "asc" }, { updatedAt: "desc" }],
  });
}

export async function getPatch(id: string) {
  return prisma.agentCodePatch.findUnique({ where: { id } });
}

export async function createPatch(input: PatchInput) {
  const title = String(input.title || "").trim();
  const problem = String(input.problem || "").trim();
  const suggestion = String(input.suggestion || "").trim();
  const cursorPrompt = String(input.cursorPrompt || "").trim();
  if (!title) throw Object.assign(new Error("title is required"), { status: 400 });
  if (!problem) throw Object.assign(new Error("problem is required"), { status: 400 });
  if (!suggestion) throw Object.assign(new Error("suggestion is required"), { status: 400 });
  if (!cursorPrompt) throw Object.assign(new Error("cursorPrompt is required"), { status: 400 });

  const targetFiles = normalizeFiles(input.targetFiles);
  const tags = normalizeTags(input.tags);
  const notes = input.notes ? String(input.notes).trim() || null : null;
  const contentHash = hashPatch({
    title,
    problem,
    targetFiles,
    suggestion,
    cursorPrompt,
    tags,
  });

  return prisma.agentCodePatch.create({
    data: {
      id: makeId("pat"),
      title,
      problem,
      targetFiles,
      suggestion,
      cursorPrompt,
      tags,
      notes,
      contentHash,
      status: "proposed",
    },
  });
}

export async function updatePatch(id: string, patch: Partial<PatchInput>) {
  const existing = await prisma.agentCodePatch.findUnique({ where: { id } });
  if (!existing) throw Object.assign(new Error("Patch not found"), { status: 404 });

  const next = {
    title:
      patch.title !== undefined ? String(patch.title).trim() : existing.title,
    problem:
      patch.problem !== undefined ? String(patch.problem).trim() : existing.problem,
    targetFiles:
      patch.targetFiles !== undefined
        ? normalizeFiles(patch.targetFiles)
        : (existing.targetFiles as string[]),
    suggestion:
      patch.suggestion !== undefined ? String(patch.suggestion).trim() : existing.suggestion,
    cursorPrompt:
      patch.cursorPrompt !== undefined
        ? String(patch.cursorPrompt).trim()
        : existing.cursorPrompt,
    tags:
      patch.tags !== undefined ? normalizeTags(patch.tags) : (existing.tags as string[]),
    notes:
      patch.notes !== undefined
        ? patch.notes
          ? String(patch.notes).trim() || null
          : null
        : existing.notes,
  };

  if (!next.title) throw Object.assign(new Error("title is required"), { status: 400 });
  if (!next.problem) throw Object.assign(new Error("problem is required"), { status: 400 });
  if (!next.suggestion) throw Object.assign(new Error("suggestion is required"), { status: 400 });
  if (!next.cursorPrompt) throw Object.assign(new Error("cursorPrompt is required"), { status: 400 });

  const contentHash = hashPatch(next);

  return prisma.agentCodePatch.update({
    where: { id },
    data: { ...next, contentHash },
  });
}

export async function deletePatch(id: string) {
  await prisma.agentCodePatch.delete({ where: { id } });
}

export async function setPatchStatus(
  id: string,
  status: "proposed" | "applied" | "rejected",
  opts?: { commit?: string },
) {
  if (!["proposed", "applied", "rejected"].includes(status)) {
    throw Object.assign(new Error("Invalid status"), { status: 400 });
  }
  const now = new Date();
  const data: any = {
    status,
    appliedAt: status === "applied" ? now : null,
    rejectedAt: status === "rejected" ? now : null,
  };
  if (status === "applied" && opts?.commit) data.appliedCommit = opts.commit.trim();
  if (status === "proposed") data.appliedCommit = null;
  return prisma.agentCodePatch.update({ where: { id }, data });
}

// ──────────────────────────────────────────────────────────────────────────
// Export
// ──────────────────────────────────────────────────────────────────────────

export interface ExportOptions {
  include?: Array<"lessons" | "patches">;
}

export async function exportKnowledge(
  opts?: ExportOptions,
): Promise<{ json: string; filename: string }> {
  const include = opts?.include && opts.include.length > 0 ? opts.include : ["lessons", "patches"];
  const wantLessons = include.includes("lessons");
  const wantPatches = include.includes("patches");

  const [lessons, patches] = await Promise.all([
    wantLessons
      ? prisma.agentLesson.findMany({ orderBy: { id: "asc" } })
      : Promise.resolve([]),
    wantPatches
      ? prisma.agentCodePatch.findMany({ orderBy: { id: "asc" } })
      : Promise.resolve([]),
  ]);

  const file: ExportFile = {
    exportVersion: 1,
    exportedAt: new Date().toISOString(),
    exportedFrom: envName(),
    counts: { lessons: lessons.length, patches: patches.length },
    lessons: lessons.map(
      (l): ExportedLesson => ({
        id: l.id,
        rule: l.rule,
        context: l.context ?? null,
        tags: (l.tags as string[]) || [],
        notes: l.notes ?? null,
        contentHash: l.contentHash,
      }),
    ),
    patches: patches.map(
      (p): ExportedPatch => ({
        id: p.id,
        title: p.title,
        problem: p.problem,
        targetFiles: (p.targetFiles as string[]) || [],
        suggestion: p.suggestion,
        cursorPrompt: p.cursorPrompt,
        tags: (p.tags as string[]) || [],
        notes: p.notes ?? null,
        contentHash: p.contentHash,
      }),
    ),
  };

  // Pretty-print, no BOM. Stable key ordering thanks to ESM property iteration.
  const json = JSON.stringify(file, null, 2) + "\n";
  const date = new Date().toISOString().slice(0, 10);
  const filename = `agent-knowledge-${file.exportedFrom}-${date}.json`;
  return { json, filename };
}

// ──────────────────────────────────────────────────────────────────────────
// Import — preview + apply
// ──────────────────────────────────────────────────────────────────────────

function parseImportJson(raw: string): ExportFile {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    throw Object.assign(new Error(`Invalid JSON: ${err.message}`), { status: 400 });
  }
  if (!parsed || typeof parsed !== "object") {
    throw Object.assign(new Error("Import file must be a JSON object"), { status: 400 });
  }
  if (parsed.exportVersion !== 1) {
    throw Object.assign(
      new Error(`Unsupported exportVersion: ${parsed.exportVersion}`),
      { status: 400 },
    );
  }
  parsed.lessons = Array.isArray(parsed.lessons) ? parsed.lessons : [];
  parsed.patches = Array.isArray(parsed.patches) ? parsed.patches : [];
  parsed.exportedFrom = String(parsed.exportedFrom || "unknown");
  parsed.exportedAt = String(parsed.exportedAt || new Date().toISOString());
  return parsed as ExportFile;
}

function diffLessonFields(local: any, incoming: ExportedLesson): string[] {
  const fields: string[] = [];
  if (String(local.rule || "") !== String(incoming.rule || "")) fields.push("rule");
  if (String(local.context || "") !== String(incoming.context || "")) fields.push("context");
  const localTags = JSON.stringify(normalizeTags(local.tags));
  const incomingTags = JSON.stringify(normalizeTags(incoming.tags));
  if (localTags !== incomingTags) fields.push("tags");
  if (String(local.notes || "") !== String(incoming.notes || "")) fields.push("notes");
  return fields;
}

function diffPatchFields(local: any, incoming: ExportedPatch): string[] {
  const fields: string[] = [];
  if (String(local.title || "") !== String(incoming.title || "")) fields.push("title");
  if (String(local.problem || "") !== String(incoming.problem || "")) fields.push("problem");
  if (
    JSON.stringify(normalizeFiles(local.targetFiles)) !==
    JSON.stringify(normalizeFiles(incoming.targetFiles))
  ) {
    fields.push("targetFiles");
  }
  if (String(local.suggestion || "") !== String(incoming.suggestion || "")) {
    fields.push("suggestion");
  }
  if (String(local.cursorPrompt || "") !== String(incoming.cursorPrompt || "")) {
    fields.push("cursorPrompt");
  }
  if (JSON.stringify(normalizeTags(local.tags)) !== JSON.stringify(normalizeTags(incoming.tags))) {
    fields.push("tags");
  }
  if (String(local.notes || "") !== String(incoming.notes || "")) fields.push("notes");
  return fields;
}

export async function previewImport(rawJson: string): Promise<ImportDiff> {
  const file = parseImportJson(rawJson);

  const [localLessons, localPatches] = await Promise.all([
    prisma.agentLesson.findMany(),
    prisma.agentCodePatch.findMany(),
  ]);
  const localLessonById = new Map(localLessons.map((l) => [l.id, l]));
  const localPatchById = new Map(localPatches.map((p) => [p.id, p]));

  const lessonsDiff: ImportDiff["lessons"] = {
    new: [],
    updated: [],
    identical: [],
    localOnly: [],
  };
  const patchesDiff: ImportDiff["patches"] = {
    new: [],
    updated: [],
    identical: [],
    localOnly: [],
  };

  const incomingLessonIds = new Set<string>();
  for (const inc of file.lessons) {
    incomingLessonIds.add(inc.id);
    const local = localLessonById.get(inc.id);
    if (!local) {
      lessonsDiff.new.push(inc);
    } else if (local.contentHash === inc.contentHash) {
      lessonsDiff.identical.push(inc);
    } else {
      lessonsDiff.updated.push({
        local,
        incoming: inc,
        fieldsChanged: diffLessonFields(local, inc),
      });
    }
  }
  for (const local of localLessons) {
    if (!incomingLessonIds.has(local.id)) lessonsDiff.localOnly.push(local);
  }

  const incomingPatchIds = new Set<string>();
  for (const inc of file.patches) {
    incomingPatchIds.add(inc.id);
    const local = localPatchById.get(inc.id);
    if (!local) {
      patchesDiff.new.push(inc);
    } else if (local.contentHash === inc.contentHash) {
      patchesDiff.identical.push(inc);
    } else {
      patchesDiff.updated.push({
        local,
        incoming: inc,
        fieldsChanged: diffPatchFields(local, inc),
      });
    }
  }
  for (const local of localPatches) {
    if (!incomingPatchIds.has(local.id)) patchesDiff.localOnly.push(local);
  }

  return {
    exportedFrom: file.exportedFrom,
    exportedAt: file.exportedAt,
    lessons: lessonsDiff,
    patches: patchesDiff,
  };
}

export interface ApplyImportOptions {
  /**
   * Per-id action ("create" / "update" / "skip"). Missing ids default to "skip"
   * for new/updated rows so the admin must opt in deliberately.
   */
  lessonActions?: Record<string, LessonAction>;
  patchActions?: Record<string, PatchAction>;
  /** When true, newly imported lessons land enabled. Default: false. */
  enableNewLessons?: boolean;
}

export interface ApplyImportResult {
  lessons: { created: number; updated: number; skipped: number };
  patches: { created: number; updated: number; skipped: number };
}

export async function applyImport(
  rawJson: string,
  options: ApplyImportOptions = {},
): Promise<ApplyImportResult> {
  const file = parseImportJson(rawJson);
  const enableNew = options.enableNewLessons === true;
  const lessonActions = options.lessonActions || {};
  const patchActions = options.patchActions || {};
  const sourceEnv = file.exportedFrom;

  const result: ApplyImportResult = {
    lessons: { created: 0, updated: 0, skipped: 0 },
    patches: { created: 0, updated: 0, skipped: 0 },
  };

  const now = new Date();

  for (const inc of file.lessons) {
    const action = lessonActions[inc.id] || "skip";
    if (action === "skip") {
      result.lessons.skipped++;
      continue;
    }
    const local = await prisma.agentLesson.findUnique({ where: { id: inc.id } });
    const tags = normalizeTags(inc.tags);
    const contentHash =
      inc.contentHash || hashLesson(inc.rule, inc.context ?? null, tags);

    if (!local) {
      // New: create with enabled flag from option (default false)
      await prisma.agentLesson.create({
        data: {
          id: inc.id,
          rule: inc.rule,
          context: inc.context ?? null,
          tags,
          notes: inc.notes ?? null,
          contentHash,
          enabled: enableNew,
          enabledAt: enableNew ? now : null,
          importedFrom: sourceEnv,
        },
      });
      result.lessons.created++;
    } else if (action === "update") {
      // Update content fields only — never touch enabled / enabledAt / disabledAt.
      await prisma.agentLesson.update({
        where: { id: inc.id },
        data: {
          rule: inc.rule,
          context: inc.context ?? null,
          tags,
          notes: inc.notes ?? null,
          contentHash,
          importedFrom: sourceEnv,
        },
      });
      result.lessons.updated++;
    } else {
      result.lessons.skipped++;
    }
  }

  for (const inc of file.patches) {
    const action = patchActions[inc.id] || "skip";
    if (action === "skip") {
      result.patches.skipped++;
      continue;
    }
    const local = await prisma.agentCodePatch.findUnique({ where: { id: inc.id } });
    const tags = normalizeTags(inc.tags);
    const targetFiles = normalizeFiles(inc.targetFiles);
    const contentHash =
      inc.contentHash ||
      hashPatch({
        title: inc.title,
        problem: inc.problem,
        targetFiles,
        suggestion: inc.suggestion,
        cursorPrompt: inc.cursorPrompt,
        tags,
      });

    if (!local) {
      // New patches always land as proposed — applying code is always a local decision.
      await prisma.agentCodePatch.create({
        data: {
          id: inc.id,
          title: inc.title,
          problem: inc.problem,
          targetFiles,
          suggestion: inc.suggestion,
          cursorPrompt: inc.cursorPrompt,
          tags,
          notes: inc.notes ?? null,
          contentHash,
          status: "proposed",
          importedFrom: sourceEnv,
        },
      });
      result.patches.created++;
    } else if (action === "update") {
      // Update content; preserve local status / appliedAt / rejectedAt / appliedCommit.
      await prisma.agentCodePatch.update({
        where: { id: inc.id },
        data: {
          title: inc.title,
          problem: inc.problem,
          targetFiles,
          suggestion: inc.suggestion,
          cursorPrompt: inc.cursorPrompt,
          tags,
          notes: inc.notes ?? null,
          contentHash,
          importedFrom: sourceEnv,
        },
      });
      result.patches.updated++;
    } else {
      result.patches.skipped++;
    }
  }

  invalidateCache();
  return result;
}

// ──────────────────────────────────────────────────────────────────────────
// Runtime injection
// ──────────────────────────────────────────────────────────────────────────

/**
 * Returns a formatted block for inclusion in the agent's system prompt.
 * Empty string when no lessons are enabled. Cached in memory until any
 * mutation calls invalidateCache().
 */
export async function getEnabledLessonsBlock(): Promise<string> {
  if (cachedLessonsBlock !== null) return cachedLessonsBlock;

  const lessons = await prisma.agentLesson.findMany({
    where: { enabled: true },
    orderBy: { enabledAt: "asc" },
  });

  if (lessons.length === 0) {
    cachedLessonsBlock = "";
    return cachedLessonsBlock;
  }

  const lines: string[] = [
    "=== LEARNED RULES (from past feedback) ===",
    "You have learned these rules from prior user feedback. Apply them strictly.",
    "",
  ];
  for (const l of lessons) {
    const tags = (l.tags as string[]) || [];
    const tagPrefix = tags.length > 0 ? `[${tags.join(", ")}] ` : "";
    lines.push(`${tagPrefix}${l.rule}`);
    if (l.context && l.context.trim()) {
      lines.push(`  Context: ${l.context.trim()}`);
    }
    lines.push("");
  }
  lines.push("==========================================");

  cachedLessonsBlock = lines.join("\n");
  return cachedLessonsBlock;
}
