import { Router, Request, Response } from "express";
import path from "path";
import fs from "fs";
import { hasFeature } from "../../services/features.service";

const router = Router();
const PROJECTS_DIR = path.join(process.cwd(), "projects");

// Splash shown over the player iframe while the user's app boots.
// Animation spec (1800 ms total, linear):
//   0%      → scale 1.0,    opacity 0
//   ~27.8%  → scale 1.0278, opacity 1   (500 ms fade-in done)
//   ~72.2%  → scale 1.0722, opacity 1   (500 ms fade-out begins)
//   100%    → scale 1.1,    opacity 0
// The percentages keep scale strictly linear from 1.0 → 1.1 across the
// full duration while the opacity in/out happens at the first/last 500 ms.
const SPLASH_HTML = `
<style>
@keyframes af-splash-logo {
  0%      { transform: scale(1);      opacity: 0; }
  27.778% { transform: scale(1.0278); opacity: 1; }
  72.222% { transform: scale(1.0722); opacity: 1; }
  100%    { transform: scale(1.1);    opacity: 0; }
}
</style>
<div id="af-splash" style="position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;background:#000000;pointer-events:none">
<img src="https://apps-father.com/splash-logo.png" alt="" style="max-width:60vw;max-height:32vh;width:auto;height:auto;animation:af-splash-logo 1800ms linear forwards;will-change:transform,opacity"/>
<div style="display:none">Make your app with no code</div>
</div>
<script>setTimeout(function(){var s=document.getElementById('af-splash');if(s)s.remove()},1800)</script>`;

function rewriteApiPaths(content: string, projectId: string): string {
  content = content.split("/api/" + projectId).join("/devapi/" + projectId);
  content = content.split("/ws/" + projectId).join("/devws/" + projectId);
  return content;
}

// ── Dev Tools: Visual Editor + Bug Reporter ──────────────────────────────────
// Logic lives in af-devtools.js. tsc doesn't copy .js assets, so deploy-full.ps1
// manually copies src/web/routes/af-devtools.js → dist/web/routes/af-devtools.js.
// We try __dirname first (compiled), then fall back to src/ for ts-node local dev.
function resolveDevtoolsPath(): string {
  const fromDist = path.join(__dirname, "af-devtools.js");
  if (fs.existsSync(fromDist)) return fromDist;
  // ts-node: __dirname is already src/web/routes, but check src explicitly too
  const fromSrc = path.join(process.cwd(), "src", "web", "routes", "af-devtools.js");
  if (fs.existsSync(fromSrc)) return fromSrc;
  return fromDist; // will throw a readable error on readFileSync if missing
}
const DEVTOOLS_JS_PATH = resolveDevtoolsPath();

function buildDevToolsScript(projectId: string): string {
  const safeId = projectId.replace(/[^a-zA-Z0-9_-]/g, "");
  try {
    const js = fs.readFileSync(DEVTOOLS_JS_PATH, "utf-8").replace(/__AFPID__/g, safeId);
    return `<script id="_af_dt">\n${js}\n</script>`;
  } catch (e) {
    console.error("[DevTools] Could not load af-devtools.js from", DEVTOOLS_JS_PATH, e);
    return ""; // degrade gracefully — app still loads, just without the editor
  }
}

router.get("/:projectId/{*filePath}", async (req: Request, res: Response) => {
  const projectId = String(req.params.projectId);
  const rawParam = req.params.filePath;
  const rawPath = (Array.isArray(rawParam) ? rawParam.join("/") : String(rawParam || "")).replace(/^\/+/, "");
  const filePath = rawPath || "index.html";

  const fullPath = path.join(PROJECTS_DIR, projectId, "development", "frontend", filePath);

  if (!fullPath.startsWith(path.join(PROJECTS_DIR, projectId))) {
    res.status(403).send("Forbidden");
    return;
  }

  const isIndex = filePath === "index.html" || filePath === "";

  if (!fs.existsSync(fullPath)) {
    if (isIndex || !rawPath) {
      const indexPath = path.join(PROJECTS_DIR, projectId, "development", "frontend", "index.html");
      if (fs.existsSync(indexPath)) {
        const html = await injectDevTools(projectId, indexPath);
        res.type("html").send(rewriteApiPaths(html, projectId));
        return;
      }
    }
    res.status(404).send("Not found");
    return;
  }

  if (isIndex) {
    const html = await injectDevTools(projectId, fullPath);
    res.type("html").send(rewriteApiPaths(html, projectId));
    return;
  }

  if (filePath.endsWith(".js")) {
    const content = fs.readFileSync(fullPath, "utf-8");
    res.type("js").send(rewriteApiPaths(content, projectId));
    return;
  }

  res.sendFile(fullPath);
});

const AF_SDK_TAG = `<script src="/af-sdk.js"></script>`;

async function injectDevTools(projectId: string, htmlPath: string): Promise<string> {
  let html = fs.readFileSync(htmlPath, "utf-8");

  // Inject AF SDK at the very start of <head> so it's available before any
  // user script runs. Skip if the page already includes it.
  if (!html.includes("/af-sdk.js")) {
    if (html.includes("<head>")) {
      html = html.replace("<head>", "<head>\n" + AF_SDK_TAG);
    } else {
      html = AF_SDK_TAG + "\n" + html;
    }
  }

  const devTools = buildDevToolsScript(projectId);

  let splash = SPLASH_HTML;
  try {
    const splashDisabled = await hasFeature(projectId, "disable_splash");
    if (splashDisabled) splash = "";
  } catch {}

  const inject = (splash ? splash + "\n" : "") + devTools;

  if (html.includes("</body>")) {
    html = html.replace("</body>", inject + "\n</body>");
  } else {
    html += inject;
  }
  return html;
}

router.get("/:projectId", (req: Request, res: Response) => {
  res.redirect(`/dev/${req.params.projectId}/`);
});

export default router;
