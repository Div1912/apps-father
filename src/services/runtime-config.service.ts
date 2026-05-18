import fs from "fs";
import path from "path";

const CONFIG_PATH = path.join(process.cwd(), "data", "runtime-config.json");

// One-time credit fees that aren't part of a per-action session price.
export const GAME_KIND_FEE_CREDITS = 100;
export const PREVIEW_UNLOCK_FEE_CREDITS = 20;
export const LINK_BOT_FEE_CREDITS = 15;

// ── Agent Session types ───────────────────────────────────────────────────────

export type AgentSessionType =
  | "router"
  | "answer"
  | "build"
  | "update"
  | "update-plan"
  | "bug-fix"
  | "suggestions"
  | "context"
  // Pseudo-type. Not chosen by the router. When the user enables MAX MODE on
  // a paid proposal we swap the model/limits in this slot for whatever the
  // base session was (build/update/...). Pricing still flows from the base
  // type — see RuntimeConfig.maxModeMultiplier for the markup factor.
  | "max-mode";

export interface AgentSessionConfig {
  model: string;
  provider?: string;
  max_tokens: number;
  reasoning: boolean;
  thinking: number;    // extended-thinking budget in tokens (0 = disabled)
  iterations: number;
}

/**
 * Classifies the nature of the work the router chose.
 * Used (alongside complexity) to pick the cheapest model that can realistically
 * handle the task without escalation.
 *   trivial_edit  → pure text / style changes (1-liner diffs)
 *   config        → .env / config / manifest changes
 *   bug_fix       → diagnosing and patching a specific regression
 *   feature_add   → adding a bounded new feature to an existing codebase
 *   new_build     → creating a full app from scratch
 *   architecture  → cross-cutting structural changes, migrations, full redesigns
 */
export type AgentTaskType =
  | "trivial_edit"
  | "config"
  | "bug_fix"
  | "feature_add"
  | "new_build"
  | "architecture";

export const AGENT_TASK_TYPES: AgentTaskType[] = [
  "trivial_edit", "config", "bug_fix", "feature_add", "new_build", "architecture",
];

/**
 * Defines when/how the agent escalates to a more powerful model mid-run.
 * All fields are admin-tunable from runtime-config.json → agentEscalation.
 */
export interface EscalationConfig {
  /** Models in ascending cost order. Agent starts at index 0 and climbs. */
  modelLadder: string[];
  /** Escalate after this many consecutive iterations with no file writes. */
  noWriteThreshold: number;
  /** Escalate after this many tool errors (start-of-run resets). */
  toolErrorThreshold: number;
  /** Escalate after this many repeated validation failures. */
  validationFailThreshold: number;
  /** Check escalation every N iterations. */
  checkEveryNIterations: number;
  /** When liveCostUsd exceeds (creditBudgetUsd * this), downgrade model. */
  budgetWarnFraction: number;
  /** When liveCostUsd exceeds (creditBudgetUsd * this), abort gracefully. */
  budgetAbortFraction: number;
}

/**
 * Per-taskType starting model overrides.
 * Maps AgentTaskType → model string (OpenRouter model ID).
 * Falls back to the session-type default when a key is absent.
 */
export type TaskTypeModelMap = Partial<Record<AgentTaskType, string>>;

/**
 * Complexity bucket emitted by the router's `propose_action` tool.
 * The router classifies how big the requested change is; the bucket selects
 * the credit price for that session type.
 */
export type AgentComplexity = "trivial" | "small" | "medium" | "large" | "huge";

export const AGENT_COMPLEXITIES: AgentComplexity[] = ["trivial", "small", "medium", "large", "huge"];

/** Session types that need a complexity-priced credit cost. */
export type PricedSessionType = "build" | "update" | "update-plan" | "bug-fix";

/**
 * Complexity-indexed credit price matrix.
 *
 * Layout (rows × columns):
 *   build              | trivial small medium large huge
 *   update             | trivial small medium large huge
 *   update-plan        | trivial small medium large huge   (base credits)
 *   update-plan-per-item| trivial small medium large huge  (per checklist item)
 *   bug-fix            | trivial small medium large huge
 *
 * Final cost = matrix[type][complexity]
 *   except update-plan: matrix["update-plan"][c] + planLen × matrix["update-plan-per-item"][c]
 */
export interface AgentComplexityPricing {
  build: Record<AgentComplexity, number>;
  update: Record<AgentComplexity, number>;
  "update-plan": Record<AgentComplexity, number>;
  "update-plan-per-item": Record<AgentComplexity, number>;
  "bug-fix": Record<AgentComplexity, number>;
}

export interface RuntimeConfig {
  // Credits per USD (1 USD = creditsPerDollar credits)
  creditsPerDollar: number;

  // Pricing (in credits) for slot/feature purchases
  slotPriceCredits: number;

  // Pricing core (legacy, kept for internal cost tracking only)
  minTopup: number;
  maxAgentIterations: number;

  // Bonuses & referrals
  firstTopupBonusPercent: number;
  referralBonusPercent: number;
  referralBonusUsd: number;
  partnerDefaultPercent: number;

  // % of credits charged refunded as cashback when the user submits a
  // feedback rating (0–100). Default 50.
  cashbackPercent: number;

  // Master switch: set to false to hide the rating button and disable the
  // cashback endpoint globally.
  cashbackEnabled: boolean;

  // Feature pricing (USD, admin-side)
  aiAvatarPriceUsd: number;
  bundlePriceUsd: number;

  // Defaults & UX
  defaultLanguage: string;
  splashSecondsBeforeContinue: number;

  // Limits
  agentTimeoutMs: number;

  // Kill switches
  disableNewSignups: boolean;
  disableNewProjects: boolean;
  allowAdminShell: boolean;
  serviceMode: boolean;

  // External file browser
  filesBrowserBaseUrl: string;
  filesBrowserProjectsRoot: string;

  // OpenRouter — main key used by the user-facing agent
  openrouterApiKey: string;

  // OpenRouter — separate key used ONLY by the agent-feedback analysis pipeline.
  trainingOpenrouterApiKey: string;

  // Optional override for the model used by the analysis pipeline.
  trainingModel: string;

  // Optional OpenRouter provider routing for the training model.
  trainingProvider: string;

  // Agent session model + iteration configuration, keyed by session type.
  // Includes the special "max-mode" slot used when the user opts in to MAX MODE.
  // ── App Store ─────────────────────────────────────────────────────────────
  // All money values are in TON (whole units, will be converted to nanoTON
  // internally). Total token supply is in whole tokens (will be multiplied
  // by 10^9 for atomic units).
  appStore: {
    publishFeeTon: number;          // 0.5 TON — platform fee on top of LP
    tradingFeePercent: number;      // 1.0 = 1%
    creatorFeeShare: number;        // 0.40 = 40% to creator, rest to platform
    tokenTotalSupply: number;       // 1_000_000_000

    // V2: user-deployed jetton + on-chain liquidity pool. The publisher
    // signs the deploy + LP-init txs from their TonConnect wallet and is
    // the sole initial LP owner. They can later add/remove liquidity.
    initialLiquidityTon: number;    // default TON the publisher locks (e.g. 5 TON)
    initialLiquidityTokenShare: number; // default fraction of supply locked (0..1, e.g. 0.50)
    minInitialLiquidityTon: number; // floor enforced server-side (e.g. 1)
    minInitialLiquidityTokenShare: number; // floor (e.g. 0.10 = 10%)

    // Legacy (ignored for V2 tokens but kept so old config files still load).
    curveSupplyShare: number;
    initialVirtualTon: number;

    minScreenshots: number;
    maxScreenshots: number;
    enabled: boolean;
  };

  agentSessions: Record<AgentSessionType, AgentSessionConfig>;

  /**
   * Per-task-type starting model overrides, keyed by session type.
   * e.g. { build: { trivial_edit: "anthropic/claude-haiku-4-5" }, update: { ... } }
   * Falls back to agentSessions[type].model when a task type is not listed.
   */
  taskTypeModels: Partial<Record<AgentSessionType, TaskTypeModelMap>>;

  /** Mid-run escalation / budget-guardrail configuration. */
  agentEscalation: EscalationConfig;

  // Complexity-bucketed credit price matrix. Router picks `complexity`,
  // pricing engine looks it up here.
  agentPricing: AgentComplexityPricing;

  /**
   * Multiplier applied to the final credit price when the user enables MAX
   * MODE on a paid proposal. Authoritative on the server. Min 1 — anything
   * lower would let users pay less than the standard price by toggling.
   */
  maxModeMultiplier: number;
}

// ── Default session configurations ───────────────────────────────────────────

const DEFAULT_AGENT_SESSIONS: Record<AgentSessionType, AgentSessionConfig> = {
  router: {
    model: "anthropic/claude-haiku-4-5",
    max_tokens: 1500,
    reasoning: false,
    thinking: 0,
    iterations: 8,
  },
  answer: {
    model: "anthropic/claude-haiku-4-5",
    max_tokens: 2000,
    reasoning: false,
    thinking: 0,
    iterations: 4,
  },
  build: {
    model: "anthropic/claude-sonnet-4-5",
    max_tokens: 32000,
    reasoning: false,
    thinking: 4000,
    iterations: 60,
  },
  update: {
    model: "anthropic/claude-sonnet-4-5",
    max_tokens: 32000,
    reasoning: false,
    thinking: 4000,
    iterations: 60,
  },
  "update-plan": {
    model: "anthropic/claude-sonnet-4-5",
    max_tokens: 32000,
    reasoning: false,
    thinking: 4000,
    iterations: 80,
  },
  "bug-fix": {
    model: "anthropic/claude-sonnet-4-5",
    max_tokens: 16000,
    reasoning: false,
    thinking: 2000,
    iterations: 40,
  },
  suggestions: {
    model: "anthropic/claude-haiku-4-5",
    max_tokens: 1000,
    reasoning: false,
    thinking: 0,
    iterations: 1,
  },
  context: {
    model: "anthropic/claude-haiku-4-5",
    max_tokens: 8000,
    reasoning: false,
    thinking: 0,
    iterations: 1,
  },
  // MAX MODE — top-tier model used when the user opts in. Same shape as any
  // other session config so admins can tune model, provider, tokens,
  // thinking budget, reasoning, and the iteration cap independently of the
  // standard build/update slots.
  "max-mode": {
    model: "anthropic/claude-opus-4-5",
    max_tokens: 32000,
    reasoning: false,
    thinking: 8000,
    iterations: 100,
  },
};

/**
 * Default per-task-type starting model overrides.
 *
 * Strategy:
 *  - trivial_edit / config → always Haiku (cheap enough, capable enough)
 *  - bug_fix → Haiku for update; Sonnet for build (new app bugs are rare but complex)
 *  - feature_add / new_build / architecture → Sonnet (default; escalates to Opus if needed)
 *
 * Admins can override any cell via runtime-config.json → taskTypeModels.
 */
const DEFAULT_TASK_TYPE_MODELS: Partial<Record<AgentSessionType, TaskTypeModelMap>> = {
  update: {
    trivial_edit:  "anthropic/claude-haiku-4-5",
    config:        "anthropic/claude-haiku-4-5",
    bug_fix:       "anthropic/claude-haiku-4-5",
    feature_add:   "anthropic/claude-sonnet-4-5",
    new_build:     "anthropic/claude-sonnet-4-5",
    architecture:  "anthropic/claude-sonnet-4-5",
  },
  "bug-fix": {
    trivial_edit:  "anthropic/claude-haiku-4-5",
    config:        "anthropic/claude-haiku-4-5",
    bug_fix:       "anthropic/claude-haiku-4-5",
    feature_add:   "anthropic/claude-sonnet-4-5",
    new_build:     "anthropic/claude-sonnet-4-5",
    architecture:  "anthropic/claude-sonnet-4-5",
  },
  // build always goes Sonnet — new apps are complex by nature
  build: {
    trivial_edit:  "anthropic/claude-sonnet-4-5",
    config:        "anthropic/claude-sonnet-4-5",
    bug_fix:       "anthropic/claude-sonnet-4-5",
    feature_add:   "anthropic/claude-sonnet-4-5",
    new_build:     "anthropic/claude-sonnet-4-5",
    architecture:  "anthropic/claude-sonnet-4-5",
  },
};

/**
 * Default escalation config.
 * All values are admin-tunable from runtime-config.json → agentEscalation.
 */
const DEFAULT_ESCALATION: EscalationConfig = {
  // Haiku → Sonnet → Opus
  modelLadder: [
    "anthropic/claude-haiku-4-5",
    "anthropic/claude-sonnet-4-5",
    "anthropic/claude-opus-4-5",
  ],
  noWriteThreshold: 3,         // 3 consecutive no-write iters → escalate
  toolErrorThreshold: 6,       // 6 tool errors in session → escalate
  validationFailThreshold: 3,  // 3 consecutive validation failures → escalate
  checkEveryNIterations: 5,    // check every 5 iters
  budgetWarnFraction: 0.80,    // at 80% budget → downgrade if possible
  budgetAbortFraction: 1.00,   // at 100% budget → graceful abort
};

// Default credit prices. The medium column matches the previous flat rates so
// existing user expectations continue to hold while admins tune the rest.
const DEFAULT_AGENT_PRICING: AgentComplexityPricing = {
  build:                  { trivial: 60,  small: 80,  medium: 100, large: 150, huge: 220 },
  update:                 { trivial: 25,  small: 50,  medium: 85,  large: 130, huge: 200 },
  "update-plan":          { trivial: 30,  small: 50,  medium: 80,  large: 130, huge: 200 },
  "update-plan-per-item": { trivial: 10,  small: 20,  medium: 30,  large: 45,  huge: 65  },
  "bug-fix":              { trivial: 10,  small: 20,  medium: 30,  large: 50,  huge: 80  },
};

/**
 * Normalise a possibly-legacy `agentPricing` blob from disk into the new
 * matrix shape. Two formats may appear:
 *  1. New shape — Record<type, Record<complexity, number>>. Pass through.
 *  2. Old shape — { build: number, update: number, "update-plan-base": number,
 *                   "update-plan-per-item": number, "bug-fix": number }. Map
 *     the flat number into the `medium` column and fan it out using ratios so
 *     existing prices stay roughly stable until admins re-edit them.
 *
 * Anything missing falls back to DEFAULT_AGENT_PRICING.
 */
function normalizeAgentPricing(raw: any): AgentComplexityPricing {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_AGENT_PRICING };

  // Per-type ratio relative to medium for the legacy → matrix migration.
  const RATIO: Record<AgentComplexity, number> = {
    trivial: 0.4, small: 0.7, medium: 1.0, large: 1.5, huge: 2.2,
  };

  const fanOut = (mediumValue: number): Record<AgentComplexity, number> => ({
    trivial: Math.max(1, Math.round(mediumValue * RATIO.trivial)),
    small:   Math.max(1, Math.round(mediumValue * RATIO.small)),
    medium:  Math.max(1, Math.round(mediumValue)),
    large:   Math.max(1, Math.round(mediumValue * RATIO.large)),
    huge:    Math.max(1, Math.round(mediumValue * RATIO.huge)),
  });

  const ensureRow = (key: keyof AgentComplexityPricing, legacyKey?: string): Record<AgentComplexity, number> => {
    const cell = raw[key];
    if (cell && typeof cell === "object" && !Array.isArray(cell)) {
      // Already matrix shape — merge missing complexities from defaults.
      return { ...DEFAULT_AGENT_PRICING[key], ...cell };
    }
    if (typeof cell === "number" && Number.isFinite(cell)) {
      return fanOut(cell);
    }
    if (legacyKey && typeof raw[legacyKey] === "number" && Number.isFinite(raw[legacyKey])) {
      return fanOut(raw[legacyKey]);
    }
    return { ...DEFAULT_AGENT_PRICING[key] };
  };

  return {
    build:                  ensureRow("build"),
    update:                 ensureRow("update"),
    "update-plan":          ensureRow("update-plan", "update-plan-base"),
    "update-plan-per-item": ensureRow("update-plan-per-item"),
    "bug-fix":              ensureRow("bug-fix"),
  };
}

const DEFAULTS: RuntimeConfig = {
  creditsPerDollar: 50,
  slotPriceCredits: 30,

  minTopup: 2,
  maxAgentIterations: 60,

  firstTopupBonusPercent: 50,
  referralBonusPercent: 15,
  referralBonusUsd: 0,
  partnerDefaultPercent: 10,
  cashbackPercent: 50,
  cashbackEnabled: true,

  aiAvatarPriceUsd: 10,
  bundlePriceUsd: 50,

  defaultLanguage: "en",
  splashSecondsBeforeContinue: 3,

  agentTimeoutMs: 600_000,

  disableNewSignups: false,
  disableNewProjects: false,
  allowAdminShell: false,
  serviceMode: false,

  filesBrowserBaseUrl:
    process.env.NODE_ENV === "development" || process.env.DOMAIN === "dev.apps-father.com"
      ? "http://62.238.2.16:9090/files"
      : "http://204.168.219.20:9090/files",
  filesBrowserProjectsRoot:
    process.env.NODE_ENV === "development" || process.env.DOMAIN === "dev.apps-father.com"
      ? "/opt/apps-father-dev/projects"
      : "/opt/apps-father/projects",

  openrouterApiKey: "",
  trainingOpenrouterApiKey: "",
  trainingModel: "",
  trainingProvider: "",

  agentSessions: DEFAULT_AGENT_SESSIONS,
  agentPricing: DEFAULT_AGENT_PRICING,
  maxModeMultiplier: 3,
  taskTypeModels: DEFAULT_TASK_TYPE_MODELS,
  agentEscalation: DEFAULT_ESCALATION,

  appStore: {
    publishFeeTon: 0.5,
    tradingFeePercent: 1.0,
    creatorFeeShare: 0.40,
    // Default mirrors minter.ton.org — 1,000,000 tokens (precision 9).
    // Owners can change the supply via runtime config; the deploy + LP-init
    // flow always uses whatever is in `appStore.tokenTotalSupply`.
    tokenTotalSupply: 1_000_000,

    initialLiquidityTon: 5,            // 5 TON locked into the pool by publisher
    initialLiquidityTokenShare: 0.5,   // 50% of supply locked into the pool
    minInitialLiquidityTon: 1,
    minInitialLiquidityTokenShare: 0.1,

    curveSupplyShare: 0.80,
    initialVirtualTon: 30,

    minScreenshots: 4,
    maxScreenshots: 6,
    enabled: true,
  },
};

// ── Service class ────────────────────────────────────────────────────────────

class RuntimeConfigService {
  private config: RuntimeConfig = { ...DEFAULTS };

  constructor() {
    this.load();
  }

  private load() {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

        // Migrate legacy bonus field
        if (raw && raw.firstTopupBonusUsd !== undefined && raw.firstTopupBonusPercent === undefined) {
          raw.firstTopupBonusPercent = Number(raw.firstTopupBonusUsd) > 0 ? 50 : 0;
          delete raw.firstTopupBonusUsd;
        }

        const agentSessions = this.mergeSessionConfigs(raw?.agentSessions);
        const agentPricing = normalizeAgentPricing(raw?.agentPricing);
        const appStore = { ...DEFAULTS.appStore, ...(raw?.appStore || {}) };

        this.config = {
          ...DEFAULTS,
          ...raw,
          agentSessions,
          agentPricing,
          appStore,
        };
      }
    } catch {
      this.config = { ...DEFAULTS };
    }
  }

  private mergeSessionConfigs(raw: any): Record<AgentSessionType, AgentSessionConfig> {
    if (!raw || typeof raw !== "object") return { ...DEFAULT_AGENT_SESSIONS };
    const result = { ...DEFAULT_AGENT_SESSIONS };
    for (const key of Object.keys(DEFAULT_AGENT_SESSIONS) as AgentSessionType[]) {
      if (raw[key] && typeof raw[key] === "object") {
        result[key] = { ...DEFAULT_AGENT_SESSIONS[key], ...raw[key] };
      }
    }
    return result;
  }

  private save() {
    const dir = path.dirname(CONFIG_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.config, null, 2), "utf-8");
  }

  get(): RuntimeConfig {
    return { ...this.config };
  }

  update(partial: Partial<RuntimeConfig>) {
    const merged: RuntimeConfig = { ...this.config, ...partial };
    if (partial.agentSessions) {
      merged.agentSessions = this.mergeSessionConfigs(partial.agentSessions);
    }
    // Floor the multiplier at 1.0 — sub-1 values would let a user pay LESS
    // than standard price by enabling MAX MODE, which defeats the toggle.
    if (typeof partial.maxModeMultiplier === "number") {
      merged.maxModeMultiplier = Math.max(1, Number(partial.maxModeMultiplier) || 1);
    }
    if (partial.agentPricing) {
      // Normalise (handles legacy flat shape sneaking back in) then deep-merge
      // by row so partial admin edits don't wipe other complexities.
      const incoming = normalizeAgentPricing(partial.agentPricing);
      merged.agentPricing = {
        build:                  { ...this.config.agentPricing.build,                  ...incoming.build },
        update:                 { ...this.config.agentPricing.update,                 ...incoming.update },
        "update-plan":          { ...this.config.agentPricing["update-plan"],          ...incoming["update-plan"] },
        "update-plan-per-item": { ...this.config.agentPricing["update-plan-per-item"], ...incoming["update-plan-per-item"] },
        "bug-fix":              { ...this.config.agentPricing["bug-fix"],              ...incoming["bug-fix"] },
      };
    }
    this.config = merged;
    this.save();
  }

  getMinTopup(): number { return this.config.minTopup; }
  getMaxAgentIterations(): number { return this.config.maxAgentIterations; }
  getOpenRouterApiKey(): string { return this.config.openrouterApiKey || ""; }

  /** DEDICATED key for the agent-feedback analysis pipeline (no fallback). */
  getTrainingApiKey(): string { return this.config.trainingOpenrouterApiKey || ""; }
  getTrainingModel(): string { return this.config.trainingModel || "anthropic/claude-sonnet-4-5"; }
  getTrainingProvider(): string { return this.config.trainingProvider || ""; }
  isServiceMode(): boolean { return !!this.config.serviceMode; }
  getCreditsPerDollar(): number { return this.config.creditsPerDollar || 50; }

  /** Returns the full AgentSessionConfig for the given session type. */
  getSessionConfig(type: AgentSessionType): AgentSessionConfig {
    return this.config.agentSessions[type] ?? DEFAULT_AGENT_SESSIONS[type];
  }

  /**
   * Returns the credit cost for starting a session of this type and
   * complexity bucket. `complexity` defaults to "medium" if missing or
   * invalid, so callers in legacy code paths still get a price.
   *
   * For "update-plan" pass `planLength` to add the variable per-item cost.
   * Returns 0 for router / answer / suggestions / context.
   */
  getSessionCost(
    type: AgentSessionType,
    complexity?: AgentComplexity,
    planLength?: number,
  ): number {
    const p = this.config.agentPricing;
    const c: AgentComplexity =
      complexity && AGENT_COMPLEXITIES.includes(complexity) ? complexity : "medium";

    switch (type) {
      case "router":
      case "answer":
      case "suggestions":
      case "context":
      case "max-mode":
        return 0;
      case "build":
        return Math.max(0, p.build[c] | 0);
      case "update":
        return Math.max(0, p.update[c] | 0);
      case "bug-fix":
        return Math.max(0, p["bug-fix"][c] | 0);
      case "update-plan": {
        const base = Math.max(0, p["update-plan"][c] | 0);
        const perItem = Math.max(0, p["update-plan-per-item"][c] | 0);
        const items = Math.max(0, Math.min(50, planLength ?? 0)); // hard cap to prevent runaway prices
        return base + items * perItem;
      }
      default:
        return 0;
    }
  }

  /** Returns the full complexity matrix (read-only copy). */
  getAgentPricing(): AgentComplexityPricing {
    return JSON.parse(JSON.stringify(this.config.agentPricing));
  }

  getAllSessionConfigs(): Record<AgentSessionType, AgentSessionConfig> {
    return { ...this.config.agentSessions };
  }

  /** Multiplier applied to the credit cost when MAX MODE is enabled. >= 1. */
  getMaxModeMultiplier(): number {
    const m = Number(this.config.maxModeMultiplier);
    return Number.isFinite(m) && m >= 1 ? m : 3;
  }

  /**
   * Resolve the effective session config for an agent run.
   *  - When `maxMode` is true we bypass the per-type config entirely and use
   *    the dedicated `max-mode` slot — admins set its model/tokens/iterations
   *    independent of the base type.
   *  - Without max mode this is identical to `getSessionConfig(type)`.
   */
  getEffectiveSessionConfig(type: AgentSessionType, maxMode: boolean): AgentSessionConfig {
    if (maxMode) return this.getSessionConfig("max-mode");
    return this.getSessionConfig(type);
  }

  /**
   * Resolve the starting model for a session, considering task type.
   * Returns the cheapest model that can realistically handle `taskType`.
   * Falls back to the session-type default when:
   *   - maxMode is on (always use max-mode model)
   *   - taskType is absent
   *   - no override row exists for this session/task combination
   */
  resolveStartingModel(
    type: AgentSessionType,
    maxMode: boolean,
    taskType?: AgentTaskType | null,
  ): string {
    if (maxMode) return this.getSessionConfig("max-mode").model;
    const sessionDefault = this.getSessionConfig(type).model;
    if (!taskType) return sessionDefault;
    const overrideMap = this.config.taskTypeModels?.[type];
    return overrideMap?.[taskType] ?? sessionDefault;
  }

  /** Returns the escalation config (thresholds, model ladder). */
  getEscalationConfig(): EscalationConfig {
    return { ...DEFAULT_ESCALATION, ...(this.config.agentEscalation || {}) };
  }

  /** Returns the per-session-type task-type model overrides map. */
  getTaskTypeModels(): Partial<Record<AgentSessionType, TaskTypeModelMap>> {
    return { ...this.config.taskTypeModels };
  }
}

export const runtimeConfig = new RuntimeConfigService();
