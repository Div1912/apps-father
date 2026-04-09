import fs from "fs";
import path from "path";

const CONFIG_PATH = path.join(process.cwd(), "data", "runtime-config.json");

export interface RuntimeConfig {
  minTopup: number;
  markupMultiplier: number;
  maxAgentIterations: number;
}

const DEFAULTS: RuntimeConfig = {
  minTopup: 10,
  markupMultiplier: 5,
  maxAgentIterations: 60,
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
        this.config = { ...DEFAULTS, ...raw };
      }
    } catch {
      this.config = { ...DEFAULTS };
    }
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
    this.config = { ...this.config, ...partial };
    this.save();
  }

  getMarkupMultiplier(): number { return this.config.markupMultiplier; }
  getMinTopup(): number { return this.config.minTopup; }
  getMaxAgentIterations(): number { return this.config.maxAgentIterations; }
}

export const runtimeConfig = new RuntimeConfigService();
