import fs from "fs";
import path from "path";
import { prisma } from "../db";
import { validateRoutesSecurity } from "./agent/security-validator";

const PROJECTS_DIR = path.join(process.cwd(), "projects");

function copyDirSync(src: string, dest: string) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function rmDirSync(dir: string) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function bustCache(dir: string): void {
  const indexPath = path.join(dir, "frontend", "index.html");
  if (!fs.existsSync(indexPath)) return;
  try {
    const v = Date.now();
    let html = fs.readFileSync(indexPath, "utf-8");
    html = html.replace(
      /(href|src)="([^"]+\.(css|js))(\?[^"]*)?"/g,
      (_, attr, file) => `${attr}="${file}?v=${v}"`
    );
    fs.writeFileSync(indexPath, html, "utf-8");
  } catch {}
}

class CommitService {
  /**
   * Prepare a new commit folder for the agent to work in.
   * Copies latest commit (or development/) into commits/N+1/.
   */
  async prepareCommitFolder(projectId: string): Promise<{ commitDir: string; commitNum: number }> {
    const projectDir = path.join(PROJECTS_DIR, projectId);
    const commitsDir = path.join(projectDir, "commits");
    fs.mkdirSync(commitsDir, { recursive: true });

    const existing = await prisma.version.findMany({
      where: { projectId },
      orderBy: { id: "desc" },
      take: 1,
    });

    let commitNum = 0;
    if (existing.length > 0) {
      const parsed = parseInt(existing[0].version, 10);
      commitNum = isNaN(parsed) ? 0 : parsed + 1;
    }

    const commitDir = path.join(commitsDir, String(commitNum));
    rmDirSync(commitDir);
    fs.mkdirSync(commitDir, { recursive: true });

    const prevCommitDir = commitNum > 0
      ? path.join(commitsDir, String(commitNum - 1))
      : null;

    if (prevCommitDir && fs.existsSync(prevCommitDir)) {
      copyDirSync(path.join(prevCommitDir, "frontend"), path.join(commitDir, "frontend"));
      copyDirSync(path.join(prevCommitDir, "backend"), path.join(commitDir, "backend"));
      // Carry forward context.md from previous commit
      const prevContext = path.join(prevCommitDir, "context.md");
      if (fs.existsSync(prevContext)) {
        fs.copyFileSync(prevContext, path.join(commitDir, "context.md"));
      }
    } else {
      const devDir = path.join(projectDir, "development");
      if (fs.existsSync(path.join(devDir, "frontend"))) {
        copyDirSync(path.join(devDir, "frontend"), path.join(commitDir, "frontend"));
      }
      if (fs.existsSync(path.join(devDir, "backend"))) {
        copyDirSync(path.join(devDir, "backend"), path.join(commitDir, "backend"));
      }
    }

    fs.mkdirSync(path.join(commitDir, "frontend"), { recursive: true });
    fs.mkdirSync(path.join(commitDir, "backend"), { recursive: true });

    // Overlay assets from development/ (handles newly uploaded files)
    const devAssets = path.join(projectDir, "development", "frontend", "assets");
    if (fs.existsSync(devAssets)) {
      copyDirSync(devAssets, path.join(commitDir, "frontend", "assets"));
    }

    console.log(`[Commit] Prepared commit #${commitNum} for project ${projectId.substring(0, 8)}`);
    return { commitDir, commitNum };
  }

  /**
   * Copy commit folder contents to development/ for live testing.
   */
  syncToDev(projectId: string, commitDir: string): void {
    const projectDir = path.join(PROJECTS_DIR, projectId);
    const devDir = path.join(projectDir, "development");

    rmDirSync(path.join(devDir, "frontend"));
    rmDirSync(path.join(devDir, "backend"));

    copyDirSync(path.join(commitDir, "frontend"), path.join(devDir, "frontend"));
    copyDirSync(path.join(commitDir, "backend"), path.join(devDir, "backend"));

    fs.mkdirSync(path.join(devDir, "data"), { recursive: true });

    bustCache(devDir);
    console.log(`[Commit] Synced to development/ for project ${projectId.substring(0, 8)}`);
  }

  /**
   * Finalize a commit: create DB record, copy agent log, sync to development/.
   */
  async createCommit(projectId: string, message: string, commitNum: number, commitDir: string, logPath?: string): Promise<number> {
    if (logPath && fs.existsSync(logPath)) {
      try {
        fs.copyFileSync(logPath, path.join(commitDir, "agent.log"));
      } catch {}
    }

    this.syncToDev(projectId, commitDir);

    await prisma.version.create({
      data: {
        projectId,
        version: String(commitNum),
        changelog: message,
      },
    });

    console.log(`[Commit] Project ${projectId.substring(0, 8)} → commit #${commitNum}: ${message.substring(0, 60)}`);
    return commitNum;
  }

  /**
   * Release: copy development/ code to release/ (preserving release DB).
   */
  async releaseCurrentDev(projectId: string): Promise<number> {
    const projectDir = path.join(PROJECTS_DIR, projectId);
    const devDir = path.join(projectDir, "development");
    const releaseDir = path.join(projectDir, "release");

    // Defense-in-depth: re-run the security validator on the dev backend
    // before promoting to release. deploy_to_dev already blocks backdoors,
    // but this catches any path that bypasses the agent (manual file edits,
    // revertToCommit of an old commit written before the validator existed,
    // etc.) so unsafe code never reaches the production release/ directory.
    const devRoutesPath = path.join(devDir, "backend", "routes.js");
    if (fs.existsSync(devRoutesPath)) {
      try {
        const devRoutesContent = fs.readFileSync(devRoutesPath, "utf-8");
        const securityError = validateRoutesSecurity(devRoutesContent);
        if (securityError) {
          console.warn(
            `[SecurityValidator] BLOCKED release for project ${projectId.substring(0, 8)} — ${securityError.split("\n")[0]}`,
          );
          throw new Error(securityError);
        }
      } catch (err: any) {
        if (err?.message?.startsWith("Security validator BLOCKED")) throw err;
      }
    }

    rmDirSync(path.join(releaseDir, "frontend"));
    rmDirSync(path.join(releaseDir, "backend"));
    fs.mkdirSync(releaseDir, { recursive: true });

    copyDirSync(path.join(devDir, "frontend"), path.join(releaseDir, "frontend"));
    copyDirSync(path.join(devDir, "backend"), path.join(releaseDir, "backend"));

    const releaseDbDir = path.join(releaseDir, "data");
    fs.mkdirSync(releaseDbDir, { recursive: true });
    const releaseDbPath = path.join(releaseDbDir, "app.db");
    if (!fs.existsSync(releaseDbPath)) {
      const devDbPath = path.join(devDir, "data", "app.db");
      if (fs.existsSync(devDbPath)) {
        fs.copyFileSync(devDbPath, releaseDbPath);
        console.log(`[Release] Seeded release DB from development for project ${projectId.substring(0, 8)}`);
      }
    }

    bustCache(releaseDir);

    const latest = await prisma.version.findFirst({
      where: { projectId },
      orderBy: { id: "desc" },
    });

    const commitNum = latest ? parseInt(latest.version, 10) || 0 : 0;

    await prisma.project.update({
      where: { id: projectId },
      data: { releaseCommit: commitNum, status: "released" },
    });

    console.log(`[Release] Project ${projectId.substring(0, 8)} → released commit #${commitNum}`);
    return commitNum;
  }

  /**
   * Revert: restore commits/N/ to development/, delete newer commits.
   */
  async revertToCommit(projectId: string, commitNum: number): Promise<void> {
    const projectDir = path.join(PROJECTS_DIR, projectId);
    const commitDir = path.join(projectDir, "commits", String(commitNum));

    if (!fs.existsSync(commitDir)) {
      throw new Error(`Commit #${commitNum} not found on disk`);
    }

    this.syncToDev(projectId, commitDir);

    const allCommits = await prisma.version.findMany({
      where: { projectId },
      orderBy: { id: "asc" },
    });

    const toDelete: number[] = [];
    for (const v of allCommits) {
      const num = parseInt(v.version, 10);
      if (!isNaN(num) && num > commitNum) {
        toDelete.push(v.id);
        rmDirSync(path.join(projectDir, "commits", String(num)));
      }
    }

    if (toDelete.length > 0) {
      await prisma.version.deleteMany({ where: { id: { in: toDelete } } });
    }

    console.log(`[Revert] Project ${projectId.substring(0, 8)} → reverted to commit #${commitNum}, deleted ${toDelete.length} newer commit(s)`);
  }

  async getCommits(projectId: string) {
    return prisma.version.findMany({
      where: { projectId },
      orderBy: { id: "desc" },
    });
  }

  getLogPath(projectId: string, commitNum: number): string | null {
    const logFile = path.join(PROJECTS_DIR, projectId, "commits", String(commitNum), "agent.log");
    return fs.existsSync(logFile) ? logFile : null;
  }

  getDetailedLogPath(projectId: string, commitNum: number): string | null {
    const file = path.join(PROJECTS_DIR, projectId, "commits", String(commitNum), "detailed-log.json");
    return fs.existsSync(file) ? file : null;
  }

  /**
   * Migrate existing projects from old layout (root frontend/backend/data)
   * to new layout (development/, release/data/).
   */
  async migrateExistingProjects(): Promise<number> {
    const projects = await prisma.project.findMany({
      where: {
        status: { in: ["deployed", "released", "building", "planning", "created", "error"] },
      },
    });

    let migrated = 0;
    for (const project of projects) {
      const projectDir = path.join(PROJECTS_DIR, project.id);
      const oldFrontend = path.join(projectDir, "frontend");
      const devDir = path.join(projectDir, "development");

      if (!fs.existsSync(oldFrontend)) continue;
      if (fs.existsSync(path.join(devDir, "frontend"))) continue;

      try {
        fs.mkdirSync(devDir, { recursive: true });
        copyDirSync(path.join(projectDir, "frontend"), path.join(devDir, "frontend"));
        copyDirSync(path.join(projectDir, "backend"), path.join(devDir, "backend"));

        const oldDataDir = path.join(projectDir, "data");
        const devDataDir = path.join(devDir, "data");
        fs.mkdirSync(devDataDir, { recursive: true });
        if (fs.existsSync(path.join(oldDataDir, "app.db"))) {
          fs.copyFileSync(path.join(oldDataDir, "app.db"), path.join(devDataDir, "app.db"));
        }

        const releaseDir = path.join(projectDir, "release");
        if (fs.existsSync(releaseDir)) {
          const releaseDataDir = path.join(releaseDir, "data");
          fs.mkdirSync(releaseDataDir, { recursive: true });
          if (!fs.existsSync(path.join(releaseDataDir, "app.db")) && fs.existsSync(path.join(oldDataDir, "app.db"))) {
            fs.copyFileSync(path.join(oldDataDir, "app.db"), path.join(releaseDataDir, "app.db"));
          }
        }

        const commitsDir = path.join(projectDir, "commits");
        if (!fs.existsSync(path.join(commitsDir, "0"))) {
          fs.mkdirSync(path.join(commitsDir, "0"), { recursive: true });
          copyDirSync(path.join(projectDir, "frontend"), path.join(commitsDir, "0", "frontend"));
          copyDirSync(path.join(projectDir, "backend"), path.join(commitsDir, "0", "backend"));

          const existingVersion = await prisma.version.findFirst({ where: { projectId: project.id } });
          if (!existingVersion) {
            await prisma.version.create({
              data: { projectId: project.id, version: "0", changelog: "Initial version (migrated)" },
            });
          }

          if (project.releaseCommit === null) {
            await prisma.project.update({
              where: { id: project.id },
              data: { releaseCommit: 0 },
            });
          }
        }

        rmDirSync(path.join(projectDir, "frontend"));
        rmDirSync(path.join(projectDir, "backend"));
        rmDirSync(path.join(projectDir, "data"));

        migrated++;
        console.log(`[Migration] Project "${project.name}" (${project.id.substring(0, 8)}) → migrated to new layout`);
      } catch (err) {
        console.error(`[Migration] Failed for project ${project.id.substring(0, 8)}:`, err);
      }
    }

    return migrated;
  }
}

export const commitService = new CommitService();
