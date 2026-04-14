import fs from "fs";
import path from "path";

const PROJECTS_DIR = path.join(process.cwd(), "projects");

export interface LogEntry {
  ts: string;
  elapsed: number;
  type: "header" | "iteration" | "thinking" | "text" | "tool_call" | "tool_result" | "tokens" | "done" | "error";
  [key: string]: any;
}

export class AgentLogger {
  private logPath: string;
  private stream: fs.WriteStream;
  private startTime: number;
  private currentIteration: number = 0;

  constructor(projectId: string) {
    const logsDir = path.join(PROJECTS_DIR, projectId, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.logPath = path.join(logsDir, `agent-${timestamp}.log`);
    this.stream = fs.createWriteStream(this.logPath, { flags: "a" });
    this.startTime = Date.now();
  }

  private elapsed(): number {
    return Date.now() - this.startTime;
  }

  private write(entry: Omit<LogEntry, "ts" | "elapsed">) {
    const full = {
      ts: new Date().toISOString(),
      elapsed: this.elapsed(),
      ...entry,
    } as LogEntry;
    this.stream.write(JSON.stringify(full) + "\n");
  }

  header(model: string, prompt: string) {
    this.write({
      type: "header",
      model,
      prompt,
      startedAt: new Date().toISOString(),
    });
  }

  iteration(num: number, model: string) {
    this.currentIteration = num;
    this.write({ type: "iteration", iteration: num, model });
  }

  thinking(text: string) {
    if (!text.trim()) return;
    this.write({ type: "thinking", iteration: this.currentIteration, text });
  }

  claudeMessage(text: string) {
    if (!text.trim()) return;
    this.write({ type: "text", iteration: this.currentIteration, text });
  }

  toolCall(name: string, args: any) {
    this.write({
      type: "tool_call",
      iteration: this.currentIteration,
      tool: name,
      args,
    });
  }

  toolResult(name: string, result: string) {
    this.write({
      type: "tool_result",
      iteration: this.currentIteration,
      tool: name,
      result,
      resultLength: result.length,
    });
  }

  tokens(
    totalInput: number, totalOutput: number, totalCacheRead: number, totalCacheWrite: number,
    iterInput?: number, iterOutput?: number, iterCacheRead?: number, iterCacheWrite?: number,
    costUsd?: number,
  ) {
    this.write({
      type: "tokens",
      iteration: this.currentIteration,
      total: { input: totalInput, output: totalOutput, cacheRead: totalCacheRead, cacheWrite: totalCacheWrite },
      iter: iterInput != null ? { input: iterInput, output: iterOutput, cacheRead: iterCacheRead, cacheWrite: iterCacheWrite } : undefined,
      costUsd,
    });
  }

  done(summary: string, iterations: number, totalInput: number, totalOutput: number) {
    this.write({
      type: "done",
      iterations,
      totalInput,
      totalOutput,
      summary,
      durationMs: this.elapsed(),
    });
  }

  error(message: string) {
    this.write({ type: "error", iteration: this.currentIteration, message });
  }

  close() {
    try { this.stream.end(); } catch {}
  }

  getLogPath(): string {
    return this.logPath;
  }

  getRelativeLogPath(projectId: string): string {
    return path.relative(path.join(PROJECTS_DIR, projectId), this.logPath);
  }
}

/**
 * Parse a JSONL agent log file into an array of entries.
 * Handles both new JSONL format and old plain-text format (returns raw text as a single entry).
 */
export function parseAgentLog(logPath: string): LogEntry[] {
  const content = fs.readFileSync(logPath, "utf-8");
  const lines = content.split("\n").filter(l => l.trim());

  if (lines.length === 0) return [];

  // Detect format: if the first line is valid JSON, it's JSONL
  try {
    JSON.parse(lines[0]);
  } catch {
    // Old plain-text format — wrap in a single entry
    return [{
      ts: new Date().toISOString(),
      elapsed: 0,
      type: "text",
      text: content,
      legacy: true,
    }];
  }

  const entries: LogEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {}
  }
  return entries;
}
