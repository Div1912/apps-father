import fs from "fs";
import path from "path";
import crypto from "crypto";

const PROJECTS_DIR = path.join(process.cwd(), "projects");

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  type: "text" | "update_request" | "devtools_request" | "question" | "answer" | "result" | "progress" | "error" | "plan" | "balance_error";
  content: string;
  attachments?: { name: string; path: string; type: string }[];
  checklist?: { id: number; text: string; done: boolean }[];
  percent?: number;
  costUsd?: number;
  balance?: number;
  /** Credits actually deducted for this run (mirrors UsageLog.creditsCharged).
   *  Used by the mini app to render the "Get cashback & rate agent" button on
   *  result bubbles, including after page reload. */
  creditsCharged?: number;
  /** Commit number produced by this run, for linking the cashback feedback
   *  back to the agent log on disk (commits/{commitNum}/agent.log). */
  commitNum?: number;
  /** Whether the cashback/rating button should be shown for this result.
   *  Absent (or false) = never show the button even if cashbackEnabled later. */
  cashbackAvailable?: boolean;
  /** Set to true (and the button replaced with a "Rated ✓" pill) once the
   *  user has submitted a rating for this run. Persisted so reload is correct. */
  cashbackClaimed?: boolean;
  timestamp: number;
  /** ISO 8601 UTC string (e.g. "2026-04-14T09:33:00.123Z"). Used by the
   *  frontend to drive the dynamic progress curve y = 1 - e^(-Δsec/100). */
  createdAtUtc?: string;
  metadata?: Record<string, any>;
}

function historyPath(projectId: string): string {
  return path.join(PROJECTS_DIR, projectId, "chat-history.json");
}

function readHistory(projectId: string): ChatMessage[] {
  const fp = historyPath(projectId);
  if (!fs.existsSync(fp)) return [];
  try {
    return JSON.parse(fs.readFileSync(fp, "utf-8"));
  } catch {
    return [];
  }
}

function writeHistory(projectId: string, messages: ChatMessage[]): void {
  const fp = historyPath(projectId);
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(messages, null, 2), "utf-8");
}

export const chatService = {
  getHistory(projectId: string, before?: number, limit = 50): ChatMessage[] {
    const all = readHistory(projectId);
    if (!before) return all.slice(-limit);
    const idx = all.findIndex(m => m.timestamp >= before);
    if (idx <= 0) return [];
    const start = Math.max(0, idx - limit);
    return all.slice(start, idx);
  },

  addMessage(projectId: string, msg: Omit<ChatMessage, "id" | "timestamp">): ChatMessage {
    const messages = readHistory(projectId);
    const now = Date.now();
    const full: ChatMessage = {
      ...msg,
      id: crypto.randomBytes(8).toString("hex"),
      timestamp: now,
      createdAtUtc: msg.createdAtUtc ?? new Date(now).toISOString(),
    };
    messages.push(full);
    writeHistory(projectId, messages);
    return full;
  },

  updateMessage(projectId: string, msgId: string, partial: Partial<ChatMessage>): ChatMessage | null {
    const messages = readHistory(projectId);
    const idx = messages.findIndex(m => m.id === msgId);
    if (idx === -1) return null;
    messages[idx] = { ...messages[idx], ...partial, id: msgId };
    writeHistory(projectId, messages);
    return messages[idx];
  },

  removeMessage(projectId: string, msgId: string): boolean {
    const messages = readHistory(projectId);
    const idx = messages.findIndex(m => m.id === msgId);
    if (idx === -1) return false;
    messages.splice(idx, 1);
    writeHistory(projectId, messages);
    return true;
  },

  removeMessages(projectId: string, msgIds: string[]): number {
    const messages = readHistory(projectId);
    const idSet = new Set(msgIds);
    const filtered = messages.filter(m => !idSet.has(m.id));
    const removed = messages.length - filtered.length;
    if (removed > 0) writeHistory(projectId, filtered);
    return removed;
  },

  clearHistory(projectId: string): void {
    const fp = historyPath(projectId);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  },

  /**
   * Recover dangling in-flight messages after a crash/restart.
   *
   * Heals EVERY `progress` (percent < 100) or `question` message anywhere in
   * the history — not just the last one. After a restart no agent can be
   * running, so any open progress/question is by definition orphaned. The old
   * "last message only" rule missed cases where the agent had appended a
   * follow-up question/answer/auto-fix progress on top of an in-flight build,
   * leaving the UI permanently showing "Working…".
   *
   * Returns the project IDs that had at least one message healed.
   */
  recoverDanglingProgress(reason: string): string[] {
    const healed: string[] = [];
    if (!fs.existsSync(PROJECTS_DIR)) return healed;
    let projectIds: string[];
    try {
      projectIds = fs.readdirSync(PROJECTS_DIR);
    } catch {
      return healed;
    }
    for (const projectId of projectIds) {
      const result = this.healProject(projectId, reason);
      if (result > 0) healed.push(projectId);
    }
    return healed;
  },

  /**
   * Convert every dangling `progress` (percent < 100) or `question` message in
   * the given project to an `error`. Returns the number of messages healed.
   * Safe to call at any time; returns 0 if nothing needed healing.
   */
  healProject(projectId: string, reason: string): number {
    const fp = historyPath(projectId);
    if (!fs.existsSync(fp)) return 0;
    let messages: ChatMessage[];
    try {
      messages = JSON.parse(fs.readFileSync(fp, "utf-8"));
    } catch {
      return 0;
    }
    if (!Array.isArray(messages) || messages.length === 0) return 0;

    let healedCount = 0;
    const next = messages.map(m => {
      const isOpenProgress = m.type === "progress" && (m.percent ?? 0) < 100;
      const isOpenQuestion = m.type === "question";
      if (!isOpenProgress && !isOpenQuestion) return m;
      healedCount++;
      return {
        ...m,
        type: "error" as const,
        content: `⚠️ ${reason}`,
        // Drop progress-only fields so the UI doesn't render a percent bar.
        percent: undefined,
        checklist: undefined,
      };
    });

    if (healedCount === 0) return 0;
    try {
      writeHistory(projectId, next);
      console.log(`[Recovery] Healed ${healedCount} dangling message(s) in project ${projectId}`);
      return healedCount;
    } catch (err: any) {
      console.warn(`[Recovery] Failed to heal ${projectId}: ${err.message}`);
      return 0;
    }
  },
};
