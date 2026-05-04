import type OpenAI from "openai";
import fs from "fs";
import path from "path";
import type { AgentTool } from "../../../AgentTool";
import type { RunContext } from "../../../RunContext";
import { SKIP_DIRS, SKIP_EXTS, BINARY_EXTS, READ_FILE_MAX_BYTES } from "../../../config";

export class ListFilesTool implements AgentTool {
  renderDefinition(): OpenAI.Chat.Completions.ChatCompletionTool {
    return {
      type: "function",
      function: {
        name: "list_files",
        description: "List all files in the project directory with sizes. Returns lines like 'frontend/app.js (340 lines, 12KB)'.",
        parameters: { type: "object", properties: {}, required: [] },
      },
    };
  }

  async execute(_args: Record<string, any>, ctx: RunContext): Promise<string> {
    await ctx.progress({ action: "📂 Scanning files", detail: "", percent: ctx.currentPercent });
    const files = this._walkDir(ctx.projectDir, ctx.projectDir);
    return files.length > 0 ? files.join("\n") : "(empty project)";
  }

  private _walkDir(dir: string, base: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.isDirectory()) {
        results.push(...this._walkDir(fullPath, base));
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        const relPath = path.relative(base, fullPath).replace(/\\/g, "/");
        try {
          const stat = fs.statSync(fullPath);
          const sizeKB = (stat.size / 1024).toFixed(1);
          if (BINARY_EXTS.has(ext) || SKIP_EXTS.has(ext)) {
            results.push(`${relPath} (${sizeKB}KB, binary — do not read_file)`);
            continue;
          }
          if (stat.size > READ_FILE_MAX_BYTES) {
            results.push(`${relPath} (${sizeKB}KB, large — use grep / paged read_file)`);
            continue;
          }
          const content = fs.readFileSync(fullPath, "utf-8");
          results.push(`${relPath} (${content.split("\n").length} lines, ${sizeKB}KB)`);
        } catch {
          results.push(relPath);
        }
      }
    }
    return results;
  }
}
