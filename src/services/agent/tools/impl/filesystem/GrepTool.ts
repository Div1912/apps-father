import type OpenAI from "openai";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import type { AgentTool } from "../../../AgentTool";
import type { RunContext } from "../../../RunContext";

const execAsync = promisify(exec);

export class GrepTool implements AgentTool {
  renderDefinition(): OpenAI.Chat.Completions.ChatCompletionTool {
    return {
      type: "function",
      function: {
        name: "grep",
        description: "Search for a pattern in project files. Returns matching lines with file:line format. Supports regex.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Search pattern (regex supported)" },
            path: { type: "string", description: "Relative path to search in (default: entire project)" },
            include: { type: "string", description: "Glob pattern for file names to include (e.g. '*.js')" },
          },
          required: ["pattern"],
        },
      },
    };
  }

  async execute(args: Record<string, any>, ctx: RunContext): Promise<string> {
    await ctx.progress({ action: "🔍 Searching", detail: args.pattern, percent: ctx.currentPercent });

    const resolvedPath = args.path ? this._safePath(ctx.projectDir, args.path) : null;
    if (args.path && !resolvedPath) return "Error: Invalid path";

    let cwd = ctx.projectDir;
    let target = ".";
    if (resolvedPath) {
      if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
        cwd = path.dirname(resolvedPath);
        target = path.basename(resolvedPath);
      } else {
        cwd = resolvedPath;
      }
    }

    const escapedPattern = args.pattern.replace(/"/g, '\\"');
    const cmd = args.include
      ? `grep -rEn --include="${args.include}" "${escapedPattern}" ${target}`
      : `grep -rEn "${escapedPattern}" ${target}`;

    try {
      const { stdout } = await execAsync(cmd, { cwd, timeout: 10000, maxBuffer: 512 * 1024 });
      const lines = stdout.split("\n").filter(l => l.trim()).slice(0, 50);
      return lines.length > 0 ? lines.join("\n") : "No matches found";
    } catch (err: any) {
      if (err.code === 1) return "No matches found";
      return `Error: ${(err.stderr || err.message || "grep failed").substring(0, 1000)}`;
    }
  }

  private _safePath(projectDir: string, relativePath: string): string | null {
    if (!relativePath || relativePath.includes("..")) return null;
    const full = path.join(projectDir, relativePath);
    if (!full.startsWith(projectDir)) return null;
    return full;
  }
}
