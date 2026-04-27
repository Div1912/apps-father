/* Tasks / Earn Credits — Admin CRM page.
   Lists all tasks, shows completion stats, provides create/edit/delete via a side-panel form. */
(function () {
  "use strict";
  window.AdminPages = window.AdminPages || {};

  const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;

  const LANGS = ["en", "ru", "uk"];
  const LANG_LABELS = { en: "English", ru: "Русский", uk: "Українська" };

  /** Multipart upload — Api.request always sets JSON; use fetch + bearer token. */
  async function uploadTaskImage(formData) {
    const token = Api.getToken();
    const headers = {};
    if (token) headers["Authorization"] = "Bearer " + token;
    const res = await fetch("/admin/api/tasks/upload-image", {
      method: "POST",
      headers,
      body: formData,
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

  window.AdminPages.tasks = {
    title: "Tasks",
    icon: ICON,
    render: async function (host) {
      host.innerHTML = `
        <div class="page-hdr">
          <div>
            <h1>Tasks</h1>
            <div class="sub">Earn Credits tasks — create, manage, and see completion stats</div>
          </div>
          <button class="btn btn-primary" id="task-create-btn">+ New Task</button>
        </div>

        <div id="tasks-list"><div class="loading-state"><div class="spinner"></div>Loading…</div></div>

        <!-- Side panel -->
        <div id="task-panel" style="display:none;position:fixed;top:0;right:0;width:420px;max-width:100vw;height:100vh;background:var(--panel-bg,#1a1f2e);border-left:1px solid var(--border,#2a3040);z-index:200;overflow-y:auto;padding:24px;box-sizing:border-box">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px">
            <h2 id="task-panel-title" style="margin:0;font-size:18px">New Task</h2>
            <button id="task-panel-close" style="background:none;border:none;color:var(--text,#e0e0e0);cursor:pointer;font-size:22px;line-height:1">×</button>
          </div>
          <form id="task-form" autocomplete="off">
            <div class="input-label">Image</div>
            <div style="display:flex;gap:8px;align-items:center;margin-bottom:12px">
              <img id="task-img-preview" src="" alt="" style="width:64px;height:64px;border-radius:12px;object-fit:cover;background:#2a3040;display:none"/>
              <div style="flex:1">
                <input class="input" type="file" id="task-img-file" accept="image/*" style="margin-bottom:4px"/>
                <input class="input" type="text" id="task-img-url" placeholder="or paste image URL" style="font-size:12px"/>
              </div>
            </div>

            ${LANGS.map(lang => `
            <div class="input-label">${LANG_LABELS[lang]} — Title</div>
            <input class="input" type="text" id="task-title-${lang}" placeholder="Title (${lang})" style="margin-bottom:6px"/>
            <div class="input-label">${LANG_LABELS[lang]} — Description</div>
            <textarea class="input" id="task-desc-${lang}" rows="2" placeholder="Description (${lang})" style="resize:vertical;margin-bottom:12px"></textarea>
            `).join("")}

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
              <div>
                <div class="input-label">Reward (credits)</div>
                <input class="input" type="number" id="task-reward" step="1" value="50" min="0"/>
              </div>
              <div>
                <div class="input-label">Delay (seconds)</div>
                <input class="input" type="number" id="task-delay" step="1" value="5" min="0"/>
              </div>
            </div>

            <div class="input-label" style="margin-top:10px">Link (URL)</div>
            <input class="input" type="text" id="task-link" placeholder="https://t.me/channel or https://example.com"/>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px">
              <div>
                <div class="input-label">Type</div>
                <select class="input" id="task-type">
                  <option value="open_link">Open Link</option>
                  <option value="channel_subscribe">Channel Subscribe</option>
                </select>
              </div>
              <div>
                <div class="input-label">Targeting</div>
                <select class="input" id="task-targeting">
                  <option value="all">All languages</option>
                  <option value="en">English only</option>
                  <option value="ru">Русский only</option>
                  <option value="uk">Українська only</option>
                </select>
              </div>
            </div>

            <div id="task-payload-wrap" style="margin-top:10px;display:none">
              <div class="input-label">Channel ID / Username (for subscribe check)</div>
              <input class="input" type="text" id="task-payload" placeholder="@channel or -100123456789"/>
            </div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px">
              <div>
                <div class="input-label">Sort order</div>
                <input class="input" type="number" id="task-sortorder" step="1" value="0"/>
              </div>
              <div style="display:flex;align-items:flex-end;padding-bottom:2px">
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
                  <input type="checkbox" id="task-active" checked style="width:16px;height:16px"/>
                  <span style="color:var(--text,#e0e0e0)">Active</span>
                </label>
              </div>
            </div>

            <div style="display:flex;gap:10px;margin-top:20px">
              <button type="submit" class="btn btn-primary" id="task-save-btn" style="flex:1">Save</button>
              <button type="button" class="btn btn-danger" id="task-delete-btn" style="display:none">Delete</button>
            </div>
          </form>
        </div>
        <div id="task-panel-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.4);z-index:199"></div>
      `;

      const listEl = host.querySelector("#tasks-list");
      const panel = host.querySelector("#task-panel");
      const overlay = host.querySelector("#task-panel-overlay");
      const typeSelect = host.querySelector("#task-type");
      const payloadWrap = host.querySelector("#task-payload-wrap");
      const imgPreview = host.querySelector("#task-img-preview");
      const imgUrlInput = host.querySelector("#task-img-url");
      const imgFileInput = host.querySelector("#task-img-file");

      let editingId = null;

      function showPayloadField() {
        payloadWrap.style.display = typeSelect.value === "channel_subscribe" ? "" : "none";
      }
      typeSelect.addEventListener("change", showPayloadField);

      function updateImgPreview(url) {
        if (url) {
          imgPreview.src = url;
          imgPreview.style.display = "";
        } else {
          imgPreview.style.display = "none";
        }
      }

      imgUrlInput.addEventListener("input", () => updateImgPreview(imgUrlInput.value.trim()));

      imgFileInput.addEventListener("change", async () => {
        const file = imgFileInput.files[0];
        if (!file) return;
        const form = new FormData();
        form.append("image", file);
        try {
          const res = await uploadTaskImage(form);
          imgUrlInput.value = res.url;
          updateImgPreview(res.url);
        } catch (e) {
          alert("Image upload failed: " + e.message);
        }
      });

      function openPanel(task) {
        editingId = task ? task.id : null;
        host.querySelector("#task-panel-title").textContent = task ? "Edit Task" : "New Task";
        host.querySelector("#task-delete-btn").style.display = task ? "" : "none";

        LANGS.forEach(lang => {
          host.querySelector(`#task-title-${lang}`).value = task ? (task.title[lang] || "") : "";
          host.querySelector(`#task-desc-${lang}`).value = task ? (task.description[lang] || "") : "";
        });

        const imgUrl = task ? (task.imageUrl || "") : "";
        imgUrlInput.value = imgUrl;
        updateImgPreview(imgUrl);
        imgFileInput.value = "";

        host.querySelector("#task-reward").value = task ? task.reward : 50;
        host.querySelector("#task-delay").value = task ? task.delaySeconds : 5;
        host.querySelector("#task-link").value = task ? (task.link || "") : "";
        typeSelect.value = task ? (task.type || "open_link") : "open_link";
        host.querySelector("#task-targeting").value = task ? (task.targeting || "all") : "all";
        host.querySelector("#task-payload").value = task ? (task.payload || "") : "";
        host.querySelector("#task-sortorder").value = task ? task.sortOrder : 0;
        host.querySelector("#task-active").checked = task ? task.isActive : true;

        showPayloadField();
        panel.style.display = "";
        overlay.style.display = "";
      }

      function closePanel() {
        panel.style.display = "none";
        overlay.style.display = "none";
        editingId = null;
      }

      host.querySelector("#task-create-btn").addEventListener("click", () => openPanel(null));
      host.querySelector("#task-panel-close").addEventListener("click", closePanel);
      overlay.addEventListener("click", closePanel);

      host.querySelector("#task-delete-btn").addEventListener("click", async () => {
        if (!editingId) return;
        if (!confirm("Delete this task? All completion records will also be deleted.")) return;
        try {
          await Api.request("/tasks/" + editingId, { method: "DELETE" });
          Fmt.toast("Task deleted", "ok");
          closePanel();
          refresh();
        } catch (err) {
          Fmt.toast(err.message || "Delete failed", "err");
        }
      });

      host.querySelector("#task-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const title = {}, description = {};
        LANGS.forEach(lang => {
          title[lang] = host.querySelector(`#task-title-${lang}`).value.trim();
          description[lang] = host.querySelector(`#task-desc-${lang}`).value.trim();
        });
        const payload = {
          title,
          description,
          imageUrl: imgUrlInput.value.trim() || null,
          reward: parseInt(host.querySelector("#task-reward").value, 10) || 0,
          delaySeconds: parseInt(host.querySelector("#task-delay").value, 10) || 5,
          link: host.querySelector("#task-link").value.trim(),
          type: typeSelect.value,
          payload: host.querySelector("#task-payload").value.trim() || null,
          targeting: host.querySelector("#task-targeting").value,
          sortOrder: parseInt(host.querySelector("#task-sortorder").value, 10) || 0,
          isActive: host.querySelector("#task-active").checked,
        };

        const saveBtn = host.querySelector("#task-save-btn");
        saveBtn.disabled = true;
        saveBtn.textContent = "Saving…";
        try {
          if (editingId) {
            await Api.request("/tasks/" + editingId, { method: "PUT", body: payload });
          } else {
            await Api.request("/tasks", { method: "POST", body: payload });
          }
          Fmt.toast("Task saved", "ok");
          closePanel();
          refresh();
        } catch (err) {
          alert("Save failed: " + err.message);
        } finally {
          saveBtn.disabled = false;
          saveBtn.textContent = "Save";
        }
      });

      async function refresh() {
        listEl.innerHTML = `<div class="loading-state"><div class="spinner"></div>Loading…</div>`;
        try {
          const tasks = await Api.request("/tasks");

          if (!tasks.length) {
            listEl.innerHTML = `<div class="empty-state">No tasks yet. Click <b>+ New Task</b> to create one.</div>`;
            return;
          }

          listEl.innerHTML = `
            <table class="data-table" style="width:100%">
              <thead>
                <tr>
                  <th style="width:56px">Image</th>
                  <th>Title (EN)</th>
                  <th>Type</th>
                  <th>Reward</th>
                  <th>Targeting</th>
                  <th>Completions</th>
                  <th>Active</th>
                  <th></th>
                </tr>
              </thead>
              <tbody id="tasks-tbody"></tbody>
            </table>
          `;

          const tbody = listEl.querySelector("#tasks-tbody");
          tasks.forEach(task => {
            const tr = document.createElement("tr");
            const imgSrc = task.imageUrl || "";
            const titleEn = (task.title && task.title.en) || "(no title)";
            const typeBadge = task.type === "channel_subscribe"
              ? `<span class="badge badge-blue">Channel</span>`
              : `<span class="badge badge-gray">Link</span>`;
            const activeBadge = task.isActive
              ? `<span class="badge badge-green">Yes</span>`
              : `<span class="badge badge-red">No</span>`;
            const targetLabel = { all: "All", en: "EN", ru: "RU", uk: "UK" }[task.targeting] || task.targeting;

            tr.innerHTML = `
              <td>
                ${imgSrc
                  ? `<img src="${imgSrc}" style="width:40px;height:40px;border-radius:8px;object-fit:cover"/>`
                  : `<div style="width:40px;height:40px;border-radius:8px;background:#2a3040;display:flex;align-items:center;justify-content:center;font-size:18px">⭐</div>`
                }
              </td>
              <td><b>${titleEn}</b><div style="font-size:11px;color:#8a9bb0;margin-top:2px">#${task.id} · order ${task.sortOrder}</div></td>
              <td>${typeBadge}</td>
              <td><b>+${task.reward}</b> cr</td>
              <td>${targetLabel}</td>
              <td><b>${task._completionCount}</b> users</td>
              <td>${activeBadge}</td>
              <td><button class="btn btn-sm" data-id="${task.id}">Edit</button></td>
            `;
            tr.querySelector("[data-id]").addEventListener("click", () => openPanel(task));
            tbody.appendChild(tr);
          });
        } catch (err) {
          listEl.innerHTML = `<div class="error-state">Failed to load tasks: ${err.message}</div>`;
        }
      }

      refresh();
    },
  };
})();
