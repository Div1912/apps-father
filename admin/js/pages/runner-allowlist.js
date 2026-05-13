/* Runner npm Allowlist — admin editor for runner-npm-allowlist.json.
   Two views:
     • Form — table with name / minVersion / description per row, add/remove
     • Raw  — single textarea with the whole JSON file
   Both POST back to /admin/api/runner-allowlist; the runtime allowlist
   service mtime-checks on every read so saves take effect on the very next
   npm_install call without restarting node. */
(function () {
  "use strict";
  window.AdminPages = window.AdminPages || {};

  const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/><path d="M9 11l-1.5 1.5L9 14"/></svg>`;

  function htmlEscape(s) { return Fmt.escapeHtml(String(s == null ? "" : s)); }

  function entriesFromUI(host) {
    const rows = host.querySelectorAll("tr[data-row]");
    const out = {};
    const seen = new Set();
    const errors = [];
    rows.forEach((row, idx) => {
      const name = (row.querySelector('[data-fld="name"]').value || "").trim();
      const minVersion = (row.querySelector('[data-fld="minVersion"]').value || "").trim();
      const description = (row.querySelector('[data-fld="description"]').value || "").trim();
      if (!name && !description && !minVersion) return; // empty row → ignore
      if (!name) { errors.push(`Row ${idx + 1}: package name is required`); return; }
      if (!description) { errors.push(`"${name}": description is required`); return; }
      if (seen.has(name)) { errors.push(`"${name}" is listed twice`); return; }
      seen.add(name);
      const entry = { description };
      if (minVersion) entry.minVersion = minVersion;
      out[name] = entry;
    });
    return { allowedPackages: out, errors };
  }

  function rowHtml(name, entry) {
    return `
      <tr data-row>
        <td>
          <input class="input" data-fld="name" type="text" value="${htmlEscape(name)}"
            placeholder="package-name" autocomplete="off" spellcheck="false"/>
        </td>
        <td>
          <input class="input" data-fld="minVersion" type="text" value="${htmlEscape(entry?.minVersion || "")}"
            placeholder="1.2.3" style="width:8em" autocomplete="off" spellcheck="false"/>
        </td>
        <td>
          <input class="input" data-fld="description" type="text" value="${htmlEscape(entry?.description || "")}"
            placeholder="What it's for and when to use it"/>
        </td>
        <td style="text-align:right;white-space:nowrap;width:1%">
          <button class="btn btn-xs btn-danger" data-del>Remove</button>
        </td>
      </tr>`;
  }

  window.AdminPages["runner-allowlist"] = {
    title: "Allowed npm packages",
    icon: ICON,
    render: async function (host) {
      host.innerHTML = `
        <div class="page-hdr">
          <div>
            <h1>Allowed npm packages</h1>
            <div class="sub">Single source of truth for the agent's <code>npm_install</code> tool and the server-side post-deploy scanner. Edit, save, instant effect — no redeploy.</div>
          </div>
          <div class="actions">
            <button class="btn btn-sm btn-ghost" id="al-fetch" title="Reload from disk">Fetch</button>
            <button class="btn btn-sm btn-primary" id="al-save-top">Save</button>
          </div>
        </div>

        <div class="card" style="margin-bottom:14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <div style="display:flex;gap:6px">
            <button class="btn btn-sm" id="al-mode-form">Form</button>
            <button class="btn btn-sm btn-ghost" id="al-mode-raw">Raw JSON</button>
          </div>
          <span class="sub" style="font-size:0.85rem;opacity:0.75">
            File: <code id="al-path">…</code>
            &middot; <span id="al-count">0</span> package(s)
            &middot; <span id="al-state" style="opacity:0.6">loading…</span>
          </span>
        </div>

        <div id="al-form-view">
          <div class="tbl-wrap">
            <table class="tbl" id="al-tbl">
              <thead>
                <tr>
                  <th style="width:22%">Package</th>
                  <th style="width:10%">Min version</th>
                  <th>Description</th>
                  <th></th>
                </tr>
              </thead>
              <tbody id="al-tbody">
                <tr><td colspan="4"><div class="loading-state"><div class="spinner"></div>Loading…</div></td></tr>
              </tbody>
            </table>
          </div>
          <div style="margin-top:12px;display:flex;gap:8px">
            <button class="btn btn-sm" id="al-add">+ Add package</button>
          </div>
        </div>

        <div id="al-raw-view" style="display:none">
          <p class="sub" style="margin:0 0 8px;font-size:0.85rem;opacity:0.75">
            Edit the whole file as JSON. Must contain an <code>allowedPackages</code> object at the top level.
            <code>$comment</code> and <code>version</code> fields are preserved if present.
          </p>
          <textarea id="al-raw" class="input" spellcheck="false"
            style="width:100%;min-height:60vh;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.85rem;line-height:1.5;tab-size:2"></textarea>
          <div style="margin-top:12px;display:flex;gap:8px">
            <button class="btn btn-sm btn-primary" id="al-save-raw">Save raw JSON</button>
            <button class="btn btn-sm btn-ghost" id="al-validate-raw">Validate JSON only</button>
          </div>
        </div>

        <div class="cfg-footer" style="margin-top:18px">
          <button class="btn btn-primary" id="al-save-bottom">Save</button>
        </div>

        <section class="card" style="margin-top:1.5rem;background:rgba(99,102,241,0.06);border:1px solid rgba(99,102,241,0.25)">
          <div class="dash-recent-title" style="margin-top:0">How this works</div>
          <ul style="font-size:0.88rem;line-height:1.6;margin:0;padding-left:1.25rem;opacity:0.9">
            <li>The agent's <code>npm_install</code> tool refuses any package not on this list.</li>
            <li>Direct <code>shell("npm install …")</code> from agent code is blocked entirely.</li>
            <li>The post-deploy scanner (<code>install-runner-npms.ps1</code>) honours the same list and runs <code>npm install --ignore-scripts</code>.</li>
            <li>Saves are atomic (write-then-rename); a half-saved file can never be observed.</li>
          </ul>
        </section>
      `;

      const $ = sel => host.querySelector(sel);
      const tbody    = $("#al-tbody");
      const formView = $("#al-form-view");
      const rawView  = $("#al-raw-view");
      const rawArea  = $("#al-raw");
      const pathEl   = $("#al-path");
      const countEl  = $("#al-count");
      const stateEl  = $("#al-state");

      let comment = [];
      let version = 1;

      function setState(text, kind) {
        stateEl.textContent = text;
        stateEl.style.color = kind === "ok" ? "#16a34a" : kind === "err" ? "#ef4444" : "";
      }

      function setMode(mode) {
        if (mode === "raw") {
          formView.style.display = "none";
          rawView.style.display = "";
          $("#al-mode-form").classList.add("btn-ghost");
          $("#al-mode-raw").classList.remove("btn-ghost");
        } else {
          formView.style.display = "";
          rawView.style.display = "none";
          $("#al-mode-form").classList.remove("btn-ghost");
          $("#al-mode-raw").classList.add("btn-ghost");
        }
      }

      function renderRows(allowedPackages) {
        const names = Object.keys(allowedPackages || {}).sort((a, b) => a.localeCompare(b));
        if (!names.length) {
          tbody.innerHTML = `<tr><td colspan="4"><div class="empty-state"><div class="big">·</div>No packages allowlisted yet</div></td></tr>`;
        } else {
          tbody.innerHTML = names.map(n => rowHtml(n, allowedPackages[n])).join("");
        }
        countEl.textContent = String(names.length);
        bindRowEvents();
      }

      function bindRowEvents() {
        tbody.querySelectorAll("[data-del]").forEach(btn => {
          btn.addEventListener("click", () => {
            btn.closest("tr").remove();
            countEl.textContent = String(tbody.querySelectorAll("tr[data-row]").length);
          });
        });
      }

      $("#al-add").addEventListener("click", () => {
        // If the empty-state placeholder is present, replace it.
        if (!tbody.querySelector("tr[data-row]")) tbody.innerHTML = "";
        tbody.insertAdjacentHTML("beforeend", rowHtml("", { description: "" }));
        const last = tbody.querySelector("tr[data-row]:last-child");
        last.querySelector('[data-fld="name"]').focus();
        countEl.textContent = String(tbody.querySelectorAll("tr[data-row]").length);
        bindRowEvents();
      });

      $("#al-mode-form").addEventListener("click", () => setMode("form"));
      $("#al-mode-raw").addEventListener("click", () => {
        // Sync raw text from current form before switching, so the user sees
        // pending edits as JSON instead of stale disk contents.
        const { allowedPackages, errors } = entriesFromUI(host);
        if (errors.length) {
          // Switch anyway — let the raw editor show whatever was loaded last;
          // the user might be jumping over to fix a validation error visually.
          Fmt.toast("Note: form has issues — switching to raw view", "info");
        }
        const next = { $comment: comment, version, allowedPackages };
        rawArea.value = JSON.stringify(next, null, 2);
        setMode("raw");
      });

      async function fetchAllowlist() {
        setState("loading…");
        try {
          const data = await Api.request("/runner-allowlist");
          pathEl.textContent = data.path || "runner-npm-allowlist.json";
          comment = Array.isArray(data.comment) ? data.comment : [];
          version = typeof data.version === "number" ? data.version : 1;
          renderRows(data.allowedPackages || {});
          rawArea.value = data.raw || JSON.stringify({
            $comment: comment, version, allowedPackages: data.allowedPackages || {},
          }, null, 2);
          setState(data.exists ? "loaded" : "file missing — will be created on save", "ok");
        } catch (err) {
          setState("load failed: " + (err.message || "error"), "err");
          tbody.innerHTML = `<tr><td colspan="4"><div class="error-state"><div class="big">!</div>${htmlEscape(err.message || "Failed")}</div></td></tr>`;
        }
      }

      async function saveForm() {
        const { allowedPackages, errors } = entriesFromUI(host);
        if (errors.length) {
          Fmt.toast(errors[0], "err");
          return;
        }
        try {
          setState("saving…");
          const data = await Api.request("/runner-allowlist", {
            method: "POST",
            body: { allowedPackages, $comment: comment, version },
          });
          comment = Array.isArray(data.comment) ? data.comment : comment;
          version = typeof data.version === "number" ? data.version : version;
          renderRows(data.allowedPackages || {});
          rawArea.value = data.raw || rawArea.value;
          setState("saved " + new Date().toLocaleTimeString(), "ok");
          Fmt.toast(`Saved · ${data.packageCount || 0} package(s)`, "ok");
        } catch (err) {
          setState("save failed", "err");
          if (err.data && Array.isArray(err.data.issues)) {
            Fmt.toast(err.data.issues[0], "err");
          } else {
            Fmt.toast(err.message || "Save failed", "err");
          }
        }
      }

      async function saveRaw() {
        try {
          // Local parse-check first for a faster error than round-tripping.
          JSON.parse(rawArea.value);
        } catch (err) {
          Fmt.toast("Invalid JSON: " + err.message, "err");
          return;
        }
        try {
          setState("saving…");
          const data = await Api.request("/runner-allowlist", {
            method: "POST",
            body: { raw: rawArea.value },
          });
          comment = Array.isArray(data.comment) ? data.comment : comment;
          version = typeof data.version === "number" ? data.version : version;
          renderRows(data.allowedPackages || {});
          rawArea.value = data.raw || rawArea.value;
          setState("saved " + new Date().toLocaleTimeString(), "ok");
          Fmt.toast(`Saved · ${data.packageCount || 0} package(s)`, "ok");
          setMode("form");
        } catch (err) {
          setState("save failed", "err");
          if (err.data && Array.isArray(err.data.issues)) {
            Fmt.toast(err.data.issues[0], "err");
          } else {
            Fmt.toast(err.message || "Save failed", "err");
          }
        }
      }

      $("#al-fetch").addEventListener("click", fetchAllowlist);
      $("#al-save-top").addEventListener("click", () => {
        if (rawView.style.display !== "none") saveRaw(); else saveForm();
      });
      $("#al-save-bottom").addEventListener("click", () => {
        if (rawView.style.display !== "none") saveRaw(); else saveForm();
      });
      $("#al-save-raw").addEventListener("click", saveRaw);
      $("#al-validate-raw").addEventListener("click", () => {
        try {
          const parsed = JSON.parse(rawArea.value);
          if (!parsed || typeof parsed !== "object" || !parsed.allowedPackages) {
            Fmt.toast("Top-level 'allowedPackages' object is missing", "err");
            return;
          }
          Fmt.toast(`Valid · ${Object.keys(parsed.allowedPackages).length} package(s)`, "ok");
        } catch (err) {
          Fmt.toast("Invalid JSON: " + err.message, "err");
        }
      });

      await fetchAllowlist();
    },
  };
})();
