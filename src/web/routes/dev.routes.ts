import { Router, Request, Response } from "express";
import path from "path";
import fs from "fs";
import { hasFeature } from "../../services/features.service";

const router = Router();
const PROJECTS_DIR = path.join(process.cwd(), "projects");

const SPLASH_HTML = `
<div id="af-splash" style="position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;background:#000000;flex-direction:column;gap:12px;opacity:1;transition:opacity .5s ease;pointer-events:none">
<div style="font-size:32px;font-weight:800;background:linear-gradient(135deg,#6366f1,#a78bfa);-webkit-background-clip:text;-webkit-text-fill-color:transparent;letter-spacing:-0.5px;background:url(https://i.postimg.cc/BZKFqnqh/welcome-2.png);background-size:contain;background-repeat:no-repeat;background-position:center;width:400px;height:98px"></div>
<div style="font-size:12px;color:#71717a;letter-spacing:1px;margin-top:-32px;margin-left:12px">Made by Apps Father bot</div>
</div>
<script>setTimeout(function(){var s=document.getElementById('af-splash');if(s){s.style.opacity='0';setTimeout(function(){s.remove()},500)}},1800)</script>`;

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

async function injectDevTools(projectId: string, htmlPath: string): Promise<string> {
  let html = fs.readFileSync(htmlPath, "utf-8");

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
