#!/usr/bin/env node
/* eslint-disable */
"use strict";

/**
 * scripts/migrate-to-runner-dev.js
 *
 * One-shot DEV migrator from the legacy in-process layout
 *   /opt/apps-father-dev/projects/<id>/{release,development}/{frontend,backend,data}
 * to the per-project worker layout
 *   /srv/apps-father/projects/<id>/{release,development}/{frontend,backend,data}
 * plus per-project Linux user provisioning (afp_<10hex(sha256(id))>).
 *
 * Frontend is migrated alongside backend/data: after this runs the platform
 * /app and /dev routes serve frontend assets from /srv (owned by the
 * per-project Linux user), keeping all project files in one isolated tree.
 *
 * Idempotent — safe to re-run. Each project is logged to migration-<ts>.log
 * with file counts per sub-tree (release+development × frontend+backend+data).
 *
 * Usage (on the DEV box, inside /opt/apps-father-dev):
 *   node scripts/migrate-to-runner-dev.js               # actually move
 *   node scripts/migrate-to-runner-dev.js --dry-run     # just plan
 *   node scripts/migrate-to-runner-dev.js --hostname-skip   # bypass guard (DANGEROUS)
 *
 * Hostname guard:
 *   By default we refuse to run unless `os.hostname()` resolves to one of:
 *     - apps-father-dev*
 *     - dev*
 *     - any host with /opt/apps-father-dev/ present and /opt/apps-father missing.
 *   Override with --hostname-skip if hostnames don't match the convention.
 */

const fs       = require("fs");
const fsp      = require("fs/promises");
const path     = require("path");
const os       = require("os");
const crypto   = require("crypto");
const { execFileSync, execSync } = require("child_process");

const DRY_RUN  = process.argv.includes("--dry-run");
const SKIP_GATE = process.argv.includes("--hostname-skip");
const SOURCE_ROOT = process.env.MIGRATE_SOURCE_ROOT || "/opt/apps-father-dev/projects";
const TARGET_ROOT = process.env.RUNNER_PROJECTS_ROOT || "/srv/apps-father/projects";
const APP_DIR     = process.env.APP_DIR || "/opt/apps-father-dev";

function log(...args) { console.log(...args); }
function err(...args) { console.error(...args); }

function fail(msg, code = 1) {
  err(`[migrate] FATAL: ${msg}`);
  process.exit(code);
}

// ── Hostname gate ───────────────────────────────────────────────────────────
function hostnameLooksLikeDev() {
  const h = (os.hostname() || "").toLowerCase();
  if (h.startsWith("apps-father-dev")) return true;
  if (h.startsWith("dev")) return true;
  if (fs.existsSync("/opt/apps-father-dev") && !fs.existsSync("/opt/apps-father")) return true;
  return false;
}
if (!SKIP_GATE && !hostnameLooksLikeDev()) {
  fail(
    `hostname '${os.hostname()}' does not look like the DEV box, refusing.\n` +
    `If you are 100% sure, re-run with --hostname-skip.`,
  );
}

if (!fs.existsSync(SOURCE_ROOT)) {
  log(`[migrate] SOURCE_ROOT ${SOURCE_ROOT} does not exist — nothing to migrate.`);
  process.exit(0);
}

// ── Prisma ──────────────────────────────────────────────────────────────────
let prisma;
try {
  process.chdir(APP_DIR);
} catch {}
try {
  const { PrismaClient } = require(path.join(APP_DIR, "node_modules/@prisma/client"));
  prisma = new PrismaClient();
} catch (e) {
  fail(`Could not load @prisma/client from ${APP_DIR}/node_modules: ${e.message}`);
}

// ── Helpers ────────────────────────────────────────────────────────────────
function linuxUsername(projectId) {
  const hash = crypto.createHash("sha256").update(projectId).digest("hex").slice(0, 10);
  return `afp_${hash}`;
}

function userExists(name) {
  try {
    execFileSync("getent", ["passwd", name], { stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch { return false; }
}

function ensureUser(name) {
  if (DRY_RUN) { log(`  → [dry-run] would useradd ${name}`); return; }
  if (userExists(name)) return;
  execFileSync("useradd", ["--no-create-home", "--gid", "nogroup", "--shell", "/usr/sbin/nologin", name]);
}

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return 0;
  fs.mkdirSync(dest, { recursive: true });
  let files = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) files += copyDirRecursive(s, d);
    else if (entry.isFile()) {
      fs.copyFileSync(s, d);
      files++;
    }
  }
  return files;
}

function maybeRenameDb(dataDir) {
  const legacy = path.join(dataDir, "app.db");
  const current = path.join(dataDir, "db.sqlite");
  try {
    if (fs.existsSync(legacy) && !fs.existsSync(current)) {
      if (DRY_RUN) {
        log(`  → [dry-run] would rename ${legacy} → ${current}`);
      } else {
        fs.renameSync(legacy, current);
      }
    }
  } catch (e) {
    err(`  ! db rename failed at ${dataDir}: ${e.message}`);
  }
}

function ensureProjectLayout(projectId) {
  const root = path.join(TARGET_ROOT, projectId);
  for (const runtime of ["release", "development"]) {
    const sub = path.join(root, runtime);
    if (DRY_RUN) {
      log(`  → [dry-run] would mkdir -p ${sub}/{frontend,backend,data/storage,data/tmp}`);
      continue;
    }
    fs.mkdirSync(path.join(sub, "frontend"), { recursive: true });
    fs.mkdirSync(path.join(sub, "backend"), { recursive: true });
    fs.mkdirSync(path.join(sub, "data", "storage"), { recursive: true });
    fs.mkdirSync(path.join(sub, "data", "tmp"), { recursive: true });
  }
}

/**
 * Copy frontend/, backend/, data/ from the legacy in-process tree to the
 * isolated /srv tree, per runtime.
 *
 * Frontend is part of this migration: post-migration, /app and /dev routes
 * read frontend assets from /srv (see app.routes.ts / dev.routes.ts) so the
 * per-project Linux user owns its own static files.
 *
 * Idempotent — safe to re-run. Returns a summary of what was synced so the
 * caller can log it for audit.
 */
function copyFromLegacy(projectId) {
  const summary = {
    release:     { frontend: 0, backend: 0, data: 0, present: false },
    development: { frontend: 0, backend: 0, data: 0, present: false },
  };

  const src = path.join(SOURCE_ROOT, projectId);
  const dst = path.join(TARGET_ROOT, projectId);
  if (!fs.existsSync(src)) return summary;

  for (const runtime of ["release", "development"]) {
    const subSrc = path.join(src, runtime);
    const subDst = path.join(dst, runtime);
    if (!fs.existsSync(subSrc)) continue;
    summary[runtime].present = true;
    if (DRY_RUN) { log(`  → [dry-run] would copy ${subSrc} → ${subDst}`); continue; }

    summary[runtime].frontend = copyDirRecursive(path.join(subSrc, "frontend"), path.join(subDst, "frontend"));
    summary[runtime].backend  = copyDirRecursive(path.join(subSrc, "backend"),  path.join(subDst, "backend"));
    summary[runtime].data     = copyDirRecursive(path.join(subSrc, "data"),     path.join(subDst, "data"));
    maybeRenameDb(path.join(subDst, "data"));
  }

  return summary;
}

function applyOwnership(projectId) {
  const username = linuxUsername(projectId);
  const target = path.join(TARGET_ROOT, projectId);
  if (DRY_RUN) {
    log(`  → [dry-run] would chown -R ${username}:nogroup ${target}`);
    log(`  → [dry-run] would chmod 750 + 700 on data dirs`);
    log(`  → [dry-run] would setfacl u:root:rwx (current+default)`);
    return;
  }
  try { execFileSync("chown", ["-R", `${username}:nogroup`, target]); } catch (e) {
    err(`  ! chown failed: ${e.message}`);
  }
  try { execFileSync("chmod", ["750", target]); } catch (e) {
    err(`  ! chmod failed: ${e.message}`);
  }
  for (const runtime of ["release", "development"]) {
    const dataDir = path.join(target, runtime, "data");
    if (fs.existsSync(dataDir)) {
      try { execFileSync("chmod", ["700", dataDir]); } catch {}
    }
  }
  try {
    execFileSync("setfacl", ["-R", "-m", "u:root:rwx", target]);
    execFileSync("setfacl", ["-d", "-R", "-m", "u:root:rwx", target]);
  } catch (e) {
    err(`  ! setfacl failed: ${e.message} — run runner/install-runner.sh first.`);
  }
}

// ── Main loop ───────────────────────────────────────────────────────────────
async function main() {
  log(`[migrate] hostname=${os.hostname()} dry-run=${DRY_RUN}`);
  log(`[migrate] SOURCE_ROOT=${SOURCE_ROOT}`);
  log(`[migrate] TARGET_ROOT=${TARGET_ROOT}`);

  if (!DRY_RUN) {
    fs.mkdirSync(TARGET_ROOT, { recursive: true });
    try { execFileSync("chmod", ["711", TARGET_ROOT]); } catch {}
  }

  const projects = await prisma.project.findMany({
    select: { id: true, name: true, workerUsername: true, workerPort: true },
    orderBy: { createdAt: "asc" },
  });
  log(`[migrate] ${projects.length} project(s) found in DB`);

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(__dirname, `migration-${ts}.log`);
  const logStream = DRY_RUN ? null : fs.createWriteStream(logPath, { flags: "a" });

  let ok = 0, skipped = 0, failed = 0;

  for (const project of projects) {
    const username = linuxUsername(project.id);
    const label = `[${project.id.slice(0, 8)} @${username}] ${project.name || ""}`;
    log(`\n→ ${label}`);

    try {
      ensureUser(username);
      ensureProjectLayout(project.id);
      const synced = copyFromLegacy(project.id);
      applyOwnership(project.id);

      if (!DRY_RUN) {
        // Persist worker_username; clear worker_port so it's allocated lazily.
        await prisma.project.update({
          where: { id: project.id },
          data: { workerUsername: username, workerPort: null },
        });
      }

      ok++;
      logStream?.write(
        `${project.id},${username},success,` +
          `rel(fe=${synced.release.frontend},be=${synced.release.backend},data=${synced.release.data}),` +
          `dev(fe=${synced.development.frontend},be=${synced.development.backend},data=${synced.development.data})\n`,
      );
      const fmt = (label, s) =>
        s.present
          ? `${label}: frontend=${s.frontend} backend=${s.backend} data=${s.data}`
          : `${label}: (missing)`;
      log(`  ✓ migrated`);
      log(`     ${fmt("release", synced.release)}`);
      log(`     ${fmt("development", synced.development)}`);
    } catch (e) {
      failed++;
      logStream?.write(`${project.id},${username},failed,${(e.message || "").replace(/[\r\n,]/g, " ")}\n`);
      err(`  ✗ failed: ${e.message}`);
    }
  }

  log(`\n[migrate] done — ok=${ok} skipped=${skipped} failed=${failed}`);
  if (logStream) {
    logStream.end();
    log(`[migrate] log written to ${logPath}`);
  }

  await prisma.$disconnect();
  process.exit(failed > 0 ? 2 : 0);
}

main().catch((e) => {
  err("[migrate] uncaught:", e);
  prisma.$disconnect().finally(() => process.exit(1));
});
