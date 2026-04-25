/**
 * Persistent runtime log capture.
 *
 * The console tagger (`console-tagger.service.ts`) calls `enqueueLog()` for
 * every line written to stdout/stderr. We buffer them in memory and flush in
 * batches to the `app_logs` Postgres table every `FLUSH_INTERVAL_MS`. This
 * lets us:
 *   - keep the hot logging path synchronous (no awaiting Prisma per write),
 *   - survive PM2 restarts (file logs rotate / are wiped; DB persists),
 *   - filter & query historically by (projectId, category, level, time, text).
 *
 * Categories are derived from the existing bracket prefix conventions:
 *   [Agent], [Context]                        -> "Agent"
 *   [Builder]                                 -> "Build"
 *   [BotRunner], [Bot]                        -> "Bot"
 *   [Commit]                                  -> "Commit"
 *   [API]                                     -> "API"
 *   [WS]                                      -> "WS"
 *   [Web], [MiniApp], [Admin], [Chat API]…    -> "Web"
 *   [DB]                                      -> "Database"
 *   [Recovery], [Shutdown], [Migration]       -> "Lifecycle"
 *   line tagged with [app:<id>] but no other tag -> "Backend"
 *   no project, no tag                        -> "System"
 *
 * IMPORTANT: never use `console.log` from inside this file — the tee would
 * recurse and re-enqueue our own diagnostic lines forever. Use
 * `process.stderr.write` directly with a sentinel byte if you really need
 * diagnostic output, but prefer keeping this file silent.
 */

import { prisma } from "../db";

// ── Tunables ────────────────────────────────────────────────────────────────
const FLUSH_INTERVAL_MS    = 1000;        // flush every second
const MAX_BUFFER           = 5_000;       // drop-oldest above this
const MAX_BATCH            = 1_000;       // per-flush insert chunk
const MAX_MESSAGE_BYTES    = 16 * 1024;   // truncate huge lines
const ENABLED_BY_DEFAULT   = true;

interface LogRow {
  ts: Date;
  projectId: string | null;
  category: string;
  level: string;
  source: "stdout" | "stderr";
  message: string;
}

// Internal state — module-level singletons so the tee can hot-call without
// any allocation per line.
const buffer: LogRow[] = [];
let droppedCount = 0;          // count of lines dropped due to overflow
let flushing = false;
let timer: NodeJS.Timeout | null = null;
let enabled = ENABLED_BY_DEFAULT;
let stopped = false;

// Recognized bracket-tag → category map (lowercased keys for cheap match).
const TAG_TO_CATEGORY: Record<string, string> = {
  agent:     "Agent",
  context:   "Agent",
  builder:   "Build",
  botrunner: "Bot",
  bot:       "Bot",
  commit:    "Commit",
  api:       "API",
  ws:        "WS",
  web:       "Web",
  miniapp:   "Web",
  "chat api": "Web",
  admin:     "Web",
  db:        "Database",
  recovery:  "Lifecycle",
  shutdown:  "Lifecycle",
  migration: "Lifecycle",
};

// Strip leading `[app:<id>] ` prefix; returns { projectId, body }. The tee
// already knows the project from ALS, but lines that came in pre-tagged
// (e.g. piped, replayed) get parsed as a fallback.
const APP_TAG_RE = /^\[app:([A-Za-z0-9_\-]+)\]\s?(.*)$/s;

// First bracket tag in the line (e.g. `[Agent] foo` → "Agent").
const TAG_RE = /^\[([A-Za-z][A-Za-z0-9 _\-]{0,32})\]/;

// Matches obvious level prefixes.
const LEVEL_TAG_RE = /^\[(error|warn|warning|info|debug)\]/i;

/** Heuristic level detection. */
function parseLevel(body: string, source: "stdout" | "stderr"): string {
  if (source === "stderr") {
    // Plain stderr is "error" by default. Down-grade obvious info noise.
    if (/\b(info|debug)\b/i.test(body)) return "info";
    return "error";
  }
  const m = LEVEL_TAG_RE.exec(body);
  if (m) {
    const t = m[1].toLowerCase();
    if (t === "warning") return "warn";
    return t;
  }
  if (/\b(error|exception|failed|stack)\b/i.test(body) && /\b(at\s|throw)\b/i.test(body)) {
    return "error";
  }
  if (/\bwarn(ing)?\b/i.test(body)) return "warn";
  return "info";
}

/** Heuristic category detection from leading bracket tag. */
function parseCategory(body: string, hasProject: boolean): string {
  const m = TAG_RE.exec(body);
  if (m) {
    const tag = m[1].toLowerCase().trim();
    const cat = TAG_TO_CATEGORY[tag];
    if (cat) return cat;
    // Unknown but bracketed tag: keep the original casing as the category so
    // operators see exactly what the producer wrote (`[Foo]` -> "Foo").
    return m[1];
  }
  return hasProject ? "Backend" : "System";
}

/**
 * Push a single raw log line into the buffer. Called by the console tagger
 * for every line written to stdout/stderr. Must be cheap and non-blocking.
 */
export function enqueueLog(opts: {
  projectId: string | null;
  source: "stdout" | "stderr";
  rawLine: string;
}): void {
  if (!enabled || stopped) return;

  let { projectId, rawLine } = opts;
  if (!rawLine) return;

  // Trim a single trailing newline (the tee passes raw lines, but be safe).
  if (rawLine.endsWith("\n")) rawLine = rawLine.slice(0, -1);
  if (rawLine.length === 0) return;

  // Belt-and-braces: if the ALS context didn't surface a project but the line
  // is already tagged (e.g. forwarded from an external producer), parse it.
  let body = rawLine;
  if (!projectId) {
    const m = APP_TAG_RE.exec(rawLine);
    if (m) { projectId = m[1]; body = m[2]; }
  } else {
    // Strip our own `[app:<id>] ` tag from the persisted message — it's
    // redundant since we store projectId as a column.
    const m = APP_TAG_RE.exec(rawLine);
    if (m && m[1] === projectId) body = m[2];
  }

  const level    = parseLevel(body, opts.source);
  const category = parseCategory(body, !!projectId);

  // Truncate over-long lines defensively.
  if (Buffer.byteLength(body, "utf8") > MAX_MESSAGE_BYTES) {
    body = body.slice(0, MAX_MESSAGE_BYTES) + "…[truncated]";
  }

  buffer.push({
    ts: new Date(),
    projectId,
    category,
    level,
    source: opts.source,
    message: body,
  });

  // Drop-oldest backpressure. Keep the most recent MAX_BUFFER lines so a
  // burst (e.g. agent dumping a stack trace into a giant payload) doesn't
  // OOM us if the DB is briefly slow.
  if (buffer.length > MAX_BUFFER) {
    droppedCount += buffer.length - MAX_BUFFER;
    buffer.splice(0, buffer.length - MAX_BUFFER);
  }
}

async function flush(): Promise<void> {
  if (flushing || buffer.length === 0) return;
  flushing = true;
  try {
    while (buffer.length > 0) {
      const chunk = buffer.splice(0, MAX_BATCH);
      try {
        await prisma.appLog.createMany({ data: chunk });
      } catch (err) {
        // Likely DB transient (restart, connection drop) or schema not yet
        // migrated. Re-buffer (front of queue) and back off; never console.log
        // from here — the tee would loop.
        buffer.unshift(...chunk);
        // Sentinel write so operators can spot persistent failures without
        // re-entering the tee. We bypass console.* on purpose.
        try {
          process.stderr.write(`[AppLog] flush failed: ${(err as any)?.message || err}\n`);
        } catch { /* swallow */ }
        return; // try again on next tick
      }
    }
    if (droppedCount > 0) {
      // Log how many lines we dropped due to overflow, then reset.
      const dropped = droppedCount;
      droppedCount = 0;
      try {
        await prisma.appLog.create({
          data: {
            ts: new Date(),
            projectId: null,
            category: "Lifecycle",
            level: "warn",
            source: "stderr",
            message: `[AppLog] dropped ${dropped} log line(s) due to buffer overflow (>${MAX_BUFFER})`,
          },
        });
      } catch { /* swallow */ }
    }
  } finally {
    flushing = false;
  }
}

/** Start the periodic flush timer. Idempotent. */
export function startAppLogFlusher(): void {
  if (timer) return;
  stopped = false;
  timer = setInterval(() => {
    void flush();
  }, FLUSH_INTERVAL_MS);
  // Don't keep the event loop alive just for the flusher.
  timer.unref?.();
}

/** Force-flush (used at shutdown). */
export async function drainAppLogs(): Promise<void> {
  stopped = false; // ensure flush proceeds even after stop()
  await flush();
}

/** Stop the flusher (no more flushes will be scheduled). Used at shutdown. */
export function stopAppLogFlusher(): void {
  stopped = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Disable the persistent sink at runtime (e.g. for tests). */
export function setAppLogEnabled(value: boolean): void {
  enabled = value;
}
