import type OpenAI from "openai";
import fs from "fs";
import path from "path";
import type { AgentTool } from "../../../AgentTool";
import type { RunContext } from "../../../RunContext";

export class WriteFileTool implements AgentTool {
  renderDefinition(): OpenAI.Chat.Completions.ChatCompletionTool {
    return {
      type: "function",
      function: {
        name: "write_file",
        description: "Create or overwrite a file with complete content. Use for new files or full rewrites. For small changes, prefer edit_file.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path relative to project root" },
            content: { type: "string", description: "Complete file content" },
          },
          required: ["path", "content"],
        },
      },
    };
  }

  async execute(args: Record<string, any>, ctx: RunContext): Promise<string> {
    if (ctx.deployLocked) {
      return "Error: Deploy limit has been reached. Further file edits cannot be deployed or verified in this run. Call finish to produce a blocked build report instead of editing.";
    }
    if (ctx.mode === "new" && !ctx.technicalPlanSubmitted) {
      return "Error: technical_plan must be called before writing code in a new build.";
    }
    if (this._isProtectedPath(args.path)) {
      return "Error: You can only write to frontend/ and backend/ directories.";
    }
    const filePath = this._safePath(ctx.projectDir, args.path);
    if (!filePath) return "Error: Invalid path";

    if (typeof args.content !== "string" || args.content.length === 0) {
      return `Error: write_file received empty content — the model hit max_tokens while generating the full file. This will happen again if you retry.

DO NOT retry write_file on ${args.path}. Use ONE of these instead:

OPTION 1 — shell heredoc (recommended for files >400 lines):
  shell("cat > ${args.path} << 'HEREDOC_EOF'\\n... full file content here ...\\nHEREDOC_EOF")

OPTION 2 — skeleton + edit_file:
  write_file("${args.path}", "// skeleton ~50 lines with // TODO: section_A markers")
  edit_file("${args.path}", "// TODO: section_A", "... actual code ...")
  edit_file("${args.path}", "// TODO: section_B", "... actual code ...")

OPTION 3 — split into multiple smaller files if the architecture allows.

Pick one and proceed.`;
    }

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, args.content, "utf-8");
    const lineCount = args.content.split("\n").length;
    ctx.wroteFiles = true;
    await ctx.progress({ action: "✏️ Writing", detail: args.path, percent: ctx.currentPercent });
    return `OK: Written ${lineCount} lines to ${args.path}`;
  }

  getStepMeta(args: Record<string, any>): Record<string, any> {
    const meta: Record<string, any> = {};
    if (typeof args?.content === "string") {
      meta.lines = args.content.split("\n").length;
      meta.bytes = Buffer.byteLength(args.content, "utf-8");
    }
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
