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

router.get("/:projectId/{*filePath}", async (req: Request, res: Response) => {
  const projectId = String(req.params.projectId);
  const rawParam = req.params.filePath;
  const rawPath = (Array.isArray(rawParam) ? rawParam.join("/") : String(rawParam || "")).replace(/^\/+/, "");
  const filePath = rawPath || "index.html";

  const baseDir = path.join(PROJECTS_DIR, projectId, "release", "frontend");

  const fullPath = path.join(baseDir, filePath);

  if (!fullPath.startsWith(path.join(PROJECTS_DIR, projectId))) {
    res.status(403).send("Forbidden");
    return;
  }

  const isIndex = filePath === "index.html" || filePath === "";

  if (!fs.existsSync(fullPath)) {
    if (isIndex || !rawPath) {
      const indexPath = path.join(baseDir, "index.html");
      if (fs.existsSync(indexPath)) {
        const html = await injectSplash(projectId, indexPath);
        res.type("html").send(html);
        return;
      }
    }
    res.status(404).send("Not found");
    return;
  }

  if (isIndex) {
    const html = await injectSplash(projectId, fullPath);
    res.type("html").send(html);
    return;
  }

  res.sendFile(fullPath);
});

async function injectSplash(projectId: string, htmlPath: string): Promise<string> {
  let html = fs.readFileSync(htmlPath, "utf-8");

  try {
    const splashDisabled = await hasFeature(projectId, "disable_splash");
    if (splashDisabled) return html;
  } catch {}

  if (html.includes("</body>")) {
    html = html.replace("</body>", SPLASH_HTML + "\n</body>");
  } else {
    html += SPLASH_HTML;
  }
  return html;
}

router.get("/:projectId", (req: Request, res: Response) => {
  res.redirect(`/app/${req.params.projectId}/`);
});

export default router;
