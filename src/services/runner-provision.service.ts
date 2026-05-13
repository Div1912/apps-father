import { execFile, ExecFileException } from "child_process";
import { promisify } from "util";
import * as crypto from "crypto";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { config } from "../config";
import { prisma } from "../db";

const execFileP = promisify(execFile);

/**
 * Runner provisioning — creates and maintains the per-project Linux user and
 * filesystem layout under `config.runnerProjectsRoot`.
 *
 * Single source of truth for the username derivation:
 *   afp_<first 10 hex chars of sha256(projectId)>
 *
 * Linux usernames cap at 32 chars (16 on some toolchains). UUID v4 is 36 chars
 * so `afp_<projectId>` would exceed the limit. 10 hex = 40 bits; collision
 * probability across ~1k projects is ~10⁻⁸.
 *
 * All shell-out operations go through `execFile` (not `exec`) with a fixed
 * argv array to avoid shell injection. Functions are idempotent and safe to
 * call repeatedly.
 *
 * On a future non-root deployment, the implementation of these functions can
 * swap to shelling out to a privileged `runner/bin/afp-provision` helper
 * without changing the public API.
 */
class RunnerProvisionService {
  /** Deterministic Linux username for a project. */
  linuxUsername(projectId: string): string {
    const hash = crypto.createHash("sha256").update(projectId).digest("hex").slice(0, 10);
    return `afp_${hash}`;
  }

  /** Absolute path to a project's tree under the runner root. */
  projectRoot(projectId: string): string {
    return path.join(config.runnerProjectsRoot, projectId);
  }

  /** Per-runtime backend dir, e.g. /srv/.../<id>/release/backend. */
  backendDir(projectId: string, runtime: "release" | "development"): string {
    return path.join(this.projectRoot(projectId), runtime, "backend");
  }

  /** Per-runtime frontend dir, e.g. /srv/.../<id>/release/frontend. */
  frontendDir(projectId: string, runtime: "release" | "development"): string {
    return path.join(this.projectRoot(projectId), runtime, "frontend");
  }

  /** Per-runtime sqlite path. */
  dbPath(projectId: string, runtime: "release" | "development"): string {
    return path.join(this.projectRoot(projectId), runtime, "data", "db.sqlite");
  }

  /**
   * Best-effort `getent passwd <username>` check. Returns true on success.
   * Used to avoid double-`useradd` failures.
   */
  async userExists(username: string): Promise<boolean> {
    try {
      await execFileP("getent", ["passwd", username]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Look up `uid` and `gid` for a Linux user via /etc/passwd. Used by the
   * spawn() call so we drop privileges to the project user.
   */
  async resolveIds(username: string): Promise<{ uid: number; gid: number } | null> {
    try {
      const { stdout } = await execFileP("getent", ["passwd", username]);
      // Format: name:x:UID:GID:GECOS:home:shell
      const parts = stdout.trim().split(":");
      if (parts.length < 4) return null;
      const uid = parseInt(parts[2], 10);
      const gid = parseInt(parts[3], 10);
      if (Number.isNaN(uid) || Number.isNaN(gid)) return null;
      return { uid, gid };
    } catch {
      return null;
    }
  }

  /**
   * Create the Linux system user (no home, no login shell). Idempotent —
   * skips if already exists.
   */
  async ensureUser(username: string): Promise<void> {
    if (await this.userExists(username)) return;
    try {
      await execFileP("useradd", [
        "--system",
        "--no-create-home",
        "--shell",
        "/usr/sbin/nologin",
        username,
      ]);
    } catch (err) {
      // Race: another process may have created the user concurrently.
      if (await this.userExists(username)) return;
      throw err;
    }
  }

  /**
   * Create the canonical directory tree for a project:
   *   <root>/<id>/{release,development}/{frontend,backend,data,data/storage,data/tmp}
   * Idempotent.
   */
  async ensureLayout(projectId: string): Promise<void> {
    const root = this.projectRoot(projectId);
    for (const runtime of ["release", "development"] as const) {
      const sub = path.join(root, runtime);
      await fsp.mkdir(path.join(sub, "frontend"), { recursive: true });
      await fsp.mkdir(path.join(sub, "backend"), { recursive: true });
      await fsp.mkdir(path.join(sub, "data", "storage"), { recursive: true });
      await fsp.mkdir(path.join(sub, "data", "tmp"), { recursive: true });
    }
  }

  /**
   * `chown -R <U>:<U>` + chmod the project tree, then apply ACLs so root
   * keeps write access (default ACL inherits to new files).
   *
   * Best-effort: if `setfacl` is missing, log a warning and continue —
   * the install-runner.sh step is supposed to install it.
   */
  async fixupOwnership(projectId: string, subPath?: string): Promise<void> {
    const username = this.linuxUsername(projectId);
    const target = subPath
      ? path.join(this.projectRoot(projectId), subPath)
      : this.projectRoot(projectId);

    if (!fs.existsSync(target)) return;

    try {
      await execFileP("chown", ["-R", `${username}:${username}`, target]);
    } catch (err) {
      console.warn(`[RunnerProvision] chown failed for ${target}:`, (err as Error).message);
    }

    // Permission modes only on full provision — applying chmod recursively
    // on a subPath (e.g. a single new commit folder) would clobber the dir
    // mode 750 of the root.
    if (!subPath) {
      try {
        await execFileP("chmod", ["750", this.projectRoot(projectId)]);
        for (const runtime of ["release", "development"] as const) {
          const dataDir = path.join(this.projectRoot(projectId), runtime, "data");
          if (fs.existsSync(dataDir)) {
            await execFileP("chmod", ["700", dataDir]);
          }
        }
      } catch (err) {
        console.warn(`[RunnerProvision] chmod failed:`, (err as Error).message);
      }
    }

    // ACLs: u:root:rwx (current) + d:u:root:rwx (default for new files).
    // Run on the full root regardless of subPath — applying default ACL
    // on parent paths is correct and idempotent.
    const aclTarget = this.projectRoot(projectId);
    try {
      await execFileP("setfacl", ["-R", "-m", "u:root:rwx", aclTarget]);
      await execFileP("setfacl", ["-d", "-R", "-m", "u:root:rwx", aclTarget]);
    } catch (err) {
      const e = err as ExecFileException;
      // ENOENT for setfacl itself = acl package not installed. Not fatal on
      // a fresh box — install-runner.sh is supposed to install it.
      if (e.code === "ENOENT") {
        console.warn(
          "[RunnerProvision] setfacl not available — skipping ACL setup. " +
            "Run runner/install-runner.sh on this host."
        );
      } else {
        console.warn(`[RunnerProvision] setfacl failed for ${aclTarget}:`, e.message);
      }
    }
  }

  /**
   * Full one-shot provision: ensure user exists, create directory layout,
   * chown + ACL. Safe to re-run.
   *
   * Persists the cached `worker_username` on the Project row.
   */
  async provision(projectId: string): Promise<{ username: string }> {
    const username = this.linuxUsername(projectId);

    await this.ensureUser(username);
    await this.ensureLayout(projectId);
    await this.fixupOwnership(projectId);

    // Cache username for ops/admin visibility (idempotent; uses skipMissing).
    try {
      await prisma.project.update({
        where: { id: projectId },
        data: { workerUsername: username },
      });
    } catch (err) {
      // Project row may not exist (e.g. during admin smoke tests). Don't fail.
      console.warn(
        `[RunnerProvision] Could not persist worker_username for ${projectId}:`,
        (err as Error).message
      );
    }

    return { username };
  }
}

export const runnerProvisionService = new RunnerProvisionService();
