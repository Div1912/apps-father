import fs from "fs";
import path from "path";
import { AgentMode } from "./types";
import { validateRoutesSecurity } from "./security-validator";

export interface TestRunFlags {
  telegram: boolean;
  api: boolean;
  ws: boolean;
}

export interface TestResult {
  tool: string;
  ok: boolean;
  detail: string;
}

export interface WsCoverage {
  types: Set<string>;
  scenarios: Set<string>;
}

export function dirHasFiles(dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile()) return true;
    if (entry.isDirectory() && dirHasFiles(path.join(dir, entry.name))) return true;
  }
  return false;
}

export function extractRoutes(content: string): Array<{ method: string; path: string }> {
  const routes: Array<{ method: string; path: string }> = [];
  const re = /router\.(get|post|put|delete|patch)\s*\(\s*["'`]([^"'`]+)["'`]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) routes.push({ method: m[1].toUpperCase(), path: m[2] });
  return routes;
}

export function plannedEndpoints(plan: any): Array<{ method: string; path: string }> {
  const endpoints = Array.isArray(plan?.restEndpoints) ? plan.restEndpoints : [];
  return endpoints.map((e: any) => {
    if (typeof e === "string") {
      const m = e.match(/^\s*(GET|POST|PUT|PATCH|DELETE)\s+(\S+)/i);
      return m ? { method: m[1].toUpperCase(), path: m[2] } : null;
    }
    const method = (e?.method || e?.verb || "").toString().toUpperCase();
    const p = (e?.path || e?.route || "").toString();
    return method && p ? { method, path: p } : null;
  }).filter(Boolean) as Array<{ method: string; path: string }>;
}

export function validatePlannedEndpoints(routesContent: string, plan: any): string | null {
  const planned = plannedEndpoints(plan);
  if (planned.length === 0) return null;
  const actual = extractRoutes(routesContent);
  const missing = planned.filter(p => !actual.some(a => a.method === p.method && a.path === p.path));
  return missing.length > 0
    ? `Backend is missing planned REST endpoint(s): ${missing.map(e => `${e.method} ${e.path}`).join(", ")}.`
    : null;
}

export function plannedWsTypes(plan: any): string[] {
  const messages = Array.isArray(plan?.wsMessages) ? plan.wsMessages : [];
  const types: string[] = messages.map((m: any) => typeof m === "string" ? m : m?.type).filter(Boolean).map(String);
  return [...new Set(types)];
}

export function plannedServerWsTypes(plan: any): string[] {
  const messages = Array.isArray(plan?.wsMessages) ? plan.wsMessages : [];
  const types: string[] = [];
  for (const msg of messages) {
    if (typeof msg === "string") {
      types.push(msg);
      continue;
    }
    const type = msg?.type ? String(msg.type) : "";
    if (!type) continue;
    const direction = String(msg?.direction || msg?.dir || "").toLowerCase();
    const clientToServer = /^client\s*(?:→|->|to)\s*server/.test(direction) || direction.includes("client→server") || direction.includes("client->server");
    const serverToClient = /^server\s*(?:→|->|to)\s*client/.test(direction) || direction.includes("server→client") || direction.includes("server->client") || direction.includes("client←server");
    if (!direction || serverToClient || (!clientToServer && direction.includes("server"))) {
      types.push(type);
    }
  }
  return [...new Set(types)];
}

export function validatePlannedWsTypes(allCode: string, plan: any): string | null {
  const types = plannedWsTypes(plan);
  if (types.length === 0) return null;
  const missing = types.filter(t => !new RegExp(`["']${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`).test(allCode));
  return missing.length > 0
    ? `Code is missing planned WebSocket message type(s): ${missing.join(", ")}.`
    : null;
}

export function plannedWsScenarioIds(plan: any): string[] {
  const scenarios = Array.isArray(plan?.testScenarios) ? plan.testScenarios : [];
  return scenarios
    .map((scenario: any, index: number) => {
      if (typeof scenario === "string") return null;
      const hasWs =
        scenario?.tool === "simulate_ws" ||
        scenario?.type === "simulate_ws" ||
        scenario?.kind === "ws" ||
        Array.isArray(scenario?.expectTypes) ||
        Array.isArray(scenario?.wsMessages) ||
        Array.isArray(scenario?.steps) && scenario.steps.some((step: any) => String(step?.type || step?.action || "").toLowerCase().includes("ws"));
      if (!hasWs) return null;
      return String(scenario?.id || scenario?.scenarioId || scenario?.name || `scenario-${index + 1}`);
    })
    .filter(Boolean) as string[];
}

export function observedWsTypes(sim: any): Set<string> {
  const captured = Object.values(sim?.captured || {}).flat().map(String);
  const observed = new Set<string>();
  for (const raw of captured) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed?.type) observed.add(String(parsed.type));
    } catch {
      const match = raw.match(/"type"\s*:\s*"([^"]+)"/);
      if (match) observed.add(match[1]);
    }
  }
  return observed;
}

export function validateWsSimulation(sim: any, plan: any): string | null {
  const explicitExpected = Array.isArray(sim?.expectedTypes) ? sim.expectedTypes.map(String).filter(Boolean) : [];
  const expected: string[] = explicitExpected.length > 0 ? [...new Set<string>(explicitExpected)] : plannedServerWsTypes(plan);
  if (expected.length === 0) return null;

  const observed = observedWsTypes(sim);
  const missing = expected.filter(type => !observed.has(type));
  if (missing.length > 0) {
    return `simulate_ws did not observe expected server WebSocket message type(s): ${missing.join(", ")}. Send scenario messages that trigger the expected event(s), or pass only the expectTypes for this scenario.`;
  }
  return null;
}

export function validateFrontendMarkup(frontendText: string, projectDir?: string): string[] {
  const errors: string[] = [];
  if (!frontendText.trim()) return errors;

  const badAttrExamples: string[] = [];
  const identityAttrRe = /\b(?:id|class|for|name|aria-labelledby|aria-describedby|aria-controls)\s*=\s*(["'])([^"'<>]*(?:\\["']|&quot;|&#34;|&#39;)[^"'<>]*)\1/gi;
  let attrMatch: RegExpExecArray | null;
  while ((attrMatch = identityAttrRe.exec(frontendText)) && badAttrExamples.length < 3) {
    badAttrExamples.push(attrMatch[0].slice(0, 80));
  }
  if (badAttrExamples.length > 0) {
    errors.push(`Frontend HTML contains escaped/nested quotes inside identity attributes (${badAttrExamples.join(", ")}). Use plain values like id="game-canvas", not id="\\"game-canvas\\"".`);
  }

  if (/\bgetElementById\s*\(\s*(["'`])(?:\\["']|["'])/.test(frontendText)) {
    errors.push(`Frontend JS queries a quoted/escaped id. Use document.getElementById("game-canvas"), not document.getElementById("\\"game-canvas\\"").`);
  }
  if (/\bquerySelector(?:All)?\s*\(\s*(["'`])[#.](?:\\["']|["'])/.test(frontendText)) {
    errors.push(`Frontend JS queries a malformed quoted selector. Use document.querySelector("#game-canvas"), not document.querySelector("#\\"game-canvas\\"").`);
  }

  if (projectDir) {
    const frontendDir = path.join(projectDir, "frontend");
    const indexPath = path.join(frontendDir, "index.html");
    if (fs.existsSync(indexPath)) {
      const indexHtml = fs.readFileSync(indexPath, "utf-8");
      if (!indexHtml.includes('src="app.js')) {
        errors.push('frontend/index.html does not reference app.js. All apps must load app.js (e.g. <script src="app.js"></script>).');
      }
      if (!indexHtml.includes('href="styles.css')) {
        errors.push('frontend/index.html does not reference styles.css. All apps must load styles.css (e.g. <link rel="stylesheet" href="styles.css">).');
      }
      if (!indexHtml.includes("telegram-web-app.js")) {
        errors.push('frontend/index.html does not load the Telegram Mini App SDK. Add <script src="https://telegram.org/js/telegram-web-app.js"></script> in <head>. Required for Mini Apps AND Games — without it Telegram.WebApp is undefined and theme/safe-area/back-button/haptics/payments break.');
      }
    }

    const appJsPath = path.join(projectDir, "frontend", "app.js");
    if (fs.existsSync(appJsPath)) {
      const appJsContent = fs.readFileSync(appJsPath, "utf-8");
      try {
        new Function(appJsContent);
      } catch (err: any) {
        errors.push(`frontend/app.js has a JavaScript syntax error: ${err.message}.`);
      }
      if (/'[^'\\\n]*[\u0400-\u04FF][^'\\\n]*'[^'\\\n]*[\u0400-\u04FF][^'\\\n]*'/.test(appJsContent)) {
        errors.push("frontend/app.js may have a broken string: a single-quoted JS string appears to contain an apostrophe inside Cyrillic text (e.g. зв'язок terminates the string early). Use double quotes or template literals: \"Це зв'язок\" or `Це зв'язок`.");
      }
    }
  }

  return errors;
}

export function validateBackendRoutes(
  projectDir: string,
  projectId: string,
  technicalPlan?: any,
): string | null {
  const errors: string[] = [];
  const routesPath = path.join(projectDir, "backend", "routes.js");
  const frontendDir = path.join(projectDir, "frontend");
  const frontendIndex = path.join(frontendDir, "index.html");
  const frontendApp = path.join(frontendDir, "app.js");
  const frontendStyles = path.join(frontendDir, "styles.css");
  const frontendText = [frontendIndex, frontendApp, frontendStyles]
    .filter(p => fs.existsSync(p))
    .map(p => fs.readFileSync(p, "utf-8"))
    .join("\n");
  const routesText = fs.existsSync(routesPath) ? fs.readFileSync(routesPath, "utf-8") : "";

  errors.push(...validateFrontendMarkup(frontendText, projectDir));
  if (/\bprocess\s*\.\s*env\b/.test(routesText + "\n" + frontendText)) {
    errors.push("Generated app code must not read process.env. Project code cannot access platform environment variables; if a feature needs an API key or credential, call ask_user before coding or use a public no-key API.");
  }

  if (!fs.existsSync(routesPath)) {
    if (plannedEndpoints(technicalPlan).length > 0 || plannedWsTypes(technicalPlan).length > 0) {
      errors.push("Technical plan includes backend endpoints or WebSocket messages, but backend/routes.js does not exist.");
    }
    return errors.length ? errors.join(" ") : null;
  }

  const content = routesText;
  try {
    new Function(content);
  } catch (err: any) {
    errors.push(`backend/routes.js has a JavaScript syntax error: ${err.message}.`);
  }

  // Security validation — block deploy if user code contains backdoor
  // patterns (shell exec, vm escapes, platform secret reads, sudoers writes,
  // etc.). This runs before commitService.syncToDev so unsafe code never
  // reaches the dev or release directories.
  const securityError = validateRoutesSecurity(content);
  if (securityError) {
    console.warn(
      `[SecurityValidator] BLOCKED deploy for project ${projectId.substring(0, 8)} — ${securityError.split("\n")[0]}`,
    );
    errors.push(securityError);
  }

  if (/^--\s/m.test(content)) {
    errors.push(`backend/routes.js contains SQL-style comments (-- ...) which are a syntax error in JavaScript. Replace every -- comment with a // comment and redeploy.`);
  }

  const hasPlatformExport = /module\.exports\s*=\s*function\s*\(\s*router\s*,\s*db\s*,\s*projectId\s*[,)]/.test(content);
  if (!hasPlatformExport) {
    errors.push(`backend/routes.js has invalid Apps Father format. It must export exactly: module.exports = function(router, db, projectId) { ... }. Do not export a route map/object.`);
  }
  if (/module\.exports\s*=\s*routes\b/.test(content) || /^\s*const\s+routes\s*=\s*\{/m.test(content)) {
    errors.push(`backend/routes.js uses object-style routes. Rewrite with Express router calls inside module.exports = function(router, db, projectId) { router.get('/path', ...); }.`);
  }
  const missingSlashRoutes: string[] = [];
  const routePathRe = /router\.(get|post|put|patch|delete|all)\s*\(\s*["']([^/"'][^"']*)["']/g;
  let routePathMatch: RegExpExecArray | null;
  while ((routePathMatch = routePathRe.exec(content)) && missingSlashRoutes.length < 5) {
    missingSlashRoutes.push(`router.${routePathMatch[1]}("${routePathMatch[2]}")`);
  }
  if (missingSlashRoutes.length > 0) {
    errors.push(`backend/routes.js has route paths missing a leading slash (${missingSlashRoutes.join(", ")}). Use router.get('/words', ...) not router.get('words', ...).`);
  }
  if (/['"`]\s*(GET|POST|PUT|PATCH|DELETE)\s+\/api\//i.test(content)) {
    errors.push(`backend/routes.js contains object-style API route keys like "GET /api/...". Use router.get('/path', ...) and never include /api/{projectId} in backend route paths.`);
  }
  const escapedProjectId = projectId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`/api/${escapedProjectId}(?:/|['"\`])`).test(content) || /\/api\/[0-9a-f]{8}-[0-9a-f-]{27,}/i.test(content)) {
    errors.push(`backend/routes.js hardcodes /api/{projectId}. Backend routes must be relative, for example router.get('/videos', ...).`);
  }

  if (/\b(?:const|let|var)\s+db\s*=\s*\{[\s\S]{0,800}\bget\s*\([^)]*\)[\s\S]{0,800}\bset\s*\([^)]*\)/.test(frontendText)) {
    errors.push("Frontend contains a fake client-side db mock. Mini App frontend must use REST/WS APIs for persisted state, not a local db object.");
  }
  if (/text\.split\s*\(\s*\/\\t\/\s*\)|text\.split\s*\(\s*["']\\t["']\s*\)/.test(content)) {
    errors.push("Bot /start parsing splits only on tabs. Use text.split(/\\s+/) so deep-link parameters work from normal Telegram messages.");
  }

  // AF.openWS() is the correct SDK wrapper — treat it the same as new WebSocket()
  const frontendUsesWs = /new\s+WebSocket\s*\(|AF\.openWS\s*\(/.test(frontendText);
  const backendHasWs = /module\.exports\.ws\s*=/.test(content);

  // Diagnostic logging — always emitted so we can trace validator decisions in server logs
  {
    const appJsOnDisk = fs.existsSync(frontendApp);
    const appJsBytes = appJsOnDisk ? fs.statSync(frontendApp).size : 0;
    const appJsLines = appJsOnDisk ? fs.readFileSync(frontendApp, "utf-8").split("\n").length : 0;
    const openWsInText = frontendText.includes("AF.openWS");
    const openWsInFile = appJsOnDisk ? fs.readFileSync(frontendApp, "utf-8").includes("AF.openWS") : false;
    console.log(
      `[validateBackendRoutes] projectDir=${projectDir} ` +
      `backendHasWs=${backendHasWs} frontendUsesWs=${frontendUsesWs} ` +
      `app.js exists=${appJsOnDisk} bytes=${appJsBytes} lines=${appJsLines} ` +
      `frontendText.includes("AF.openWS")=${openWsInText} ` +
      `app.js direct read includes("AF.openWS")=${openWsInFile} ` +
      `frontendText.length=${frontendText.length}`
    );
  }
  if (frontendUsesWs && !backendHasWs) {
    errors.push("Frontend opens a WebSocket, but backend/routes.js does not export module.exports.ws.");
  }
  if (backendHasWs) {
    if (!frontendUsesWs) {
      const appJsExists = fs.existsSync(frontendApp);
      const appJsSize = appJsExists ? fs.statSync(frontendApp).size : 0;
      let wsDiag = "";
      if (!appJsExists) {
        wsDiag = "app.js DOES NOT EXIST";
      } else {
        const appJsRaw = fs.readFileSync(frontendApp, "utf-8");
        const lines = appJsRaw.split("\n");
        // Search for any mention of openWS or WebSocket in the file
        const wsLineIdx = lines.findIndex(l => /AF\.openWS|new\s+WebSocket/i.test(l));
        if (wsLineIdx >= 0) {
          // Pattern IS in file but regex didn't match — show surrounding context
          const ctx = lines.slice(Math.max(0, wsLineIdx - 1), wsLineIdx + 4).join(" | ");
          wsDiag = `app.js has ${appJsSize} bytes / ${lines.length} lines. ` +
            `"openWS" found at line ${wsLineIdx + 1} but regex still failed — context: "${ctx.substring(0, 300)}". ` +
            `This is likely a formatting issue. Rewrite the WS init with exactly: ws = AF.openWS({`;
        } else {
          // Pattern NOT in file at all — show tail to detect truncation
          const tail = lines.slice(-8).join(" | ").replace(/\s+/g, " ").substring(0, 300);
          wsDiag = `app.js has ${appJsSize} bytes / ${lines.length} lines — "AF.openWS" not found anywhere. ` +
            `Last 8 lines: "${tail}". ` +
            `The file may have been overwritten without the WS code. ` +
            `Use grep_files tool with pattern "AF.openWS" to confirm, then rewrite frontend/app.js.`;
        }
      }
      errors.push(
        `Backend exports module.exports.ws, but frontend does not create a WebSocket client. ` +
        `${wsDiag} ` +
        `FIX: ensure frontend/app.js contains: ws = AF.openWS({ onOpen: () => { ws.send(JSON.stringify({type:'auth',initData:AF.tg.initData||''})); }, onMessage: (data) => { handleWSMessage(data); }, onClose: () => { setTimeout(reconnect, 3000); }, onError: () => {} });`,
      );
    }
    // AF.openWS accepts onClose: handler — recognise both raw and SDK forms
    if (frontendUsesWs && !/onclose\s*=|addEventListener\(\s*["']close|onClose\s*:/.test(frontendText)) {
      errors.push("WebSocket frontend must implement reconnect/onclose handling.");
    }
    if (frontendUsesWs && /type\s*:\s*["']auth["']/.test(content) && !/type\s*:\s*["']auth["']/.test(frontendText)) {
      errors.push("Backend expects WS auth messages, but frontend does not send { type: 'auth', ... }.");
    }
    const trustsClientUserId =
      /data\.type\s*={2,3}\s*["']auth["'][\s\S]{0,500}(?:myUserId|userId)\s*=\s*String\s*\(\s*data\.userId\s*\)/.test(content) ||
      /online\.set\s*\(\s*String\s*\(\s*data\.userId\s*\)/.test(content);
    if (trustsClientUserId) {
      errors.push("WebSocket auth trusts data.userId from the client. Send Telegram initData (or another signed platform token) and derive the user id server-side before routing private events.");
    }
    if (/["']send_msg["']/.test(content) && /matches?/.test(content)) {
      const checksMatchMembership =
        (
          /\.users\.includes\s*\(/.test(content) ||
          /matchUsers[\s\S]{0,300}\.includes\s*\(/.test(content) ||
          /matchUsers[\s\S]{0,300}\.indexOf\s*\([^)]*\)\s*!={1,2}\s*-1/.test(content) ||
          /matchUsers[\s\S]{0,300}\.indexOf\s*\([^)]*\)\s*={2,3}\s*-1[\s\S]{0,200}(?:not_allowed|return)/.test(content) ||
          /\.users\.some\s*\(/.test(content)
        ) &&
        (
          /(?:match|matches)\.find\s*\(/.test(content) ||
          /for\s*\([^)]*matches\.length[\s\S]{0,700}\bmatch\s*=/.test(content) ||
          /matches\.some\s*\(/.test(content)
        ) &&
        /(?:myUserId|auth\.telegramId|telegramId|senderId|fromUserId)/.test(content) &&
        /(?:toUserId|recipientId|targetId|otherUserId)/.test(content) &&
        /(?:not_allowed|403|Unauthorized|Forbidden)/i.test(content);
      if (!checksMatchMembership) {
        errors.push("Private chat send_msg handler must verify the sender belongs to the match before persisting or forwarding messages.");
      }
    }
  }

  const plannedEndpointError = validatePlannedEndpoints(content, technicalPlan);
  if (plannedEndpointError) errors.push(plannedEndpointError);
  const plannedWsError = validatePlannedWsTypes(content + "\n" + frontendText, technicalPlan);
  if (plannedWsError) errors.push(plannedWsError);

  return errors.length ? errors.join(" ") : null;
}

export function validateFinishReadiness(
  mode: AgentMode,
  technicalPlan: any,
  testsRun: TestRunFlags,
  deployed: boolean,
  testResults: TestResult[] = [],
  wsCoverage: WsCoverage = { types: new Set(), scenarios: new Set() },
  hasBotToken = false,
): string | null {
  const latestResult = (tool: string) => {
    const r = [...testResults].reverse().find(t => t.tool === tool);
    return r ? ` Last ${tool} result: ${r.detail}` : "";
  };
  if (mode === "new" && !technicalPlan) {
    return "technical_plan is required before finish().";
  }
  if (!deployed) {
    return "deploy_to_dev() must succeed before finish().";
  }
  if (hasBotToken && Array.isArray(technicalPlan?.botBehavior) && technicalPlan.botBehavior.length > 0 && !testsRun.telegram) {
    return `Builds with planned bot behavior must pass simulate_telegram before finish().${latestResult("simulate_telegram")}`;
  }
  if (plannedEndpoints(technicalPlan).length > 0 && !testsRun.api) {
    return `Builds with planned REST endpoints must pass simulate_api before finish().${latestResult("simulate_api")}`;
  }
  if (plannedWsTypes(technicalPlan).length > 0) {
    const wsScenarioIds = plannedWsScenarioIds(technicalPlan);
    if (wsScenarioIds.length > 0) {
      const missingScenarios = wsScenarioIds.filter(id => !wsCoverage.scenarios.has(id));
      if (missingScenarios.length > 0) {
        return `Real-time builds must pass planned WebSocket test scenario(s) before finish(): ${missingScenarios.join(", ")}.${latestResult("simulate_ws")}`;
      }
    } else {
      const missingTypes = plannedServerWsTypes(technicalPlan).filter(type => !wsCoverage.types.has(type));
      if (missingTypes.length > 0) {
        return `Real-time builds with planned WebSocket messages must pass simulate_ws before finish(). Missing observed server type(s): ${missingTypes.join(", ")}.${latestResult("simulate_ws")}`;
      }
      if (plannedServerWsTypes(technicalPlan).length === 0 && !testsRun.ws) {
        return `Real-time builds with planned WebSocket messages must pass simulate_ws before finish().${latestResult("simulate_ws")}`;
      }
    }
  }
  return null;
}
