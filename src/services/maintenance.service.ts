/**
 * Maintenance mode — per-project release-runtime kill switch.
 *
 * When a project's maintenance mode is ON, every request to its release
 * frontend (/app/:id/*) returns a 503 maintenance HTML page instead of the
 * actual app. The development runtime is unaffected so the owner can keep
 * working.
 *
 * State is kept in-memory for fast reads on the hot request path, and
 * persisted to `projects/<id>/.maintenance` (empty file = ON) so it survives
 * server restarts without requiring a DB schema change.
 */

import fs from "fs";
import path from "path";

const PROJECTS_DIR = path.join(process.cwd(), "projects");
const FLAG_FILENAME = ".maintenance";

/** In-memory cache: projectId → boolean */
const cache = new Map<string, boolean>();

function flagPath(projectId: string): string {
  return path.join(PROJECTS_DIR, projectId, FLAG_FILENAME);
}

/** Read flag from disk (used on first access / cache miss). */
function readFromDisk(projectId: string): boolean {
  try {
    return fs.existsSync(flagPath(projectId));
  } catch {
    return false;
  }
}

export function isMaintenanceMode(projectId: string): boolean {
  if (cache.has(projectId)) return cache.get(projectId)!;
  const val = readFromDisk(projectId);
  cache.set(projectId, val);
  return val;
}

export function setMaintenanceMode(projectId: string, enabled: boolean): void {
  cache.set(projectId, enabled);
  const fp = flagPath(projectId);
  try {
    if (enabled) {
      // Ensure parent dir exists (project may not have been deployed yet).
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      // Touch the flag file.
      fs.writeFileSync(fp, "", "utf-8");
    } else {
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
  } catch (err) {
    console.error("[MaintenanceService] persist error:", err);
  }
}

export const MAINTENANCE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Maintenance</title>
<!-- Telegram Mini App SDK -->
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{
    min-height:100vh;
    display:flex;align-items:center;justify-content:center;
    background:#0a0a0c;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
    color:#fff;
    padding:24px;
  }
  .wrap{text-align:center;max-width:320px}
  .icon{font-size:52px;margin-bottom:20px;display:block;line-height:1}
  h1{font-size:22px;font-weight:700;margin-bottom:10px;color:#f4f4f5}
  p{font-size:14px;color:rgba(255,255,255,0.5);line-height:1.6}
  .badge{
    display:inline-block;margin-top:22px;
    padding:5px 14px;border-radius:20px;
    font-size:11px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;
    background:rgba(251,191,36,0.15);color:#fbbf24;
  }
</style>
</head>
<body>
<div class="wrap">
  <span class="icon">🔧</span>
  <h1>Under Maintenance</h1>
  <p>This app is temporarily unavailable while updates are being applied. Please check back soon.</p>
  <span class="badge">Maintenance mode</span>
</div>
<!-- Telegram Mini App init -->
<script>
  (function () {
    function _tg() {
      return window.Telegram && window.Telegram.WebApp || null;
    }
    var tg = _tg();
    if (tg) {
      tg.setHeaderColor("#0a0a0c");
      tg.setBottomBarColor("#0a0a0c");
      tg.setBackgroundColor("#0a0a0c");
      if (tg.requestFullscreen &&
          tg.platform && ['android', 'ios'].indexOf(tg.platform) !== -1) {
        tg.requestFullscreen();
      }
    }
  })();
</script>
</body>
</html>`;
