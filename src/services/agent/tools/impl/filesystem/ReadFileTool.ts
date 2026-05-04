import type OpenAI from "openai";
import fs from "fs";
import path from "path";
import type { AgentTool } from "../../../AgentTool";
import type { RunContext } from "../../../RunContext";
import { BINARY_EXTS, READ_FILE_MAX_BYTES, READ_FILE_SOFT_CAP_BYTES } from "../../../config";

export class ReadFileTool implements AgentTool {
  renderDefinition(): OpenAI.Chat.Completions.ChatCompletionTool {
    return {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a TEXT file from the project. Supports optional line range to read only specific lines (1-indexed). Returns numbered lines. NEVER call on binary files (images .png/.jpg/.jpeg/.gif/.webp, video, audio, fonts, archives, .pdf, .db, etc.) - they will be refused. Reference image assets directly in HTML/CSS via their path (e.g. <img src=\"assets/foo.jpg\">) without reading them. For text files >256KB you MUST pass offset+limit; full reads are capped.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path relative to project root. Must point to a text file." },
            offset: { type: "number", description: "Start line number (1-indexed, optional)" },
            limit: { type: "number", description: "Number of lines to read (optional). Required for files larger than 256KB." },
          },
          required: ["path"],
        },
      },
    };
  }

  async execute(args: Record<string, any>, ctx: RunContext): Promise<string> {
    const filePath = this._safePath(ctx.projectDir, args.path);
    if (!filePath) return "Error: Invalid path";
    if (!fs.existsSync(filePath)) return "Error: File not found";

    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      return `Error: ${args.path} is a directory, not a file. Use list_files to inspect the project tree.`;
    }

    const ext = path.extname(args.path).toLowerCase();
    const sizeKB = (stat.size / 1024).toFixed(1);

    if (BINARY_EXTS.has(ext)) {
      const msg = `Error: ${args.path} is a binary file (${ext}, ${sizeKB}KB) and cannot be read as text. ` +
        `Reading it would inject ~${Math.round(stat.size / 4)} junk tokens into context. ` +
        `If this is an image/audio/video asset, reference it directly in your HTML/CSS by path ` +
        `(e.g. <img src="${args.path.replace(/^.*?(assets\/.*)$/, "$1")}">) without reading its contents. ` +
        `Do NOT retry read_file on this path.`;
      console.warn(`[Agent] 🚫 read_file refused binary: ${args.path} (${sizeKB}KB)`);
      await ctx.progress({ action: "🚫 Skipped binary", detail: `${args.path} (${sizeKB}KB)`, percent: ctx.currentPercent });
      return msg;
    }

    if (!args.offset && !args.limit && stat.size > READ_FILE_SOFT_CAP_BYTES) {
      return `Error: ${args.path} is ${sizeKB}KB which exceeds the 256KB full-read cap. ` +
        `Use offset+limit to page through it (e.g. read_file({path, offset: 1, limit: 500})), ` +
        `or run grep first to locate the specific section you need.`;
    }
    if (stat.size > READ_FILE_MAX_BYTES) {
      return `Error: ${args.path} is ${sizeKB}KB which exceeds the 512KB hard cap. ` +
        `Files this large must be inspected with grep, not read_file.`;
    }

    // Binary sniff via NUL bytes in first 4KB
    const sniffSize = Math.min(stat.size, 4096);
    if (sniffSize > 0) {
      const fd = fs.openSync(filePath, "r");
      const sniffBuf = Buffer.alloc(sniffSize);
      fs.readSync(fd, sniffBuf, 0, sniffSize, 0);
      fs.closeSync(fd);
      let nulCount = 0;
      for (let i = 0; i < sniffBuf.length; i++) {
        if (sniffBuf[i] === 0) { nulCount++; if (nulCount > 2) break; }
      }
      if (nulCount > 2) {
        return `Error: ${args.path} (${sizeKB}KB) appears to be a binary file (contains NUL bytes) and cannot be read as text. ` +
          `Do NOT retry read_file on this path.`;
      }
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    if (args.offset || args.limit) {
      const start = Math.max(0, (args.offset || 1) - 1);
      const end = args.limit ? start + args.limit : lines.length;
      let body = lines.slice(start, end).map((l, i) => `${start + i + 1}|${l}`).join("\n");
      if (Buffer.byteLength(body, "utf-8") > READ_FILE_SOFT_CAP_BYTES) {
        body = body.slice(0, READ_FILE_SOFT_CAP_BYTES) +
          `\n... [truncated: result exceeded 256KB cap; narrow the range with smaller limit]`;
      }
      await ctx.progress({ action: "📖 Reading", detail: `${args.path} lines ${start + 1}-${Math.min(end, lines.length)}`, percent: ctx.currentPercent });
      return body;
    }

    await ctx.progress({ action: "📖 Reading", detail: args.path, percent: ctx.currentPercent });
    return lines.map((l, i) => `${i + 1}|${l}`).join("\n");
  }

  private _safePath(projectDir: string, relativePath: string): string | null {
    if (!relativePath || relativePath.includes("..")) return null;
    const full = path.join(projectDir, relativePath);
    if (!full.startsWith(projectDir)) return null;
    return full;
  }
}
