import type OpenAI from "openai";
import fs from "fs";
import path from "path";
import type { AgentTool } from "../../../AgentTool";
import type { RunContext } from "../../../RunContext";

export class EditFileTool implements AgentTool {
  renderDefinition(): OpenAI.Chat.Completions.ChatCompletionTool {
    return {
      type: "function",
      function: {
        name: "edit_file",
        description: "Edit a file by replacing an exact string with new content. Much cheaper than rewriting the whole file. Use replace_all to replace every occurrence.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path relative to project root" },
            old_string: { type: "string", description: "Exact string to find (must be unique in file unless replace_all)" },
            new_string: { type: "string", description: "Replacement string" },
            replace_all: { type: "boolean", description: "Replace all occurrences (default false)" },
          },
          required: ["path", "old_string", "new_string"],
        },
      },
    };
  }

  async execute(args: Record<string, any>, ctx: RunContext): Promise<string> {
    if (ctx.deployLocked) {
      return "Error: Deploy limit has been reached. Further file edits cannot be deployed or verified in this run. Call finish to produce a blocked build report instead of editing.";
    }
    if (ctx.mode === "new" && !ctx.technicalPlanSubmitted) {
      return "Error: technical_plan must be called before editing code in a new build.";
    }
    if (this._isProtectedPath(args.path)) {
      return "Error: You can only edit files in frontend/ and backend/ directories.";
    }
    const filePath = this._safePath(ctx.projectDir, args.path);
    if (!filePath) return "Error: Invalid path";
    if (!fs.existsSync(filePath)) return "Error: File not found";

    let content = fs.readFileSync(filePath, "utf-8");
    const oldStr: string = args.old_string;
    const newStr: string = args.new_string;

    if (!content.includes(oldStr)) {
      return "Error: old_string not found in file";
    }

    if (args.replace_all) {
      const count = content.split(oldStr).length - 1;
      content = content.split(oldStr).join(newStr);
      fs.writeFileSync(filePath, content, "utf-8");
      ctx.wroteFiles = true;
      await ctx.progress({ action: "✏️ Editing", detail: args.path, percent: ctx.currentPercent });
      return `OK: Replaced ${count} occurrence(s) in ${args.path}`;
    }

    content = content.replace(oldStr, newStr);
    fs.writeFileSync(filePath, content, "utf-8");
    ctx.wroteFiles = true;
    await ctx.progress({ action: "✏️ Editing", detail: args.path, percent: ctx.currentPercent });
    return `OK: Replaced 1 occurrence in ${args.path}`;
  }

  getStepMeta(args: Record<string, any>): Record<string, any> {
    const meta: Record<string, any> = {};
    meta.added = typeof args?.new_string === "string" ? args.new_string.split("\n").length : 0;
    meta.removed = typeof args?.old_string === "string" ? args.old_string.split("\n").length : 0;
    if (args?.replace_all) meta.replaceAll = true;
    return meta;
  }

  private _isProtectedPath(relativePath: string): boolean {
    const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
    return !/^(frontend|backend)(\/|$)/i.test(normalized);
  }

  private _safePath(projectDir: string, relativePath: string): string | null {
    if (!relativePath || relativePath.includes("..")) return null;
    const full = path.join(projectDir, relativePath);
    if (!full.startsWith(projectDir)) return null;
    return full;
  }
}
