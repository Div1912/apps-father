import { Router, Request, Response } from "express";
import path from "path";
import fs from "fs";
import { hasFeature } from "../../services/features.service";
import { prisma } from "../../db";

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
  res.redirect(`/app/${req.params.projectId}/`);
});

export default router;
