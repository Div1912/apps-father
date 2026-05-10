/* Logs viewer — Phase 8 (persistent).
   Backed by `prisma.appLog` (see src/services/app-log.service.ts) so we keep
   full historical data across PM2 restarts. The console tee captures every
   stdout/stderr line and stores it indexed by (projectId, category, ts).

   Filters: scope (All / System / project), category (Agent, Backend, …),
   level (info/warn/error), free-text search. Auto-refreshes every 5s by
   polling /admin/api/applogs?beforeId=… for the newest page. */
(function () {
  "use strict";
  window.AdminPages = window.AdminPages || {};

  const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`;

  function shortId(id) { return id && id.length > 12 ? id.slice(0, 8) + "…" : id; }

  // Project name lookup populated on first load. Cached per-tab so re-renders
  // don't re-fetch.
  let projectIndex = null;
  let projectIndexPromise = null;
  function loadProjectIndex() {
    if (projectIndex) return Promise.resolve(projectIndex);
    if (projectIndexPromise) return projectIndexPromise;
    projectIndexPromise = Api.request("/projects?pageSize=500&sort=updated_desc")
      .then(d => {
        projectIndex = new Map();
        for (const p of (d.projects || [])) projectIndex.set(p.id, p.name || p.id);
        return projectIndex;
      })
      .catch(() => { projectIndex = new Map(); return projectIndex; });
    return projectIndexPromise;
  }

  // Category → CSS color class. Falls back to the generic .out style.
  function categoryClass(cat) {
    switch ((cat || "").toLowerCase()) {
      case "agent":     return "out agent";
      case "build":     return "out info";
      case "bot":       return "out info";
      case "commit":    return "out success";
      case "api":       return "out";
      case "ws":        return "out info";
      case "web":       return "out";
      case "database":  return "out info";
      case "lifecycle": return "out warn";
      case "backend":   return "out";
      case "system":    return "out";
      default:          return "out";
    }
  }
  function levelClass(level, source) {
    if (source === "stderr") return "err";
    if (level === "error")   return "err";
    if (level === "warn")    return "out warn";
    return null;
  }
  function lineClass(entry) {
    return levelClass(entry.level, entry.source) || categoryClass(entry.category);
  }

  function fmtTs(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString([], { hour12: false }) + "." + String(d.getMilliseconds()).padStart(3, "0");
    } catch { return ""; }
  }

  /**
   * Reusable runtime-log viewer. Renders a toolbar + scrolling pane into
   * `host`. Used by the global Logs page AND by the per-app Logs sub-tab.
   *
   * Options:
   *   - state: persisted UI state object (mutated in place)
   *   - lockedProjectId: when set, hides the scope dropdown and forces this id
   *   - showSourceFilter: if true, also exposes stdout / stderr selector
   */
  function mountLogsViewer(host, options) {
    const opts = options || {};
    const state = opts.state;
    state.scope     = state.scope     || (opts.lockedProjectId ? opts.lockedProjectId : "all");
    state.category  = state.category  || "all";
    state.level     = state.level     || "all";
    state.filter    = state.filter    || "";
    state.lines     = state.lines     || 300;
    state.autoRefresh = state.autoRefresh !== false;
    if (opts.lockedProjectId) state.scope = opts.lockedProjectId;

    host.innerHTML = `
      <div class="logs-toolbar">
        ${opts.lockedProjectId ? "" : `
          <select class="select" id="lg-scope" title="Filter by source">
            <option value="all">All sources</option>
            <option value="__system__">System (Apps Father core)</option>
            <option value="__projects__" disabled>—— Projects ——</option>
          </select>
        `}

        <select class="select" id="lg-category" title="Filter by category">
          <option value="all">All categories</option>
        </select>

        <select class="select" id="lg-level" title="Filter by level">
          <option value="all">All levels</option>
          <option value="info">Info</option>
          <option value="warn">Warning</option>
          <option value="error">Error</option>
          <option value="debug">Debug</option>
        </select>

        <select class="select" id="lg-lines">
          <option value="100">100 lines</option>
          <option value="300">300 lines</option>
          <option value="1000">1000 lines</option>
          <option value="2000">2000 lines</option>
        </select>

        <input type="search" class="input" id="lg-filter" placeholder="Filter…" style="max-width:240px"/>

        <label class="logs-auto">
          <input type="checkbox" id="lg-auto" ${state.autoRefresh ? "checked" : ""}/>
          <span>Auto 5s</span>
        </label>

        <button class="btn btn-sm btn-ghost" id="lg-refresh" style="margin-left:auto">Refresh</button>
        <button class="btn btn-sm btn-ghost" id="lg-clear" title="Clear visible lines (does not delete from DB)">Clear</button>

        <span class="logs-meta" id="lg-meta"></span>
      </div>

      <div class="logs-shell">
        <div class="logs-stream" id="lg-stream"><div class="loading-state"><div class="spinner"></div>Loading…</div></div>
      </div>
    `;

    const linesEl    = host.querySelector("#lg-lines");
    const filterEl   = host.querySelector("#lg-filter");
    const autoEl     = host.querySelector("#lg-auto");
    const streamEl   = host.querySelector("#lg-stream");
    const metaEl     = host.querySelector("#lg-meta");
    const refreshBtn = host.querySelector("#lg-refresh");
    const clearBtn   = host.querySelector("#lg-clear");
    const scopeEl    = host.querySelector("#lg-scope");
    const catEl      = host.querySelector("#lg-category");
    const levelEl    = host.querySelector("#lg-level");

    linesEl.value  = String(state.lines);
    filterEl.value = state.filter;
    levelEl.value  = state.level;
    if (scopeEl) scopeEl.value = state.scope;

    // Track every project id we've seen so the scope dropdown stays in sync.
    const seenProjects = new Set();
    function ensureProjectOption(pid) {
      if (!scopeEl || !pid || seenProjects.has(pid)) return;
      seenProjects.add(pid);
      const name = projectIndex && projectIndex.get(pid);
      const label = name ? `${name} (${shortId(pid)})` : shortId(pid);
      const opt = document.createElement("option");
      opt.value = pid;
      opt.textContent = label;
      scopeEl.appendChild(opt);
      if (state.scope === pid) scopeEl.value = pid;
    }

    // Populate categories dropdown from server (cached server-side).
    Api.request("/applogs/categories").then(d => {
      const cats = d.categories || [];
      for (const c of cats) {
        const opt = document.createElement("option");
        opt.value = c;
        opt.textContent = c;
        catEl.appendChild(opt);
      }
      catEl.value = state.category;
    }).catch(() => {});

    let timer = null;
    let inFlight = false;
    let stickyBottom = true;
    let latestId = null;        // newest id we've already rendered (for incremental polls)
    let lineCount = 0;          // currently in DOM

    streamEl.addEventListener("scroll", () => {
      const dist = streamEl.scrollHeight - streamEl.scrollTop - streamEl.clientHeight;
      stickyBottom = dist < 80;
    });

    function lineHtml(entry) {
      const cls   = lineClass(entry);
      const ts    = fmtTs(entry.ts);
      const cat   = entry.category || "";
      let chip;
      if (entry.projectId) {
        const name = (projectIndex && projectIndex.get(entry.projectId)) || shortId(entry.projectId);
        chip = `<span class="log-tag" title="${Fmt.escapeHtml(entry.projectId)}">${Fmt.escapeHtml(name)}</span>`;
      } else {
        chip = `<span class="log-tag log-tag-core" title="Apps Father core">core</span>`;
      }
      const catChip = cat
        ? `<span class="log-cat" data-cat="${Fmt.escapeHtml(cat.toLowerCase())}">${Fmt.escapeHtml(cat)}</span>`
        : "";
      return `<div class="log-line ${cls}" data-id="${entry.id}">`
        + `<span class="log-ts-inline">${ts}</span>`
        + chip + catChip
        + `<span class="log-msg">${Fmt.escapeHtml(entry.message)}</span>`
        + `</div>`;
    }

    function buildQuery(extra) {
      const params = new URLSearchParams();
      if (opts.lockedProjectId) {
        params.set("projectId", opts.lockedProjectId);
      } else if (state.scope && state.scope !== "all") {
        params.set("projectId", state.scope);
      }
      if (state.category && state.category !== "all") params.set("category", state.category);
      if (state.level    && state.level    !== "all") params.set("level",    state.level);
      if (state.filter)                                params.set("q",        state.filter);
      params.set("limit", String(state.lines));
      if (extra) for (const [k, v] of Object.entries(extra)) params.set(k, v);
      return params.toString();
    }

    function endpointBase() {
      return opts.lockedProjectId
        ? "/projects/" + encodeURIComponent(opts.lockedProjectId) + "/applogs"
        : "/applogs";
    }

    async function fullReload() {
      if (inFlight) return;
      inFlight = true;
      try {
        const data = await Api.request(endpointBase() + "?" + buildQuery());
        const lines = data.lines || [];
        for (const e of lines) ensureProjectOption(e.projectId);
        if (!lines.length) {
          streamEl.innerHTML = `<div class="empty-state"><div class="big">·</div>No log entries match the current filters</div>`;
          metaEl.textContent = "0 lines";
          latestId = null;
          lineCount = 0;
          return;
        }
        streamEl.innerHTML = lines.map(lineHtml).join("");
        latestId  = lines[lines.length - 1].id;
        lineCount = lines.length;
        metaEl.textContent = lineCount + " line" + (lineCount === 1 ? "" : "s")
          + (data.hasMore ? " (more older)" : "");
        if (stickyBottom) streamEl.scrollTop = streamEl.scrollHeight;
      } catch (err) {
        streamEl.innerHTML = `<div class="error-state"><div class="big">!</div>${Fmt.escapeHtml(err.message || "Failed")}</div>`;
      } finally {
        inFlight = false;
      }
    }

    // Incremental poll — only fetch lines strictly newer than latestId using
    // the afterId param so the server returns at most a handful of new rows
    // instead of re-fetching the full 300-row page every tick.
    async function tick() {
      if (inFlight || !latestId) { return fullReload(); }
      inFlight = true;
      try {
        const extra = { afterId: latestId, limit: "200" };
        const data = await Api.request(endpointBase() + "?" + buildQuery(extra));
        const lines = data.lines || [];
        if (!lines.length) return;
        for (const e of lines) ensureProjectOption(e.projectId);
        streamEl.insertAdjacentHTML("beforeend", lines.map(lineHtml).join(""));
        latestId  = lines[lines.length - 1].id;
        lineCount += lines.length;
        // Cap DOM size so a long auto-refresh session doesn't grow without bound.
        const cap = state.lines * 2;
        while (lineCount > cap && streamEl.firstElementChild) {
          streamEl.removeChild(streamEl.firstElementChild);
          lineCount--;
        }
        metaEl.textContent = lineCount + " line" + (lineCount === 1 ? "" : "s");
        if (stickyBottom) streamEl.scrollTop = streamEl.scrollHeight;
      } catch { /* keep silent — UI shows previous content */ }
      finally { inFlight = false; }
    }

    function startTimer() {
      stopTimer();
      if (state.autoRefresh) timer = setInterval(tick, 5000);
    }
    function stopTimer() {
      if (timer) { clearInterval(timer); timer = null; }
    }

    if (scopeEl) scopeEl.addEventListener("change", () => { state.scope = scopeEl.value; fullReload(); });
    catEl.addEventListener("change",      () => { state.category = catEl.value; fullReload(); });
    levelEl.addEventListener("change",    () => { state.level    = levelEl.value; fullReload(); });
    linesEl.addEventListener("change",    () => { state.lines    = parseInt(linesEl.value, 10) || 300; fullReload(); });

    // Debounce free-text search.
    let searchTimer = null;
    filterEl.addEventListener("input", () => {
      state.filter = filterEl.value;
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(fullReload, 250);
    });

    autoEl.addEventListener("change", () => {
      state.autoRefresh = autoEl.checked;
      if (state.autoRefresh) startTimer(); else stopTimer();
    });
    refreshBtn.addEventListener("click", fullReload);
    clearBtn.addEventListener("click", () => {
      streamEl.innerHTML = `<div class="empty-state"><div class="big">·</div>Cleared. Logs are still in the database — refresh to reload.</div>`;
      lineCount = 0;
      latestId  = null;
      metaEl.textContent = "0 lines";
    });

    loadProjectIndex().then(() => {});

    fullReload().then(startTimer);

    // Return a teardown handle.
    return {
      destroy() { stopTimer(); },
    };
  }

  // Expose the reusable viewer so the App page can mount it inside its sub-tab.
  window.AdminPages.logsViewer = { mount: mountLogsViewer };

  window.AdminPages.logs = {
    title: "Logs",
    icon: ICON,
    render: async function (host, ctx) {
      const state = (ctx.state.logs = ctx.state.logs || {});
      host.innerHTML = `
        <div class="page-hdr">
          <div><h1>Logs</h1><div class="sub">Persistent runtime logs (all stdout / stderr captured)</div></div>
        </div>
        <div id="logs-viewer-host"></div>
      `;
      const viewerHost = host.querySelector("#logs-viewer-host");
      const handle = mountLogsViewer(viewerHost, { state });
      // Tear down the polling timer when the tab is closed/replaced.
      ctx.tab.onClose = () => handle.destroy();
    },
  };
})();
