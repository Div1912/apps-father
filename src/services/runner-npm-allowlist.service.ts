import fs from "fs";
import path from "path";

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
