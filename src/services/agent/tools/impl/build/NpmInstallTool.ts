import type OpenAI from "openai";
import type { AgentTool } from "../../../AgentTool";
import type { RunContext } from "../../../RunContext";
import {
  validatePackages,
  listAllowedPackages,
  getAllowlistEntry,
  autoApproveIfPopular,
} from "../../../../runner-npm-allowlist.service";

/**
 * Allowlisted npm package installation for user routes.js.
 *
 * Replaces the previous pattern where the agent ran `shell("npm install <pkg>")`
 * with no validation. The new model:
 *   1. Agent calls npm_install({ packages: ["multer", ...] }).
 *   2. Tool validates against runner-npm-allowlist.json (deny-all unless listed).
 *   3. The package is recorded as a runtime dependency for this project (a
 *      best-effort hint to the operator); actual install on the platform's
 *      runner node_modules is performed by install-runner-npms.ps1 server-side
 *      after deploy, with --ignore-scripts.
 *   4. Allowlisted packages are pre-installed at platform deploy time, so the
 *      agent can immediately `require()` them in routes.js without waiting.
 *
 * The agent NEVER shells out to npm directly — ShellTool blocks `npm/pnpm/yarn`
 * patterns. This is the only path to add a runtime dep.
 */
export class NpmInstallTool implements AgentTool {
  renderDefinition(): OpenAI.Chat.Completions.ChatCompletionTool {
    return {
      type: "function",
      function: {
        name: "npm_install",
        description:
          "Declare npm packages your routes.js needs. ONLY allowlisted packages are accepted; " +
          "anything else is rejected with the list of allowed packages. Allowlisted packages " +
          "are pre-installed by the platform — after this call returns OK, you can " +
          "`require('<pkg>')` from routes.js immediately. Use this instead of `shell('npm install ...')` " +
          "(which is blocked).",
        parameters: {
          type: "object",
          properties: {
            packages: {
              type: "array",
              items: { type: "string" },
              description:
                "Bare package names to declare (e.g. ['multer', 'axios']). " +
                "Sub-path imports like 'lodash/get' are accepted; they're rolled up to the parent " +
                "package for allowlist matching. Built-in modules ('fs', 'path', 'crypto', etc.) " +
                "do not need to be declared.",
            },
          },
          required: ["packages"],
        },
      },
    };
  }

  async execute(args: Record<string, any>, ctx: RunContext): Promise<string> {
    const raw = Array.isArray(args?.packages) ? args.packages : [];
    const packages: string[] = raw
      .map((p: unknown) => (typeof p === "string" ? p.trim() : ""))
      .filter((p: string): p is string => p.length > 0);

    if (packages.length === 0) {
      return (
        "Error: npm_install called with no packages. Pass an array of bare package " +
        "names: { packages: [\"multer\", \"axios\"] }."
      );
    }

    await ctx.progress({
      action: "📦 Declaring npm packages",
      detail: packages.join(", "),
      percent: ctx.currentPercent,
    });

    let { allowed, rejected } = validatePackages(packages);

    if (rejected.length > 0) {
      await ctx.progress({
        action: "🔍 Checking npm popularity for unlisted packages",
        detail: rejected.join(", "),
        percent: ctx.currentPercent,
      });

      const autoResults = await autoApproveIfPopular(rejected);
      const stillRejected: string[] = [];

      for (const result of autoResults) {
        if (result.approved) {
          // Re-fetch the now-approved entry and move to allowed
          const entry = getAllowlistEntry(result.pkg);
          if (entry) allowed.push({ pkg: result.pkg, entry });
          else allowed.push({ pkg: result.pkg, entry: { description: result.reason } });
        } else {
          stillRejected.push(`  - ${result.pkg}: ${result.reason}`);
        }
      }

      if (stillRejected.length > 0) {
        const allowedList = listAllowedPackages();
        return (
          `Error: ${stillRejected.length} package${stillRejected.length === 1 ? "" : "s"} could not be approved:\n` +
          stillRejected.join("\n") +
          `\n\n(Packages with <100k weekly npm downloads are blocked for security.)\n\n` +
          `Allowed packages (${allowedList.length}):\n` +
          allowedList.map((p) => `  - ${p}: ${getAllowlistEntry(p)?.description || ""}`).join("\n") +
          `\n\nIf you genuinely need a package that is not on the list:\n` +
          `  1. Re-design the feature using an allowlisted package or a public no-key API.\n` +
          `  2. If that's not possible, ask_user — they can add the package to runner-npm-allowlist.json.\n` +
          `Do NOT try to shell out to npm; that path is blocked.`
        );
      }
    }

    const summary = allowed
      .map(({ pkg, entry }) => `  ${pkg}${entry.minVersion ? ` (>=${entry.minVersion})` : ""} — ${entry.description}`)
      .join("\n");

    return (
      `OK: ${allowed.length} package${allowed.length === 1 ? "" : "s"} declared and available to require():\n` +
      `${summary}\n\n` +
      `Use them with require() at the top of backend/routes.js. The platform pre-installs ` +
      `allowlisted packages, so no waiting is needed.`
    );
  }

  getStepMeta(args: Record<string, any>): Record<string, any> {
    const pkgs = Array.isArray(args?.packages) ? args.packages.filter((p: unknown) => typeof p === "string") : [];
    return { packages: pkgs };
  }
}
