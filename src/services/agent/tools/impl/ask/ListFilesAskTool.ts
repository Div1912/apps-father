import fs from "fs";
import path from "path";
import type { AskTool } from "./AskTool";
import type { AskContext } from "./AskContext";
import { SKIP_DIRS, SKIP_EXTS, BINARY_EXTS, READ_FILE_MAX_BYTES } from "../../../config";

export class ListFilesAskTool implements AskTool {
  name = "list_files";
  definition = {
    type: "function",
    function: {
      name: "list_files",
      description: "List files in the live app (frontend/ + backend/) with sizes. Use this to see what the project actually contains before asking the owner.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  };

  async execute(_args: Record<string, any>, ctx: AskContext): Promise<string> {
    if (!ctx.projectDir) return "Project has no built files yet.";
    const files = this._walkDir(ctx.projectDir, ctx.projectDir);
    if (files.length === 0) return "(empty project)";
    return files.slice(0, 80).join("\n") + (files.length > 80 ? `\n... +${files.length - 80} more` : "");
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
            results.push(`${relPath} (${sizeKB}KB, binary)`);
            continue;
          }
          if (stat.size > READ_FILE_MAX_BYTES) {
            results.push(`${relPath} (${sizeKB}KB, large)`);
            continue;
          }
          results.push(`${relPath} (${fs.readFileSync(fullPath, "utf-8").split("\n").length} lines, ${sizeKB}KB)`);
        } catch {
          results.push(relPath);
        }
      }
    }
    return results;
  }
}
