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
 * `runWithProject` context is prefixed with `[app:<projectId>] `.
 *
 * Tagging happens at the stream level (not at console.log) so multi-line
 * payloads (object inspection, stack traces, `\n`-containing strings) get
 * tagged on every line, not just the first. */
export function installConsoleTagger(): void {
  if (installed) return;
  installed = true;

  patchStream(process.stdout);
  patchStream(process.stderr);
}

const APP_PREFIX_RE = /^\[app:[A-Za-z0-9_\-]+\]\s/;

function patchStream(stream: NodeJS.WriteStream): void {
  const original = stream.write.bind(stream);

  (stream as any).write = (chunk: any, encoding?: any, cb?: any): boolean => {
    const ctx = als.getStore();
    if (!ctx?.projectId) return original(chunk, encoding, cb);

    let text: string;
    if (typeof chunk === "string") {
      text = chunk;
    } else if (Buffer.isBuffer(chunk)) {
      text = chunk.toString("utf8");
    } else {
      // Unknown chunk type — pass through unchanged.
      return original(chunk, encoding, cb);
    }

    const tag = `[app:${ctx.projectId}] `;
    const endsWithNl = text.endsWith("\n");
    const body = endsWithNl ? text.slice(0, -1) : text;
    const tagged =
      body
        .split("\n")
        .map((line) => {
          if (line.length === 0) return line;
          // Avoid double-tagging if the line is already tagged (e.g. PM2 piped
          // chains, or our own re-entry).
          if (APP_PREFIX_RE.test(line)) return line;
          return tag + line;
        })
        .join("\n") + (endsWithNl ? "\n" : "");

    return original(tagged, encoding, cb);
  };
}
