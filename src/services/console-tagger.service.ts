/**
 * Console tagger — attaches a `[app:<projectId>]` prefix to every stdout/stderr
 * line written while inside a project's execution context.
 *
 * Usage:
 *   - Call `installConsoleTagger()` once at process start (before any user code).
 *   - Wrap any code that runs a user-generated app's `routes.js`/ws handlers in
 *     `runWithProject(projectId, () => { ... })`. AsyncLocalStorage propagates
 *     through promises, setTimeout, setInterval and `ws.on(...)` listeners
 *     registered inside the wrapped function, so transitive logs are tagged
 *     automatically — no need to modify the generated app code.
 *
 * The PM2-captured log file ends up looking like:
 *   2025-... [app:9f3a-...] User connected: 1234
 *   2025-... [BotRunner] Bot @foo started for project ...        <- core (untagged)
 *
 * The log viewer parses the `[app:<id>]` prefix to filter by project.
 */

import { AsyncLocalStorage } from "async_hooks";
import { enqueueLog } from "./app-log.service";

interface AppContext {
  projectId: string;
}

const als = new AsyncLocalStorage<AppContext>();

/** Run `fn` so any console output produced (sync, in promises, in timers, in
 * event listeners registered while inside `fn`) is tagged with `projectId`. */
export function runWithProject<T>(projectId: string, fn: () => T): T {
  return als.run({ projectId }, fn);
}

/** Returns the current project ID if the running async chain is inside a
 * `runWithProject` block, otherwise `null`. */
export function getCurrentProjectId(): string | null {
  return als.getStore()?.projectId ?? null;
}

let installed = false;

/** Patch process.stdout/stderr.write so that every line emitted while inside a
 * `runWithProject` context is prefixed with `[app:<projectId>] `, AND every
 * line (project-tagged or core) is forked into the persistent `app_logs`
 * sink via app-log.service.ts.
 *
 * Tagging happens at the stream level (not at console.log) so multi-line
 * payloads (object inspection, stack traces, `\n`-containing strings) get
 * tagged on every line, not just the first. */
export function installConsoleTagger(): void {
  if (installed) return;
  installed = true;

  patchStream(process.stdout, "stdout");
  patchStream(process.stderr, "stderr");
}

const APP_PREFIX_RE = /^\[app:[A-Za-z0-9_\-]+\]\s/;

// Re-entrancy guard. Any process.stdout/stderr.write that happens *while*
// we're already inside the patched `write` (e.g. a logger somewhere in the
// flush path) goes straight to the original stream and is NOT re-captured
// to the persistent sink. Prevents infinite loops if the DB itself logs.
let inTee = 0;

function patchStream(stream: NodeJS.WriteStream, source: "stdout" | "stderr"): void {
  const original = stream.write.bind(stream);

  (stream as any).write = (chunk: any, encoding?: any, cb?: any): boolean => {
    if (inTee > 0) return original(chunk, encoding, cb);

    const ctx = als.getStore();
    const projectId = ctx?.projectId ?? null;

    let text: string | null = null;
    if (typeof chunk === "string") {
      text = chunk;
    } else if (Buffer.isBuffer(chunk)) {
      text = chunk.toString("utf8");
    }

    // Unknown chunk type — pass through, can't capture meaningfully.
    if (text === null) return original(chunk, encoding, cb);

    const endsWithNl = text.endsWith("\n");
    const body = endsWithNl ? text.slice(0, -1) : text;

    // Walk lines: build the (possibly tagged) outgoing text AND fork to the
    // persistent sink. We do both in the same pass to keep the cost low.
    const out: string[] = [];
    inTee++;
    try {
      const lines = body.split("\n");
      for (const line of lines) {
        if (line.length === 0) { out.push(line); continue; }

        // Strip an already-present `[app:<id>]` tag for the persistent sink
        // and use it as the project id if ALS didn't have one.
        let pid = projectId;
        let persistedLine = line;
        if (APP_PREFIX_RE.test(line)) {
          // Already tagged — don't double-tag for output.
          out.push(line);
          if (!pid) {
            const m = /^\[app:([A-Za-z0-9_\-]+)\]\s?(.*)$/.exec(line);
            if (m) { pid = m[1]; persistedLine = m[2]; }
          }
        } else if (pid) {
          out.push(`[app:${pid}] ${line}`);
        } else {
          out.push(line);
        }

        // Fork to the persistent sink (cheap enqueue, async flush).
        try {
          enqueueLog({ projectId: pid, source, rawLine: persistedLine });
        } catch { /* never let a sink failure break process.stdout */ }
      }
    } finally {
      inTee--;
    }

    const tagged = out.join("\n") + (endsWithNl ? "\n" : "");
    return original(tagged, encoding, cb);
  };
}
