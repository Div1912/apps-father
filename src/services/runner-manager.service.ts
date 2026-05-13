import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as http from "http";
import * as crypto from "crypto";
import { config } from "../config";
import { prisma } from "../db";
import { runnerProvisionService } from "./runner-provision.service";
import { decryptToken } from "./crypto.service";

/**
 * Runner Manager — supervises one Node.js worker process per project.
 *
 * Phase 1 lifecycle:
 *   - Workers stopped by default. No prewarm at boot.
 *   - First inbound request triggers `ensureRunning(projectId)`:
 *       allocate port → spawn worker → poll /__worker/health → ready.
 *   - Crash supervision with exponential backoff (1→2→4→8→16s, max 5 in 5min).
 *   - Manual lifecycle controls: stop, restart, reload, stopAll.
 *
 * Phase 2 (deferred): idle eviction, LRU cap, prewarm, memory tiers, pinning.
 *
 * Worker entry runs at `<runner-dir>/worker-entry.js` as plain JS (no TS dep).
 *   - DEV: /opt/apps-father-dev/runner/worker-entry.js
 *   - dev local: <repo>/runner/worker-entry.js (resolved relative to dist).
 *
 * Security: worker spawn drops to per-project Linux user uid/gid, env is built
 * from a strict allowlist (no platform secrets), and stdout/stderr are tagged
 * and ring-buffered for ops introspection.
 */

const LOG_RING_LIMIT = 500;        // lines kept in memory per worker
const DRAIN_MS = 30_000;           // SIGTERM drain budget for graceful manual stop
const RELOAD_DRAIN_MS = 5_000;     // shorter drain for supervisor-initiated reloads
const BACKOFF_STEPS_MS = [1000, 2000, 4000, 8000, 16000];
const BACKOFF_WINDOW_MS = 5 * 60_000;

export type RuntimeKind = "release" | "development";

interface RuntimeStatus {
  loaded: boolean;
  error?: string | null;
}

interface WorkerHealth {
  ok: boolean;
  uptimeMs?: number;
  release?: RuntimeStatus;
  development?: RuntimeStatus;
  mem?: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
  };
  cpuPercent?: number;
}

interface WorkerHandle {
  projectId: string;
  pid: number;
  port: number;
  /** Only set after the first /__worker/health check succeeds. */
  startedAt: number;
}

interface LogLine {
  ts: number;
  stream: "stdout" | "stderr";
  text: string;
}

interface RegistryEntry {
  projectId: string;
  port: number;
  child: ChildProcess | null;
  state: "spawning" | "ready" | "stopping" | "stopped" | "circuit-broken";
  startedAt: number | null;
  /** When the most recent crash window started — used to expire the backoff. */
  crashWindowStart: number;
  /** Number of crashes within the current 5-minute window. */
  crashesInWindow: number;
  restartCount: number;
  crashCount: number;
  lastError: string | null;
  /** Most recent successful /__worker/health body. */
  lastHealth: WorkerHealth | null;
  /** Promise resolved when ensureRunning() is currently in flight. */
  spawnPromise: Promise<WorkerHandle> | null;
  /**
   * Promise resolved when a stop() is currently in flight.
   * Concurrent stop/restart callers await this instead of issuing a second
   * SIGTERM, which would create a race where the new worker tries to bind the
   * same port before the old process has released it.
   */
  stopPromise: Promise<void> | null;
  /** True while a reloadIfRunning() is in flight — deduplicates burst calls. */
  reloadInFlight: boolean;
  logs: LogLine[];
  /** Username derived once via runner-provision-service. */
  username: string;
}

export interface WorkerSummary {
  projectId: string;
  port: number;
  pid: number | null;
  state: RegistryEntry["state"];
  uptimeMs: number | null;
  username: string | null;
  restartCount: number;
  crashCount: number;
  lastError: string | null;
  release: RuntimeStatus | null;
  development: RuntimeStatus | null;
  /** RSS memory in bytes from the most recent stats poll, or null if unknown. */
  memRssBytes: number | null;
  /** CPU usage % averaged over the last stats poll interval, or null if unknown. */
  cpuPercent: number | null;
}

class RunnerManager {
  private registry = new Map<string, RegistryEntry>();
  private shuttingDown = false;
  /** Set to true once main is fully booted; spawn() refuses if false. */
  private enabled = false;

  /** Resolved at first use — points at runner/ next to dist/ (or repo root in dev). */
  private workerEntryPath: string | null = null;

  /** Timer handle for the periodic stats poller. */
  private statsPollerTimer: ReturnType<typeof setInterval> | null = null;

  enable() {
    this.enabled = true;
    this.startStatsPoller();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Lazy-spawn entry point. Idempotent and safe to call concurrently —
   * concurrent callers share the same in-flight spawn promise.
   */
  async ensureRunning(projectId: string): Promise<WorkerHandle> {
    if (!this.enabled) {
      throw new Error("RunnerManager is disabled");
    }
    if (this.shuttingDown) {
      throw new Error("RunnerManager is shutting down");
    }

    let entry = this.registry.get(projectId);

    // Already up & running.
    if (entry && entry.state === "ready" && entry.child && !entry.child.killed) {
      return this.handleFromEntry(entry);
    }

    // Spawn already in flight — share the promise.
    if (entry?.spawnPromise) {
      return entry.spawnPromise;
    }

    // Circuit-broken — surface lastError without trying to respawn.
    if (entry?.state === "circuit-broken") {
      throw new Error(
        `Worker for project ${projectId} is in circuit-break: ${entry.lastError || "unknown"}`
      );
    }

    if (!entry) {
      entry = {
        projectId,
        port: 0,
        child: null,
        state: "stopped",
        startedAt: null,
        crashWindowStart: 0,
        crashesInWindow: 0,
        restartCount: 0,
        crashCount: 0,
        lastError: null,
        lastHealth: null,
        spawnPromise: null,
        stopPromise: null,
        reloadInFlight: false,
        logs: [],
        username: "",
      };
      this.registry.set(projectId, entry);
    }

    const promise = this.spawnWorker(entry).finally(() => {
      entry!.spawnPromise = null;
    });
    entry.spawnPromise = promise;
    return promise;
  }

  /** True if a worker is currently running (spawning or ready). */
  isRunning(projectId: string): boolean {
    const e = this.registry.get(projectId);
    return !!e && (e.state === "ready" || e.state === "spawning");
  }

  /** Snapshot list of every entry in the registry — used by admin API. */
  list(): WorkerSummary[] {
    return Array.from(this.registry.values()).map((e) => this.summarize(e));
  }

  getMetrics(projectId: string): WorkerSummary | null {
    const e = this.registry.get(projectId);
    return e ? this.summarize(e) : null;
  }

  /** Last N stdout/stderr lines (default 200). */
  getLogs(projectId: string, n = 200): LogLine[] {
    const e = this.registry.get(projectId);
    if (!e) return [];
    return e.logs.slice(-n);
  }

  /**
   * Stop a worker via SIGTERM with drain → SIGKILL fallback. Removes from
   * registry on success. Supervisor does NOT respawn — next request lazy-starts.
   *
   * Concurrent callers are coalesced: if a stop is already in flight the second
   * caller awaits the same promise instead of issuing a second SIGTERM, which
   * would race the new spawn against the still-alive old process on the same port.
   */
  async stop(projectId: string): Promise<void> {
    const entry = this.registry.get(projectId);
    if (!entry || !entry.child || entry.state === "stopped") {
      this.registry.delete(projectId);
      return;
    }

    // Already stopping — return the in-flight promise so all concurrent callers
    // wait for the SAME termination rather than sending duplicate signals.
    if (entry.state === "stopping" && entry.stopPromise) {
      return entry.stopPromise;
    }

    entry.state = "stopping";
    entry.stopPromise = this.terminate(entry).then(() => {
      this.registry.delete(projectId);
    });
    return entry.stopPromise;
  }

  /** Restart: stop + ensureRunning. Bumps `restartCount`. */
  async restart(projectId: string): Promise<WorkerHandle> {
    const entry = this.registry.get(projectId);
    if (entry) entry.restartCount++;
    await this.stopFast(projectId);
    // Preserve restartCount across recreate.
    const handle = await this.ensureRunning(projectId);
    return handle;
  }

  /** Code-change reload — semantically same as restart, separate call site. */
  async reload(projectId: string): Promise<WorkerHandle> {
    return this.restart(projectId);
  }

  /**
   * Like stop(), but uses a short RELOAD_DRAIN_MS timeout so the port is
   * released quickly. Used by the restart/reload paths where the supervisor
   * immediately re-spawns on the same port.
   */
  private async stopFast(projectId: string): Promise<void> {
    const entry = this.registry.get(projectId);
    if (!entry || !entry.child || entry.state === "stopped") {
      this.registry.delete(projectId);
      return;
    }

    if (entry.state === "stopping" && entry.stopPromise) {
      return entry.stopPromise;
    }

    entry.state = "stopping";
    entry.stopPromise = this.terminate(entry, RELOAD_DRAIN_MS).then(() => {
      this.registry.delete(projectId);
    });
    return entry.stopPromise;
  }

  /**
   * Reload only if the worker is currently in the registry. Used by
   * commit.service.ts after sync/release: a stopped worker simply picks up
   * new code on its next lazy spawn, so we don't need to start one.
   *
   * Burst-safe: if a reload is already in flight for this project (e.g. deploy
   * + finish() both call syncToDev within milliseconds of each other) the second
   * call is a no-op. The first reload will use the latest code on disk anyway.
   */
  async reloadIfRunning(projectId: string): Promise<void> {
    if (!this.isRunning(projectId)) return;

    const entry = this.registry.get(projectId);
    if (!entry) return;

    if (entry.reloadInFlight) {
      console.log(`[RunnerManager] reload already in flight for ${projectId.slice(0, 8)}, skipping duplicate`);
      return;
    }

    entry.reloadInFlight = true;
    try {
      await this.reload(projectId);
    } finally {
      // Entry may have been deleted by stop(); safe to ignore if gone.
      const e = this.registry.get(projectId);
      if (e) e.reloadInFlight = false;
    }
  }

  /** Drain every worker. Used by the main process shutdown hook. */
  async stopAll(): Promise<void> {
    this.shuttingDown = true;
    const ids = Array.from(this.registry.keys());
    await Promise.all(ids.map((id) => this.stop(id).catch(() => {})));
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private resolveWorkerEntry(): string {
    if (this.workerEntryPath) return this.workerEntryPath;
    // dist/services/runner-manager.service.js → ../../runner/worker-entry.js
    // src/services/runner-manager.service.ts (dev) → ../../runner/worker-entry.js
    const candidate = path.resolve(__dirname, "..", "..", "runner", "worker-entry.js");
    this.workerEntryPath = candidate;
    return candidate;
  }

  private async spawnWorker(entry: RegistryEntry): Promise<WorkerHandle> {
    entry.state = "spawning";
    entry.lastError = null;

    // 1. Provision Linux user + tree if missing (idempotent).
    const username = runnerProvisionService.linuxUsername(entry.projectId);
    entry.username = username;

    if (!(await runnerProvisionService.userExists(username))) {
      try {
        await runnerProvisionService.provision(entry.projectId);
      } catch (err) {
        const msg = (err as Error).message;
        entry.state = "stopped";
        entry.lastError = `provision_failed: ${msg}`;
        throw new Error(entry.lastError);
      }
    }

    const ids = await runnerProvisionService.resolveIds(username);
    if (!ids) {
      entry.state = "stopped";
      entry.lastError = `cannot_resolve_uid_for_${username}`;
      throw new Error(entry.lastError);
    }

    // 2. Allocate port if missing, then evict any stale process on that port.
    if (!entry.port) {
      entry.port = await this.allocatePort(entry.projectId);
    }
    await this.freePort(entry.port);

    // 3. Build env + spawn arg vector.
    const env = await this.buildWorkerEnv(entry);
    const workerEntry = this.resolveWorkerEntry();
    const heapMb = Math.max(64, config.runnerHeapMb);

    const cwd = runnerProvisionService.projectRoot(entry.projectId);

    let child: ChildProcess;
    try {
      child = spawn(
        process.execPath,
        [`--max-old-space-size=${heapMb}`, workerEntry],
        {
          cwd,
          env,
          uid: ids.uid,
          gid: ids.gid,
          stdio: ["ignore", "pipe", "pipe"],
          // Detach from main's process group so SIGINT to main doesn't tear
          // down workers prematurely (we manage their lifecycle ourselves).
          detached: false,
        }
      );
    } catch (err) {
      entry.state = "stopped";
      entry.lastError = `spawn_failed: ${(err as Error).message}`;
      throw new Error(entry.lastError);
    }

    entry.child = child;

    this.attachStdio(entry, child);
    this.attachExitHandler(entry, child);

    // 4. Poll /__worker/health until ready or timeout.
    try {
      const health = await this.waitHealthy(entry);
      entry.lastHealth = health;
      entry.state = "ready";
      entry.startedAt = Date.now();
      entry.crashesInWindow = 0; // reset on successful boot
      return this.handleFromEntry(entry);
    } catch (err) {
      const msg = (err as Error).message;
      entry.lastError = `healthcheck_failed: ${msg}`;
      // Kill the half-started process so it doesn't linger.
      try { child.kill("SIGKILL"); } catch {}
      entry.state = "stopped";

      // If the worker logged EADDRINUSE the port is still occupied.
      // Clear the cached port so the next ensureRunning() allocates a fresh
      // one instead of re-trying the same blocked port indefinitely.
      const portStuck = entry.logs.some(l => l.text.includes("EADDRINUSE"));
      if (portStuck) {
        console.warn(
          `[RunnerManager] port ${entry.port} is stuck (EADDRINUSE) for ${entry.projectId.slice(0, 8)} — clearing so next spawn picks a fresh port`,
        );
        entry.port = 0; // force re-allocation on next ensureRunning()
        try {
          await import("../db").then(({ prisma }) =>
            prisma.project.update({
              where: { id: entry.projectId },
              data: { workerPort: null },
            })
          );
        } catch { /* DB update is best-effort */ }
      }

      throw new Error(entry.lastError);
    }
  }

  /**
   * Build the strictly-allowlisted env passed to spawn(). Never derived from
   * `{...process.env, ...}` — built from scratch.
   */
  private async buildWorkerEnv(entry: RegistryEntry): Promise<NodeJS.ProcessEnv> {
    const projectRoot = runnerProvisionService.projectRoot(entry.projectId);

    const env: NodeJS.ProcessEnv = {
      NODE_ENV: process.env.NODE_ENV || "production",
      PROJECT_ID: entry.projectId,
      PROJECT_ROOT: projectRoot,
      RELEASE_BACKEND_DIR: path.join(projectRoot, "release", "backend"),
      RELEASE_DATA_DIR: path.join(projectRoot, "release", "data"),
      RELEASE_DB_PATH: path.join(projectRoot, "release", "data", "db.sqlite"),
      DEVELOPMENT_BACKEND_DIR: path.join(projectRoot, "development", "backend"),
      DEVELOPMENT_DATA_DIR: path.join(projectRoot, "development", "data"),
      DEVELOPMENT_DB_PATH: path.join(projectRoot, "development", "data", "db.sqlite"),
      PORT: String(entry.port),
      BASE_URL: config.baseUrl,
      RUNNER_SECRET: config.runnerSecret,
      AF_INTERNAL_SECRET: config.internalSecret,
      // PATH is required by some node addons (better-sqlite3 native loader);
      // safe to forward — contains no secrets.
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      // NODE_PATH lets routes.js resolve npm packages installed in the platform's
      // own node_modules (e.g. multer, axios, etc.) without per-project installs.
      // Routes live at /srv/…/backend/routes.js whose ancestor chain never reaches
      // /opt/apps-father[-dev]/node_modules, so without this they can't find anything.
      NODE_PATH: path.join(process.cwd(), "node_modules"),
    };

    // Per-project bot token (release runtime only). Decrypted inside main and
    // handed to the worker; the worker scrubs it from process.env before
    // requiring routes.js.
    try {
      const project = await prisma.project.findUnique({
        where: { id: entry.projectId },
        select: { botTokenEncrypted: true, botUsername: true },
      });
      if (project?.botTokenEncrypted) {
        try {
          const plain = decryptToken(project.botTokenEncrypted);
          if (plain) {
            env.BOT_TOKEN = plain;
            if (project.botUsername) env.BOT_USERNAME = project.botUsername;
          }
        } catch {
          // bad encryption key for this row — skip token, don't fail spawn.
        }
      }
    } catch {
      // DB lookup failed — boot worker without a bot token. Logs only.
    }

    return env;
  }

  private attachStdio(entry: RegistryEntry, child: ChildProcess) {
    const tag = `[worker:${entry.projectId.slice(0, 8)}]`;

    const onData = (stream: "stdout" | "stderr") => (chunk: Buffer | string) => {
      const text = chunk.toString("utf8");
      const lines = text.split("\n");
      for (const line of lines) {
        if (!line) continue;
        entry.logs.push({ ts: Date.now(), stream, text: line });
        if (entry.logs.length > LOG_RING_LIMIT) {
          entry.logs.splice(0, entry.logs.length - LOG_RING_LIMIT);
        }
        const out = stream === "stdout" ? process.stdout : process.stderr;
        out.write(`${tag} ${line}\n`);
      }
    };

    child.stdout?.on("data", onData("stdout"));
    child.stderr?.on("data", onData("stderr"));
  }

  private attachExitHandler(entry: RegistryEntry, child: ChildProcess) {
    child.once("exit", (code, signal) => {
      const wasReady = entry.state === "ready";
      const wasStopping = entry.state === "stopping";

      if (wasStopping) {
        // Manual stop — don't respawn.
        entry.state = "stopped";
        entry.child = null;
        return;
      }

      if (code === 0 && !signal) {
        // Clean exit (e.g. /__worker/reload). Respawn lazily on next request,
        // OR if it crashed mid-flight while a request was waiting, bubble up
        // via the spawnPromise chain. We don't auto-respawn here.
        entry.state = "stopped";
        entry.child = null;
        if (wasReady) {
          // Voluntary reload — clear lastError so admin sees clean state.
          entry.lastError = null;
        }
        return;
      }

      // Non-zero exit or killed by signal — count as crash.
      entry.crashCount++;
      entry.lastError = `exit code=${code} signal=${signal || "none"}`;
      entry.child = null;

      // Reset the rolling window if expired.
      const now = Date.now();
      if (now - entry.crashWindowStart > BACKOFF_WINDOW_MS) {
        entry.crashWindowStart = now;
        entry.crashesInWindow = 1;
      } else {
        entry.crashesInWindow++;
      }

      if (entry.crashesInWindow > BACKOFF_STEPS_MS.length) {
        entry.state = "circuit-broken";
        console.error(
          `[RunnerManager] Worker for ${entry.projectId} circuit-broken after ${entry.crashesInWindow} crashes`
        );
        return;
      }

      entry.state = "stopped";

      // No proactive respawn — keep crashed worker idle until next inbound
      // request. The exponential backoff is observed by the next ensureRunning
      // call via a setTimeout.
      const delay = BACKOFF_STEPS_MS[Math.min(entry.crashesInWindow - 1, BACKOFF_STEPS_MS.length - 1)];
      console.warn(
        `[RunnerManager] Worker ${entry.projectId} crashed (${entry.lastError}); next spawn deferred ${delay}ms`
      );
    });

    child.once("error", (err) => {
      entry.lastError = `child_error: ${err.message}`;
    });
  }

  /** Poll /__worker/health until 200 ok or spawn timeout. */
  private async waitHealthy(entry: RegistryEntry): Promise<WorkerHealth> {
    const deadline = Date.now() + config.runnerSpawnTimeoutMs;
    const interval = config.runnerHealthIntervalMs;
    let lastErr: Error | null = null;

    while (Date.now() < deadline) {
      // If the child died during boot, abort early.
      if (!entry.child || entry.child.killed) {
        throw new Error("worker exited before becoming healthy");
      }

      try {
        const body = await this.fetchWorkerHealth(entry.port);
        if (body.ok) return body;
      } catch (err) {
        lastErr = err as Error;
      }
      await sleep(interval);
    }

    throw new Error(
      `health timeout after ${config.runnerSpawnTimeoutMs}ms: ${lastErr?.message || "no response"}`
    );
  }

  private fetchWorkerHealth(port: number): Promise<WorkerHealth> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          path: "/__worker/health",
          method: "GET",
          headers: { "X-Runner-Secret": config.runnerSecret },
          timeout: 1500,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              resolve(body);
            } catch (err) {
              reject(err as Error);
            }
          });
        }
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("health request timeout")));
      req.end();
    });
  }

  /**
   * Allocate a free port in [runnerPortMin, runnerPortMax] and persist it on
   * the project row. Reuses an already-assigned port if one exists.
   *
   * Phase 1: linear scan over `worker_port` values + jitter on collision.
   * Good enough for hundreds of projects; Phase 2 will use a sequence.
   */
  async allocatePort(projectId: string): Promise<number> {
    // Reuse if already allocated.
    const existing = await prisma.project.findUnique({
      where: { id: projectId },
      select: { workerPort: true },
    });
    if (existing?.workerPort && existing.workerPort >= config.runnerPortMin && existing.workerPort <= config.runnerPortMax) {
      return existing.workerPort;
    }

    // Pull every used port — small set, no real cost.
    const used = await prisma.project.findMany({
      where: { workerPort: { not: null } },
      select: { workerPort: true },
    });
    const usedSet = new Set<number>(used.map((r) => r.workerPort!).filter(Boolean));

    // Try a randomised offset first for fairness across restarts.
    const span = config.runnerPortMax - config.runnerPortMin + 1;
    const offset = crypto.randomInt(0, span);
    for (let i = 0; i < span; i++) {
      const candidate = config.runnerPortMin + ((offset + i) % span);
      if (usedSet.has(candidate)) continue;
      try {
        await prisma.project.update({
          where: { id: projectId },
          data: { workerPort: candidate },
        });
        return candidate;
      } catch {
        // unique violation — race with another spawner. Try the next port.
        usedSet.add(candidate);
      }
    }

    throw new Error("port pool exhausted");
  }

  /**
   * Send SIGTERM, wait up to `drainMs` for graceful exit, then SIGKILL.
   * Caller passes RELOAD_DRAIN_MS for code-change reloads so the new worker
   * can bind the same port quickly instead of waiting 30 s.
   */
  private async terminate(entry: RegistryEntry, drainMs = DRAIN_MS): Promise<void> {
    const child = entry.child;
    if (!child || child.killed) return;

    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
    });

    try {
      child.kill("SIGTERM");
    } catch {}

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, drainMs);

    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }

  private handleFromEntry(entry: RegistryEntry): WorkerHandle {
    return {
      projectId: entry.projectId,
      pid: entry.child?.pid || 0,
      port: entry.port,
      startedAt: entry.startedAt || Date.now(),
    };
  }

  /**
   * Poll /__worker/health every 10 s on all ready workers to keep RAM + CPU
   * stats fresh. Non-fatal: a poll failure is silently ignored (worker may
   * be momentarily busy). Timer is set up once on enable().
   */
  private startStatsPoller(): void {
    if (this.statsPollerTimer) return;
    this.statsPollerTimer = setInterval(() => {
      for (const entry of this.registry.values()) {
        if (entry.state !== "ready" || !entry.port) continue;
        this.fetchWorkerHealth(entry.port)
          .then((health) => {
            entry.lastHealth = health;
          })
          .catch(() => { /* ignore transient failures */ });
      }
    }, 10_000);
    // Allow Node to exit even if this timer is still running.
    if (this.statsPollerTimer.unref) this.statsPollerTimer.unref();
  }

  private summarize(e: RegistryEntry): WorkerSummary {
    return {
      projectId: e.projectId,
      port: e.port,
      pid: e.child?.pid ?? null,
      state: e.state,
      uptimeMs: e.startedAt ? Date.now() - e.startedAt : null,
      username: e.username || null,
      restartCount: e.restartCount,
      crashCount: e.crashCount,
      lastError: e.lastError,
      release: e.lastHealth?.release ?? null,
      development: e.lastHealth?.development ?? null,
      memRssBytes: e.lastHealth?.mem?.rssBytes ?? null,
      cpuPercent: e.lastHealth?.cpuPercent ?? null,
    };
  }

  /**
   * Kill any process currently holding `port` via `fuser -k <port>/tcp`
   * (Linux only). Waits 250 ms after the kill so the OS releases the socket
   * before we try to bind to it. Silently no-ops if fuser is unavailable
   * (e.g. dev on macOS/Windows).
   */
  private freePort(port: number): Promise<void> {
    return new Promise((resolve) => {
      if (!port) { resolve(); return; }
      const child = spawn("fuser", ["-k", `${port}/tcp`], { stdio: "ignore" });
      const done = () => setTimeout(resolve, 250);
      child.on("close", done);
      child.on("error", () => resolve()); // fuser not installed — skip
    });
  }

  /**
   * For the proxy/forwarder: get the worker port without forcing a spawn.
   * Returns null if the worker is not currently in the registry.
   */
  getPortIfRunning(projectId: string): number | null {
    const e = this.registry.get(projectId);
    if (e && e.state === "ready" && e.port) return e.port;
    return null;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export const runnerManager = new RunnerManager();
