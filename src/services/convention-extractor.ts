import fs from "fs";
import path from "path";

interface ExtractedBlock {
  label: string;
  file: string;
  line: number;
  code: string[];
}

export class ConventionExtractor {

  // ────────────────────────────────────────────────────────────────────────
  // PUBLIC API
  // ────────────────────────────────────────────────────────────────────────

  extract(projectDir: string): { structure: string; conventions: string } {
    const structure: string[] = [];
    const conventions: string[] = [];

    // Backend
    const routesPath = path.join(projectDir, "backend", "routes.js");
    if (fs.existsSync(routesPath)) {
      const content = fs.readFileSync(routesPath, "utf-8");
      const lines = content.split("\n");

      structure.push("### backend/routes.js");
      structure.push(...this.extractStructure(lines, "routes.js"));

      conventions.push("### backend/routes.js conventions");
      conventions.push(...this.extractRoutesConventions(lines));
    }

    // Frontend JS
    const appPath = path.join(projectDir, "frontend", "app.js");
    if (fs.existsSync(appPath)) {
      const content = fs.readFileSync(appPath, "utf-8");
      const lines = content.split("\n");

      structure.push("\n### frontend/app.js");
      structure.push(...this.extractStructure(lines, "app.js"));

      conventions.push("\n### frontend/app.js conventions");
      conventions.push(...this.extractFrontendConventions(lines));
    }

    // Frontend HTML
    const htmlPath = path.join(projectDir, "frontend", "index.html");
    if (fs.existsSync(htmlPath)) {
      const content = fs.readFileSync(htmlPath, "utf-8");
      const lines = content.split("\n");

      structure.push("\n### frontend/index.html");
      structure.push(...this.extractHtmlStructure(lines));

      conventions.push("\n### frontend/index.html conventions");
      conventions.push(...this.extractHtmlConventions(lines));
    }

    // Frontend CSS
    const cssPath = path.join(projectDir, "frontend", "styles.css");
    if (fs.existsSync(cssPath)) {
      const content = fs.readFileSync(cssPath, "utf-8");
      const lines = content.split("\n");

      structure.push("\n### frontend/styles.css");
      structure.push(...this.extractCssStructure(lines));

      conventions.push("\n### frontend/styles.css conventions");
      conventions.push(...this.extractCssConventions(lines));
    }

    return {
      structure: structure.join("\n"),
      conventions: conventions.join("\n"),
    };
  }


  // ────────────────────────────────────────────────────────────────────────
  // STRUCTURE EXTRACTION (WHERE things are)
  // ────────────────────────────────────────────────────────────────────────

  private extractStructure(lines: string[], fileName: string): string[] {
    const result: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*")) continue;

      if (trimmed.match(/^module\.exports\s*=/) || trimmed.match(/^module\.exports\.(ws|setup)\s*=/)) {
        result.push(`  L${i + 1}: ${trimmed.substring(0, 120)}`);
      }

      if (trimmed.match(/router\.(get|post|put|delete|patch|all)\s*\(/)) {
        result.push(`  L${i + 1}: ${trimmed.substring(0, 120)}`);
      }

      if (trimmed.match(/^(async\s+)?function\s+\w+/)) {
        result.push(`  L${i + 1}: ${trimmed.substring(0, 120)}`);
      }

      if (line.match(/^(const|let|var)\s+\w+\s*=\s*(async\s+)?\(/) ||
          line.match(/^(const|let|var)\s+\w+\s*=\s*(async\s+)?function/)) {
        result.push(`  L${i + 1}: ${trimmed.substring(0, 120)}`);
      }

      if (trimmed.match(/^(const|let|var)\s+(state|config|settings|options|defaults|CONSTANTS)\s*=/)) {
        result.push(`  L${i + 1}: ${trimmed.substring(0, 120)}`);
      }

      if (trimmed.match(/wss\.on\w*\s*\(|socket\.on\s*\(/)) {
        result.push(`  L${i + 1}: ${trimmed.substring(0, 120)}`);
      }

      if (trimmed.match(/\.addEventListener\s*\(/) && !trimmed.includes("//")) {
        result.push(`  L${i + 1}: ${trimmed.substring(0, 120)}`);
      }

      if (trimmed.match(/db\.(get|set|delete|keys|getAll)\s*\(/)) {
        result.push(`  L${i + 1}: ${trimmed.substring(0, 120)}`);
      }

      if (trimmed.match(/Telegram\.WebApp\.\w+\s*\(/) || trimmed.match(/telegram\.org\/bot/)) {
        result.push(`  L${i + 1}: ${trimmed.substring(0, 120)}`);
      }

      if (trimmed.match(/\.innerHTML\s*=/) && line.search(/\S/) < 4) {
        result.push(`  L${i + 1}: ${trimmed.substring(0, 100)}`);
      }

      if (trimmed.match(/apiCall\s*\(|fetch\s*\(/)) {
        result.push(`  L${i + 1}: ${trimmed.substring(0, 120)}`);
      }
    }

    return result;
  }

  private extractHtmlStructure(lines: string[]): string[] {
    const result: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();

      if (trimmed.match(/<script\s|<link\s/)) {
        result.push(`  L${i + 1}: ${trimmed.substring(0, 120)}`);
      }

      const idMatch = trimmed.match(/<(div|section|main|nav|header|footer|form|ul|ol)\s[^>]*id="([^"]+)"/);
      if (idMatch) {
        result.push(`  L${i + 1}: <${idMatch[1]} id="${idMatch[2]}">`);
      }

      if (trimmed.match(/class="[^"]*\b(screen|page|tab|modal|panel|view|section|container)\b/)) {
        const classMatch = trimmed.match(/class="([^"]+)"/);
        const idM = trimmed.match(/id="([^"]+)"/);
        const tag = trimmed.match(/<(\w+)/)?.[1] || "div";
        result.push(`  L${i + 1}: <${tag}${idM ? ` id="${idM[1]}"` : ""} class="${classMatch?.[1] || ""}">`);
      }
    }

    return result;
  }

  private extractCssStructure(lines: string[]): string[] {
    const result: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();

      if (trimmed.match(/^:root\s*\{/)) {
        result.push(`  L${i + 1}: :root { ... } (CSS variables)`);
      }

      if (trimmed.match(/^\.[a-zA-Z][\w-]*\s*\{/) || trimmed.match(/^\.[a-zA-Z][\w-]*\s*,/)) {
        result.push(`  L${i + 1}: ${trimmed.substring(0, 80)}`);
      }

      if (trimmed.match(/^@media\s/)) {
        result.push(`  L${i + 1}: ${trimmed.substring(0, 80)}`);
      }

      if (trimmed.match(/^@keyframes\s+(\w+)/)) {
        result.push(`  L${i + 1}: ${trimmed.substring(0, 80)}`);
      }
    }

    return result;
  }


  // ────────────────────────────────────────────────────────────────────────
  // CONVENTION SAMPLES (HOW code is written)
  // One real example per pattern — agent learns the style
  // ────────────────────────────────────────────────────────────────────────

  private extractRoutesConventions(lines: string[]): string[] {
    const samples: string[] = [];
    const found = { get: false, post: false, ws: false, dbRead: false, dbWrite: false, errorHandling: false };

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();

      if (!found.get && trimmed.match(/router\.get\s*\(/)) {
        samples.push(`\n// GET route pattern (routes.js:${i + 1}):`);
        samples.push(...this.captureBlock(lines, i, 30));
        found.get = true;
      }

      if (!found.post && trimmed.match(/router\.post\s*\(/)) {
        samples.push(`\n// POST route pattern (routes.js:${i + 1}):`);
        samples.push(...this.captureBlock(lines, i, 35));
        found.post = true;
      }

      if (!found.ws && trimmed.match(/socket\.on\s*\(\s*['"]message['"]/)) {
        samples.push(`\n// WebSocket handler pattern (routes.js:${i + 1}):`);
        samples.push(...this.captureBlock(lines, i, 35));
        found.ws = true;
      }

      if (!found.errorHandling) {
        if (trimmed.match(/catch\s*\(/) || trimmed.match(/res\.status\s*\(\s*(4|5)\d\d\s*\)/)) {
          const start = Math.max(0, i - 3);
          const end = Math.min(lines.length, i + 4);
          samples.push(`\n// Error handling pattern (routes.js:${i + 1}):`);
          for (let j = start; j < end; j++) {
            samples.push(lines[j]);
          }
          found.errorHandling = true;
        }
      }

      if (found.get && found.post && found.errorHandling) break;
    }

    const moduleExportLine = lines.findIndex(l => l.trim().startsWith("module.exports"));
    if (moduleExportLine >= 0) {
      samples.push(`\n// Module structure (routes.js:${moduleExportLine + 1}):`);
      samples.push(...lines.slice(moduleExportLine, moduleExportLine + 5));
    }

    return samples;
  }

  private extractFrontendConventions(lines: string[]): string[] {
    const samples: string[] = [];
    const found = {
      apiWrapper: false,
      stateInit: false,
      renderFn: false,
      eventBinding: false,
      modalToggle: false,
      tabSwitch: false,
      wsConnect: false,
    };

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();

      if (!found.apiWrapper && trimmed.match(/^(async\s+)?function\s+apiCall|^const\s+apiCall\s*=/)) {
        samples.push(`\n// API call wrapper (app.js:${i + 1}):`);
        samples.push(...this.captureBlock(lines, i, 15));
        found.apiWrapper = true;
      }

      if (!found.stateInit && (
        trimmed.match(/^(const|let|var)\s+state\s*=\s*\{/) ||
        trimmed.match(/^window\.state\s*=\s*\{/)
      )) {
        samples.push(`\n// State object (app.js:${i + 1}):`);
        samples.push(...this.captureBlock(lines, i, 25));
        found.stateInit = true;
      }

      if (!found.renderFn && trimmed.match(/^(async\s+)?function\s+(render|update|show|display|refresh)\w*\s*\(/)) {
        samples.push(`\n// Render/update pattern (app.js:${i + 1}):`);
        samples.push(...this.captureBlock(lines, i, 30));
        found.renderFn = true;
      }

      if (!found.eventBinding && trimmed.match(/\.addEventListener\s*\(\s*['"]click['"]/)) {
        const start = Math.max(0, i - 1);
        samples.push(`\n// Event binding pattern (app.js:${i + 1}):`);
        samples.push(...lines.slice(start, Math.min(i + 6, lines.length)));
        found.eventBinding = true;
      }

      if (!found.modalToggle && trimmed.match(/function\s+(show|open|close|hide|toggle)Modal/)) {
        samples.push(`\n// Modal pattern (app.js:${i + 1}):`);
        samples.push(...this.captureBlock(lines, i, 15));
        found.modalToggle = true;
      }

      if (!found.tabSwitch && trimmed.match(/function\s+(switch|show|select)Tab|function\s+navigate/)) {
        samples.push(`\n// Tab/navigation pattern (app.js:${i + 1}):`);
        samples.push(...this.captureBlock(lines, i, 15));
        found.tabSwitch = true;
      }

      if (!found.wsConnect && trimmed.match(/new\s+WebSocket\s*\(/)) {
        const start = Math.max(0, i - 2);
        samples.push(`\n// WebSocket connection (app.js:${i + 1}):`);
        samples.push(...this.captureBlock(lines, start, 25));
        found.wsConnect = true;
      }

      if (Object.values(found).every(Boolean)) break;
    }

    if (found.apiWrapper) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].match(/apiCall\s*\(/) && !lines[i].match(/function\s+apiCall/)) {
          const start = Math.max(0, i - 1);
          const end = Math.min(lines.length, i + 8);
          samples.push(`\n// API usage example (app.js:${i + 1}):`);
          samples.push(...lines.slice(start, end));
          break;
        }
      }
    }

    return samples;
  }

  private extractHtmlConventions(lines: string[]): string[] {
    const samples: string[] = [];

    const headStart = lines.findIndex(l => l.trim().match(/<head/i));
    const headEnd = lines.findIndex(l => l.trim().match(/<\/head/i));
    if (headStart >= 0 && headEnd >= 0) {
      samples.push(`// HTML head setup (index.html:${headStart + 1}-${headEnd + 1}):`);
      samples.push(...lines.slice(headStart, Math.min(headEnd + 1, headStart + 30)));
    }

    const bodyStart = lines.findIndex(l => l.trim().match(/<body/i));
    if (bodyStart >= 0) {
      samples.push(`\n// Body structure (index.html:${bodyStart + 1}):`);
      samples.push(...lines.slice(bodyStart, Math.min(bodyStart + 20, lines.length)));
    }

    return samples;
  }

  private extractCssConventions(lines: string[]): string[] {
    const samples: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim().match(/^:root\s*\{/)) {
        samples.push(`// CSS variables (styles.css:${i + 1}):`);
        samples.push(...this.captureBlock(lines, i, 40));
        break;
      }
    }

    for (let i = 0; i < Math.min(lines.length, 80); i++) {
      const trimmed = lines[i].trim();
      if (trimmed.match(/^(html|body|\*|\.app)\s*[,{]/)) {
        samples.push(`\n// Base styles (styles.css:${i + 1}):`);
        samples.push(...this.captureBlock(lines, i, 15));
        break;
      }
    }

    let componentCount = 0;
    for (let i = 0; i < lines.length && componentCount < 3; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.match(/^\.[a-zA-Z][\w-]*(__|--)?[\w-]*\s*\{/) &&
          !trimmed.match(/^\.(app)\s*\{/)) {
        samples.push(`\n// Component class example (styles.css:${i + 1}):`);
        samples.push(...this.captureBlock(lines, i, 12));
        componentCount++;
      }
    }

    return samples;
  }


  // ────────────────────────────────────────────────────────────────────────
  // HELPERS
  // ────────────────────────────────────────────────────────────────────────

  private captureBlock(lines: string[], startIdx: number, maxLines: number): string[] {
    const block: string[] = [];
    let braceDepth = 0;
    let parenDepth = 0;
    let started = false;

    for (let i = startIdx; i < Math.min(startIdx + maxLines, lines.length); i++) {
      block.push(lines[i]);

      for (const ch of lines[i]) {
        if (ch === "{") { braceDepth++; started = true; }
        if (ch === "}") braceDepth--;
        if (ch === "(") parenDepth++;
        if (ch === ")") parenDepth--;
      }

      if (started && braceDepth <= 0) {
        if (i + 1 < lines.length) {
          const nextTrimmed = lines[i + 1].trim();
          if (nextTrimmed.match(/^[)}\];,]/)) {
            block.push(lines[i + 1]);
          }
        }
        break;
      }
    }

    if (started && braceDepth > 0) {
      block.push("  // ... (block continues)");
    }

    return block;
  }
}
