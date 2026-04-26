import fs from "fs";
import path from "path";

const CONFIG_PATH = path.join(process.cwd(), "data", "runtime-config.json");

export interface ModelActionConfig {
  modelId: string;
  provider?: string;
  maxTokens: number;
  markupMultiplier: number;
  maxIterations?: number;   // Code Gen / agent loop only
  thinkingBudget?: number;  // Code Gen / agent loop only
}

export interface ModelConfigs {
  plan:        ModelActionConfig;
  codegen:     ModelActionConfig;
  ask:         ModelActionConfig;
  suggestions: ModelActionConfig;
  passport:    ModelActionConfig;
}

export interface RuntimeConfig {
  // Pricing core
  minTopup: number;
  markupMultiplier: number;
  askMultiplier: number;
  maxAgentIterations: number;

  // Bonuses & referrals
  // First-deposit bonus is now percentage-based: bonusUsd = amountUsd * (percent/100).
  // Example: 100 → user deposits $5 and gets +$5 credited. Set to 0 to disable.
  firstTopupBonusPercent: number;
  referralBonusUsd: number;
  partnerDefaultPercent: number;

  // Feature pricing
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

  // External file browser (used by the Admin CRM "Files" sub-tab to embed a
  // remote file explorer for the project directory). Leave empty to fall back
  // to the built-in tree viewer.
  // Example: "http://204.168.219.20:9090/files"
  filesBrowserBaseUrl: string;
  // Server-side absolute path that the file browser exposes. The admin will
  // visit `${filesBrowserBaseUrl}${filesBrowserProjectsRoot}/<projectId>/commits/`.
  // Example: "/opt/apps-father/projects" or "/opt/apps-father-dev/projects".
  filesBrowserProjectsRoot: string;

  // OpenRouter
  openrouterApiKey: string;
  modelConfigs: ModelConfigs;
}

const DEFAULT_MODEL_CONFIGS: ModelConfigs = {
  plan: {
    modelId: "anthropic/claude-sonnet-4-5",
    provider: "",
    maxTokens: 2048,
    markupMultiplier: 5,
  },
  codegen: {
    modelId: "anthropic/claude-sonnet-4-5",
    provider: "",
    maxTokens: 20000,
    thinkingBudget: 4000,
    maxIterations: 80,
    markupMultiplier: 5,
  },
  ask: {
    modelId: "anthropic/claude-sonnet-4-5",
    provider: "",
    maxTokens: 2048,
    markupMultiplier: 10,
  },
  suggestions: {
    modelId: "anthropic/claude-sonnet-4-5",
    provider: "",
    maxTokens: 1500,
    markupMultiplier: 5,
  },
  passport: {
    modelId: "anthropic/claude-haiku-4-5",
    provider: "",
    maxTokens: 16000,
    markupMultiplier: 5,
  },
};

const DEFAULTS: RuntimeConfig = {
  minTopup: 2,
  markupMultiplier: 5,
  askMultiplier: 10,
  maxAgentIterations: 60,

  firstTopupBonusPercent: 100,
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

  // Defaults assume a Filebrowser instance per environment, exposing the
  // ProcessRuntime project folder. Admins can override these from the
  // Configuration page if their setup differs.
  filesBrowserBaseUrl: process.env.NODE_ENV === "development" || process.env.DOMAIN === "dev.apps-father.com"
    ? "http://62.238.2.16:9090/files"
    : "http://204.168.219.20:9090/files",
  filesBrowserProjectsRoot: process.env.NODE_ENV === "development" || process.env.DOMAIN === "dev.apps-father.com"
    ? "/opt/apps-father-dev/projects"
    : "/opt/apps-father/projects",

  openrouterApiKey: "",
  modelConfigs: DEFAULT_MODEL_CONFIGS,
};

class RuntimeConfigService {
  private config: RuntimeConfig = { ...DEFAULTS };

  constructor() {
    this.load();
  }

  private load() {
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
        // Migrate legacy `firstTopupBonusUsd` (fixed-amount bonus) to the new
        // percentage-based `firstTopupBonusPercent`. If the admin had it
        // configured to anything > 0 we keep the bonus enabled (default 100%);
        // otherwise we leave it disabled.
        if (raw && raw.firstTopupBonusUsd !== undefined && raw.firstTopupBonusPercent === undefined) {
          raw.firstTopupBonusPercent = Number(raw.firstTopupBonusUsd) > 0 ? 100 : 0;
          delete raw.firstTopupBonusUsd;
        }
        this.config = {
          ...DEFAULTS,
          ...raw,
          modelConfigs: this.mergeModelConfigs(raw?.modelConfigs),
        };
      }
    } catch {
      this.config = { ...DEFAULTS };
    }
  }

  private mergeModelConfigs(raw: any): ModelConfigs {
    if (!raw) return { ...DEFAULT_MODEL_CONFIGS };
    const result = { ...DEFAULT_MODEL_CONFIGS };
    for (const key of Object.keys(DEFAULT_MODEL_CONFIGS) as (keyof ModelConfigs)[]) {
      if (raw[key] && typeof raw[key] === "object") {
        result[key] = { ...DEFAULT_MODEL_CONFIGS[key], ...raw[key] };
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
    if (partial.modelConfigs) {
      merged.modelConfigs = this.mergeModelConfigs({
        ...this.config.modelConfigs,
        ...partial.modelConfigs,
      });
    }
    this.config = merged;
    this.save();
  }

  getMarkupMultiplier(): number { return this.config.markupMultiplier; }
  getAskMultiplier(): number { return this.config.askMultiplier; }
  getMinTopup(): number { return this.config.minTopup; }
  getMaxAgentIterations(): number { return this.config.maxAgentIterations; }
  getModelConfig(action: keyof ModelConfigs): ModelActionConfig {
    return this.config.modelConfigs[action] || DEFAULT_MODEL_CONFIGS[action];
  }
  getOpenRouterApiKey(): string {
    return this.config.openrouterApiKey || "";
  }
  isServiceMode(): boolean {
    return !!this.config.serviceMode;
  }
}

export const runtimeConfig = new RuntimeConfigService();
