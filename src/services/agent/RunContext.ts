import path from "path";
import fs from "fs";
import type { AgentLogger } from "../agent-logger";
import type { AgentMode } from "./types";
import type { AgentProgress, AgentResult, AgentStepKind } from "../agent.service";
import type { EscalationConfig } from "../runtime-config.service";

export interface RunContextParams {
  projectId: string;
  projectDir: string;        // commit working directory (commits/N/)
  projectRootDir: string;    // PROJECTS_DIR/projectId
  commitDir: string;
  commitNum: number;
  mode: AgentMode;
  botToken: string;
  tierConfig: any;
  taskId: string;
  selectedWorkflow: string;
  logger: AgentLogger;
  onAskUser?: (question: string, options: string[]) => Promise<string>;
  rawProgress: (p: AgentProgress) => Promise<void>;
  /** Credit budget in USD for this run. Used by budget guardrail. */
  creditBudgetUsd?: number;
  /** Escalation thresholds loaded from runtimeConfig at run start. */
  escalationConfig?: EscalationConfig;
}

export class RunContext {
  // ── Static per-run config ────────────────────────────────────────────────
  readonly projectId: string;
  readonly projectDir: string;
  readonly projectRootDir: string;
  readonly commitDir: string;
  readonly commitNum: number;
  readonly mode: AgentMode;
  readonly botToken: string;
  readonly tierConfig: any;
  readonly taskId: string;
  readonly selectedWorkflow: string;
  readonly logger: AgentLogger;
  readonly onAskUser?: (question: string, options: string[]) => Promise<string>;
  private readonly _rawProgress: (p: AgentProgress) => Promise<void>;

  // ── Mutable agent state ──────────────────────────────────────────────────
  wroteFiles = false;
  deployed = false;
  finished = false;
  configuredApp = false;
  deployCount = 0;
  deployLocked = false;
  technicalPlan: any = null;
  technicalPlanSubmitted: boolean;
  testsRun = { telegram: false, api: false, ws: false };
  wsCoverage = { types: new Set<string>(), scenarios: new Set<string>() };
  loadedSkills = new Set<string>();
  validatorResults: Array<{ stage: string; ok: boolean; message?: string }> = [];
  testResults: Array<{ tool: string; ok: boolean; detail: string }> = [];
  lastWsFailureSignature = "";
  repeatedWsFailureCount = 0;
  summary = "";
  shortSummary = "";
  contextDiff = "";
  consecutiveNoWrite = 0;

  // ── Escalation tracking ──────────────────────────────────────────────────
  /** Total tool-call errors accumulated this session. */
  toolErrorCount = 0;
  /** Consecutive validation failures (reset on any passing validation). */
  consecutiveValidationFails = 0;
  /** Credit budget for this run (USD). 0 = unlimited. */
  readonly creditBudgetUsd: number;
  /** Escalation thresholds (copied from runtimeConfig at run start). */
  readonly escalationConfig: EscalationConfig | null;
  /** Log of every model switch: { iteration, fromModel, toModel, reason } */
  escalationHistory: Array<{ iteration: number; fromModel: string; toModel: string; reason: string }> = [];

  // ── Billing / cost ───────────────────────────────────────────────────────
  totalInputTokens = 0;
  totalOutputTokens = 0;
  totalCacheWriteTokens = 0;
  totalCacheReadTokens = 0;
  liveCostUsd = 0;
  /**
   * Authoritative USD cost reported by OpenRouter (sum of `usage.cost`
   * across iterations). Preferred over the token×price-table estimate when
   * non-zero. Filled when the request opts into usage accounting via
   * `extra_body.usage = { include: true }`.
   */
  totalCostUsd = 0;
  /** Sum of `usage.cost_details.upstream_inference_prompt_cost`. */
  totalCostUsdInput = 0;
  /** Sum of `usage.cost_details.upstream_inference_completions_cost`. */
  totalCostUsdOutput = 0;
  readonly startBalance: number;
  currentPercent: number | undefined;

  // ── Timing ───────────────────────────────────────────────────────────────
  readonly runStartMs = Date.now();
  stepCounter = 0;

  // ── Termination signal ───────────────────────────────────────────────────
  /** Set by FinishTool to stop the runner loop and return this result. */
  terminalResult: AgentResult | null = null;

  // ── Detailed log accumulator ─────────────────────────────────────────────
  detailedEntries: Array<{ iteration: number; timestamp: string; request: any; response: any }> = [];

  constructor(params: RunContextParams, userBalance?: number) {
    this.projectId = params.projectId;
    this.projectDir = params.projectDir;
    this.projectRootDir = params.projectRootDir;
    this.commitDir = params.commitDir;
    this.commitNum = params.commitNum;
    this.mode = params.mode;
    this.botToken = params.botToken;
    this.tierConfig = params.tierConfig;
    this.taskId = params.taskId;
    this.selectedWorkflow = params.selectedWorkflow;
    this.logger = params.logger;
    this.onAskUser = params.onAskUser;
    this._rawProgress = params.rawProgress;
    this.technicalPlanSubmitted = params.mode === "update";
    this.startBalance = userBalance ?? 0;
    this.creditBudgetUsd = params.creditBudgetUsd ?? 0;
    this.escalationConfig = params.escalationConfig ?? null;
  }

  // ── Event emitters ───────────────────────────────────────────────────────

  async progress(p: AgentProgress): Promise<void> {
    p.costUsd = this.liveCostUsd;
    p.balance = this.startBalance > 0 ? Math.max(0, this.startBalance - this.liveCostUsd) : undefined;
    return this._rawProgress(p);
  }

  newStepId(prefix: string): string {
    return `${prefix}-${Date.now().toString(36)}-${++this.stepCounter}`;
  }

  async emitStepStart(
    kind: AgentStepKind,
    title: string,
    toolName: string,
    target?: AgentProgress["target"],
  ): Promise<string> {
    const stepId = this.newStepId(toolName || kind);
    await this.progress({
      event: "step_start",
      stepId,
      kind,
      title,
      toolName,
      target,
      action: title,
      detail: target?.file || target?.url || target?.key || "",
      percent: this.currentPercent,
    });
    return stepId;
  }

  async emitStepEnd(stepId: string, status: "ok" | "error", meta?: Record<string, any>): Promise<void> {
    await this.progress({
      event: "step_end",
      stepId,
      status,
      meta,
      action: "",
      detail: "",
      percent: this.currentPercent,
    });
  }

  async emitNarrationStart(stepId: string): Promise<void> {
    await this.progress({ event: "narration_start", stepId, action: "", detail: "", percent: this.currentPercent });
  }

  async emitNarrationChunk(stepId: string, delta: string, text: string): Promise<void> {
    await this.progress({ event: "narration_chunk", stepId, delta, text, action: "", detail: "", percent: this.currentPercent });
  }

  async emitNarrationEnd(stepId: string): Promise<void> {
    await this.progress({ event: "narration_end", stepId, action: "", detail: "", percent: this.currentPercent });
  }

  async emitWritingChunk(stepId: string, toolName: string, argsDelta: string, argsFull: string): Promise<void> {
    await this.progress({
      event: "writing_chunk",
      stepId,
      toolName,
      delta: argsDelta,
      text: argsFull,
      action: "",
      detail: "",
      percent: this.currentPercent,
    });
  }

  // ── Terminal signal ───────────────────────────────────────────────────────

  /** Called by FinishTool to stop the runner loop. */
  terminate(result: AgentResult): void {
    this.terminalResult = result;
    this.finished = true;
  }

  // ── Detailed log ──────────────────────────────────────────────────────────

  writeDetailedLog(reason: string): void {
    try {
      const detailedLogPath = path.join(this.commitDir, "detailed-log.json");
      fs.writeFileSync(
        detailedLogPath,
        JSON.stringify({
          projectId: this.projectId,
          commitNum: this.commitNum,
          mode: this.mode,
          selectedWorkflow: this.selectedWorkflow,
          reason,
          loadedSkills: [...this.loadedSkills],
          technicalPlan: this.technicalPlan,
          state: {
            technicalPlanSubmitted: this.technicalPlanSubmitted,
            wroteFiles: this.wroteFiles,
            deployed: this.deployed,
            finished: this.finished,
            testsRun: this.testsRun,
          },
          validatorResults: this.validatorResults,
          testResults: this.testResults,
          entries: this.detailedEntries,
        }, null, 2),
        "utf-8",
      );
    } catch (err: any) {
      console.warn(`[Agent] failed to write detailed-log.json (${reason}): ${err.message}`);
    }
  }
}
