import { Router, Request, Response } from "express";
import path from "path";
import fs from "fs";

const router = Router();
const PROJECTS_DIR = path.join(process.cwd(), "projects");

function getLanguage(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    ".js": "javascript", ".ts": "typescript", ".html": "html",
    ".css": "css", ".json": "json", ".sql": "sql",
    ".md": "markdown", ".txt": "plaintext",
  };
  return map[ext] || "plaintext";
}

function walkDir(dir: string, base: string): { path: string; name: string; language: string }[] {
  const results: { path: string; name: string; language: string }[] = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(base, fullPath).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath, base));
    } else {
      results.push({ path: relPath, name: entry.name, language: getLanguage(entry.name) });
    }
  }
  return results;
}

router.get("/:projectId/api/files", (req: Request, res: Response) => {
  const projectId = String(req.params.projectId);
  const devDir = path.join(PROJECTS_DIR, projectId, "development");
  if (!fs.existsSync(devDir)) { res.json({ files: [] }); return; }
  res.json({ files: walkDir(devDir, devDir) });
});

router.get("/:projectId/api/file", (req: Request, res: Response) => {
  const projectId = String(req.params.projectId);
  const filePath = String(req.query.path || "");
  if (!filePath || filePath.includes("..")) { res.status(400).json({ error: "Invalid path" }); return; }
  const devDir = path.join(PROJECTS_DIR, projectId, "development");
  const fullPath = path.join(devDir, filePath);
  if (!fullPath.startsWith(devDir)) { res.status(403).json({ error: "Forbidden" }); return; }
  if (!fs.existsSync(fullPath)) { res.status(404).json({ error: "File not found" }); return; }
  res.json({ content: fs.readFileSync(fullPath, "utf-8"), language: getLanguage(filePath) });
});

router.post("/:projectId/api/file", (req: Request, res: Response) => {
  const projectId = String(req.params.projectId);
  const { path: filePath, content } = req.body;
  if (!filePath || typeof content !== "string" || filePath.includes("..")) { res.status(400).json({ error: "Invalid request" }); return; }
  const devDir = path.join(PROJECTS_DIR, projectId, "development");
  const fullPath = path.join(devDir, filePath);
  if (!fullPath.startsWith(devDir)) { res.status(403).json({ error: "Forbidden" }); return; }
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf-8");
  res.json({ ok: true });
});

router.post("/:projectId/api/new-file", (req: Request, res: Response) => {
  const projectId = String(req.params.projectId);
  const { path: filePath } = req.body;
  if (!filePath || filePath.includes("..")) { res.status(400).json({ error: "Invalid path" }); return; }
  const devDir = path.join(PROJECTS_DIR, projectId, "development");
  const fullPath = path.join(devDir, filePath);
  if (!fullPath.startsWith(devDir)) { res.status(403).json({ error: "Forbidden" }); return; }
  if (fs.existsSync(fullPath)) { res.status(409).json({ error: "File already exists" }); return; }
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, "", "utf-8");
  res.json({ ok: true });
});

router.delete("/:projectId/api/file", (req: Request, res: Response) => {
  const projectId = String(req.params.projectId);
  const filePath = String(req.query.path || "");
  if (!filePath || filePath.includes("..")) { res.status(400).json({ error: "Invalid path" }); return; }
  const devDir = path.join(PROJECTS_DIR, projectId, "development");
  const fullPath = path.join(devDir, filePath);
  if (!fullPath.startsWith(devDir)) { res.status(403).json({ error: "Forbidden" }); return; }
  if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  res.json({ ok: true });
});

router.get("/:projectId/", (_req: Request, res: Response) => {
  res.send(EDITOR_HTML);
});

router.get("/:projectId", (req: Request, res: Response) => {
  res.redirect("/editor/" + req.params.projectId + "/");
});

const EDITOR_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Code Editor — Apps Father</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#1e1e1e;--sidebar:#252526;--border:#3c3c3c;--text:#ccc;--dim:#858585;--accent:#0078d4;--hover:#2a2d2e;--active:#37373d;--success:#4ec9b0;--danger:#f44747;--warn:#dcdcaa}
body{font-family:'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--text);height:100vh;overflow:hidden}
.app{display:flex;height:100vh;flex-direction:column}
.toolbar{display:flex;align-items:center;justify-content:space-between;height:40px;background:#323233;border-bottom:1px solid var(--border);padding:0 12px;flex-shrink:0}
.toolbar-left{display:flex;align-items:center;gap:10px}
.toolbar-title{font-size:13px;font-weight:600}
.toolbar-project{font-size:12px;color:var(--accent)}
.toolbar-actions{display:flex;gap:6px}
.btn{background:var(--accent);color:#fff;border:none;padding:5px 14px;border-radius:4px;font-size:12px;cursor:pointer;font-weight:500}
.btn:hover{filter:brightness(1.15)}
.btn.sec{background:var(--active);color:var(--text)}
.btn.sec:hover{background:var(--hover)}
.main{display:flex;flex:1;overflow:hidden}
.sidebar{width:260px;background:var(--sidebar);border-right:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0}
.sidebar-hdr{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:var(--dim);border-bottom:1px solid var(--border)}
.sidebar-hdr button{background:none;border:none;color:var(--dim);cursor:pointer;font-size:16px;padding:0 4px}
.sidebar-hdr button:hover{color:var(--text)}
.file-tree{flex:1;overflow-y:auto;padding:4px 0}
.fi{display:flex;align-items:center;padding:4px 14px;cursor:pointer;font-size:13px;gap:6px;user-select:none}
.fi:hover{background:var(--hover)}
.fi.active{background:var(--active)}
.fi.mod .fn::after{content:' \\25CF';color:var(--warn)}
.ficon{font-size:14px;flex-shrink:0;width:18px;text-align:center}
.fn{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.folder{display:flex;align-items:center;padding:4px 14px;font-size:12px;color:var(--dim);letter-spacing:.5px;gap:6px;margin-top:4px;font-weight:600}
.editor-area{flex:1;display:flex;flex-direction:column;overflow:hidden}
.tabs{display:flex;background:var(--sidebar);border-bottom:1px solid var(--border);overflow-x:auto;flex-shrink:0;min-height:36px}
.tab{display:flex;align-items:center;gap:6px;padding:0 16px;font-size:13px;cursor:pointer;border-right:1px solid var(--border);white-space:nowrap;color:var(--dim);height:36px}
.tab:hover{color:var(--text)}
.tab.active{color:var(--text);background:var(--bg);border-bottom:1px solid var(--accent);margin-bottom:-1px}
.tab.mod .tn::after{content:' \\25CF';color:var(--warn)}
.tc{font-size:14px;opacity:0;cursor:pointer;padding:0 2px;border-radius:3px;line-height:1}
.tab:hover .tc,.tab.active .tc{opacity:.7}
.tc:hover{opacity:1!important;background:rgba(255,255,255,.1)}
#ec{flex:1}
.empty{flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;color:var(--dim)}
.empty .ico{font-size:48px;opacity:.3}
.empty .hint{font-size:14px}
.toast{position:fixed;bottom:20px;right:20px;padding:10px 20px;border-radius:6px;font-size:13px;z-index:1000;animation:si .3s ease;color:#fff}
.toast.ok{background:#2d6a4f}.toast.err{background:#9d0208}
@keyframes si{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:100}
.modal{background:var(--sidebar);border:1px solid var(--border);border-radius:8px;padding:20px;min-width:360px}
.modal h3{margin-bottom:12px;font-size:15px}
.modal input{width:100%;padding:8px 12px;background:var(--bg);border:1px solid var(--border);border-radius:4px;color:var(--text);font-size:13px;outline:none}
.modal input:focus{border-color:var(--accent)}
.modal-acts{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}
.status{height:24px;background:var(--accent);display:flex;align-items:center;padding:0 12px;font-size:11px;color:#fff;justify-content:space-between;flex-shrink:0}
</style>
</head>
<body>
<div class="app">
  <div class="toolbar">
    <div class="toolbar-left">
      <span class="toolbar-title">Apps Father Editor</span>
      <span class="toolbar-project" id="pid"></span>
    </div>
    <div class="toolbar-actions">
      <button class="btn sec" id="btn-new">+ New File</button>
      <button class="btn" id="btn-save">Save</button>
      <button class="btn sec" id="btn-save-all">Save All</button>
    </div>
  </div>
  <div class="main">
    <div class="sidebar">
      <div class="sidebar-hdr"><span>Explorer</span><button id="btn-refresh" title="Refresh">&#x21bb;</button></div>
      <div class="file-tree" id="tree"></div>
    </div>
    <div class="editor-area">
      <div class="tabs" id="tabs"></div>
      <div id="ec"></div>
      <div class="empty" id="empty"><div class="ico">{ }</div><div class="hint">Select a file to start editing</div></div>
    </div>
  </div>
  <div class="status"><span id="sf">Ready</span><span id="sl"></span></div>
</div>
<div class="modal-bg" id="nfm" style="display:none">
  <div class="modal">
    <h3>New File</h3>
    <input type="text" id="nfp" placeholder="e.g. frontend/page.html" />
    <div class="modal-acts">
      <button class="btn sec" id="nf-cancel">Cancel</button>
      <button class="btn" id="nf-create">Create</button>
    </div>
  </div>
</div>
<script src="https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs/loader.js"></script>
<script>
(function(){
var PID = location.pathname.split('/')[2];
var API = '/editor/' + PID + '/api';
document.getElementById('pid').textContent = PID.substring(0,8) + '...';

var editor = null;
var openFiles = {};
var activeFile = null;
var modified = {};
var fileList = [];

require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs' } });
require(['vs/editor/editor.main'], function(){
  monaco.editor.defineTheme('af', { base:'vs-dark', inherit:true, rules:[], colors:{'editor.background':'#1e1e1e'} });
  monaco.editor.setTheme('af');
  editor = monaco.editor.create(document.getElementById('ec'), {
    value:'', language:'plaintext', theme:'af', fontSize:14,
    minimap:{enabled:true}, automaticLayout:true, tabSize:2,
    wordWrap:'on', scrollBeyondLastLine:false, renderWhitespace:'selection',
    bracketPairColorization:{enabled:true}
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveFile);
  editor.onDidChangeModelContent(function(){
    if(activeFile){
      var cur = editor.getValue();
      if(cur !== openFiles[activeFile].orig){ modified[activeFile]=true; } else { delete modified[activeFile]; }
      renderTabs(); renderTree();
    }
  });
  document.getElementById('ec').style.display='none';
  refresh();
});

function refresh(){
  fetch(API+'/files').then(function(r){return r.json()}).then(function(d){
    fileList = d.files || [];
    renderTree();
  });
}

function ficon(n){
  if(n.endsWith('.html'))return'\\uD83D\\uDFE0';
  if(n.endsWith('.css'))return'\\uD83D\\uDD35';
  if(n.endsWith('.js'))return'\\uD83D\\uDFE1';
  if(n.endsWith('.json'))return'\\uD83D\\uDCCB';
  if(n.endsWith('.sql'))return'\\uD83D\\uDDC3';
  return'\\uD83D\\uDCC4';
}

function renderTree(){
  var tree = document.getElementById('tree');
  var groups = {};
  fileList.forEach(function(f){
    var parts = f.path.split('/');
    var folder = parts.length>1 ? parts.slice(0,-1).join('/') : '(root)';
    if(!groups[folder]) groups[folder]=[];
    groups[folder].push(f);
  });
  var html='';
  var order=['frontend','backend','(root)'];
  var keys=Object.keys(groups).sort(function(a,b){
    var ai=order.findIndex(function(x){return a.startsWith(x)});
    var bi=order.findIndex(function(x){return b.startsWith(x)});
    return (ai<0?99:ai)-(bi<0?99:bi);
  });
  keys.forEach(function(folder){
    var ico=folder.startsWith('frontend')?'\\uD83C\\uDF10':folder.startsWith('backend')?'\\u2699\\uFE0F':'\\uD83D\\uDCC1';
    html+='<div class="folder">\\u25BC '+ico+' '+folder+'</div>';
    groups[folder].forEach(function(f){
      var cls='fi';
      if(activeFile===f.path)cls+=' active';
      if(modified[f.path])cls+=' mod';
      html+='<div class="'+cls+'" data-path="'+f.path+'" data-lang="'+f.language+'"><span class="ficon">'+ficon(f.name)+'</span><span class="fn">'+f.name+'</span></div>';
    });
  });
  tree.innerHTML=html;
}

function renderTabs(){
  var c=document.getElementById('tabs');
  var html='';
  Object.keys(openFiles).forEach(function(fp){
    var name=fp.split('/').pop();
    var cls='tab';
    if(fp===activeFile)cls+=' active';
    if(modified[fp])cls+=' mod';
    html+='<div class="'+cls+'" data-tab="'+fp+'"><span class="tn">'+name+'</span><span class="tc" data-close="'+fp+'">\\u00D7</span></div>';
  });
  c.innerHTML=html;
}

function openF(fp, lang){
  if(openFiles[fp]){
    switchTo(fp);
    return;
  }
  fetch(API+'/file?path='+encodeURIComponent(fp)).then(function(r){return r.json()}).then(function(d){
    openFiles[fp]={content:d.content, orig:d.content, lang:d.language||lang};
    switchTo(fp);
  });
}

function switchTo(fp){
  if(activeFile && openFiles[activeFile]){
    openFiles[activeFile].content = editor.getValue();
  }
  activeFile=fp;
  var f=openFiles[fp];
  document.getElementById('ec').style.display='block';
  document.getElementById('empty').style.display='none';
  var model=monaco.editor.createModel(f.content, f.lang);
  var old=editor.getModel();
  editor.setModel(model);
  if(old) old.dispose();
  document.getElementById('sf').textContent=fp;
  document.getElementById('sl').textContent=f.lang;
  renderTabs(); renderTree();
}

function saveFile(){
  if(!activeFile)return;
  var content=editor.getValue();
  openFiles[activeFile].content=content;
  openFiles[activeFile].orig=content;
  fetch(API+'/file',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:activeFile,content:content})}).then(function(r){
    if(r.ok){ delete modified[activeFile]; renderTabs(); renderTree(); toast('Saved '+activeFile,'ok'); }
    else toast('Failed to save','err');
  });
}

function saveAll(){
  var keys=Object.keys(modified);
  if(!keys.length){toast('No unsaved changes','ok');return;}
  var done=0;
  keys.forEach(function(fp){
    var content=fp===activeFile?editor.getValue():openFiles[fp].content;
    fetch(API+'/file',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:fp,content:content})}).then(function(r){
      if(r.ok){openFiles[fp].orig=content;openFiles[fp].content=content;delete modified[fp];done++;}
      if(done===keys.length){renderTabs();renderTree();toast('Saved '+done+' file(s)','ok');}
    });
  });
}

function closeTab(fp){
  if(modified[fp] && !confirm('Discard unsaved changes to '+fp+'?'))return;
  delete openFiles[fp]; delete modified[fp];
  if(activeFile===fp){
    var rem=Object.keys(openFiles);
    if(rem.length>0){switchTo(rem[rem.length-1]);}
    else{activeFile=null;document.getElementById('ec').style.display='none';document.getElementById('empty').style.display='flex';document.getElementById('sf').textContent='Ready';document.getElementById('sl').textContent='';}
  }
  renderTabs();renderTree();
}

function toast(msg,type){
  var el=document.createElement('div');el.className='toast '+type;el.textContent=msg;
  document.body.appendChild(el);setTimeout(function(){el.remove()},2500);
}

document.getElementById('tree').addEventListener('click',function(e){
  var el=e.target.closest('.fi');
  if(el)openF(el.dataset.path,el.dataset.lang);
});
document.getElementById('tabs').addEventListener('click',function(e){
  var cl=e.target.closest('.tc');
  if(cl){e.stopPropagation();closeTab(cl.dataset.close);return;}
  var tab=e.target.closest('.tab');
  if(tab)switchTo(tab.dataset.tab);
});
document.getElementById('btn-save').addEventListener('click',saveFile);
document.getElementById('btn-save-all').addEventListener('click',saveAll);
document.getElementById('btn-refresh').addEventListener('click',refresh);
document.getElementById('btn-new').addEventListener('click',function(){
  document.getElementById('nfm').style.display='flex';
  var inp=document.getElementById('nfp');inp.value='';setTimeout(function(){inp.focus()},50);
});
document.getElementById('nf-cancel').addEventListener('click',function(){document.getElementById('nfm').style.display='none';});
document.getElementById('nf-create').addEventListener('click',createFile);
document.getElementById('nfp').addEventListener('keydown',function(e){if(e.key==='Enter')createFile();if(e.key==='Escape')document.getElementById('nfm').style.display='none';});

function createFile(){
  var fp=document.getElementById('nfp').value.trim();
  if(!fp)return;
  fetch(API+'/new-file',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:fp})}).then(function(r){
    if(r.ok){document.getElementById('nfm').style.display='none';refresh();setTimeout(function(){openF(fp,'plaintext')},300);toast('Created '+fp,'ok');}
    else r.json().then(function(d){toast(d.error||'Failed','err')});
  });
}
})();
</script>
</body>
</html>`;

export default router;
