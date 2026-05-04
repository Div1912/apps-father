import fs from "fs";
import path from "path";
import type { AskTool } from "./AskTool";
import type { AskContext } from "./AskContext";
import { BINARY_EXTS, READ_FILE_MAX_BYTES, READ_FILE_SOFT_CAP_BYTES } from "../../../config";

export class ReadFileAskTool implements AskTool {
  name = "read_file";
  definition = {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file from the live app. Paths are relative to the project root (e.g. 'frontend/index.html', 'backend/routes.js'). Refuses binary files. Optional offset/limit page through long files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path, e.g. frontend/index.html" },
          offset: { type: "number", description: "1-based start line for paging." },
          limit: { type: "number", description: "Max lines to return when offset is set." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  };

  async execute(args: Record<string, any>, ctx: AskContext): Promise<string> {
    if (!ctx.projectDir) return "Project has no built files yet.";
    if (typeof args?.path !== "string" || !args.path) return "Error: path is required.";

    const filePath = this._safePath(ctx.projectDir, args.path);
    if (!filePath) return "Error: invalid path.";
    if (!fs.existsSync(filePath)) return `Error: file not found: ${args.path}`;

    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) return `Error: ${args.path} is a directory; use list_files instead.`;

    const ext = path.extname(args.path).toLowerCase();
    const sizeKB = (stat.size / 1024).toFixed(1);
    if (BINARY_EXTS.has(ext)) {
      return `Error: ${args.path} is a binary file (${ext}, ${sizeKB}KB) and cannot be read as text.`;
    }
    if (!args.offset && !args.limit && stat.size > READ_FILE_SOFT_CAP_BYTES) {
      return `Error: ${args.path} is ${sizeKB}KB; pass offset+limit to page through it.`;
    }
    if (stat.size > READ_FILE_MAX_BYTES) {
      return `Error: ${args.path} is ${sizeKB}KB; too large to read.`;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    if (args.offset || args.limit) {
      const start = Math.max(0, (args.offset || 1) - 1);
      const end = args.limit ? start + args.limit : lines.length;
      return lines.slice(start, end).map((l, i) => `${start + i + 1}|${l}`).join("\n");
    }
    if (Buffer.byteLength(content, "utf-8") > 20 * 1024) {
      return content.slice(0, 20 * 1024) + `\n... [truncated; pass offset+limit to read more]`;
    }
    return lines.map((l, i) => `${i + 1}|${l}`).join("\n");
  }

  private _safePath(projectDir: string, relativePath: string): string | null {
    if (!relativePath || relativePath.includes("..")) return null;
    const full = path.join(projectDir, relativePath);
    if (!full.startsWith(projectDir)) return null;
    return full;
  }
}
