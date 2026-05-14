import dotenv from "dotenv";
import crypto from "crypto";
dotenv.config();

// If AF_INTERNAL_SECRET is not in .env, generate one at startup.
// This ensures bucket internal auth works even on fresh dev servers.
const _internalSecret = process.env.AF_INTERNAL_SECRET || crypto.randomBytes(32).toString("hex");

// Worker-mode shared secret — minted once per main-process boot if not set.
// Workers verify this on every /__worker/* request via X-Runner-Secret header.
const _runnerSecret = process.env.RUNNER_SECRET || crypto.randomBytes(32).toString("hex");

// Detect runtime mode:
//   "in-process" → legacy bot-runner inside main (PROD baseline).
//   "worker"     → per-project Node.js child + Linux user isolation (Phase 1).
//   "docker"     → per-project Docker container (Phase 2; current).
// "docker" implies all "worker"-mode behaviour (proxy, lazy spawn, server
// control endpoints, ServerLogsTool, etc.) — the only difference is the
// supervisor implementation behind the IRunnerManager interface.
const _runtimeMode: "worker" | "docker" | "in-process" = (() => {
  const v = (process.env.RUNTIME_MODE || "").toLowerCase();
  if (v === "docker") return "docker";
  if (v === "worker") return "worker";
  return "in-process";
})();

// ── Production safety checks ─────────────────────────────────────────────────
if (process.env.NODE_ENV === "production") {
  if (!process.env.ADMIN_PASSWORD) {
    console.error("[config] FATAL: ADMIN_PASSWORD env var is required in production.");
    process.exit(1);
  }
  if (process.env.ADMIN_PASSWORD === "admin") {
    console.error("[config] FATAL: ADMIN_PASSWORD must not be the default value 'admin' in production.");
    process.exit(1);
  }
}

export const config = {
  botToken: process.env.APPS_FATHER_TOKEN!,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  openrouterApiKey: process.env.OPENROUTER_API_KEY || "",
  databaseUrl: process.env.DATABASE_URL!,
  domain: process.env.DOMAIN || "localhost",
  port: parseInt(process.env.PORT || "3000", 10),
  nodeEnv: process.env.NODE_ENV || "development",
  webhookSecret: process.env.WEBHOOK_SECRET || "default-secret",
  encryptionKey: process.env.ENCRYPTION_KEY!,
  nowpaymentsApiKey: process.env.NOWPAYMENTS_API_KEY || "",
  nowpaymentsIpnSecret: process.env.NOWPAYMENTS_IPN_SECRET || "",
  adminPassword: process.env.ADMIN_PASSWORD || "",
  cryptoBotToken: process.env.CRYPTO_BOT_TOKEN || "",
  walletMnemonic: process.env.WALLET_MNEMONIC || "",
  toncenterApiKey: process.env.TONCENTER_API_KEY || "",
  withdrawGroupId: process.env.WITHDRAW_GROUP_ID || "-1003984965330",
  openPanelClientId: process.env.OPENPANEL_CLIENT_ID || "",
  openPanelClientSecret: process.env.OPENPANEL_CLIENT_SECRET || "",
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY || "",
  apiPassKey: process.env.APIPASS_KEY || "",
  /** Comma-separated Telegram IDs of platform admins who bypass maintenance mode. */
  adminTelegramIds: new Set(
    (process.env.ADMIN_TELEGRAM_IDS || "")
      .split(",").map(s => s.trim()).filter(Boolean)
  ),

  get baseUrl(): string {
    if (this.nodeEnv === "development") {
      return `http://localhost:${this.port}`;
    }
    return `https://${this.domain}`;
  },

  get webhookUrl(): string {
    return `${this.baseUrl}/webhook`;
  },

  /** Shared secret used for server-side bucket uploads from routes.js */
  internalSecret: _internalSecret,

  // ── Runner runtime (per-project worker isolation) ─────────────────────
  /**
   * Runner backend:
   *   - "in-process" → legacy bot-runner in main (no per-project isolation)
   *   - "worker"     → child_process per project, dropped to a Linux user
   *   - "docker"     → Docker container per project
   * Use `isWorkerRuntime` (below) for any "is the runner-proxy / Server
   * Control / ServerLogsTool active?" check.
   */
  runtimeMode: _runtimeMode,
  /**
   * True for any runtime mode where worker isolation is active. Both
   * "worker" and "docker" expose the same runner-proxy + Server Control
   * surface; "in-process" disables them. Prefer this over comparing
   * `runtimeMode === "worker"` directly.
   */
  get isWorkerRuntime(): boolean {
    return _runtimeMode === "worker" || _runtimeMode === "docker";
  },
  /** Shared secret for worker /__worker/* internal endpoints (X-Runner-Secret). */
  runnerSecret: _runnerSecret,
  /** Filesystem root holding /srv/apps-father/projects/<id>/{release,development}. */
  runnerProjectsRoot: process.env.RUNNER_PROJECTS_ROOT || "/srv/apps-father/projects",
  /** Allocated 127.0.0.1 port range for worker listeners. */
  runnerPortMin: parseInt(process.env.RUNNER_PORT_MIN || "30000", 10),
  runnerPortMax: parseInt(process.env.RUNNER_PORT_MAX || "39999", 10),
  /** Spawn timeout — how long to wait for /__worker/health to return 200. */
  runnerSpawnTimeoutMs: parseInt(process.env.RUNNER_SPAWN_TIMEOUT_MS || "10000", 10),
  /** Polling interval for /__worker/health during spawn. */
  runnerHealthIntervalMs: parseInt(process.env.RUNNER_HEALTH_INTERVAL_MS || "200", 10),
  /** Default heap cap (MB) passed to worker via --max-old-space-size. */
  runnerHeapMb: parseInt(process.env.RUNNER_HEAP_MB || "512", 10),
  /** 0 = unlimited concurrent workers. Future Phase 2 knob. */
  runnerMaxConcurrent: parseInt(process.env.RUNNER_MAX_CONCURRENT || "0", 10),
};
