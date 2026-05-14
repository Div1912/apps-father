import { spawn, ChildProcess, execFile } from "child_process";
import * as pty from "node-pty";
import { promisify } from "util";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";
import * as dotenv from "dotenv";
import { config } from "../config";
import { prisma } from "../db";
import { decryptToken } from "./crypto.service";
import type {
  IExecStream,
  IRunnerManager,
  LogLine,
  RuntimeStatus,
  WorkerHandle,
  WorkerHealth,
  WorkerSummary,
} from "./runner-types";

const execFileP = promisify(execFile);

/**
 * DockerRunnerService — Phase 2 of worker isolation.
 *
 * Replaces the legacy {@link RunnerManager} (per-Linux-user `child_process.spawn`)
 * with a container-per-project model. Each project gets its own Docker container
 * derived from `apps-father-runner:latest`, isolated at the namespace + cgroup
 * level, with strict memory/CPU/PID limits and a read-only root filesystem.
 *
 * Public API mirrors {@link RunnerManager} 1:1 so call sites flip via
 * `config.runtimeMode` (env RUNTIME_MODE=docker) without code changes.
 *
 * Key invariants:
 *   - Container name: `afp-<projectId>` — same shape used by ShellTool / console.
 *   - Volume:  `-v /srv/.../<id>:/workspace` — files live on host, container
 *              is stateless. Per-project node_modules go to /workspace/node_modules.
 *   - Network: shared `apps-father-runners` bridge with --icc=false. Outbound
 *              internet open; host gateway / loopback / private LANs blocked
 *              by iptables (see scripts/setup-docker-network.sh).
 *   - Limits:  --memory 512m  --cpus 0.5  --pids-limit 100  --read-only
 *              + tmpfs /tmp:64m so npm cache / build steps work in --read-only.
 *   - Logs:    `docker logs --follow --timestamps` is piped into an in-memory
 *              ring buffer so getLogs() remains synchronous (critical for
 *              ServerLogsTool and Server Control polling).
 *   - Health:  the worker entry's /__worker/health is polled exactly like in
 *              the legacy manager — the container exposes its 8080 inside
 *              port to a random 127.0.0.1:<port> on the host (Docker-managed).
 */

const LOG_RING_LIMIT = 500;
const STATS_POLL_MS = 10_000;
const HEALTH_TIMEOUT_MS = 1_500;
const STARTUP_DEADLINE_MS = 30_000; // image + container boot + health
const DRAIN_GRACEFUL_S = 30;        // docker stop --time 30
const DRAIN_FAST_S = 5;             // restart/reload — short drain
const CONTAINER_NAME_PREFIX = "afp-";
const IMAGE_NAME = "apps-father-runner:latest";
const DOCKER_NETWORK = "apps-father-runners";
const CONTAINER_PORT = "8080";

/** Platform-owned env keys that user .env files must not override. */
const RESERVED_ENV_KEYS = new Set([
  "NODE_ENV", "PROJECT_ID", "PROJECT_ROOT",
  "RELEASE_BACKEND_DIR", "RELEASE_DATA_DIR", "RELEASE_DB_PATH",
  "DEVELOPMENT_BACKEND_DIR", "DEVELOPMENT_DATA_DIR", "DEVELOPMENT_DB_PATH",
  "PORT", "BASE_URL", "RUNNER_SECRET", "AF_INTERNAL_SECRET",
  "NODE_PATH", "PATH", "BOT_TOKEN", "BOT_USERNAME",
]);

interface RegistryEntry {
  projectId: string;
  containerName: string;
  /** Host-side mapped port (Docker-assigned). 0 until container is running. */
  port: number;
  /** Container ID once started; null otherwise. */
  containerId: string | null;
  /** Long-lived `docker logs --follow` child; null when not streaming. */
  logsChild: ChildProcess | null;
  state: "spawning" | "ready" | "stopping" | "stopped" | "circuit-broken";
  startedAt: number | null;
  restartCount: number;
  crashCount: number;
  lastError: string | null;
  lastHealth: WorkerHealth | null;
  /** RSS bytes from `docker stats`, kept fresh by the periodic poller. */
  memRssBytes: number | null;
  /** CPU% from `docker stats`. */
  cpuPercent: number | null;
  spawnPromise: Promise<WorkerHandle> | null;
  stopPromise: Promise<void> | null;
  reloadInFlight: boolean;
  logs: LogLine[];
}

class DockerRunnerService implements IRunnerManager {
  private registry = new Map<string, RegistryEntry>();
  private shuttingDown = false;
  private enabled = false;
  private statsPollerTimer: ReturnType<typeof setInterval> | null = null;

  enable(): void {
    this.enabled = true;
    this.startStatsPoller();
    // Best-effort recovery: if the platform restarted but containers are still
    // up, re-attach to them. Anything missing will be re-created on demand.
    this.adoptExistingContainers().catch((err) => {
      console.warn("[DockerRunner] adoptExistingContainers failed:", err);
    });
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async ensureRunning(projectId: string): Promise<WorkerHandle> {
    if (!this.enabled) throw new Error("DockerRunner is disabled");
    if (this.shuttingDown) throw new Error("DockerRunner is shutting down");

    let entry = this.registry.get(projectId);

    if (entry && entry.state === "ready" && entry.containerId && entry.port) {
      return this.handleFromEntry(entry);
    }
    if (entry?.spawnPromise) return entry.spawnPromise;
    if (entry?.state === "circuit-broken") {
      throw new Error(
        `Worker for project ${projectId} is in circuit-break: ${entry.lastError || "unknown"}`,
      );
    }

    if (!entry) {
      entry = this.makeEntry(projectId);
      this.registry.set(projectId, entry);
    }

    const promise = this.spawnContainer(entry).finally(() => {
      entry!.spawnPromise = null;
    });
    entry.spawnPromise = promise;
    return promise;
  }

  isRunning(projectId: string): boolean {
    const e = this.registry.get(projectId);
    return !!e && (e.state === "ready" || e.state === "spawning");
  }

  getPortIfRunning(projectId: string): number | null {
    const e = this.registry.get(projectId);
    if (e && e.state === "ready" && e.port) return e.port;
    return null;
  }

  list(): WorkerSummary[] {
    return Array.from(this.registry.values()).map((e) => this.summarize(e));
  }

  getMetrics(projectId: string): WorkerSummary | null {
    const e = this.registry.get(projectId);
    return e ? this.summarize(e) : null;
  }

  getLogs(projectId: string, n = 200): LogLine[] {
    const e = this.registry.get(projectId);
    if (!e) return [];
    return e.logs.slice(-n);
  }

  async stop(projectId: string): Promise<void> {
    const entry = this.registry.get(projectId);
    if (!entry || entry.state === "stopped") {
      this.registry.delete(projectId);
      return;
    }
    if (entry.state === "stopping" && entry.stopPromise) {
      return entry.stopPromise;
    }
    entry.state = "stopping";
    entry.stopPromise = this.terminate(entry, DRAIN_GRACEFUL_S).then(() => {
      this.registry.delete(projectId);
    });
    return entry.stopPromise;
  }

  async restart(projectId: string): Promise<WorkerHandle> {
    const entry = this.registry.get(projectId);
    if (entry) entry.restartCount++;
    await this.stopFast(projectId);
    return this.ensureRunning(projectId);
  }

  async reload(projectId: string): Promise<WorkerHandle> {
    return this.restart(projectId);
  }

  async reloadIfRunning(projectId: string): Promise<void> {
    if (!this.isRunning(projectId)) return;
    const entry = this.registry.get(projectId);
    if (!entry) return;
    if (entry.reloadInFlight) {
      console.log(
        `[DockerRunner] reload already in flight for ${projectId.slice(0, 8)}, skipping duplicate`,
      );
      return;
    }
    entry.reloadInFlight = true;
    try {
      await this.reload(projectId);
    } finally {
      const e = this.registry.get(projectId);
      if (e) e.reloadInFlight = false;
    }
  }

  /**
   * Detach from all containers without stopping them.
   *
   * Called on platform (PM2) graceful restart. Docker containers are
   * independent OS processes — they keep serving traffic while Node.js
   * is restarting. Stopping them here would cause downtime for every
   * user project on every deploy.
   *
   * On the next `enable()` call, `adoptExistingContainers()` re-attaches
   * to the still-running containers transparently.
   *
   * Use `killAll()` (via the admin "Stop all" button) when you intentionally
   * want to bring every container down.
   */
  async stopAll(): Promise<void> {
    this.shuttingDown = true;
    if (this.statsPollerTimer) {
      clearInterval(this.statsPollerTimer);
      this.statsPollerTimer = null;
    }
    // Detach log streamers so we don't leak `docker logs --follow` processes,
    // but leave the containers themselves running.
    for (const entry of this.registry.values()) {
      this.detachStreams(entry);
    }
    this.registry.clear();
    console.log("[DockerRunner] detached from all containers (containers kept running)");
  }

  /**
   * Actually stop and remove every container. Used by the admin "Stop all"
   * button — NOT called on normal PM2 restart.
   *
   * Does NOT set shuttingDown so new ensureRunning() calls can succeed
   * afterwards (e.g. user starts a worker again from the admin panel).
   */
  async killAll(): Promise<void> {
    const ids = Array.from(this.registry.keys());
    await Promise.all(ids.map((id) => this.stop(id).catch(() => { /* swallow */ })));
  }

  // ── Direct command execution (used by Agent ShellTool, console WS) ─────────

  /**
   * Run a one-shot shell command inside the project's container. Spawns the
   * container if not yet running. Returns combined stdout/stderr (truncated).
   *
   * `--user node`  → never run as root inside the container.
   * `-w /workspace` → working dir maps to the project tree on host.
   * `--no-tty`     → suitable for non-interactive use; for the WebSocket
   *                   console use {@link execStreaming} instead.
   */
  async exec(
    projectId: string,
    command: string,
    opts: { timeoutMs?: number; maxBytes?: number } = {},
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    await this.ensureRunning(projectId);
    const containerName = this.containerNameOf(projectId);
    const timeout = opts.timeoutMs ?? 30_000;
    const maxBytes = opts.maxBytes ?? 1024 * 1024;

    return new Promise((resolve) => {
      const child = spawn(
        "docker",
        ["exec", "--user", "node", "-w", "/workspace", containerName, "sh", "-c", command],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      let err = "";
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        try { child.kill("SIGKILL"); } catch {}
      }, timeout);
      child.stdout.on("data", (c) => {
        if (out.length < maxBytes) out += c.toString("utf8").slice(0, maxBytes - out.length);
      });
      child.stderr.on("data", (c) => {
        if (err.length < maxBytes) err += c.toString("utf8").slice(0, maxBytes - err.length);
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ exitCode: 1, stdout: out, stderr: err || e.message });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (killed) {
          resolve({ exitCode: 124, stdout: out, stderr: err + "\n[killed: timeout]" });
        } else {
          resolve({ exitCode: code ?? 1, stdout: out, stderr: err });
        }
      });
    });
  }

  /**
   * Spawn a long-running interactive `docker exec -it sh` for the WebSocket
   * console endpoint. Caller pipes stdin/stdout to the WS frame stream.
   */
  execStreaming(
    projectId: string,
    args: { cmd?: string[]; cols?: number; rows?: number } = {},
  ): IExecStream {
    const containerName = this.containerNameOf(projectId);
    const cmd = args.cmd && args.cmd.length > 0 ? args.cmd : ["sh"];

    // node-pty allocates a real OS-level pseudo-terminal (PTY pair).
    // Docker exec receives the PTY slave fd as its stdin, which IS a terminal,
    // so --tty is accepted. The shell runs interactively: shows a prompt,
    // echoes keystrokes, honours SIGWINCH on resize.
    // Encoding note: node-pty delivers data as latin1 strings (one char = one
    // byte). We convert to Buffer with "binary" (alias for latin1) so all raw
    // bytes — including ANSI escape sequences — are preserved when we send
    // them as binary WebSocket frames to xterm.js.
    const ptyProc = pty.spawn(
      "docker",
      [
        "exec",
        "--tty",
        "--interactive",
        "--user", "node",
        "-w", "/workspace",
        containerName,
        ...cmd,
      ],
      {
        name: "xterm-256color",
        cols: args.cols ?? 80,
        rows: args.rows ?? 24,
        cwd: "/",
        env: process.env as { [key: string]: string },
      },
    );

    return {
      onData: (cb) => ptyProc.onData((data) => cb(Buffer.from(data, "binary"))),
      onExit: (cb) => ptyProc.onExit(({ exitCode }) => cb(exitCode ?? null)),
      write: (data) =>
        ptyProc.write(Buffer.isBuffer(data) ? data.toString("binary") : data),
      resize: (cols, rows) => {
        try { ptyProc.resize(cols, rows); } catch { /* process may have exited */ }
      },
      kill: (signal) => {
        try { ptyProc.kill(signal); } catch { /* already dead */ }
      },
    };
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private makeEntry(projectId: string): RegistryEntry {
    return {
      projectId,
      containerName: this.containerNameOf(projectId),
      port: 0,
      containerId: null,
      logsChild: null,
      state: "stopped",
      startedAt: null,
      restartCount: 0,
      crashCount: 0,
      lastError: null,
      lastHealth: null,
      memRssBytes: null,
      cpuPercent: null,
      spawnPromise: null,
      stopPromise: null,
      reloadInFlight: false,
      logs: [],
    };
  }

  private containerNameOf(projectId: string): string {
    return CONTAINER_NAME_PREFIX + projectId;
  }

  private async spawnContainer(entry: RegistryEntry): Promise<WorkerHandle> {
    entry.state = "spawning";
    entry.lastError = null;

    const projectRoot = path.join(config.runnerProjectsRoot, entry.projectId);
    try {
      // Pre-create all subdirs that SQLite needs before the container starts.
      // SQLite can create a new .sqlite file but cannot mkdir parent dirs itself.
      for (const sub of [
        "development/data",
        "development/backend",
        "release/data",
        "release/backend",
      ]) {
        fs.mkdirSync(path.join(projectRoot, sub), { recursive: true });
      }
    } catch (err) {
      entry.state = "stopped";
      entry.lastError = `mkdir_project_root: ${(err as Error).message}`;
      throw new Error(entry.lastError);
    }

    // Ensure the workspace is owned by the container's `node` user (uid=1000).
    // Files pushed by the platform are owned by the server process user (root
    // or deploy user). Without this chown the container can't write its SQLite
    // databases or any runtime files.
    try {
      await execFileP("chown", ["-R", "1000:1000", projectRoot]);
    } catch {
      // Non-fatal: container will still start; individual writes may fail.
      console.warn(`[DockerRunner] chown 1000:1000 failed for ${projectRoot}`);
    }

    // Remove any stale container with the same name (e.g. left over after a
    // platform crash) — `docker run` would otherwise fail with name-conflict.
    await this.removeStaleContainer(entry.containerName);

    const env = await this.buildContainerEnv(entry);
    const heapMb = Math.max(64, config.runnerHeapMb);

    const args: string[] = [
      "run",
      "--detach",
      "--name", entry.containerName,
      "--label", "afp.project=" + entry.projectId,
      "--label", "afp.runner=worker",
      "--network", DOCKER_NETWORK,
      "--memory", `${heapMb * 2}m`,           // 2x heap is a sane container ceiling
      "--memory-swap", `${heapMb * 2}m`,
      "--cpus", "0.5",
      "--pids-limit", "100",
      "--read-only",
      "--tmpfs", "/tmp:rw,size=256m,mode=1777",
      // Owned by uid/gid 1000 (the `node` user) so npm install can write to
      // its cache. Without uid=1000 the tmpfs is owned by root (default) and
      // mode=0755 leaves the unprivileged `node` user with read-only access,
      // breaking every `npm install` (both from the agent's npm_install tool
      // and from the interactive worker console).
      "--tmpfs", "/home/node/.npm:rw,size=512m,mode=0755,uid=1000,gid=1000",
      "-v", `${projectRoot}:/workspace`,
      "-p", `127.0.0.1:0:${CONTAINER_PORT}`,  // Docker auto-assigns host port
      "--restart", "no",
    ];
    for (const [k, v] of Object.entries(env)) {
      if (v == null) continue;
      args.push("-e", `${k}=${v}`);
    }
    args.push(IMAGE_NAME);
    // Override the default CMD so Node uses the right heap cap.
    args.push("node", `--max-old-space-size=${heapMb}`, "/runner/worker-entry.js");

    let containerId: string;
    try {
      const { stdout } = await execFileP("docker", args, { timeout: 60_000 });
      containerId = stdout.trim();
      if (!containerId) throw new Error("docker run returned empty container id");
    } catch (err) {
      entry.state = "stopped";
      entry.lastError = `docker_run_failed: ${(err as Error).message}`;
      throw new Error(entry.lastError);
    }

    entry.containerId = containerId;

    // Resolve host-mapped port from `docker port`.
    try {
      const { stdout } = await execFileP("docker", ["port", entry.containerName, CONTAINER_PORT], { timeout: 5_000 });
      // Output: "127.0.0.1:32768"  (or a multi-line list with v4/v6)
      const match = stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => /^127\.0\.0\.1:\d+$/.test(l));
      if (!match) throw new Error("could not resolve mapped host port");
      entry.port = parseInt(match.split(":")[1], 10);
    } catch (err) {
      entry.lastError = `port_resolve_failed: ${(err as Error).message}`;
      try { await execFileP("docker", ["rm", "-f", entry.containerName]); } catch {}
      entry.state = "stopped";
      entry.containerId = null;
      throw new Error(entry.lastError);
    }

    // Attach the log streamer BEFORE the health-check loop, so any startup
    // error from the worker is captured into the ring buffer for inspection.
    this.attachLogStreamer(entry);
    this.attachExitWatcher(entry);

    try {
      const health = await this.waitHealthy(entry);
      entry.lastHealth = health;
      entry.state = "ready";
      entry.startedAt = Date.now();
      return this.handleFromEntry(entry);
    } catch (err) {
      entry.lastError = `healthcheck_failed: ${(err as Error).message}`;
      try { await execFileP("docker", ["rm", "-f", entry.containerName]); } catch {}
      this.detachStreams(entry);
      entry.containerId = null;
      entry.state = "stopped";
      throw new Error(entry.lastError);
    }
  }

  private async buildContainerEnv(entry: RegistryEntry): Promise<Record<string, string>> {
    const projectRoot = path.join(config.runnerProjectsRoot, entry.projectId);

    const env: Record<string, string> = {
      NODE_ENV: process.env.NODE_ENV || "production",
      PROJECT_ID: entry.projectId,
      PROJECT_ROOT: "/workspace",
      RELEASE_BACKEND_DIR: "/workspace/release/backend",
      RELEASE_DATA_DIR: "/workspace/release/data",
      RELEASE_DB_PATH: "/workspace/release/data/db.sqlite",
      DEVELOPMENT_BACKEND_DIR: "/workspace/development/backend",
      DEVELOPMENT_DATA_DIR: "/workspace/development/data",
      DEVELOPMENT_DB_PATH: "/workspace/development/data/db.sqlite",
      PORT: CONTAINER_PORT,
      BASE_URL: config.baseUrl,
      RUNNER_SECRET: config.runnerSecret,
      AF_INTERNAL_SECRET: config.internalSecret,
      // NODE_PATH: container resolves user packages from /workspace/node_modules
      // first, falling back to /runner/node_modules for platform-baked deps
      // (express, ws, dotenv, better-sqlite3, grammy). Set in the Dockerfile,
      // re-exported here so explicit -e overrides work.
      NODE_PATH: "/workspace/node_modules:/runner/node_modules",
      // Bind to all container interfaces so Docker's host-port proxy can
      // forward connections. The host never exposes this port directly —
      // it only maps 127.0.0.1:0 → container. Security comes from Docker
      // network isolation, not from the bind address.
      BIND_HOST: "0.0.0.0",
    };

    // Per-project user-defined env vars from <projectRoot>/<runtime>/backend/.env
    // on the HOST. The host path is read here and passed via -e flags so the
    // container's /workspace mount supplies the same files for runtime reads.
    for (const runtime of ["release", "development"] as const) {
      const envFile = path.join(projectRoot, runtime, "backend", ".env");
      if (fs.existsSync(envFile)) {
        try {
          const parsed = dotenv.parse(fs.readFileSync(envFile));
          for (const [k, v] of Object.entries(parsed)) {
            if (!RESERVED_ENV_KEYS.has(k)) env[k] = v;
          }
        } catch { /* malformed .env — ignore */ }
      }
    }

    // Per-project bot token (release runtime only).
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
        } catch { /* bad encryption key — skip */ }
      }
    } catch { /* DB lookup failed — boot without token */ }

    return env;
  }

  private async removeStaleContainer(name: string): Promise<void> {
    try {
      await execFileP("docker", ["rm", "-f", name], { timeout: 15_000 });
    } catch {
      // Doesn't exist → fine. Failure → fine, the next docker run will surface it.
    }
  }

  /**
   * Pipe `docker logs --follow --timestamps` into the in-memory ring buffer
   * so getLogs() stays synchronous (matches RunnerManager semantics — the
   * mini_app Server Control screen and ServerLogsTool expect this).
   */
  private attachLogStreamer(entry: RegistryEntry): void {
    if (entry.logsChild) return;
    const tag = `[worker:${entry.projectId.slice(0, 8)}]`;

    const proc = spawn(
      "docker",
      ["logs", "--follow", "--tail", String(LOG_RING_LIMIT), entry.containerName],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    entry.logsChild = proc;

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
    proc.stdout?.on("data", onData("stdout"));
    proc.stderr?.on("data", onData("stderr"));
    proc.on("error", () => { /* ignore — `docker logs` will be respawned on next event */ });
    proc.on("exit", () => {
      if (entry.logsChild === proc) entry.logsChild = null;
    });
  }

  /**
   * Watch for unexpected container exits via `docker events` is overkill;
   * instead, when /__worker/health stops responding the stats poller flips
   * the entry state. Crash counting is incremented by terminate() / poller
   * branches that detect an exit while state was "ready".
   */
  private attachExitWatcher(_entry: RegistryEntry): void {
    // Reserved for future expansion. Today: stats poller flips state when
    // health stops responding, and terminate() handles graceful shutdown.
  }

  private detachStreams(entry: RegistryEntry): void {
    if (entry.logsChild) {
      try { entry.logsChild.kill("SIGTERM"); } catch {}
      entry.logsChild = null;
    }
  }

  private async waitHealthy(entry: RegistryEntry): Promise<WorkerHealth> {
    const deadline = Date.now() + STARTUP_DEADLINE_MS;
    const interval = config.runnerHealthIntervalMs;
    let lastErr: Error | null = null;
    while (Date.now() < deadline) {
      try {
        const body = await this.fetchWorkerHealth(entry.port);
        if (body.ok) return body;
      } catch (err) {
        lastErr = err as Error;
      }
      await sleep(interval);
    }
    throw new Error(
      `health timeout after ${STARTUP_DEADLINE_MS}ms: ${lastErr?.message || "no response"}`,
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
          timeout: HEALTH_TIMEOUT_MS,
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
        },
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("health request timeout")));
      req.end();
    });
  }

  private async stopFast(projectId: string): Promise<void> {
    const entry = this.registry.get(projectId);
    if (!entry || entry.state === "stopped") {
      this.registry.delete(projectId);
      return;
    }
    if (entry.state === "stopping" && entry.stopPromise) {
      return entry.stopPromise;
    }
    entry.state = "stopping";
    entry.stopPromise = this.terminate(entry, DRAIN_FAST_S).then(() => {
      this.registry.delete(projectId);
    });
    return entry.stopPromise;
  }

  /**
   * Stop the container with `docker stop --time <drain>` and remove it.
   * Always cleans up the log streamer.
   */
  private async terminate(entry: RegistryEntry, drainSec: number): Promise<void> {
    if (!entry.containerId) {
      this.detachStreams(entry);
      return;
    }
    try {
      await execFileP("docker", ["stop", "--time", String(drainSec), entry.containerName], {
        timeout: (drainSec + 5) * 1_000,
      });
    } catch {
      // Force kill if graceful stop failed.
      try { await execFileP("docker", ["kill", entry.containerName]); } catch {}
    }
    try {
      await execFileP("docker", ["rm", "-f", entry.containerName]);
    } catch { /* best-effort */ }
    this.detachStreams(entry);
    entry.containerId = null;
    entry.state = "stopped";
  }

  private handleFromEntry(entry: RegistryEntry): WorkerHandle {
    return {
      projectId: entry.projectId,
      // Container PIDs differ from host PIDs; we use the registered numeric
      // hash of containerId as a stable proxy that's unique per-spawn so
      // existing UI fields (which only render or compare the PID column)
      // keep working without DB churn.
      pid: entry.containerId ? parseInt(entry.containerId.slice(0, 8), 16) || 0 : 0,
      port: entry.port,
      startedAt: entry.startedAt || Date.now(),
    };
  }

  /** Periodic `docker stats` + /__worker/health poll for fresh metrics. */
  private startStatsPoller(): void {
    if (this.statsPollerTimer) return;
    this.statsPollerTimer = setInterval(() => {
      for (const entry of this.registry.values()) {
        if (entry.state !== "ready" || !entry.port) continue;
        // Health (cheaper than docker stats; gives runtime status too).
        this.fetchWorkerHealth(entry.port)
          .then((health) => { entry.lastHealth = health; })
          .catch(() => { /* transient */ });
      }
      // docker stats on all our containers in one call (no --no-stream's
      // 1-second sample cost per container).
      this.refreshDockerStats().catch(() => { /* transient */ });
    }, STATS_POLL_MS);
    if (this.statsPollerTimer.unref) this.statsPollerTimer.unref();
  }

  private async refreshDockerStats(): Promise<void> {
    if (this.registry.size === 0) return;
    const names = Array.from(this.registry.values())
      .filter((e) => e.state === "ready")
      .map((e) => e.containerName);
    if (names.length === 0) return;
    try {
      const { stdout } = await execFileP(
        "docker",
        ["stats", "--no-stream", "--format", "{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}", ...names],
        { timeout: 5_000 },
      );
      for (const line of stdout.split(/\r?\n/)) {
        const [name, cpuRaw, memRaw] = line.split("|");
        if (!name) continue;
        const entry = Array.from(this.registry.values()).find((e) => e.containerName === name);
        if (!entry) continue;
        if (cpuRaw) {
          const v = parseFloat(cpuRaw.replace("%", "").trim());
          if (!isNaN(v)) entry.cpuPercent = v;
        }
        if (memRaw) {
          // Format is "<used> / <limit>"; we want bytes from <used>.
          const [used] = memRaw.split("/");
          const bytes = parseHumanBytes(used.trim());
          if (bytes != null) entry.memRssBytes = bytes;
        }
      }
    } catch { /* docker stats returns non-zero when a container vanished mid-call */ }
  }

  /**
   * Re-attach to any container running with our label after a platform
   * restart. We don't try to verify health here — the next ensureRunning()
   * call will do that. The goal is just to recover the registry.
   */
  private async adoptExistingContainers(): Promise<void> {
    let stdout = "";
    try {
      const out = await execFileP("docker", [
        "ps",
        "--filter", "label=afp.runner=worker",
        "--format", "{{.ID}}|{{.Names}}|{{.Label \"afp.project\"}}|{{.RunningFor}}",
      ], { timeout: 5_000 });
      stdout = out.stdout;
    } catch {
      return;
    }
    for (const line of stdout.split(/\r?\n/)) {
      const parts = line.split("|");
      const [id, name, projectId] = parts;
      const runningFor = parts[3] ?? "";
      if (!id || !name || !projectId) continue;
      if (this.registry.has(projectId)) continue;
      const entry = this.makeEntry(projectId);
      entry.containerId = id;
      entry.containerName = name;
      // Resolve port.
      try {
        const portOut = await execFileP("docker", ["port", name, CONTAINER_PORT], { timeout: 3_000 });
        const match = portOut.stdout.split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => /^127\.0\.0\.1:\d+$/.test(l));
        if (match) entry.port = parseInt(match.split(":")[1], 10);
      } catch { /* not exposed yet */ }
      entry.state = "ready";
      // Parse Docker's "X minutes ago" / "X hours ago" / "X days ago" string into
      // an approximate epoch so the admin UI shows real container uptime instead of
      // "time since last PM2 restart".
      entry.startedAt = parseDockerRunningFor(runningFor);
      this.attachLogStreamer(entry);
      this.registry.set(projectId, entry);
      console.log(`[DockerRunner] adopted container ${name} (project ${projectId.slice(0, 8)}, port ${entry.port})`);
      // Populate lastHealth immediately so the admin UI shows release/development
      // statuses without waiting for the first 10-second stats-poller tick.
      if (entry.port) {
        this.fetchWorkerHealth(entry.port)
          .then((h) => { entry.lastHealth = h; })
          .catch(() => { /* container may not be ready yet; poller will retry */ });
      }
    }
  }

  private summarize(e: RegistryEntry): WorkerSummary {
    const release: RuntimeStatus | null = e.lastHealth?.release ?? null;
    const development: RuntimeStatus | null = e.lastHealth?.development ?? null;
    return {
      projectId: e.projectId,
      port: e.port,
      pid: e.containerId ? parseInt(e.containerId.slice(0, 8), 16) || 0 : null,
      state: e.state,
      uptimeMs: e.startedAt ? Date.now() - e.startedAt : null,
      // For UI continuity we expose the container name where the legacy
      // RunnerManager exposed the Linux username.
      username: e.containerName,
      restartCount: e.restartCount,
      crashCount: e.crashCount,
      lastError: e.lastError,
      release,
      development,
      memRssBytes: e.memRssBytes ?? e.lastHealth?.mem?.rssBytes ?? null,
      cpuPercent: e.cpuPercent ?? e.lastHealth?.cpuPercent ?? null,
    };
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Convert Docker's `--format {{.RunningFor}}` string (e.g. "3 hours ago",
 * "2 days ago", "47 minutes ago", "About a minute ago") into a `Date.now()`-
 * compatible epoch so we can show real container uptime after a PM2 restart.
 * Falls back to `Date.now()` if the string can't be parsed.
 */
function parseDockerRunningFor(s: string): number {
  if (!s) return Date.now();
  const lower = s.toLowerCase();
  const num = (unit: string) => {
    const m = lower.match(new RegExp(`(\\d+)\\s+${unit}`));
    return m ? parseInt(m[1], 10) : null;
  };
  const seconds =
    (num("second") ?? (lower.includes("second") ? 1 : null)) ??
    ((lower.includes("minute") && !num("minute")) ? 60 : null) ??
    (num("minute") !== null ? (num("minute")! * 60) : null) ??
    (num("hour") !== null ? (num("hour")! * 3600) : null) ??
    (num("day") !== null ? (num("day")! * 86400) : null) ??
    (num("week") !== null ? (num("week")! * 604800) : null) ??
    (num("month") !== null ? (num("month")! * 2592000) : null);
  if (seconds === null) return Date.now();
  return Date.now() - seconds * 1_000;
}

/**
 * Parse "1.234MiB" / "512KiB" / "2.5GiB" / "1.2MB" / "1024B" → bytes.
 * Returns null on unrecognised input.
 */
function parseHumanBytes(s: string): number | null {
  const m = /^([0-9.]+)\s*([KMGTP]?i?B)$/i.exec(s.trim());
  if (!m) return null;
  const value = parseFloat(m[1]);
  if (isNaN(value)) return null;
  const unit = m[2].toUpperCase();
  const multipliers: Record<string, number> = {
    "B": 1,
    "KB": 1_000, "MB": 1_000_000, "GB": 1_000_000_000, "TB": 1e12, "PB": 1e15,
    "KIB": 1024, "MIB": 1024 ** 2, "GIB": 1024 ** 3, "TIB": 1024 ** 4, "PIB": 1024 ** 5,
  };
  const mult = multipliers[unit];
  if (mult == null) return null;
  return Math.round(value * mult);
}

export const dockerRunnerService = new DockerRunnerService();
