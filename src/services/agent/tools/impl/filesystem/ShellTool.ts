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
import { config } from "../../../../../config";

const execAsync = promisify(exec);

/**
 * Shell command execution tool exposed to the LLM.
 *
 * Two backends, selected by `config.runtimeMode`:
 *   - "docker": run inside the project's container via `dockerRunnerService.exec`
 *               as the unprivileged `node` user with `cwd=/workspace`. The
 *               container has zero platform secrets and is rate/CPU/RAM-limited
 *               at the cgroup level. This is the **secure path** — closes the
 *               build-phase attack surface where ShellTool used to inherit the
 *               main process's root privileges and full env (DATABASE_URL,
 *               ENCRYPTION_KEY, etc.).
 *   - anything else: legacy in-process exec on the platform host with
 *                    cwd = commits/<N>/. Preserved for in-process and worker
 *                    modes during rollback or local dev.
 */
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

    // Docker mode: route through the project's isolated container.
    if (config.runtimeMode === "docker") {
      return this.executeInContainer(cmd, ctx);
    }

    // Legacy worker / in-process: exec on the platform host with the agent's
    // build directory as cwd. The blocked-pattern lists above are the only
    // sandbox; the host process inherits platform env. Kept for fallback.
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

  /**
   * Run the command inside the project container's /workspace.
   *
   * Note: the container's /workspace = /srv/apps-father/projects/<id>/, which
   * mirrors the **deployed** state, not the in-flight commits/<N>/ build
   * directory the agent is currently editing. This is fine for most agent
   * workflows because:
   *   1. The agent uses the read_file / list_files / edit_file tools (which
   *      operate on commits/<N>/) for code inspection.
   *   2. ShellTool is typically called AFTER deploy_to_dev, when the
   *      commits/<N>/ tree has already been pushed into /srv.
   *   3. The container has no platform secrets and a 30s/1MB cap, so it's
   *      safe even for adversarial commands.
   */
  private async executeInContainer(cmd: string, ctx: RunContext): Promise<string> {
    // Late require to avoid a circular import via runner-types from the agent
    // module graph (agent → ShellTool → docker-runner-service → prisma → ...).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { dockerRunnerService } = require("../../../../docker-runner.service") as
      typeof import("../../../../docker-runner.service");

    let result: { exitCode: number; stdout: string; stderr: string };
    try {
      result = await dockerRunnerService.exec(ctx.projectId, cmd, {
        timeoutMs: 30_000,
        maxBytes: 1024 * 1024,
      });
    } catch (err) {
      return `Exit code 1:\n[shell] container exec failed: ${(err as Error).message}`;
    }

    if (result.exitCode === 0) {
      return (result.stdout || "(no output)").substring(0, 10_000);
    }
    const combined = (result.stderr + result.stdout) || "(no output)";
    return `Exit code ${result.exitCode}:\n${combined.substring(0, 5_000)}`;
  }

  getStepMeta(args: Record<string, any>): Record<string, any> {
    const cmd = typeof args?.command === "string" ? args.command : "";
    return { command: cmd.length > 120 ? cmd.slice(0, 117) + "…" : cmd };
  }
}
