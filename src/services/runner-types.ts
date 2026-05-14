/**
 * Shared types and the IRunnerManager contract used by both implementations
 * of the per-project worker manager:
 *   - {@link runner-manager.service.ts}     (legacy: child_process + Linux user)
 *   - {@link docker-runner.service.ts}      (current: Docker container)
 *
 * The platform code (admin routes, runner-proxy, mini_app Server Control,
 * ServerLogsTool, ShellTool) consumes runners through this interface only,
 * so flipping `config.runtimeMode` between "worker" and "docker" requires
 * no call-site changes.
 */

export type RuntimeKind = "release" | "development";

export interface RuntimeStatus {
  loaded: boolean;
  error?: string | null;
}

export interface WorkerHealth {
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

export interface WorkerHandle {
  projectId: string;
  pid: number;
  port: number;
  /** Only set after the first /__worker/health check succeeds. */
  startedAt: number;
}

export interface LogLine {
  ts: number;
  stream: "stdout" | "stderr";
  text: string;
}

export type RegistryState =
  | "spawning"
  | "ready"
  | "stopping"
  | "stopped"
  | "circuit-broken";

export interface WorkerSummary {
  projectId: string;
  port: number;
  pid: number | null;
  state: RegistryState;
  uptimeMs: number | null;
  /** Linux username (legacy) or container name (Docker) — UI-friendly identifier. */
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

/**
 * Unified stream handle returned by DockerRunnerService.execStreaming().
 * Wraps node-pty's IPty so callers never import node-pty directly.
 *
 * With a real PTY:  stdout and stderr are merged into a single onData stream,
 *   `sh` runs interactively (echoes keystrokes, shows a prompt), and
 *   resize() propagates SIGWINCH into the container's tty.
 */
export interface IExecStream {
  /** All terminal output (stdout + stderr merged by PTY). */
  onData(cb: (chunk: Buffer) => void): void;
  /** Fired when the shell exits. */
  onExit(cb: (exitCode: number | null) => void): void;
  /** Write keystrokes / stdin to the shell. */
  write(data: Buffer | string): void;
  /** Resize the terminal window (triggers SIGWINCH inside the container). */
  resize(cols: number, rows: number): void;
  /** Terminate the shell process. */
  kill(signal?: string): void;
}

/**
 * The supervisor contract every runner backend must implement. Phase 2 of
 * worker isolation introduced two backends; the platform code never depends
 * on a specific one.
 */
export interface IRunnerManager {
  /** Mark the manager as live; spawn() is a no-op until enabled. */
  enable(): void;
  isEnabled(): boolean;

  /** Idempotent: returns the running worker handle, or spawns a new one. */
  ensureRunning(projectId: string): Promise<WorkerHandle>;
  /** True if a worker is currently running (spawning or ready). */
  isRunning(projectId: string): boolean;

  /** Stop one worker; safe to call concurrently. */
  stop(projectId: string): Promise<void>;
  /**
   * Detach from all workers/containers.
   * In Docker mode: leaves containers running (used by PM2 graceful restart).
   * In legacy mode: kills all child processes (same as killAll).
   */
  stopAll(): Promise<void>;
  /**
   * Stop and remove every worker/container completely.
   * Used by the admin "Stop all" button.
   * In legacy mode: same as stopAll().
   */
  killAll(): Promise<void>;

  /** Restart: stop + ensureRunning. Bumps restart counter. */
  restart(projectId: string): Promise<WorkerHandle>;
  /** Code-change reload — same effect as restart for the current implementations. */
  reload(projectId: string): Promise<WorkerHandle>;
  /** Reload only if the worker is currently in the registry (no-op otherwise). */
  reloadIfRunning(projectId: string): Promise<void>;

  /** Snapshot list of every entry currently tracked. */
  list(): WorkerSummary[];
  /** Snapshot for a specific project; null if not tracked. */
  getMetrics(projectId: string): WorkerSummary | null;
  /** Last N stdout/stderr lines from the in-memory ring buffer (default 200). */
  getLogs(projectId: string, n?: number): LogLine[];

  /** Get the worker port without forcing a spawn. */
  getPortIfRunning(projectId: string): number | null;
}
