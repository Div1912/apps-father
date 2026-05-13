import type OpenAI from "openai";
import { exec } from "child_process";
import { promisify } from "util";
import type { AgentTool } from "../../../AgentTool";
import type { RunContext } from "../../../RunContext";
import {
  BLOCKED_COMMANDS,
  BLOCKED_INFRA_SHELL_PATTERNS,
  BLOCKED_PACKAGE_MANAGER_PATTERNS,
} from "../../../config";

const execAsync = promisify(exec);

export class ShellTool implements AgentTool {
  renderDefinition(): OpenAI.Chat.Completions.ChatCompletionTool {
    return {
      type: "function",
      function: {
        name: "shell",
        description: "Run a shell command in the project directory for file manipulation or one-off scripts. Blocked: rm -rf /, shutdown, AND any package-manager call (npm/pnpm/yarn/npx/bun). To add a runtime dependency, use the npm_install tool — it enforces the runner allowlist.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "Shell command to execute" },
          },
          required: ["command"],
        },
      },
    };
  }

  async execute(args: Record<string, any>, ctx: RunContext): Promise<string> {
    const cmd: string = args.command;
    if (BLOCKED_COMMANDS.some(b => cmd.includes(b))) {
      return "Error: Command blocked for safety";
    }
    if (BLOCKED_PACKAGE_MANAGER_PATTERNS.some(re => re.test(cmd))) {
      return "Error: Direct package-manager calls (npm/pnpm/yarn/npx/bun) are blocked from the project shell. To add a runtime dependency, call the npm_install tool — it enforces the runner allowlist (only known-safe packages installable, --ignore-scripts always set). Built-in modules ('fs', 'path', 'crypto', etc.) need no install.";
    }
    if (BLOCKED_INFRA_SHELL_PATTERNS.some(re => re.test(cmd))) {
      return "Error: Platform infrastructure diagnostics are not allowed from project shell. Use deploy_to_dev, simulate_api, simulate_telegram, simulate_ws, and server_logs; fix project files based on those tool results.";
    }
    await ctx.progress({ action: "⚡ Running system commands...", detail: "", percent: ctx.currentPercent });
    try {
      const { stdout } = await execAsync(cmd, {
        cwd: ctx.projectDir,
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, HOME: ctx.projectDir, NODE_ENV: "development" },
      });
      return (stdout || "(no output)").substring(0, 10000);
    } catch (err: any) {
      const stderr = err.stderr || "";
      const stdout = err.stdout || "";
      return `Exit code ${err.code || 1}:\n${(stderr + stdout || err.message).substring(0, 5000)}`;
    }
  }

  getStepMeta(args: Record<string, any>): Record<string, any> {
    const cmd = typeof args?.command === "string" ? args.command : "";
    return { command: cmd.length > 120 ? cmd.slice(0, 117) + "…" : cmd };
  }
}
