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
 * For packages not on the allowlist, check npm weekly downloads.
 * If downloads >= NPM_DOWNLOADS_THRESHOLD (100k), auto-approve:
 *   1. Write entry to runner-npm-allowlist.json
 *   2. npm install --ignore-scripts --no-audit in the platform app dir
 * Returns result for each package.
 */
export async function autoApproveIfPopular(packages: string[]): Promise<AutoApproveResult[]> {
  const results: AutoApproveResult[] = [];

  for (const raw of packages) {
    const pkg = stripSubpath(String(raw || "").trim());
    if (!pkg) continue;

    // Already on the allowlist — shouldn't reach here, but guard anyway
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

    // Popular enough — write to allowlist JSON
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

    // Install the package into the platform node_modules right now
    try {
      await execFileP("npm", [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--save-exact",
        pkg,
      ], { cwd: process.cwd(), timeout: 60_000 });
    } catch (err) {
      // Package is now on the allowlist but couldn't install — not fatal, operator
      // can re-run install-runner-npms.ps1 to finish the job.
      results.push({
        pkg, approved: true, weeklyDownloads,
        reason: `added to allowlist (${weeklyDownloads.toLocaleString()}/wk) but npm install failed: ${(err as Error).message}. Re-run install-runner-npms.ps1.`,
      });
      continue;
    }

    results.push({
      pkg, approved: true, weeklyDownloads,
      reason: `auto-approved (${weeklyDownloads.toLocaleString()} weekly downloads) and installed`,
    });
  }

  return results;
}
