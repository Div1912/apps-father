/* Agent Feedback — review user "cashback issue" cases collected from the
   mini app, run LLM analysis on demand, and apply suggested lessons/patches.
   Uses the shared admin design system (.tbl, .card, .btn, .badge, etc.). */
(function () {
  "use strict";
  window.AdminPages = window.AdminPages || {};

  const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`;

  const esc = (s) => Fmt.escapeHtml(s);

  const STATUS_LABELS = {
    pending:      "Pending",
    learning:     "Learning…",
    result_ready: "Result ready",
    applied:      "Applied",
    skipped:      "Skipped",
  };

  const state = {
    items: [],
    filter: { status: "all", q: "" },
    selectedId: null,
    detail: null,
    pollTimer: null,
  };

  // ──────────────────────────────────────────────────────────────────────
  // Page entry
  // ──────────────────────────────────────────────────────────────────────
  window.AdminPages["agent-feedback"] = {
    title: "Agent Feedback",
    icon: ICON,
    render: async function (host) {
      host.innerHTML = `
        <div class="page-hdr">
          <div>
            <h1>Agent Feedback</h1>
            <div class="sub">User-submitted cashback cases. Run analysis to extract suggested lessons / code patches.</div>
          </div>
          <div class="actions">
            <button class="btn" id="af-refresh">Refresh</button>
          </div>
        </div>

        <div class="af-toolbar">
          <select id="af-filter-status" class="select">
            <option value="all">All statuses</option>
            <option value="pending">Pending</option>
            <option value="learning">Learning</option>
            <option value="result_ready">Result ready</option>
            <option value="applied">Applied</option>
            <option value="skipped">Skipped</option>
          </select>
          <input id="af-filter-q" class="input" placeholder="Search prompt or description…"/>
        </div>

        <div id="af-content"><div class="loading-state"><div class="spinner"></div>Loading…</div></div>

        <div class="side-panel-overlay" id="af-panel-overlay"></div>
        <aside class="side-panel" id="af-panel" aria-hidden="true">
          <header class="side-panel-header">
            <div class="side-panel-title" id="af-panel-title">Case</div>
            <button class="side-panel-close" id="af-panel-close" aria-label="Close">×</button>
          </header>
          <div class="side-panel-body" id="af-panel-body"></div>
        </aside>
      `;

      host.querySelector("#af-refresh").onclick = () => loadList();
      host.querySelector("#af-filter-status").onchange = (e) => {
        state.filter.status = e.target.value;
        renderList();
      };
      host.querySelector("#af-filter-q").oninput = (e) => {
        state.filter.q = e.target.value.trim().toLowerCase();
        renderList();
      };
      host.querySelector("#af-panel-close").onclick = closePanel;
      host.querySelector("#af-panel-overlay").onclick = closePanel;

      await loadList();
    },
    onUnload: function () {
      if (state.pollTimer) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
      }
    },
  };

  // ──────────────────────────────────────────────────────────────────────
  // List
  // ──────────────────────────────────────────────────────────────────────
  async function loadList() {
    try {
      const items = await Api.request("/agent-feedback");
      state.items = Array.isArray(items) ? items : [];
      renderList();
    } catch (err) {
      const c = document.getElementById("af-content");
      if (c) c.innerHTML = `<div class="error-state"><div class="big">!</div>Failed to load: ${esc(err.message)}</div>`;
    }
  }

  function renderList() {
    const container = document.getElementById("af-content");
    if (!container) return;
    let rows = state.items;
    if (state.filter.status !== "all") rows = rows.filter((r) => r.analysisStatus === state.filter.status);
    if (state.filter.q) {
      const q = state.filter.q;
      rows = rows.filter(
        (r) =>
          (r.userPrompt || "").toLowerCase().includes(q) ||
          (r.userDescription || "").toLowerCase().includes(q),
      );
    }

    if (!rows.length) {
      container.innerHTML = `<div class="empty-state">No cases${state.filter.status !== "all" ? " for this filter" : " yet"}.</div>`;
      return;
    }

    const html = `
      <div class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>When</th>
              <th>User</th>
              <th>Project</th>
              <th>Correct?</th>
              <th>Quality</th>
              <th>Speed</th>
              <th>Charged</th>
              <th>Cashback</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(renderRow).join("")}
          </tbody>
        </table>
      </div>
    `;
    container.innerHTML = html;
    container.querySelectorAll("button[data-id]").forEach((btn) => {
      btn.addEventListener("click", () => openDetail(btn.getAttribute("data-id")));
    });
    container.querySelectorAll("tr.clickable[data-id]").forEach((row) => {
      row.addEventListener("click", () => openDetail(row.getAttribute("data-id")));
    });
  }

  function renderRow(r) {
    const userLabel = r.user
      ? `${esc(r.user.firstName || r.user.username || "user")}${r.user.telegramId ? ` <span style="color:var(--admin-muted);font-size:11px">#${esc(String(r.user.telegramId))}</span>` : ""}`
      : `<span style="color:var(--admin-muted)">unknown</span>`;
    const projLabel = r.project
      ? esc(r.project.name || r.project.id)
      : `<span style="color:var(--admin-muted)">deleted</span>`;
    const correct = r.isCorrect
      ? `<span class="af-correct-yes">✓ Yes</span>`
      : `<span class="af-correct-no">✗ No</span>`;
    return `
      <tr class="clickable" data-id="${esc(r.id)}">
        <td style="color:var(--admin-muted);font-size:12px;white-space:nowrap">${esc(formatDate(r.createdAt))}</td>
        <td>${userLabel}</td>
        <td title="${esc(r.projectId)}">${projLabel}</td>
        <td>${correct}</td>
        <td><span class="af-score">${r.qualityScore}<span style="color:var(--admin-muted)">/10</span></span></td>
        <td><span class="af-score">${r.speedScore}<span style="color:var(--admin-muted)">/10</span></span></td>
        <td>${r.creditsCharged}</td>
        <td style="color:${r.cashbackCredits > 0 ? 'var(--success-color)' : 'var(--admin-muted)'}">+${r.cashbackCredits}</td>
        <td>${statusBadge(r.analysisStatus)}</td>
        <td><button class="btn btn-sm" data-id="${esc(r.id)}">Open</button></td>
      </tr>
    `;
  }

  function statusBadge(status) {
    const label = STATUS_LABELS[status] || status;
    return `<span class="badge status-${esc(status)}"><span class="dot"></span>${esc(label)}</span>`;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Detail panel
  // ──────────────────────────────────────────────────────────────────────
  async function openDetail(id) {
    state.selectedId = id;
    const panel = document.getElementById("af-panel");
    const overlay = document.getElementById("af-panel-overlay");
    panel.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => {
      panel.classList.add("open");
      overlay.classList.add("open");
    });
    document.getElementById("af-panel-body").innerHTML = `<div class="loading-state"><div class="spinner"></div>Loading case…</div>`;
    document.getElementById("af-panel-title").textContent = "Case";
    await loadDetail();
  }

  function closePanel() {
    state.selectedId = null;
    state.detail = null;
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    const panel = document.getElementById("af-panel");
    const overlay = document.getElementById("af-panel-overlay");
    panel.classList.remove("open");
    overlay.classList.remove("open");
    panel.setAttribute("aria-hidden", "true");
  }

  async function loadDetail() {
    if (!state.selectedId) return;
    try {
      const detail = await Api.request(`/agent-feedback/${state.selectedId}`);
      state.detail = detail;
      renderDetail();
      if (detail.analysisStatus === "learning") {
        if (!state.pollTimer) {
          state.pollTimer = setInterval(() => {
            loadDetail().catch(() => {});
          }, 3000);
        }
      } else if (state.pollTimer) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
      }
    } catch (err) {
      document.getElementById("af-panel-body").innerHTML = `<div class="error-state"><div class="big">!</div>Failed: ${esc(err.message)}</div>`;
    }
  }

  function renderDetail() {
    const fb = state.detail;
    if (!fb) return;
    const titleEl = document.getElementById("af-panel-title");
    if (titleEl) {
      titleEl.innerHTML = `Case <span class="id">#${esc(fb.id.slice(-6))}</span> ${statusBadge(fb.analysisStatus)}`;
    }

    const body = document.getElementById("af-panel-body");
    if (!body) return;

    body.innerHTML = `
      ${renderMetaSection(fb)}
      ${renderPromptSection(fb)}
      ${renderUserAnswerSection(fb)}
      ${renderAnalysisSection(fb)}
      ${renderLogSection(fb)}
      ${renderDangerSection(fb)}
    `;

    wireDetailButtons(body, fb);
  }

  function wireDetailButtons(body, fb) {
    const analyzeBtn = body.querySelector("#af-analyze-btn");
    if (analyzeBtn) {
      analyzeBtn.onclick = async () => {
        analyzeBtn.disabled = true;
        analyzeBtn.textContent = "Starting…";
        try {
          await Api.request(`/agent-feedback/${fb.id}/analyze`, { method: "POST" });
          Fmt.toast("Analysis started", "ok");
          await loadDetail();
        } catch (err) {
          Fmt.toast("Failed: " + err.message, "err");
          analyzeBtn.disabled = false;
          analyzeBtn.textContent = "Run Analysis";
        }
      };
    }
    const applyBtn = body.querySelector("#af-apply-btn");
    if (applyBtn) {
      applyBtn.onclick = async () => {
        if (!confirm("Apply all suggested lessons and patches? This creates rows in agent_lessons / agent_code_patches.")) return;
        applyBtn.disabled = true;
        applyBtn.textContent = "Applying…";
        try {
          const r = await Api.request(`/agent-feedback/${fb.id}/apply`, { method: "POST", body: {} });
          Fmt.toast(`Created ${r.createdLessons} lesson(s), ${r.createdPatches} patch(es)`, "ok");
          await loadDetail();
          await loadList();
        } catch (err) {
          Fmt.toast("Apply failed: " + err.message, "err");
          applyBtn.disabled = false;
          applyBtn.textContent = "Apply suggestions";
        }
      };
    }
    const skipBtn = body.querySelector("#af-skip-btn");
    if (skipBtn) {
      skipBtn.onclick = async () => {
        if (!confirm("Mark this case as skipped (no-op)?")) return;
        try {
          await Api.request(`/agent-feedback/${fb.id}`, { method: "PATCH", body: { analysisStatus: "skipped" } });
          await loadDetail();
          await loadList();
        } catch (err) {
          Fmt.toast("Failed: " + err.message, "err");
        }
      };
    }
    const reopenBtn = body.querySelector("#af-reopen-btn");
    if (reopenBtn) {
      reopenBtn.onclick = async () => {
        try {
          await Api.request(`/agent-feedback/${fb.id}`, { method: "PATCH", body: { analysisStatus: "pending" } });
          await loadDetail();
          await loadList();
        } catch (err) {
          Fmt.toast("Failed: " + err.message, "err");
        }
      };
    }
    const delBtn = body.querySelector("#af-delete-btn");
    if (delBtn) {
      delBtn.onclick = async () => {
        if (!confirm("Permanently delete this feedback case? This cannot be undone.")) return;
        try {
          await Api.request(`/agent-feedback/${fb.id}`, { method: "DELETE" });
          Fmt.toast("Deleted", "ok");
          closePanel();
          await loadList();
        } catch (err) {
          Fmt.toast("Failed: " + err.message, "err");
        }
      };
    }

    body.querySelectorAll(".af-copy-prompt").forEach((btn) => {
      btn.addEventListener("click", () => {
        const txt = btn.getAttribute("data-prompt") || "";
        try {
          navigator.clipboard.writeText(decodeURIComponent(txt));
          Fmt.toast("Copied to clipboard", "ok");
        } catch {
          Fmt.toast("Copy failed", "err");
        }
      });
    });
  }

  function renderMetaSection(fb) {
    const userStr = fb.user
      ? `${esc(fb.user.firstName || fb.user.username || "user")}${fb.user.telegramId ? ` <span style="color:var(--admin-muted);font-size:11px">#${esc(String(fb.user.telegramId))}</span>` : ""}`
      : "—";
    return `
      <section class="adm-section">
        <div class="adm-section-title">Meta</div>
        <div class="adm-meta-grid">
          <div>
            <div class="label">User</div>
            <div class="value">${userStr}</div>
          </div>
          <div>
            <div class="label">Created</div>
            <div class="value">${esc(formatDate(fb.createdAt))}</div>
          </div>
          <div>
            <div class="label">Project</div>
            <div class="value">${fb.project ? esc(fb.project.name || fb.project.id) : "—"}</div>
          </div>
          <div>
            <div class="label">Project ID</div>
            <div class="value"><code>${esc(fb.projectId)}</code></div>
          </div>
          <div>
            <div class="label">Commit before → after</div>
            <div class="value">${fb.commitNumBefore ?? "—"} → ${fb.commitNumAfter ?? "—"}</div>
          </div>
          <div>
            <div class="label">Credits charged</div>
            <div class="value">${fb.creditsCharged}</div>
          </div>
          <div>
            <div class="label">Performance tier</div>
            <div class="value">${fb.performanceTier
              ? `<code>${esc(fb.performanceTier)}</code>`
              : `<span style="color:var(--admin-muted)">— (older case)</span>`}</div>
          </div>
          <div>
            <div class="label">Cashback paid</div>
            <div class="value">${fb.cashbackCredits > 0 ? `<span style="color:var(--success-color);font-weight:600">+${fb.cashbackCredits}</span>` : "0"}${fb.cashbackPaidAt ? ` <span style="color:var(--admin-muted);font-size:11px">· ${esc(formatDate(fb.cashbackPaidAt))}</span>` : ""}</div>
          </div>
          <div>
            <div class="label">Analysis model</div>
            <div class="value">${fb.analysisModel ? `<code>${esc(fb.analysisModel)}</code>` : `<span style="color:var(--admin-muted)">—</span>`}</div>
          </div>
        </div>
        ${fb.analysisError ? `<div class="af-banner af-banner-error"><b>Analysis error:</b> ${esc(fb.analysisError)}</div>` : ""}
      </section>
    `;
  }

  function renderPromptSection(fb) {
    return `
      <section class="adm-section">
        <div class="adm-section-title">User prompt</div>
        <pre class="adm-prompt-box">${esc(fb.userPrompt || "")}</pre>
      </section>
    `;
  }

  function renderUserAnswerSection(fb) {
    const correct = fb.isCorrect
      ? `<span class="af-correct-yes">✓ Yes</span>`
      : `<span class="af-correct-no">✗ No</span>`;
    return `
      <section class="adm-section">
        <div class="adm-section-title">User judgment</div>
        <div class="adm-pill-row">
          <div><span class="label">Correct?</span> ${correct}</div>
          <div><span class="label">Quality</span> <b>${fb.qualityScore}</b><span style="color:var(--admin-muted)">/10</span></div>
          <div><span class="label">Speed</span> <b>${fb.speedScore}</b><span style="color:var(--admin-muted)">/10</span></div>
        </div>
        ${
          fb.userDescription
            ? `<pre class="adm-prompt-box">${esc(fb.userDescription)}</pre>`
            : `<div style="color:var(--admin-muted);font-size:12px">(no description provided)</div>`
        }
      </section>
    `;
  }

  function renderAnalysisSection(fb) {
    const status = fb.analysisStatus || "pending";
    const result = fb.analysisResult || {};
    const lessons = Array.isArray(result.suggestedLessons) ? result.suggestedLessons : [];
    const patches = Array.isArray(result.suggestedPatches) ? result.suggestedPatches : [];

    let actions = "";
    if (status === "pending") {
      actions = `
        <button class="btn btn-primary" id="af-analyze-btn">Run Analysis</button>
        <button class="btn" id="af-skip-btn">Skip</button>
      `;
    } else if (status === "learning") {
      actions = `<div class="af-learning-row"><span class="af-spinner-inline"></span> Analyzing… (auto-refreshing every 3s)</div>`;
    } else if (status === "result_ready") {
      actions = `
        <button class="btn btn-primary" id="af-apply-btn">Apply suggestions</button>
        <button class="btn" id="af-analyze-btn">Re-run</button>
        <button class="btn" id="af-skip-btn">Skip</button>
      `;
    } else if (status === "applied") {
      actions = `
        <div class="af-status-line applied">✓ Applied${fb.appliedAt ? ` <span style="color:var(--admin-muted);font-weight:400;margin-left:6px;font-size:12px">at ${esc(formatDate(fb.appliedAt))}</span>` : ""}</div>
        <button class="btn" id="af-reopen-btn">Reopen</button>
      `;
    } else if (status === "skipped") {
      actions = `
        <div class="af-status-line skipped">Skipped</div>
        <button class="btn" id="af-reopen-btn">Reopen</button>
      `;
    }

    let resultHtml = "";
    if (status === "result_ready" || status === "applied") {
      const summaryBlock = result.summary
        ? `<div class="af-banner af-banner-info" style="margin-top:12px"><b>Summary:</b> ${esc(result.summary)}</div>`
        : "";
      const rootCauseBlock = result.rootCause
        ? `<div class="af-banner" style="background:var(--admin-card-bg);border-color:var(--admin-card-border);color:var(--admin-text)"><b>Root cause:</b> ${esc(result.rootCause)}</div>`
        : "";

      const lessonsBlock = lessons.length
        ? `
          <div class="af-suggestion-section-label">Suggested lessons (${lessons.length})</div>
          ${lessons.map(renderLessonCard).join("")}
        `
        : "";
      const patchesBlock = patches.length
        ? `
          <div class="af-suggestion-section-label">Suggested code patches (${patches.length})</div>
          ${patches.map(renderPatchCard).join("")}
        `
        : "";
      const emptyBlock = !lessons.length && !patches.length
        ? `<div class="af-suggestion-empty">(no suggestions returned)</div>`
        : "";

      const appliedIdsBlock =
        status === "applied" &&
        ((Array.isArray(fb.appliedLessonIds) ? fb.appliedLessonIds.length : 0) +
          (Array.isArray(fb.appliedPatchIds) ? fb.appliedPatchIds.length : 0) >
          0)
          ? `<div class="af-applied-ids">Applied IDs — Lessons: ${(fb.appliedLessonIds || []).map(esc).join(", ") || "—"} · Patches: ${(fb.appliedPatchIds || []).map(esc).join(", ") || "—"}</div>`
          : "";

      const investigationBlock = renderInvestigationBlock(result);
      const metaBlock = renderAnalysisMetaBlock(fb, result);

      resultHtml = `${summaryBlock}${rootCauseBlock}${lessonsBlock}${patchesBlock}${emptyBlock}${appliedIdsBlock}${investigationBlock}${metaBlock}`;
    }

    return `
      <section class="adm-section">
        <div class="adm-section-title">Analysis</div>
        <div class="af-actions-row">${actions}</div>
        ${resultHtml}
      </section>
    `;
  }

  function renderAnalysisMetaBlock(fb, result) {
    const bits = [];
    if (fb.analysisModel) bits.push(`<b>Model:</b> ${esc(fb.analysisModel)}`);
    if (typeof result.iterations === "number") bits.push(`<b>Iterations:</b> ${result.iterations}`);
    const u = result.usage;
    if (u && (u.input || u.output || u.cacheRead || u.cacheWrite)) {
      const cacheInfo = (u.cacheRead || u.cacheWrite)
        ? ` <span style="color:var(--success-color)">cache: ${u.cacheRead}r / ${u.cacheWrite}w</span>`
        : "";
      bits.push(`<b>Tokens:</b> ${u.input}↑ ${u.output}↓${cacheInfo}`);
    }
    if (result.truncated) bits.push(`<span style="color:var(--admin-warn,#e5a200)">truncated (no submit_analysis)</span>`);
    if (!bits.length) return "";
    return `<div class="af-banner" style="margin-top:10px;background:var(--admin-card-bg);border-color:var(--admin-card-border);color:var(--admin-muted);font-size:12px">${bits.join(" · ")}</div>`;
  }

  function renderInvestigationBlock(result) {
    const log = Array.isArray(result.investigationLog) ? result.investigationLog : [];
    if (!log.length) return "";
    const rows = log.map((step) => {
      const argsStr = (() => {
        try { return JSON.stringify(step.args || {}); } catch { return "{}"; }
      })();
      const okBadge = step.ok
        ? `<span class="badge ok">ok</span>`
        : `<span class="badge err">err</span>`;
      return `
        <details class="af-trace-step">
          <summary>
            <span class="af-trace-iter">#${step.iter}</span>
            <code class="af-trace-tool">${esc(step.tool)}</code>
            ${okBadge}
            <span class="af-trace-args">${esc(argsStr.length > 120 ? argsStr.slice(0, 120) + "…" : argsStr)}</span>
            <span class="af-trace-len">${step.resultLength}c</span>
          </summary>
          <pre class="af-trace-result">${esc(step.resultPreview || "")}${step.resultLength > (step.resultPreview || "").length ? `\n…[${step.resultLength - (step.resultPreview || "").length} more chars not shown]` : ""}</pre>
        </details>
      `;
    }).join("");
    return `
      <details class="adm-section open-details" style="margin-top:14px">
        <summary>Investigation trace <span style="color:var(--admin-muted);font-weight:400;font-size:11px;text-transform:none;letter-spacing:0">(${log.length} tool call${log.length === 1 ? "" : "s"})</span></summary>
        <div class="af-trace-list">${rows}</div>
      </details>
    `;
  }

  function renderLessonCard(l) {
    return `
      <div class="af-suggestion-card">
        <div class="row"><span class="lbl">Rule:</span> ${esc(l.rule || "")}</div>
        ${l.context ? `<div class="row"><span class="lbl">Context:</span> ${esc(l.context)}</div>` : ""}
        ${Array.isArray(l.tags) && l.tags.length ? `<div class="row">${l.tags.map((t) => `<span class="adm-tag-chip">${esc(t)}</span>`).join("")}</div>` : ""}
        ${l.notes ? `<div class="row" style="color:var(--admin-muted);font-size:12px">${esc(l.notes)}</div>` : ""}
      </div>
    `;
  }

  function renderPatchCard(p) {
    const cursorPrompt = p.cursorPrompt || "";
    return `
      <div class="af-suggestion-card">
        <div class="head">
          <div class="title">${esc(p.title || "")}</div>
          <button class="btn btn-sm af-copy-prompt" data-prompt="${encodeURIComponent(cursorPrompt)}">Copy IDE prompt</button>
        </div>
        <div class="row"><span class="lbl">Problem:</span> ${esc(p.problem || "")}</div>
        ${Array.isArray(p.targetFiles) && p.targetFiles.length ? `<div class="row"><span class="lbl">Target files:</span> ${p.targetFiles.map((f) => `<code>${esc(f)}</code>`).join(", ")}</div>` : ""}
        <div class="row"><span class="lbl">Suggestion:</span> ${esc(p.suggestion || "")}</div>
        ${cursorPrompt ? `<details><summary>Show IDE prompt</summary><pre>${esc(cursorPrompt)}</pre></details>` : ""}
        ${Array.isArray(p.tags) && p.tags.length ? `<div class="row">${p.tags.map((t) => `<span class="adm-tag-chip">${esc(t)}</span>`).join("")}</div>` : ""}
      </div>
    `;
  }

  function renderLogSection(fb) {
    const entries = Array.isArray(fb.logEntries) ? fb.logEntries : [];
    if (!entries.length) {
      return `
        <details class="adm-section open-details">
          <summary>Agent log <span style="color:var(--admin-muted);font-weight:400;font-size:11px;text-transform:none;letter-spacing:0">(empty)</span></summary>
          <div style="color:var(--admin-muted);font-size:12px;margin-top:8px">No agent.log file found at commits/${fb.commitNumAfter}/agent.log.</div>
        </details>
      `;
    }
    return `
      <details class="adm-section open-details">
        <summary>Agent log <span style="color:var(--admin-muted);font-weight:400;font-size:11px;text-transform:none;letter-spacing:0">(${entries.length} entries)</span></summary>
        <div class="af-log-viewer">
          ${entries.map(renderLogEntry).join("")}
        </div>
      </details>
    `;
  }

  function renderLogEntry(e) {
    const t = e.type;
    if (t === "text")        return `<div class="log-entry"><span class="log-tag text">[text]</span>${esc(String(e.text || "").slice(0, 1500))}</div>`;
    if (t === "tool_call")   return `<div class="log-entry"><span class="log-tag tool_call">[tool_call]</span>${esc(e.name || "")} <span class="log-extra">${esc(JSON.stringify(e.input || {}).slice(0, 300))}</span></div>`;
    if (t === "tool_result") return `<div class="log-entry"><span class="log-tag tool_result">[tool_result]</span>${esc(e.name || "")} <span class="log-extra">${esc(String(e.result || "").slice(0, 300))}</span></div>`;
    if (t === "thinking")    return `<div class="log-entry"><span class="log-tag thinking">[thinking]</span><span style="opacity:0.75">${esc(String(e.text || "").slice(0, 800))}</span></div>`;
    if (t === "error")       return `<div class="log-entry"><span class="log-tag error">[error]</span>${esc(String(e.error || ""))}</div>`;
    if (t === "done")        return `<div class="log-entry"><span class="log-tag done">[done]</span>iter=${e.iterations || 0} in=${e.totalInput || 0} out=${e.totalOutput || 0}</div>`;
    return `<div class="log-entry"><span class="log-tag" style="color:var(--admin-muted)">[${esc(String(t))}]</span><span class="log-extra">${esc(JSON.stringify(e).slice(0, 300))}</span></div>`;
  }

  function renderDangerSection(fb) {
    return `
      <div class="af-danger-zone">
        <button class="btn btn-danger" id="af-delete-btn">Delete case</button>
        <span class="note">Removing the row does not refund the cashback.</span>
      </div>
    `;
  }

  function formatDate(s) {
    if (!s) return "—";
    try {
      const d = new Date(s);
      if (isNaN(d.getTime())) return String(s);
      return d.toLocaleString();
    } catch {
      return String(s);
    }
  }
})();
