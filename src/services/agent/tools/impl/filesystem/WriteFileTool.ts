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
        description:
          "Create, overwrite, or extend a file. " +
          "For small in-place edits, prefer edit_file. " +
          "If the file is too large to fit in one tool call (≳300 lines), write the first chunk with append=false (or omitted), then call write_file again with append=true to add the next chunks until the file is complete. " +
          "Use this same append-chunking approach if a previous write_file was truncated by max_tokens — never use shell to write file content.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path relative to project root" },
            content: { type: "string", description: "Content to write (one chunk)" },
            append: {
              type: "boolean",
              description: "If true, append `content` to the end of the existing file instead of overwriting. Use this to continue a multi-chunk write. Defaults to false (overwrite).",
            },
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

    // Guard: args may be empty/undefined if the JSON was truncated by max_tokens
    if (!args.path || typeof args.path !== "string") {
      return `Error: write_file args were truncated by max_tokens — 'path' is missing. The file content was too large to fit in one tool call.

DO NOT retry write_file with the full file. Split the content into chunks and use the append flag:

  write_file({ path: "<your/path>", content: "<first ~200 lines>" })
  write_file({ path: "<your/path>", content: "<next ~200 lines>", append: true })
  write_file({ path: "<your/path>", content: "<final ~200 lines>", append: true })

The first call (no append) creates/overwrites the file with the first chunk. Each subsequent call with append:true adds more content to the end. Continue until the file is complete.

Do NOT use shell to write file content — shell may run against a different filesystem than the build directory.

Pick path + first chunk and proceed immediately.`;
    }

    if (this._isProtectedPath(args.path)) {
      return "Error: You can only write to frontend/ and backend/ directories.";
    }
    const filePath = this._safePath(ctx.projectDir, args.path);
    if (!filePath) return "Error: Invalid path";

    if (typeof args.content !== "string" || args.content.length === 0) {
      return `Error: write_file received empty content for '${args.path}' — the model hit max_tokens while generating the file body. This will happen again if you retry the same way.

DO NOT retry write_file with the full file. Split the content into chunks and use the append flag:

  write_file({ path: "${args.path}", content: "<first ~200 lines>" })
  write_file({ path: "${args.path}", content: "<next ~200 lines>", append: true })
  write_file({ path: "${args.path}", content: "<final ~200 lines>", append: true })

The first call (no append) creates/overwrites the file. Each subsequent call with append:true adds more content to the end. Continue until the file is complete.

Do NOT use shell to write file content.

Proceed with the first chunk now.`;
    }

    const append = args.append === true;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (append) {
      fs.appendFileSync(filePath, args.content, "utf-8");
    } else {
      fs.writeFileSync(filePath, args.content, "utf-8");
    }
    const lineCount = args.content.split("\n").length;

    // Diagnostic — log every write so we can correlate with validator failures
    const hasOpenWS = /AF\.openWS\s*\(/.test(args.content);
    const mode = append ? "appended" : "wrote";
    console.log(`[WriteFileTool] ${mode} ${args.path} → ${lineCount} lines, ${Buffer.byteLength(args.content, "utf-8")} bytes, contains AF.openWS=${hasOpenWS}, fullPath=${filePath}`);
    ctx.wroteFiles = true;
    await ctx.progress({ action: append ? "➕ Appending" : "✏️ Writing", detail: args.path, percent: ctx.currentPercent });

    // Early-warning only fires on full overwrites — for append calls we don't
    // know what the rest of the file looks like yet (AF.openWS may live in a
    // later chunk), so the WS check would false-positive on the first chunk.
    if (!append) {
      const normalizedWritePath = args.path.replace(/\\/g, "/").replace(/^\/+/, "");
      const planHasWs = Array.isArray(ctx.technicalPlan?.wsMessages) && ctx.technicalPlan.wsMessages.length > 0;
      if (normalizedWritePath === "frontend/app.js" && planHasWs) {
        const hasWsCall = /AF\.openWS\s*\(|new\s+WebSocket\s*\(/.test(args.content);
        if (!hasWsCall) {
          return `OK: Written ${lineCount} lines to ${args.path}. ` +
            `WARNING: Your technical plan includes WebSocket messages, but this app.js does not contain AF.openWS(). ` +
            `deploy_to_dev WILL FAIL with a validator error. ` +
            `You MUST add WebSocket connection code before deploying. ` +
            `Add a connectWS() function that calls: ws = AF.openWS({ onOpen: () => { ws.send(JSON.stringify({type:'auth',initData:AF.tg.initData||''})); }, onMessage: (data) => { handleWSMessage(data); }, onClose: () => { setTimeout(connectWS, 3000); } });`;
        }
      }
    }

    const verb = append ? "Appended" : "Written";
    return `OK: ${verb} ${lineCount} lines to ${args.path}`;
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
