import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileP = promisify(execFile);

const NPM_DOWNLOADS_THRESHOLD = 100_000;
const NPM_DOWNLOADS_API = "https://api.npmjs.org/downloads/point/last-week";

/**
 * Runner npm allowlist — single source of truth for which npm packages
 * user `routes.js` files are permitted to `require()`.
 *
 * Security boundary:
 *   - The agent cannot install arbitrary packages anymore: ShellTool blocks
 *     `npm/pnpm/yarn/npx` patterns. Instead it must call the `npm_install`
 *     tool, which validates against this list.
 *   - install-runner-npms.ps1 (server-side post-deploy scanner) also reads
 *     this list (via `runner-npm-allowlist.json`) and refuses to install
 *     any third-party require() that is not listed.
 *   - npm itself runs with `--ignore-scripts` so a compromised postinstall
 *     hook in a transitively-pulled dep cannot escalate.
 *
 * The JSON file lives at the repo root so it can be deployed independently
 * of the dist build (security-critical config should be re-loadable without
 * restarting node).
 */

export interface AllowlistEntry {
  /** Minimum semver acceptable; install-runner script enforces this. */
  minVersion?: string;
  /** Why the package is allowed and what to use it for (LLM hint). */
  description: string;
}

interface AllowlistFile {
  version: number;
  allowedPackages: Record<string, AllowlistEntry>;
  $comment?: string[];
}

const ALLOWLIST_FILENAME = "runner-npm-allowlist.json";

let cached: AllowlistFile | null = null;
let cachedMtimeMs = 0;
let cachedPath: string | null = null;

function resolveAllowlistPath(): string {
  if (cachedPath) return cachedPath;
  // Prefer cwd (the install dir at runtime); fall back to repo root for tests.
  const candidates = [
    path.join(process.cwd(), ALLOWLIST_FILENAME),
    path.resolve(__dirname, "..", "..", ALLOWLIST_FILENAME),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      cachedPath = candidate;
      return candidate;
    }
  }
  // Last-resort: cwd path (will produce a clear ENOENT on first read).
  cachedPath = candidates[0];
  return cachedPath;
}

/**
 * Read the allowlist from disk. Caches by mtime so we re-read when the file
 * is updated without requiring a node restart, but skip filesystem work on
 * the hot path otherwise.
 */
function loadAllowlist(): AllowlistFile {
  const filePath = resolveAllowlistPath();
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(filePath).mtimeMs;
  } catch {
    // Missing file → return an empty allowlist (deny-all). Code paths that
    // require any package will surface a clear "not in allowlist" error.
    return { version: 0, allowedPackages: {} };
  }

  if (cached && mtimeMs === cachedMtimeMs) return cached;

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as AllowlistFile;
    if (!parsed || typeof parsed !== "object" || !parsed.allowedPackages) {
      throw new Error("malformed allowlist (missing allowedPackages)");
    }
    cached = parsed;
    cachedMtimeMs = mtimeMs;
    return parsed;
  } catch (err) {
    console.warn(
      `[RunnerAllowlist] Failed to load ${filePath}: ${(err as Error).message}. ` +
        `Returning deny-all to fail safe.`,
    );
    return { version: 0, allowedPackages: {} };
  }
}

/** True if `pkg` is on the allowlist. Bare imports only (no `node:` prefix). */
export function isAllowed(pkg: string): boolean {
  if (!pkg) return false;
  const base = stripSubpath(pkg);
  return Object.prototype.hasOwnProperty.call(loadAllowlist().allowedPackages, base);
}

/** Get the metadata for an allowed package, or null if not allowed. */
export function getAllowlistEntry(pkg: string): AllowlistEntry | null {
  if (!pkg) return null;
  const base = stripSubpath(pkg);
  const entry = loadAllowlist().allowedPackages[base];
  return entry || null;
}

/** Return all allowed package names (sorted). */
export function listAllowedPackages(): string[] {
  return Object.keys(loadAllowlist().allowedPackages).sort();
}

/**
 * Strip a sub-path import like `lodash/cloneDeep` → `lodash`, or
 * `@scope/pkg/sub` → `@scope/pkg`. Returns the import as-is if neither.
 */
function stripSubpath(pkg: string): string {
  if (pkg.startsWith("@")) {
    // Scoped: @scope/pkg/sub → @scope/pkg
    const parts = pkg.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : pkg;
  }
  const slash = pkg.indexOf("/");
  return slash === -1 ? pkg : pkg.slice(0, slash);
}

/**
 * Multi-package validation for the install tool. Returns:
 *   - allowed: package names that are on the list
 *   - rejected: package names that are not, with their entries
 */
export function validatePackages(packages: string[]): {
  allowed: Array<{ pkg: string; entry: AllowlistEntry }>;
  rejected: string[];
} {
  const allowed: Array<{ pkg: string; entry: AllowlistEntry }> = [];
  const rejected: string[] = [];
  for (const raw of packages) {
    const pkg = String(raw || "").trim();
    if (!pkg) continue;
    const entry = getAllowlistEntry(pkg);
    if (entry) allowed.push({ pkg: stripSubpath(pkg), entry });
    else rejected.push(pkg);
  }
  return { allowed, rejected };
}

export interface AutoApproveResult {
  pkg: string;
  approved: boolean;
  weeklyDownloads?: number;
  reason: string;
}

/**
 * For packages not on the allowlist, check npm weekly downloads. If a package
 * has >= {@link NPM_DOWNLOADS_THRESHOLD} weekly downloads, write it into
 * `runner-npm-allowlist.json` so future calls find it via {@link isAllowed}.
 *
 * This function does NOT install anything anymore — installation is the
 * caller's job. NpmInstallTool decides where the package physically lands:
 *   - docker mode → `docker exec npm install` inside the project's container
 *                   (per-project /workspace/node_modules)
 *   - worker / in-process mode → platform-wide install via
 *                   {@link installPlatformWide} (legacy path, kept for rollback)
 */
export async function autoApproveIfPopular(packages: string[]): Promise<AutoApproveResult[]> {
  const results: AutoApproveResult[] = [];

  for (const raw of packages) {
    const pkg = stripSubpath(String(raw || "").trim());
    if (!pkg) continue;

    if (isAllowed(pkg)) {
      results.push({ pkg, approved: true, reason: "already on allowlist" });
      continue;
    }

    let weeklyDownloads = 0;
    try {
      const url = `${NPM_DOWNLOADS_API}/${encodeURIComponent(pkg)}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) {
        results.push({ pkg, approved: false, reason: `npm API returned ${res.status}` });
        continue;
      }
      const data = await res.json() as { downloads?: number; error?: string };
      if (data.error || typeof data.downloads !== "number") {
        results.push({ pkg, approved: false, reason: data.error || "package not found on npm" });
        continue;
      }
      weeklyDownloads = data.downloads;
    } catch (err) {
      results.push({ pkg, approved: false, weeklyDownloads: 0, reason: `npm API error: ${(err as Error).message}` });
      continue;
    }

    if (weeklyDownloads < NPM_DOWNLOADS_THRESHOLD) {
      results.push({
        pkg, approved: false, weeklyDownloads,
        reason: `only ${weeklyDownloads.toLocaleString()} weekly downloads (threshold: ${NPM_DOWNLOADS_THRESHOLD.toLocaleString()})`,
      });
      continue;
    }

    try {
      const filePath = resolveAllowlistPath();
      const raw2 = fs.readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw2) as AllowlistFile;
      parsed.allowedPackages[pkg] = {
        description: `Auto-approved: ${weeklyDownloads.toLocaleString()} weekly npm downloads.`,
      };
      fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
      // Invalidate in-memory cache so the new entry is picked up immediately
      cached = null;
      cachedMtimeMs = 0;
    } catch (err) {
      results.push({ pkg, approved: false, weeklyDownloads, reason: `failed to write allowlist: ${(err as Error).message}` });
      continue;
    }

    results.push({
      pkg, approved: true, weeklyDownloads,
      reason: `auto-approved (${weeklyDownloads.toLocaleString()} weekly downloads)`,
    });
  }

  return results;
}

export interface InstallResult {
  pkg: string;
  installed: boolean;
  reason: string;
}

/**
 * Install allowlisted packages into the **platform's** node_modules. Used in
 * legacy worker / in-process mode where every project shares the same set of
 * platform-installed deps via NODE_PATH.
 */
export async function installPlatformWide(packages: string[]): Promise<InstallResult[]> {
  const out: InstallResult[] = [];
  for (const raw of packages) {
    const pkg = stripSubpath(String(raw || "").trim());
    if (!pkg) continue;
    try {
      await execFileP("npm", [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--save-exact",
        pkg,
      ], { cwd: process.cwd(), timeout: 120_000 });
      out.push({ pkg, installed: true, reason: "installed in platform node_modules" });
    } catch (err) {
      out.push({ pkg, installed: false, reason: `npm install failed: ${(err as Error).message}` });
    }
  }
  return out;
}

/**
 * Install allowlisted packages into a single project's container, writing to
 * `/workspace/node_modules` (host: `<runnerProjectsRoot>/<id>/node_modules`).
 *
 * Spawns/uses the container via {@link dockerRunnerService.exec}, runs
 * `npm install --ignore-scripts --save-exact <pkgs>` as the unprivileged
 * `node` user. The container has `--network apps-father-runners` (outbound
 * internet open) so the registry fetch works.
 *
 * Caller (NpmInstallTool) is expected to seed `/workspace/package.json` first
 * if missing, so npm has somewhere to record the dependency.
 */
export async function installInProjectContainer(
  projectId: string,
  packages: string[],
): Promise<InstallResult[]> {
  // Late require — avoids a circular import via runner-types since the
  // allowlist module is also pulled by the agent build chain.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { dockerRunnerService } = require("./docker-runner.service") as typeof import("./docker-runner.service");

  const out: InstallResult[] = [];
  const cleaned = packages
    .map((p) => stripSubpath(String(p || "").trim()))
    .filter((p) => p.length > 0);
  if (cleaned.length === 0) return out;

  // Make sure /workspace/package.json exists so `npm install --save-exact`
  // can record the dep instead of just dropping it into node_modules. Run
  // this inside the container so the file ends up node-owned.
  await dockerRunnerService.exec(projectId,
    `[ -f /workspace/package.json ] || echo '{"name":"workspace","version":"1.0.0","private":true}' > /workspace/package.json`,
    { timeoutMs: 5_000 },
  ).catch(() => { /* container will surface the error on the actual install */ });

  // Single npm install with all packages — faster than one-at-a-time.
  const cmd =
    "npm install --ignore-scripts --no-audit --no-fund --save-exact " +
    cleaned.map((p) => JSON.stringify(p)).join(" ");

  const { exitCode, stdout, stderr } = await dockerRunnerService.exec(projectId, cmd, {
    timeoutMs: 180_000,
    maxBytes: 256 * 1024,
  });

  if (exitCode === 0) {
    for (const pkg of cleaned) out.push({ pkg, installed: true, reason: "installed in /workspace/node_modules" });
  } else {
    // npm prints the most useful error context (EACCES paths, ETARGET versions,
    // network errors, etc.) somewhere in stderr — often not in the last 3 lines
    // because npm appends a generic "see ... for more info" footer. Surface a
    // longer slice to the agent and dump the full stderr to the platform log
    // so operators can debug install failures without console-shelling.
    console.error(
      `[npm-allowlist] install failed for project=${projectId.slice(0, 8)} ` +
      `pkgs=${cleaned.join(",")} exit=${exitCode}\nstderr:\n${stderr}\nstdout:\n${stdout}`,
    );
    const tail = stderr
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("npm notice") && !l.startsWith("npm warn"))
      .slice(-8)
      .join(" | ");
    const reason = `npm install failed (exit ${exitCode}): ${tail || "unknown error — check server logs"}`;
    for (const pkg of cleaned) out.push({ pkg, installed: false, reason });
  }
  return out;
}
