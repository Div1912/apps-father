/* Agent Lessons & Code Patches — review, manage, and sync trained knowledge.
   Two tabs share one toolbar (Export / Import). See plan: agent-lessons import/export. */
(function () {
  "use strict";
  window.AdminPages = window.AdminPages || {};

  const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 0 7 4.5v15A2.5 2.5 0 0 0 9.5 22h11"/><path d="M14 2v20"/><path d="M2 9.5h5"/><path d="M2 14.5h5"/></svg>`;

  const esc = (s) => Fmt.escapeHtml(s);

  // ──────────────────────────────────────────────────────────────────────
  // Multipart upload helper — Api.request always sets Content-Type JSON.
  // ──────────────────────────────────────────────────────────────────────
  async function uploadKnowledgeFile(file) {
    const token = Api.getToken();
    const headers = {};
    if (token) headers["Authorization"] = "Bearer " + token;
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/admin/api/agent-knowledge/import/preview", {
      method: "POST",
      headers,
      body: form,
    });
    if (res.status === 401) {
      Api.logout();
      if (window.AdminApp && typeof window.AdminApp.boot === "function") window.AdminApp.boot();
      throw new Error("Unauthorized");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText || "Upload failed");
    return data;
  }

  // ──────────────────────────────────────────────────────────────────────
  // State
  // ──────────────────────────────────────────────────────────────────────
  const state = {
    tab: "lessons",          // "lessons" | "patches"
    lessons: [],
    patches: [],
    filters: {
      lessons: { enabled: "all", q: "", tag: "" },
      patches: { status: "all", q: "", tag: "" },
    },
    panelOpen: false,
    panelMode: null,         // "lesson-edit" | "lesson-new" | "patch-edit" | "patch-new" | "patch-view" | "import-preview"
    panelData: null,
    importDiff: null,        // ImportDiff from server preview
    importRawJson: null,     // raw json string (passed back to apply)
  };

  // ──────────────────────────────────────────────────────────────────────
  // Page entry — render shell
  // ──────────────────────────────────────────────────────────────────────
  window.AdminPages["agent-lessons"] = {
    title: "Agent Lessons",
    icon: ICON,
    render: async function (host) {
      host.innerHTML = `
        <div class="page-hdr">
          <div>
            <h1>Agent Lessons</h1>
            <div class="sub">Trained knowledge — runtime rules and code-fix suggestions. Sync between DEV and PROD via Export / Import.</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <button class="btn" id="al-export-btn">Export JSON</button>
            <button class="btn" id="al-import-btn">Import JSON</button>
            <input type="file" id="al-import-file" accept="application/json,.json" style="display:none"/>
            <button class="btn btn-primary" id="al-create-btn">+ New</button>
          </div>
        </div>

        <div class="al-tab-bar">
          <button class="al-tab" data-tab="lessons" id="tab-lessons">
            Lessons <span id="lessons-count" class="badge">0</span>
          </button>
          <button class="al-tab" data-tab="patches" id="tab-patches">
            Code Patches <span id="patches-count" class="badge">0</span>
          </button>
        </div>

        <div id="al-toolbar" class="al-toolbar"></div>

        <div id="al-content"><div class="loading-state"><div class="spinner"></div>Loading…</div></div>

        <!-- Side panel (used for create/edit/view/import) -->
        <div id="al-panel" class="side-panel">
          <div class="side-panel-header">
            <h2 id="al-panel-title" class="side-panel-title"></h2>
            <button id="al-panel-close" class="side-panel-close" aria-label="Close">×</button>
          </div>
          <div id="al-panel-body" class="side-panel-body"></div>
        </div>
        <div id="al-panel-overlay" class="side-panel-overlay"></div>
      `;

      // tab clicks
      host.querySelectorAll(".al-tab").forEach((btn) => {
        btn.addEventListener("click", () => {
          state.tab = btn.dataset.tab;
          renderActiveTab(host);
        });
      });

      // toolbar buttons
      host.querySelector("#al-create-btn").addEventListener("click", () => openCreatePanel(host));
      host.querySelector("#al-export-btn").addEventListener("click", () => doExport());
      host.querySelector("#al-import-btn").addEventListener("click", () => {
        host.querySelector("#al-import-file").click();
      });
      host.querySelector("#al-import-file").addEventListener("change", async (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = "";
        if (!file) return;
        try {
          const diff = await uploadKnowledgeFile(file);
          // We need the raw text to send back at apply time
          state.importRawJson = await file.text();
          state.importDiff = diff;
          openImportPreviewPanel(host);
        } catch (err) {
          Fmt.toast("Import failed: " + err.message, "err");
        }
      });

      // panel close
      host.querySelector("#al-panel-close").addEventListener("click", () => closePanel(host));
      host.querySelector("#al-panel-overlay").addEventListener("click", () => closePanel(host));

      await refreshAll(host);
    },
  };

  // ──────────────────────────────────────────────────────────────────────
  // Refresh & render
  // ──────────────────────────────────────────────────────────────────────
  async function refreshAll(host) {
    try {
      const [lessons, patches] = await Promise.all([
        Api.request("/agent-lessons"),
        Api.request("/agent-patches"),
      ]);
      state.lessons = lessons;
      state.patches = patches;
      host.querySelector("#lessons-count").textContent = lessons.length;
      host.querySelector("#patches-count").textContent = patches.length;
      renderActiveTab(host);
    } catch (err) {
      host.querySelector("#al-content").innerHTML =
        `<div class="error-state">Failed to load: ${esc(err.message)}</div>`;
    }
  }

  function renderActiveTab(host) {
    host.querySelectorAll(".al-tab").forEach((btn) => {
      btn.classList.toggle("active-tab", btn.dataset.tab === state.tab);
    });
    if (state.tab === "lessons") renderLessonsTab(host);
    else renderPatchesTab(host);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Lessons tab
  // ──────────────────────────────────────────────────────────────────────
  function renderLessonsTab(host) {
    const f = state.filters.lessons;
    const toolbar = host.querySelector("#al-toolbar");
    toolbar.innerHTML = `
      <input class="input" id="al-l-search" placeholder="Search lessons…" value="${esc(f.q)}" style="flex:1;min-width:220px"/>
      <select class="input" id="al-l-status" style="width:160px">
        <option value="all" ${f.enabled === "all" ? "selected" : ""}>All</option>
        <option value="enabled" ${f.enabled === "enabled" ? "selected" : ""}>Enabled</option>
        <option value="disabled" ${f.enabled === "disabled" ? "selected" : ""}>Disabled</option>
      </select>
      <input class="input" id="al-l-tag" placeholder="Filter by tag" value="${esc(f.tag)}" style="width:160px"/>
      <button class="btn" id="al-l-bulk-enable">Enable selected</button>
      <button class="btn" id="al-l-bulk-disable">Disable selected</button>
    `;
    toolbar.querySelector("#al-l-search").addEventListener("input", (e) => { f.q = e.target.value; renderLessonsList(host); });
    toolbar.querySelector("#al-l-status").addEventListener("change", (e) => { f.enabled = e.target.value; renderLessonsList(host); });
    toolbar.querySelector("#al-l-tag").addEventListener("input", (e) => { f.tag = e.target.value; renderLessonsList(host); });
    toolbar.querySelector("#al-l-bulk-enable").addEventListener("click", () => bulkSetEnabled(host, true));
    toolbar.querySelector("#al-l-bulk-disable").addEventListener("click", () => bulkSetEnabled(host, false));
    renderLessonsList(host);
  }

  function filterLessons() {
    const f = state.filters.lessons;
    const q = (f.q || "").toLowerCase().trim();
    const tag = (f.tag || "").toLowerCase().trim();
    return state.lessons.filter((l) => {
      if (f.enabled === "enabled" && !l.enabled) return false;
      if (f.enabled === "disabled" && l.enabled) return false;
      if (tag && !(l.tags || []).some((t) => String(t).toLowerCase().includes(tag))) return false;
      if (q) {
        const hay = `${l.rule || ""} ${l.context || ""} ${l.notes || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function renderLessonsList(host) {
    const content = host.querySelector("#al-content");
    const rows = filterLessons();
    if (!rows.length) {
      content.innerHTML = `<div class="empty-state">No lessons match. Click <b>+ New</b> to create one.</div>`;
      return;
    }
    content.innerHTML = `
      <div class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th style="width:36px"><input type="checkbox" id="al-l-checkall"/></th>
              <th style="width:80px">Status</th>
              <th>Rule</th>
              <th style="width:180px">Tags</th>
              <th style="width:120px">Source</th>
              <th style="width:120px">Updated</th>
              <th style="width:80px"></th>
            </tr>
          </thead>
          <tbody id="al-l-tbody"></tbody>
        </table>
      </div>
    `;
    const tbody = content.querySelector("#al-l-tbody");
    rows.forEach((l) => {
      const tr = document.createElement("tr");
      const tagsHtml = (l.tags || []).map((t) => `<span class="adm-tag-chip">${esc(t)}</span>`).join("");
      const sourceHtml = l.importedFrom
        ? `<span class="badge badge-info">from ${esc(l.importedFrom)}</span>`
        : `<span class="badge">Local</span>`;
      const ruleSnippet = String(l.rule || "").length > 120
        ? esc(l.rule.slice(0, 120)) + "…"
        : esc(l.rule || "");
      const enabledBadge = l.enabled
        ? `<span class="badge ok">ON</span>`
        : `<span class="badge">OFF</span>`;
      tr.innerHTML = `
        <td><input type="checkbox" class="al-l-row-check" data-id="${esc(l.id)}"/></td>
        <td>
          <label class="al-toggle-label">
            <input type="checkbox" class="al-l-toggle" data-id="${esc(l.id)}" ${l.enabled ? "checked" : ""}/>
            ${enabledBadge}
          </label>
        </td>
        <td title="${esc(l.rule || "")}" style="color:var(--admin-text)">${ruleSnippet}</td>
        <td>${tagsHtml || `<span style="color:var(--admin-muted)">—</span>`}</td>
        <td>${sourceHtml}</td>
        <td style="font-size:12px;color:var(--admin-muted)">${esc(Fmt.relativeTime(l.updatedAt))}</td>
        <td><button class="btn btn-sm al-l-edit" data-id="${esc(l.id)}">Edit</button></td>
      `;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll(".al-l-toggle").forEach((cb) => {
      cb.addEventListener("change", async (e) => {
        const id = e.target.dataset.id;
        const enabled = e.target.checked;
        try {
          await Api.request(`/agent-lessons/${id}/${enabled ? "enable" : "disable"}`, { method: "POST" });
          const row = state.lessons.find((x) => x.id === id);
          if (row) row.enabled = enabled;
          Fmt.toast(enabled ? "Enabled" : "Disabled", "ok");
        } catch (err) {
          e.target.checked = !enabled;
          Fmt.toast(err.message || "Toggle failed", "err");
        }
      });
    });
    tbody.querySelectorAll(".al-l-edit").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        const lesson = state.lessons.find((x) => x.id === id);
        if (lesson) openLessonPanel(host, lesson);
      });
    });
    content.querySelector("#al-l-checkall").addEventListener("change", (e) => {
      tbody.querySelectorAll(".al-l-row-check").forEach((cb) => { cb.checked = e.target.checked; });
    });
  }

  async function bulkSetEnabled(host, enabled) {
    const ids = Array.from(host.querySelectorAll(".al-l-row-check:checked")).map((cb) => cb.dataset.id);
    if (!ids.length) { Fmt.toast("Select at least one lesson", "info"); return; }
    try {
      const res = await Api.request(`/agent-lessons/bulk-${enabled ? "enable" : "disable"}`, {
        method: "POST",
        body: { ids },
      });
      Fmt.toast(`${enabled ? "Enabled" : "Disabled"} ${res.count}`, "ok");
      await refreshAll(host);
    } catch (err) {
      Fmt.toast(err.message || "Bulk failed", "err");
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Patches tab
  // ──────────────────────────────────────────────────────────────────────
  function renderPatchesTab(host) {
    const f = state.filters.patches;
    const toolbar = host.querySelector("#al-toolbar");
    toolbar.innerHTML = `
      <input class="input" id="al-p-search" placeholder="Search patches…" value="${esc(f.q)}" style="flex:1;min-width:220px"/>
      <select class="input" id="al-p-status" style="width:160px">
        <option value="all" ${f.status === "all" ? "selected" : ""}>All</option>
        <option value="proposed" ${f.status === "proposed" ? "selected" : ""}>Proposed</option>
        <option value="applied" ${f.status === "applied" ? "selected" : ""}>Applied</option>
        <option value="rejected" ${f.status === "rejected" ? "selected" : ""}>Rejected</option>
      </select>
      <input class="input" id="al-p-tag" placeholder="Filter by tag" value="${esc(f.tag)}" style="width:160px"/>
    `;
    toolbar.querySelector("#al-p-search").addEventListener("input", (e) => { f.q = e.target.value; renderPatchesList(host); });
    toolbar.querySelector("#al-p-status").addEventListener("change", (e) => { f.status = e.target.value; renderPatchesList(host); });
    toolbar.querySelector("#al-p-tag").addEventListener("input", (e) => { f.tag = e.target.value; renderPatchesList(host); });
    renderPatchesList(host);
  }

  function filterPatches() {
    const f = state.filters.patches;
    const q = (f.q || "").toLowerCase().trim();
    const tag = (f.tag || "").toLowerCase().trim();
    return state.patches.filter((p) => {
      if (f.status !== "all" && p.status !== f.status) return false;
      if (tag && !(p.tags || []).some((t) => String(t).toLowerCase().includes(tag))) return false;
      if (q) {
        const hay = `${p.title || ""} ${p.problem || ""} ${p.suggestion || ""} ${p.cursorPrompt || ""} ${p.notes || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function patchStatusBadge(s) {
    if (s === "applied") return `<span class="badge ok">applied</span>`;
    if (s === "rejected") return `<span class="badge err">rejected</span>`;
    return `<span class="badge warn">proposed</span>`;
  }

  function renderPatchesList(host) {
    const content = host.querySelector("#al-content");
    const rows = filterPatches();
    if (!rows.length) {
      content.innerHTML = `<div class="empty-state">No patches match. Click <b>+ New</b> to create one.</div>`;
      return;
    }
    content.innerHTML = `
      <div class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th style="width:100px">Status</th>
              <th>Title</th>
              <th style="width:240px">Target files</th>
              <th style="width:160px">Tags</th>
              <th style="width:120px">Source</th>
              <th style="width:120px">Updated</th>
              <th style="width:70px"></th>
            </tr>
          </thead>
          <tbody id="al-p-tbody"></tbody>
        </table>
      </div>
    `;
    const tbody = content.querySelector("#al-p-tbody");
    rows.forEach((p) => {
      const tr = document.createElement("tr");
      const targetsHtml = (p.targetFiles || [])
        .map((f) => `<code class="al-code-chip">${esc(f.split("/").slice(-2).join("/"))}</code>`)
        .join("") || `<span style="color:var(--admin-muted)">—</span>`;
      const tagsHtml = (p.tags || []).map((t) => `<span class="adm-tag-chip">${esc(t)}</span>`).join("") || `<span style="color:var(--admin-muted)">—</span>`;
      const sourceHtml = p.importedFrom
        ? `<span class="badge badge-info">from ${esc(p.importedFrom)}</span>`
        : `<span class="badge">Local</span>`;
      tr.innerHTML = `
        <td>${patchStatusBadge(p.status)}</td>
        <td style="color:var(--admin-text)"><b>${esc(p.title)}</b></td>
        <td>${targetsHtml}</td>
        <td>${tagsHtml}</td>
        <td>${sourceHtml}</td>
        <td style="font-size:12px;color:var(--admin-muted)">${esc(Fmt.relativeTime(p.updatedAt))}</td>
        <td><button class="btn btn-sm al-p-view" data-id="${esc(p.id)}">View</button></td>
      `;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll(".al-p-view").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.id;
        const patch = state.patches.find((x) => x.id === id);
        if (patch) openPatchViewPanel(host, patch);
      });
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // Panel — generic open/close
  // ──────────────────────────────────────────────────────────────────────
  function openPanel(host, title) {
    host.querySelector("#al-panel-title").textContent = title;
    const panel = host.querySelector("#al-panel");
    const overlay = host.querySelector("#al-panel-overlay");
    overlay.classList.add("open");
    panel.classList.add("open");
    state.panelOpen = true;
  }

  function closePanel(host) {
    host.querySelector("#al-panel").classList.remove("open");
    host.querySelector("#al-panel-overlay").classList.remove("open");
    setTimeout(() => {
      if (host.querySelector("#al-panel-body"))
        host.querySelector("#al-panel-body").innerHTML = "";
    }, 240);
    state.panelOpen = false;
    state.panelMode = null;
    state.panelData = null;
    state.importDiff = null;
    state.importRawJson = null;
  }

  function openCreatePanel(host) {
    if (state.tab === "lessons") openLessonPanel(host, null);
    else openPatchPanel(host, null);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Lesson edit panel
  // ──────────────────────────────────────────────────────────────────────
  function openLessonPanel(host, lesson) {
    state.panelMode = lesson ? "lesson-edit" : "lesson-new";
    state.panelData = lesson;
    openPanel(host, lesson ? "Edit Lesson" : "New Lesson");
    const body = host.querySelector("#al-panel-body");
    const tagsStr = lesson ? (lesson.tags || []).join(", ") : "";
    body.innerHTML = `
      <form id="al-lesson-form" autocomplete="off">
        <div class="input-label">Rule (injected into agent prompt) *</div>
        <textarea class="input" id="al-l-rule" rows="3" required style="resize:vertical">${esc(lesson ? lesson.rule : "")}</textarea>

        <div class="input-label" style="margin-top:10px">Context (when this rule applies)</div>
        <textarea class="input" id="al-l-context" rows="2" style="resize:vertical">${esc(lesson ? (lesson.context || "") : "")}</textarea>

        <div class="input-label" style="margin-top:10px">Tags (comma-separated)</div>
        <input class="input" type="text" id="al-l-tags" value="${esc(tagsStr)}" placeholder="forms, validation, ui"/>

        <div class="input-label" style="margin-top:10px">Notes (admin-only, exported)</div>
        <textarea class="input" id="al-l-notes" rows="2" style="resize:vertical">${esc(lesson ? (lesson.notes || "") : "")}</textarea>

        ${lesson ? `<div style="margin-top:14px;padding:10px;background:rgba(255,255,255,0.03);border-radius:6px;font-size:12px;color:#9aa5b8">
          <div>ID: <code>${esc(lesson.id)}</code></div>
          <div>Status: <b style="color:${lesson.enabled ? "#4ade80" : "#9aa5b8"}">${lesson.enabled ? "ENABLED" : "DISABLED"}</b></div>
          <div>Source: ${lesson.importedFrom ? `imported from <b>${esc(lesson.importedFrom)}</b>` : "local"}</div>
          <div>Created: ${esc(Fmt.date(lesson.createdAt))}</div>
        </div>` : ""}

        <div style="display:flex;gap:10px;margin-top:20px">
          <button type="submit" class="btn btn-primary" id="al-l-save" style="flex:1">Save</button>
          ${lesson ? `<button type="button" class="btn btn-danger" id="al-l-delete">Delete</button>` : ""}
        </div>
      </form>
    `;
    body.querySelector("#al-lesson-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const payload = {
        rule: body.querySelector("#al-l-rule").value.trim(),
        context: body.querySelector("#al-l-context").value.trim() || null,
        tags: body.querySelector("#al-l-tags").value.split(",").map((s) => s.trim()).filter(Boolean),
        notes: body.querySelector("#al-l-notes").value.trim() || null,
      };
      if (!payload.rule) { Fmt.toast("Rule is required", "err"); return; }
      const saveBtn = body.querySelector("#al-l-save");
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving…";
      try {
        if (lesson) await Api.request(`/agent-lessons/${lesson.id}`, { method: "PATCH", body: payload });
        else await Api.request(`/agent-lessons`, { method: "POST", body: payload });
        Fmt.toast("Saved", "ok");
        closePanel(host);
        await refreshAll(host);
      } catch (err) {
        Fmt.toast(err.message || "Save failed", "err");
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = "Save";
      }
    });
    if (lesson) {
      body.querySelector("#al-l-delete").addEventListener("click", async () => {
        if (!confirm("Delete this lesson permanently?")) return;
        try {
          await Api.request(`/agent-lessons/${lesson.id}`, { method: "DELETE" });
          Fmt.toast("Deleted", "ok");
          closePanel(host);
          await refreshAll(host);
        } catch (err) {
          Fmt.toast(err.message || "Delete failed", "err");
        }
      });
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Patch view + edit panels
  // ──────────────────────────────────────────────────────────────────────
  function openPatchViewPanel(host, patch) {
    state.panelMode = "patch-view";
    state.panelData = patch;
    openPanel(host, "Code Patch");
    const body = host.querySelector("#al-panel-body");
    const targetsHtml = (patch.targetFiles || [])
      .map((f) => `<div><code style="background:rgba(255,255,255,0.04);padding:2px 6px;border-radius:4px;font-size:12px">${esc(f)}</code></div>`)
      .join("");
    body.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
        ${patchStatusBadge(patch.status)}
        ${patch.importedFrom ? `<span class="badge" style="background:#1f3a5f;color:#9ec5ff">from ${esc(patch.importedFrom)}</span>` : `<span class="badge">Local</span>`}
        ${(patch.tags || []).map((t) => `<span class="badge">${esc(t)}</span>`).join("")}
      </div>

      <h3 style="margin:0 0 6px;font-size:16px">${esc(patch.title)}</h3>

      <div class="input-label" style="margin-top:14px">Problem</div>
      <div style="padding:10px;background:rgba(255,255,255,0.03);border-radius:6px;white-space:pre-wrap;font-size:13px;line-height:1.5">${esc(patch.problem)}</div>

      <div class="input-label" style="margin-top:14px">Target files</div>
      <div>${targetsHtml || "<i style='color:#9aa5b8'>none</i>"}</div>

      <div class="input-label" style="margin-top:14px">Suggestion</div>
      <div style="padding:10px;background:rgba(255,255,255,0.03);border-radius:6px;white-space:pre-wrap;font-size:13px;line-height:1.5">${esc(patch.suggestion)}</div>

      <div class="input-label" style="margin-top:14px;display:flex;justify-content:space-between;align-items:center">
        <span>Cursor prompt (paste in IDE)</span>
        <button class="btn btn-sm" id="al-p-copy">Copy</button>
      </div>
      <div style="padding:10px;background:#0d1117;border:1px solid #2a3040;border-radius:6px;white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:1.5;max-height:240px;overflow:auto">${esc(patch.cursorPrompt)}</div>

      ${patch.notes ? `
        <div class="input-label" style="margin-top:14px">Notes</div>
        <div style="padding:10px;background:rgba(255,255,255,0.03);border-radius:6px;white-space:pre-wrap;font-size:13px">${esc(patch.notes)}</div>
      ` : ""}

      <div style="margin-top:14px;padding:10px;background:rgba(255,255,255,0.03);border-radius:6px;font-size:12px;color:#9aa5b8">
        <div>ID: <code>${esc(patch.id)}</code></div>
        <div>Created: ${esc(Fmt.date(patch.createdAt))}</div>
        ${patch.appliedAt ? `<div>Applied: ${esc(Fmt.date(patch.appliedAt))}${patch.appliedCommit ? ` · commit <code>${esc(patch.appliedCommit)}</code>` : ""}</div>` : ""}
        ${patch.rejectedAt ? `<div>Rejected: ${esc(Fmt.date(patch.rejectedAt))}</div>` : ""}
      </div>

      <div style="display:flex;gap:8px;margin-top:18px;flex-wrap:wrap">
        ${patch.status !== "applied" ? `<button class="btn btn-primary" id="al-p-apply">Mark Applied</button>` : ""}
        ${patch.status !== "rejected" ? `<button class="btn" id="al-p-reject">Mark Rejected</button>` : ""}
        ${patch.status !== "proposed" ? `<button class="btn" id="al-p-reopen">Reopen</button>` : ""}
        <button class="btn" id="al-p-edit-btn">Edit</button>
        <button class="btn btn-danger" id="al-p-delete" style="margin-left:auto">Delete</button>
      </div>
    `;
    body.querySelector("#al-p-copy").addEventListener("click", async () => {
      try { await Fmt.copyToClipboard(patch.cursorPrompt); Fmt.toast("Copied to clipboard", "ok"); }
      catch { Fmt.toast("Copy failed", "err"); }
    });
    const applyBtn = body.querySelector("#al-p-apply");
    if (applyBtn) {
      applyBtn.addEventListener("click", async () => {
        const commit = prompt("Optional: paste git commit SHA where you applied this patch", "");
        try {
          await Api.request(`/agent-patches/${patch.id}/mark-applied`, {
            method: "POST",
            body: { commit: commit ? commit.trim() : "" },
          });
          Fmt.toast("Marked applied", "ok");
          closePanel(host);
          await refreshAll(host);
        } catch (err) { Fmt.toast(err.message || "Failed", "err"); }
      });
    }
    const rejectBtn = body.querySelector("#al-p-reject");
    if (rejectBtn) {
      rejectBtn.addEventListener("click", async () => {
        if (!confirm("Mark this patch as rejected?")) return;
        try {
          await Api.request(`/agent-patches/${patch.id}/mark-rejected`, { method: "POST" });
          Fmt.toast("Rejected", "ok");
          closePanel(host);
          await refreshAll(host);
        } catch (err) { Fmt.toast(err.message || "Failed", "err"); }
      });
    }
    const reopenBtn = body.querySelector("#al-p-reopen");
    if (reopenBtn) {
      reopenBtn.addEventListener("click", async () => {
        try {
          await Api.request(`/agent-patches/${patch.id}/reopen`, { method: "POST" });
          Fmt.toast("Reopened", "ok");
          closePanel(host);
          await refreshAll(host);
        } catch (err) { Fmt.toast(err.message || "Failed", "err"); }
      });
    }
    body.querySelector("#al-p-edit-btn").addEventListener("click", () => openPatchPanel(host, patch));
    body.querySelector("#al-p-delete").addEventListener("click", async () => {
      if (!confirm("Delete this patch permanently?")) return;
      try {
        await Api.request(`/agent-patches/${patch.id}`, { method: "DELETE" });
        Fmt.toast("Deleted", "ok");
        closePanel(host);
        await refreshAll(host);
      } catch (err) { Fmt.toast(err.message || "Delete failed", "err"); }
    });
  }

  function openPatchPanel(host, patch) {
    state.panelMode = patch ? "patch-edit" : "patch-new";
    state.panelData = patch;
    openPanel(host, patch ? "Edit Patch" : "New Patch");
    const body = host.querySelector("#al-panel-body");
    const tagsStr = patch ? (patch.tags || []).join(", ") : "";
    const filesStr = patch ? (patch.targetFiles || []).join("\n") : "";
    body.innerHTML = `
      <form id="al-patch-form" autocomplete="off">
        <div class="input-label">Title *</div>
        <input class="input" type="text" id="al-p-title" value="${esc(patch ? patch.title : "")}" required/>

        <div class="input-label" style="margin-top:10px">Problem (what's broken in agent behavior) *</div>
        <textarea class="input" id="al-p-problem" rows="3" required style="resize:vertical">${esc(patch ? patch.problem : "")}</textarea>

        <div class="input-label" style="margin-top:10px">Target files (one per line)</div>
        <textarea class="input" id="al-p-files" rows="3" placeholder="agent_knowledge/instructions/frontend-rules.md&#10;src/services/agent.service.ts" style="resize:vertical;font-family:ui-monospace,Menlo,monospace;font-size:12px">${esc(filesStr)}</textarea>

        <div class="input-label" style="margin-top:10px">Suggestion (what to change) *</div>
        <textarea class="input" id="al-p-suggestion" rows="3" required style="resize:vertical">${esc(patch ? patch.suggestion : "")}</textarea>

        <div class="input-label" style="margin-top:10px">Cursor prompt (paste-ready instruction for IDE) *</div>
        <textarea class="input" id="al-p-cursor" rows="6" required style="resize:vertical;font-family:ui-monospace,Menlo,monospace;font-size:12px">${esc(patch ? patch.cursorPrompt : "")}</textarea>

        <div class="input-label" style="margin-top:10px">Tags (comma-separated)</div>
        <input class="input" type="text" id="al-p-tags" value="${esc(tagsStr)}" placeholder="instructions, frontend"/>

        <div class="input-label" style="margin-top:10px">Notes (admin-only, exported)</div>
        <textarea class="input" id="al-p-notes" rows="2" style="resize:vertical">${esc(patch ? (patch.notes || "") : "")}</textarea>

        <div style="display:flex;gap:10px;margin-top:20px">
          <button type="submit" class="btn btn-primary" id="al-p-save" style="flex:1">Save</button>
        </div>
      </form>
    `;
    body.querySelector("#al-patch-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const payload = {
        title: body.querySelector("#al-p-title").value.trim(),
        problem: body.querySelector("#al-p-problem").value.trim(),
        targetFiles: body.querySelector("#al-p-files").value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
        suggestion: body.querySelector("#al-p-suggestion").value.trim(),
        cursorPrompt: body.querySelector("#al-p-cursor").value.trim(),
        tags: body.querySelector("#al-p-tags").value.split(",").map((s) => s.trim()).filter(Boolean),
        notes: body.querySelector("#al-p-notes").value.trim() || null,
      };
      if (!payload.title || !payload.problem || !payload.suggestion || !payload.cursorPrompt) {
        Fmt.toast("Fill all required fields", "err"); return;
      }
      const saveBtn = body.querySelector("#al-p-save");
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving…";
      try {
        if (patch) await Api.request(`/agent-patches/${patch.id}`, { method: "PATCH", body: payload });
        else await Api.request(`/agent-patches`, { method: "POST", body: payload });
        Fmt.toast("Saved", "ok");
        closePanel(host);
        await refreshAll(host);
      } catch (err) {
        Fmt.toast(err.message || "Save failed", "err");
      } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = "Save";
      }
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // Export
  // ──────────────────────────────────────────────────────────────────────
  async function doExport() {
    try {
      const token = Api.getToken();
      const headers = {};
      if (token) headers["Authorization"] = "Bearer " + token;
      const res = await fetch("/admin/api/agent-knowledge/export", { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const cd = res.headers.get("content-disposition") || "";
      const m = /filename="([^"]+)"/.exec(cd);
      const filename = m ? m[1] : `agent-knowledge-${new Date().toISOString().slice(0, 10)}.json`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      Fmt.toast("Exported " + filename, "ok");
    } catch (err) {
      Fmt.toast("Export failed: " + err.message, "err");
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Import preview panel
  // ──────────────────────────────────────────────────────────────────────
  function openImportPreviewPanel(host) {
    state.panelMode = "import-preview";
    openPanel(host, "Import Preview");
    const body = host.querySelector("#al-panel-body");
    const diff = state.importDiff;
    const lc = diff.lessons;
    const pc = diff.patches;

    // Build per-row checkbox map; default: NEW + UPDATED checked.
    body.innerHTML = `
      <div style="font-size:12px;color:#9aa5b8;margin-bottom:14px">
        Exported from <b>${esc(diff.exportedFrom)}</b> at ${esc(Fmt.date(diff.exportedAt))}
      </div>

      <details open style="margin-bottom:14px;border:1px solid #2a3040;border-radius:6px;padding:10px">
        <summary style="cursor:pointer;font-weight:600">Lessons — ${lc.new.length} new · ${lc.updated.length} updated · ${lc.identical.length} identical · ${lc.localOnly.length} local-only</summary>
        ${renderDiffSection("lesson-new", "NEW (created as DISABLED unless toggled)", lc.new, lessonRowSummary, true)}
        ${renderDiffSection("lesson-upd", "UPDATED (local enabled flag preserved)", lc.updated.map((u) => u.incoming), (l, i) => `${lessonRowSummary(l, i)} <span style="color:#9aa5b8;font-size:11px">· changed: ${esc((lc.updated[i].fieldsChanged || []).join(", "))}</span>`, true)}
        ${renderDiffSection("lesson-ide", "IDENTICAL (no action)", lc.identical, lessonRowSummary, false, true)}
        ${renderDiffSection("lesson-loc", "LOCAL-ONLY (kept untouched)", lc.localOnly, lessonRowSummary, false, true)}
      </details>

      <details open style="margin-bottom:14px;border:1px solid #2a3040;border-radius:6px;padding:10px">
        <summary style="cursor:pointer;font-weight:600">Code Patches — ${pc.new.length} new · ${pc.updated.length} updated · ${pc.identical.length} identical · ${pc.localOnly.length} local-only</summary>
        ${renderDiffSection("patch-new", "NEW (created as PROPOSED)", pc.new, patchRowSummary, true)}
        ${renderDiffSection("patch-upd", "UPDATED (local status preserved)", pc.updated.map((u) => u.incoming), (p, i) => `${patchRowSummary(p, i)} <span style="color:#9aa5b8;font-size:11px">· changed: ${esc((pc.updated[i].fieldsChanged || []).join(", "))}</span>`, true)}
        ${renderDiffSection("patch-ide", "IDENTICAL (no action)", pc.identical, patchRowSummary, false, true)}
        ${renderDiffSection("patch-loc", "LOCAL-ONLY (kept untouched)", pc.localOnly, patchRowSummary, false, true)}
      </details>

      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:14px">
        <input type="checkbox" id="al-import-enable-new" style="width:16px;height:16px"/>
        <span>Enable newly imported lessons immediately</span>
      </label>

      <div style="display:flex;gap:10px">
        <button class="btn" id="al-import-cancel" style="flex:1">Cancel</button>
        <button class="btn btn-primary" id="al-import-apply" style="flex:2">Apply Import</button>
      </div>
    `;
    body.querySelector("#al-import-cancel").addEventListener("click", () => closePanel(host));
    body.querySelector("#al-import-apply").addEventListener("click", () => doApplyImport(host));
  }

  function lessonRowSummary(l) {
    const tags = (l.tags || []).slice(0, 3).join(", ");
    const ruleSnip = String(l.rule || "").slice(0, 100);
    return `<b>${esc(ruleSnip)}${l.rule && l.rule.length > 100 ? "…" : ""}</b>${tags ? ` <span style="color:#9aa5b8;font-size:11px">[${esc(tags)}]</span>` : ""}`;
  }

  function patchRowSummary(p) {
    const targets = (p.targetFiles || []).slice(0, 2).map((f) => f.split("/").pop()).join(", ");
    return `<b>${esc(p.title)}</b>${targets ? ` <span style="color:#9aa5b8;font-size:11px">→ ${esc(targets)}</span>` : ""}`;
  }

  function renderDiffSection(group, label, rows, rowFn, defaultChecked, readOnly) {
    if (!rows.length) return "";
    return `
      <div style="margin-top:8px">
        <div style="font-size:11px;color:#9aa5b8;text-transform:uppercase;letter-spacing:.5px;margin:6px 0 4px">${esc(label)} (${rows.length})</div>
        ${rows.map((r, i) => `
          <label style="display:flex;align-items:flex-start;gap:8px;padding:6px;border-radius:4px;cursor:${readOnly ? "default" : "pointer"};${readOnly ? "opacity:.6" : ""}">
            <input type="checkbox" class="al-import-check" data-group="${esc(group)}" data-id="${esc(r.id)}" ${defaultChecked ? "checked" : ""} ${readOnly ? "disabled" : ""} style="margin-top:3px;width:14px;height:14px"/>
            <span style="flex:1;font-size:13px;line-height:1.4">${rowFn(r, i)}</span>
          </label>
        `).join("")}
      </div>
    `;
  }

  async function doApplyImport(host) {
    const enableNewLessons = host.querySelector("#al-import-enable-new").checked;
    const lessonActions = {};
    const patchActions = {};

    host.querySelectorAll(".al-import-check").forEach((cb) => {
      const group = cb.dataset.group;
      const id = cb.dataset.id;
      const checked = cb.checked;
      if (!checked) return;
      // group encodes kind + bucket: "lesson-new" / "lesson-upd" / "patch-new" / "patch-upd"
      if (group === "lesson-new") lessonActions[id] = "create";
      else if (group === "lesson-upd") lessonActions[id] = "update";
      else if (group === "patch-new") patchActions[id] = "create";
      else if (group === "patch-upd") patchActions[id] = "update";
    });

    const applyBtn = host.querySelector("#al-import-apply");
    applyBtn.disabled = true;
    applyBtn.textContent = "Applying…";
    try {
      const result = await Api.request("/agent-knowledge/import/apply", {
        method: "POST",
        body: {
          json: state.importRawJson,
          lessonActions,
          patchActions,
          enableNewLessons,
        },
      });
      const lc = result.lessons;
      const pc = result.patches;
      Fmt.toast(
        `Imported lessons: +${lc.created} ~${lc.updated} (skip ${lc.skipped}) · patches: +${pc.created} ~${pc.updated} (skip ${pc.skipped})`,
        "ok",
      );
      closePanel(host);
      await refreshAll(host);
    } catch (err) {
      Fmt.toast("Apply failed: " + err.message, "err");
    } finally {
      applyBtn.disabled = false;
      applyBtn.textContent = "Apply Import";
    }
  }
})();
