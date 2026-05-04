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
  | "context";

export interface AgentSessionConfig {
  model: string;
  provider?: string;
  max_tokens: number;
  reasoning: boolean;
  thinking: number;    // extended-thinking budget in tokens (0 = disabled)
  iterations: number;
}

export interface AgentSessionPricing {
  build: number;
  update: number;
  "update-plan-base": number;
  "update-plan-per-item": number;
  "bug-fix": number;
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

  // Agent session model + iteration configuration, keyed by session type
  agentSessions: Record<AgentSessionType, AgentSessionConfig>;

  // Flat credit costs per session type (0-cost types are not listed)
  agentPricing: AgentSessionPricing;
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
    max_tokens: 16000,
    reasoning: false,
    thinking: 4000,
    iterations: 60,
  },
  update: {
    model: "anthropic/claude-sonnet-4-5",
    max_tokens: 16000,
    reasoning: false,
    thinking: 4000,
    iterations: 60,
  },
  "update-plan": {
    model: "anthropic/claude-sonnet-4-5",
    max_tokens: 16000,
    reasoning: false,
    thinking: 4000,
    iterations: 80,
  },
  "bug-fix": {
    model: "anthropic/claude-sonnet-4-5",
    max_tokens: 12000,
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
};

const DEFAULT_AGENT_PRICING: AgentSessionPricing = {
  build: 100,
  update: 85,
  "update-plan-base": 50,
  "update-plan-per-item": 25,
  "bug-fix": 30,
};

const DEFAULTS: RuntimeConfig = {
  creditsPerDollar: 50,
  slotPriceCredits: 30,

  minTopup: 2,
  maxAgentIterations: 60,

  firstTopupBonusPercent: 100,
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
          raw.firstTopupBonusPercent = Number(raw.firstTopupBonusUsd) > 0 ? 100 : 0;
          delete raw.firstTopupBonusUsd;
        }

        const agentSessions = this.mergeSessionConfigs(raw?.agentSessions);
        const agentPricing: AgentSessionPricing = {
          ...DEFAULT_AGENT_PRICING,
          ...(raw?.agentPricing || {}),
        };

        this.config = {
          ...DEFAULTS,
          ...raw,
          agentSessions,
          agentPricing,
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
    if (partial.agentPricing) {
      merged.agentPricing = { ...this.config.agentPricing, ...partial.agentPricing };
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
   * Returns the credit cost for starting a session of this type.
   * For "update-plan" pass planLength to compute the variable component.
   * Returns 0 for router / answer / suggestions / context.
   */
  getSessionCost(type: AgentSessionType, planLength?: number): number {
    const p = this.config.agentPricing;
    switch (type) {
      case "router":
      case "answer":
      case "suggestions":
      case "context":
        return 0;
      case "build":
        return p.build;
      case "update":
        return p.update;
      case "bug-fix":
        return p["bug-fix"];
      case "update-plan":
        return p["update-plan-base"] + (planLength ?? 0) * p["update-plan-per-item"];
      default:
        return 0;
    }
  }

  getAllSessionConfigs(): Record<AgentSessionType, AgentSessionConfig> {
    return { ...this.config.agentSessions };
  }
}

export const runtimeConfig = new RuntimeConfigService();
