import dotenv from "dotenv";
import crypto from "crypto";
dotenv.config();

// If AF_INTERNAL_SECRET is not in .env, generate one at startup.
// This ensures bucket internal auth works even on fresh dev servers.
const _internalSecret = process.env.AF_INTERNAL_SECRET || crypto.randomBytes(32).toString("hex");

// Worker-mode shared secret — minted once per main-process boot if not set.
// Workers verify this on every /__worker/* request via X-Runner-Secret header.
const _runnerSecret = process.env.RUNNER_SECRET || crypto.randomBytes(32).toString("hex");

// Detect runtime mode: "worker" splits user routes.js into per-project worker
// processes; "in-process" keeps the legacy bot-runner in main. PROD stays
// in-process until a separate cutover.
const _runtimeMode: "worker" | "in-process" =
  process.env.RUNTIME_MODE === "worker" ? "worker" : "in-process";

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
  /** "worker" = spawn a Node.js child per project; "in-process" = legacy bot-runner. */
  runtimeMode: _runtimeMode,
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
  runnerHeapMb: parseInt(process.env.RUNNER_HEAP_MB || "256", 10),
  /** 0 = unlimited concurrent workers. Future Phase 2 knob. */
  runnerMaxConcurrent: parseInt(process.env.RUNNER_MAX_CONCURRENT || "0", 10),
};
