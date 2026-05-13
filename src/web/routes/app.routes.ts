import { Router, Request, Response } from "express";
import path from "path";
import fs from "fs";
import { hasFeature } from "../../services/features.service";
import { prisma } from "../../db";
import { config } from "../../config";
import { runnerProvisionService } from "../../services/runner-provision.service";
import { isMaintenanceMode, MAINTENANCE_HTML } from "../../services/maintenance.service";

const router = Router();
const PROJECTS_DIR = path.join(process.cwd(), "projects");

/**
 * Resolve the directory that holds the release frontend for a project.
 *
 * In worker mode the source of truth is the per-project, isolated tree under
 * /srv/apps-father/projects/<id>/release/frontend (owned by the project's
 * Linux user). The platform-managed cwd/projects copy is treated as a
 * fallback for projects that haven't been migrated to /srv yet.
 */
function resolveReleaseFrontendDir(projectId: string): string {
  if (config.runtimeMode === "worker") {
    const srvDir = runnerProvisionService.frontendDir(projectId, "release");
    if (fs.existsSync(srvDir)) return srvDir;
  }
  return path.join(PROJECTS_DIR, projectId, "release", "frontend");
}

const SPLASH_HTML = `<style>
@keyframes af-splash-logo {
  0%      { transform: scale(1);      opacity: 0; }
  27.778% { transform: scale(1.0278); opacity: 1; }
  72.222% { transform: scale(1.0722); opacity: 1; }
  100%    { transform: scale(1.1);    opacity: 0; }
}
</style>
<div id="af-splash" style="position:fixed;inset:0;z-index:999999;display:flex;align-items:center;justify-content:center;background:#000000;pointer-events:none">
<img src="https://dev.apps-father.com/splash-logo.png" alt="" style="max-width:60vw;max-height:32vh;width:auto;height:auto;animation:af-splash-logo 1800ms linear forwards;will-change:transform,opacity"/>
<div style="display:none">Make your app with no code</div>
</div>
<script>setTimeout(function(){var s=document.getElementById('af-splash');if(s)s.remove()},1800)</script>`;

router.get("/:projectId/{*filePath}", async (req: Request, res: Response) => {
  const projectId = String(req.params.projectId);

  // Maintenance mode: block all release-runtime requests for this project.
  if (isMaintenanceMode(projectId)) {
    res.status(503).type("html").send(MAINTENANCE_HTML);
    return;
  }

  const rawParam = req.params.filePath;
  const rawPath = (Array.isArray(rawParam) ? rawParam.join("/") : String(rawParam || "")).replace(/^\/+/, "");
  const filePath = rawPath || "index.html";

  const baseDir = resolveReleaseFrontendDir(projectId);

  const fullPath = path.join(baseDir, filePath);

  // Path-traversal guard: resolved absolute path must remain inside baseDir.
  const resolved = path.resolve(fullPath);
  const resolvedBase = path.resolve(baseDir);
  if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
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

function buildErrorMonitorScript(ownerTelegramId: number, projectId: string): string {
  return `<script>
(function(){
  var OID=${ownerTelegramId},PID="${projectId}",shown=false;
  function uid(){try{var t=window.Telegram&&window.Telegram.WebApp;return t&&t.initDataUnsafe&&t.initDataUnsafe.user?t.initDataUnsafe.user.id:null}catch(e){return null}}
  function showErr(msg,stack){
    if(shown)return;
    if(uid()!==OID)return;
    shown=true;
    var o=document.createElement('div');
    o.id='_af_err';
    o.style.cssText='position:fixed;inset:0;z-index:2147483647;background:rgba(10,10,12,0.97);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,sans-serif';
    var shortMsg=(msg||'Unknown error').toString().slice(0,200);
    var shortStack=(stack||'').toString().split('\\n').slice(0,6).join('\\n');
    o.innerHTML='<div style="max-width:480px;width:100%">'
      +'<div style="font-size:36px;text-align:center;margin-bottom:12px">🐛</div>'
      +'<div style="font-size:18px;font-weight:700;color:#f87171;text-align:center;margin-bottom:8px">Error in your app</div>'
      +'<div style="font-size:13px;color:#fca5a5;margin-bottom:16px;text-align:center">Only you see this — your users are not affected</div>'
      +'<div style="background:#1c1c1e;border:1px solid #3f3f46;border-radius:10px;padding:14px;margin-bottom:16px;font-size:12px;color:#e4e4e7;font-family:monospace;white-space:pre-wrap;word-break:break-all;max-height:180px;overflow-y:auto">'+shortMsg+(shortStack?'\\n\\n'+shortStack:'')+'</div>'
      +'<button id="_af_send" style="width:100%;padding:14px;background:#2563eb;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;margin-bottom:10px">Send to fix</button>'
      +'<div style="text-align:center"><button id="_af_dis" style="background:none;border:none;color:#71717a;font-size:13px;cursor:pointer;text-decoration:underline">Dismiss</button></div>'
      +'</div>';
    document.body.appendChild(o);
    document.getElementById('_af_dis').onclick=function(){o.remove();shown=false};
    document.getElementById('_af_send').onclick=function(){
      var btn=document.getElementById('_af_send');
      btn.disabled=true;btn.textContent='Sending...';
      fetch('/telegram-mini-app/api/error-report/'+PID,{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({message:msg,stack:stack,url:location.href})
      }).then(function(){
        btn.textContent='✓ Sent! The agent will fix it';
        btn.style.background='#16a34a';
        setTimeout(function(){try{window.Telegram.WebApp.close()}catch(e){}o.remove();shown=false},2000);
      }).catch(function(){
        btn.textContent='Failed — try again';
        btn.style.background='#dc2626';
        btn.disabled=false;
      });
    };
  }
  window.onerror=function(m,s,l,c,e){showErr(String(m),e&&e.stack?e.stack:m+' at '+s+':'+l);return false};
  window.addEventListener('unhandledrejection',function(e){
    var r=e.reason,m=r&&r.message?r.message:String(r),s=r&&r.stack?r.stack:m;
    showErr(m,s);
  });
  var _origFetch=window.fetch;
  window.fetch=function(){
    var args=arguments,u=typeof args[0]==='string'?args[0]:(args[0]&&args[0].url?args[0].url:'');
    return _origFetch.apply(this,args).then(function(r){
      if(r.status>=500&&u.indexOf('/af-error-report')===-1&&u.indexOf('/telegram-mini-app/api')===-1){
        showErr('HTTP '+r.status+' from '+u,'fetch '+u+' returned status '+r.status);
      }
      return r;
    });
  };
})();
</script>`;
}

async function getOwnerTelegramId(projectId: string): Promise<number | null> {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { userId: true },
    });
    if (!project) return null;
    const user = await prisma.user.findUnique({
      where: { id: project.userId },
      select: { telegramId: true },
    });
    return user ? Number(user.telegramId) : null;
  } catch {
    return null;
  }
}

const AF_SDK_TAG = `<script src="/af-sdk.js"></script>`;

async function injectSplash(projectId: string, htmlPath: string): Promise<string> {
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

  try {
    const splashDisabled = await hasFeature(projectId, "disable_splash");
    if (splashDisabled) return html;
  } catch {}

  const ownerTelegramId = await getOwnerTelegramId(projectId);
  const errorMonitor = ownerTelegramId ? buildErrorMonitorScript(ownerTelegramId, projectId) : "";

  const inject = SPLASH_HTML + "\n" + errorMonitor;

  if (html.includes("</body>")) {
    html = html.replace("</body>", inject + "\n</body>");
  } else {
    html += inject;
  }
  return html;
}

router.get("/:projectId", (req: Request, res: Response) => {
  const pid = String(req.params.projectId);
  if (isMaintenanceMode(pid)) {
    res.status(503).type("html").send(MAINTENANCE_HTML);
    return;
  }
  res.redirect(`/app/${pid}/`);
});

export default router;
