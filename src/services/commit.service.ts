import fs from "fs";
import path from "path";
import { prisma } from "../db";

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

function bustCache(projectDir: string): void {
  const indexPath = path.join(projectDir, "frontend", "index.html");
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
  async createCommit(projectId: string, message: string): Promise<number> {
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

    copyDirSync(path.join(projectDir, "frontend"), path.join(commitDir, "frontend"));
    copyDirSync(path.join(projectDir, "backend"), path.join(commitDir, "backend"));

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

  async releaseCurrentDev(projectId: string): Promise<number> {
    const projectDir = path.join(PROJECTS_DIR, projectId);
    const releaseDir = path.join(projectDir, "release");

    rmDirSync(releaseDir);
    fs.mkdirSync(releaseDir, { recursive: true });

    copyDirSync(path.join(projectDir, "frontend"), path.join(releaseDir, "frontend"));
    copyDirSync(path.join(projectDir, "backend"), path.join(releaseDir, "backend"));

    bustCache(path.join(releaseDir));

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

  async revertToCommit(projectId: string, commitNum: number): Promise<void> {
    const projectDir = path.join(PROJECTS_DIR, projectId);
    const commitDir = path.join(projectDir, "commits", String(commitNum));

    if (!fs.existsSync(commitDir)) {
      throw new Error(`Commit #${commitNum} not found on disk`);
    }

    rmDirSync(path.join(projectDir, "frontend"));
    rmDirSync(path.join(projectDir, "backend"));

    copyDirSync(path.join(commitDir, "frontend"), path.join(projectDir, "frontend"));
    copyDirSync(path.join(commitDir, "backend"), path.join(projectDir, "backend"));

    bustCache(projectDir);

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

  async migrateExistingProjects(): Promise<number> {
    const projects = await prisma.project.findMany({
      where: {
        status: { in: ["deployed", "released"] },
        releaseCommit: null,
      },
    });

    let migrated = 0;
    for (const project of projects) {
      const projectDir = path.join(PROJECTS_DIR, project.id);
      const frontendDir = path.join(projectDir, "frontend");
      const commitsDir = path.join(projectDir, "commits", "0");

      if (!fs.existsSync(frontendDir)) continue;
      if (fs.existsSync(commitsDir)) continue;

      try {
        copyDirSync(path.join(projectDir, "frontend"), path.join(commitsDir, "frontend"));
        copyDirSync(path.join(projectDir, "backend"), path.join(commitsDir, "backend"));

        const releaseDir = path.join(projectDir, "release");
        rmDirSync(releaseDir);
        fs.mkdirSync(releaseDir, { recursive: true });
        copyDirSync(path.join(projectDir, "frontend"), path.join(releaseDir, "frontend"));
        copyDirSync(path.join(projectDir, "backend"), path.join(releaseDir, "backend"));

        await prisma.version.create({
          data: {
            projectId: project.id,
            version: "0",
            changelog: "Initial version (migrated)",
          },
        });

        await prisma.project.update({
          where: { id: project.id },
          data: { releaseCommit: 0 },
        });

        migrated++;
        console.log(`[Migration] Project "${project.name}" (${project.id.substring(0, 8)}) → migrated to version control`);
      } catch (err) {
        console.error(`[Migration] Failed for project ${project.id.substring(0, 8)}:`, err);
      }
    }

    return migrated;
  }
}

export const commitService = new CommitService();
