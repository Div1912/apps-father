import fs from "fs";
import path from "path";

const PROJECTS_DIR = path.join(process.cwd(), "projects");

export class AgentLogger {
  private logPath: string;
  private stream: fs.WriteStream;
  private startTime: number;

  constructor(projectId: string) {
    const logsDir = path.join(PROJECTS_DIR, projectId, "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.logPath = path.join(logsDir, `agent-${timestamp}.log`);
    this.stream = fs.createWriteStream(this.logPath, { flags: "a" });
    this.startTime = Date.now();
  }

  private elapsed(): string {
    const ms = Date.now() - this.startTime;
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `[${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}]`;
  }

  private write(line: string) {
    this.stream.write(`${this.elapsed()} ${line}\n`);
  }

  header(model: string, prompt: string) {
    this.write(`${"=".repeat(80)}`);
    this.write(`AGENT SESSION — ${new Date().toISOString()}`);
    this.write(`Model: ${model}`);
    this.write(`${"=".repeat(80)}`);
    this.write("");
    this.write(`USER PROMPT:`);
    this.write(prompt);
    this.write("");
    this.write(`${"─".repeat(80)}`);
    this.write("");
  }

  iteration(num: number, model: string) {
    this.write(`── Iteration ${num} ── (${model})`);
  }

  thinking(text: string) {
    if (!text.trim()) return;
    this.write(`🧠 THINKING:`);
    this.write(text.substring(0, 2000));
    if (text.length > 2000) this.write(`... (${text.length} chars total)`);
    this.write("");
  }

  claudeMessage(text: string) {
    if (!text.trim()) return;
    this.write(`💬 CLAUDE:`);
    this.write(text);
    this.write("");
  }

  toolCall(name: string, args: any) {
    const argsStr = JSON.stringify(args, null, 2);
    const truncated = argsStr.length > 3000 ? argsStr.substring(0, 3000) + `\n... (${argsStr.length} chars)` : argsStr;
    this.write(`🔧 TOOL CALL: ${name}`);
    this.write(`   Args: ${truncated}`);
  }

  toolResult(name: string, result: string) {
    const truncated = result.length > 5000 ? result.substring(0, 5000) + `\n... (${result.length} chars)` : result;
    this.write(`   ← ${name} result:`);
    this.write(truncated);
    this.write("");
  }

  tokens(input: number, output: number, cacheRead: number, cacheWrite: number) {
    this.write(`📊 Tokens: in=${input} out=${output} cache_read=${cacheRead} cache_write=${cacheWrite}`);
  }

  done(summary: string, iterations: number, totalInput: number, totalOutput: number) {
    this.write("");
    this.write(`${"=".repeat(80)}`);
    this.write(`✅ DONE after ${iterations} iterations`);
    this.write(`Total tokens: in=${totalInput} out=${totalOutput}`);
    this.write(`Summary: ${summary}`);
    this.write(`Duration: ${Math.round((Date.now() - this.startTime) / 1000)}s`);
    this.write(`${"=".repeat(80)}`);
  }

  error(message: string) {
    this.write(`❌ ERROR: ${message}`);
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
