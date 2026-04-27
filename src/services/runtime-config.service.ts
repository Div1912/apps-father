import fs from "fs";
import path from "path";

const CONFIG_PATH = path.join(process.cwd(), "data", "runtime-config.json");

export interface ModelActionConfig {
  modelId: string;
  provider?: string;
  maxTokens: number;
  maxIterations?: number;   // Code Gen / agent loop only
  thinkingBudget?: number;  // Claude extended thinking (extra_body) — Claude models only
  reasoningBudget?: number; // OpenRouter reasoning.max_tokens — for reasoning models (Kimi, DeepSeek-R1, etc.)
}

export interface ModelConfigs {
  plan:        ModelActionConfig;
  codegen:     ModelActionConfig;
  ask:         ModelActionConfig;
  suggestions: ModelActionConfig;
  passport:    ModelActionConfig;
}

export interface TierPricing {
  create:      number;
  update:      number;
  plan:        number;
  ask:         number;
  suggestions: number;
  passport:    number;
}

export interface TierStats {
  speed:   number; // 0–10
  quality: number; // 0–10
  price:   number; // 0–10 (higher = more expensive)
}

export interface PerformanceTier {
  id:      string;   // "tier_0" | "tier_1" | "tier_2"
  name:    string;
  nameI18n?:        Record<string, string>; // { en, ru, uk }
  descriptionI18n?: Record<string, string>; // { en, ru, uk }
  stats:   TierStats;
  models:  ModelConfigs;
  pricing: TierPricing;
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
  referralBonusPercent: number; // % of credits granted given to regular referrer
  referralBonusUsd: number;     // legacy USD bonus (no longer used)
  partnerDefaultPercent: number;

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

  // OpenRouter
  openrouterApiKey: string;

  // Performance tiers (array index = tier number)
  performanceTiers: PerformanceTier[];
}

// ── Tier model configs ───────────────────────────────────────────────────────

const TIER_0_MODELS: ModelConfigs = {
  plan:        { modelId: "anthropic/claude-haiku-4-5", provider: "", maxTokens: 1500 },
  codegen:     { modelId: "anthropic/claude-haiku-4-5", provider: "", maxTokens: 16000, maxIterations: 60, thinkingBudget: 0 },
  ask:         { modelId: "anthropic/claude-haiku-4-5", provider: "", maxTokens: 1500 },
  suggestions: { modelId: "anthropic/claude-haiku-4-5", provider: "", maxTokens: 1000 },
  passport:    { modelId: "anthropic/claude-haiku-4-5", provider: "", maxTokens: 8000 },
};

const TIER_1_MODELS: ModelConfigs = {
  plan:        { modelId: "anthropic/claude-sonnet-4-5", provider: "", maxTokens: 2048 },
  codegen:     { modelId: "anthropic/claude-sonnet-4-5", provider: "", maxTokens: 20000, maxIterations: 80, thinkingBudget: 4000 },
  ask:         { modelId: "anthropic/claude-sonnet-4-5", provider: "", maxTokens: 2048 },
  suggestions: { modelId: "anthropic/claude-sonnet-4-5", provider: "", maxTokens: 1500 },
  passport:    { modelId: "anthropic/claude-haiku-4-5",  provider: "", maxTokens: 16000 },
};

const TIER_2_MODELS: ModelConfigs = {
  plan:        { modelId: "anthropic/claude-opus-4-5", provider: "", maxTokens: 4096 },
  codegen:     { modelId: "anthropic/claude-opus-4-5", provider: "", maxTokens: 32000, maxIterations: 100, thinkingBudget: 8000 },
  ask:         { modelId: "anthropic/claude-sonnet-4-5", provider: "", maxTokens: 4096 },
  suggestions: { modelId: "anthropic/claude-sonnet-4-5", provider: "", maxTokens: 2000 },
  passport:    { modelId: "anthropic/claude-haiku-4-5",  provider: "", maxTokens: 16000 },
};

// ── Default performance tiers ────────────────────────────────────────────────

const DEFAULT_PERFORMANCE_TIERS: PerformanceTier[] = [
  {
    id:   "tier_0",
    name: "Tier 0",
    stats: { speed: 9, quality: 3, price: 1 },
    models: TIER_0_MODELS,
    pricing: { create: 200, update: 75, plan: 30, ask: 15, suggestions: 25, passport: 10 },
  },
  {
    id:   "tier_1",
    name: "Tier 1",
    stats: { speed: 6, quality: 6, price: 4 },
    models: TIER_1_MODELS,
    pricing: { create: 300, update: 100, plan: 50, ask: 20, suggestions: 35, passport: 15 },
  },
  {
    id:   "tier_2",
    name: "Tier 2",
    stats: { speed: 3, quality: 9, price: 8 },
    models: TIER_2_MODELS,
    pricing: { create: 500, update: 200, plan: 80, ask: 40, suggestions: 60, passport: 20 },
  },
];

const DEFAULTS: RuntimeConfig = {
  creditsPerDollar: 50,
  slotPriceCredits: 30,

  minTopup: 2,
  maxAgentIterations: 60,

  firstTopupBonusPercent: 100,
  referralBonusPercent: 15,
  referralBonusUsd: 0,
  partnerDefaultPercent: 10,

  aiAvatarPriceUsd: 10,
  bundlePriceUsd: 50,

  defaultLanguage: "en",
  splashSecondsBeforeContinue: 3,

  agentTimeoutMs: 600_000,

  disableNewSignups: false,
  disableNewProjects: false,
  allowAdminShell: false,
  serviceMode: false,

  filesBrowserBaseUrl: process.env.NODE_ENV === "development" || process.env.DOMAIN === "dev.apps-father.com"
    ? "http://62.238.2.16:9090/files"
    : "http://204.168.219.20:9090/files",
  filesBrowserProjectsRoot: process.env.NODE_ENV === "development" || process.env.DOMAIN === "dev.apps-father.com"
    ? "/opt/apps-father-dev/projects"
    : "/opt/apps-father/projects",

  openrouterApiKey: "",

  performanceTiers: DEFAULT_PERFORMANCE_TIERS,
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

        // Merge performance tiers carefully
        const tiers = this.mergePerformanceTiers(raw?.performanceTiers);

        this.config = {
          ...DEFAULTS,
          ...raw,
          performanceTiers: tiers,
        };
      }
    } catch {
      this.config = { ...DEFAULTS };
    }
  }

  private mergePerformanceTiers(raw: any): PerformanceTier[] {
    if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_PERFORMANCE_TIERS;
    return DEFAULT_PERFORMANCE_TIERS.map((def, i) => {
      const saved = raw[i];
      if (!saved || typeof saved !== "object") return def;
      return {
        ...def,
        ...saved,
        stats:   { ...def.stats,   ...(saved.stats   || {}) },
        pricing: { ...def.pricing, ...(saved.pricing || {}) },
        models:  this.mergeModelConfigs(def.models, saved.models),
      };
    });
  }

  private mergeModelConfigs(defaults: ModelConfigs, raw: any): ModelConfigs {
    if (!raw) return { ...defaults };
    const result = { ...defaults };
    for (const key of Object.keys(defaults) as (keyof ModelConfigs)[]) {
      if (raw[key] && typeof raw[key] === "object") {
        result[key] = { ...defaults[key], ...raw[key] };
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
    if (partial.performanceTiers) {
      merged.performanceTiers = this.mergePerformanceTiers(partial.performanceTiers);
    }
    this.config = merged;
    this.save();
  }

  getMinTopup(): number { return this.config.minTopup; }
  getMaxAgentIterations(): number { return this.config.maxAgentIterations; }
  getOpenRouterApiKey(): string { return this.config.openrouterApiKey || ""; }
  isServiceMode(): boolean { return !!this.config.serviceMode; }
  getCreditsPerDollar(): number { return this.config.creditsPerDollar || 50; }

  getPerformanceTier(tierId: string): PerformanceTier {
    const tier = this.config.performanceTiers.find(t => t.id === tierId);
    return tier || this.config.performanceTiers[1] || DEFAULT_PERFORMANCE_TIERS[1];
  }

  getModelConfig(action: keyof ModelConfigs, tierId?: string): ModelActionConfig {
    const tier = this.getPerformanceTier(tierId || "tier_1");
    return tier.models[action];
  }

  getAllTiers(): PerformanceTier[] {
    return this.config.performanceTiers;
  }
}

export const runtimeConfig = new RuntimeConfigService();
