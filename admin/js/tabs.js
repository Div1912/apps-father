/* ── TabManager: open/close/focus/persist ──
   Each tab owns a panel <div> + a Router. The sidebar always opens a *new*
   tab per category (reuseSamePage: false); in-tab navigation still uses the
   Router stack (back/forward).

   Persistence: tabs + active id are stored in localStorage under
   af_admin_tabs_v1. Restored on boot. */
(function () {
  "use strict";

  const STORAGE_KEY = "af_admin_tabs_v1";

  let nextId = 1;
  /** @type {Array<Tab>} */
  const tabs = [];
  /** @type {string|null} */
  let activeId = null;

  let strip, panels, brandIcons;

  function makeId() { return "t" + (Date.now().toString(36)) + "_" + (nextId++); }

  function persist() {
    const minimal = tabs.map(t => ({
      id: t.id,
      pinned: !!t.pinned,
      stack: t.router.stack.map(e => ({
        pageKey: e.pageKey,
        params: e.params || null,
        title: e.title || null,
        icon: e.icon || null,
      })),
    }));
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ tabs: minimal, activeId }));
    } catch (_) {}
  }

  function restore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.tabs) || !parsed.tabs.length) return false;
      for (const t of parsed.tabs) {
        const stack = (t.stack || []).filter(e => e && e.pageKey && window.AdminPages && window.AdminPages[e.pageKey]);
        if (!stack.length) continue;
        openTab({
          pinned: !!t.pinned,
          initialStack: stack,
          focus: false,
        });
      }
      const wantActive = tabs.find(x => x.id === parsed.activeId);
      activate((wantActive || tabs[0]).id);
      return true;
    } catch (_) {
      return false;
    }
  }

  function init({ stripEl, panelsEl }) {
    strip = stripEl;
    panels = panelsEl;
  }

  function findByPageKey(pageKey) {
    // For "primary" pages (no params), reuse the existing tab.
    return tabs.find(t => {
      const root = t.router.stack[0];
      return root && root.pageKey === pageKey && !root.params;
    });
  }

  /**
   * Open or focus a tab.
   * @param {Object} opts
   * @param {string} [opts.pageKey]    — page registered on AdminPages.
   * @param {Object} [opts.params]     — page params.
   * @param {string} [opts.title]      — explicit tab title (overrides page default).
   * @param {string} [opts.icon]       — explicit tab icon (svg string).
   * @param {boolean} [opts.pinned]    — non-closeable tab (e.g. Dashboard).
   * @param {boolean} [opts.focus=true]
   * @param {boolean} [opts.reuseSamePage=true] — focus existing tab instead of duplicating.
   * @param {Array}   [opts.initialStack] — pre-built history (used by restore()).
   */
  function openTab(opts) {
    opts = opts || {};
    const focus = opts.focus !== false;
    const reuse = opts.reuseSamePage !== false && opts.pageKey && !opts.params;

    if (reuse) {
      const existing = findByPageKey(opts.pageKey);
      if (existing) {
        if (focus) activate(existing.id);
        return existing;
      }
    }

    const id = makeId();
    const panel = document.createElement("div");
    panel.className = "tab-panel";
    panel.dataset.tid = id;
    panels.appendChild(panel);

    const tab = {
      id,
      pinned: !!opts.pinned,
      title: opts.title || (opts.pageKey || "Tab"),
      icon: opts.icon || "",
      panel,
      router: null,
    };
    tab.router = window.Router.create(tab, panel);
    tabs.push(tab);

    if (Array.isArray(opts.initialStack) && opts.initialStack.length) {
      // Reset and replay history (without re-rendering each step needlessly).
      for (let i = 0; i < opts.initialStack.length; i++) {
        const e = opts.initialStack[i];
        if (i === 0) tab.router.reset(e);
        else         tab.router.push(e);
      }
    } else if (opts.pageKey) {
      tab.router.push({ pageKey: opts.pageKey, params: opts.params, title: opts.title, icon: opts.icon });
    }

    refresh();
    if (focus) activate(id);
    persist();
    return tab;
  }

  function closeTab(id) {
    const idx = tabs.findIndex(t => t.id === id);
    if (idx === -1) return;
    const t = tabs[idx];
    if (t.pinned) return;
    t.panel.remove();
    tabs.splice(idx, 1);
    if (activeId === id) {
      const next = tabs[idx] || tabs[idx - 1] || tabs[0];
      activate(next ? next.id : null);
    } else {
      refresh();
    }
    persist();
  }

  function closeOthers(id) {
    for (const t of tabs.slice()) {
      if (t.id !== id && !t.pinned) closeTab(t.id);
    }
  }

  function closeToRight(id) {
    const idx = tabs.findIndex(t => t.id === id);
    if (idx === -1) return;
    for (const t of tabs.slice(idx + 1).reverse()) {
      if (!t.pinned) closeTab(t.id);
    }
  }

  function activate(id) {
    activeId = id;
    for (const t of tabs) {
      t.panel.classList.toggle("active", t.id === id);
    }
    refresh();
    persist();
    // Update sidebar highlight.
    if (window.AdminApp && typeof window.AdminApp.syncSidebar === "function") {
      const t = tabs.find(x => x.id === id);
      const root = t && t.router.stack[0];
      window.AdminApp.syncSidebar(root ? root.pageKey : null);
    }
  }

  function refresh() {
    if (!strip) return;
    strip.innerHTML = "";
    for (const t of tabs) {
      const el = document.createElement("div");
      el.className = "tab" + (t.id === activeId ? " active" : "") + (t.pinned ? " pinned" : "");
      el.dataset.tid = t.id;
      el.innerHTML = `
        ${t.icon ? `<span class="tab-icon">${t.icon}</span>` : ""}
        <span class="tab-title">${Fmt.escapeHtml(t.title || "Tab")}</span>
        <button class="tab-close" title="Close tab">×</button>
      `;
      el.addEventListener("click", e => {
        if (e.target.closest(".tab-close")) {
          e.stopPropagation();
          closeTab(t.id);
          return;
        }
        // Middle-click closes (browser convention)
        if (e.button === 1) {
          e.stopPropagation();
          closeTab(t.id);
          return;
        }
        activate(t.id);
      });
      el.addEventListener("auxclick", e => {
        if (e.button === 1 && !t.pinned) {
          e.preventDefault();
          closeTab(t.id);
        }
      });
      el.addEventListener("contextmenu", e => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, t.id);
      });
      strip.appendChild(el);
    }
  }

  let openMenuEl = null;
  function showContextMenu(x, y, tid) {
    if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; }
    const t = tabs.find(x => x.id === tid);
    if (!t) return;
    const menu = document.createElement("div");
    menu.className = "ctx-menu";
    menu.style.left = x + "px";
    menu.style.top = y + "px";
    menu.innerHTML = `
      <button class="item" data-act="close" ${t.pinned ? "disabled style='opacity:.4;cursor:not-allowed'" : ""}>Close tab</button>
      <button class="item" data-act="closeOthers">Close other tabs</button>
      <button class="item" data-act="closeRight">Close tabs to the right</button>
    `;
    document.body.appendChild(menu);
    openMenuEl = menu;

    menu.querySelectorAll("[data-act]").forEach(b => {
      b.addEventListener("click", () => {
        const act = b.dataset.act;
        if (act === "close")        closeTab(tid);
        if (act === "closeOthers")  closeOthers(tid);
        if (act === "closeRight")   closeToRight(tid);
        menu.remove();
        openMenuEl = null;
      });
    });
    setTimeout(() => {
      const close = (e) => {
        if (!menu.contains(e.target)) {
          menu.remove();
          openMenuEl = null;
          document.removeEventListener("mousedown", close);
        }
      };
      document.addEventListener("mousedown", close);
    }, 0);
  }

  function getTabs()    { return tabs.slice(); }
  function getActive()  { return tabs.find(t => t.id === activeId) || null; }
  function setActiveByPageKey(pageKey) {
    const t = findByPageKey(pageKey);
    if (t) activate(t.id);
  }

  window.TabBar = {
    init, openTab, closeTab, activate, refresh, restore, persist,
    getTabs, getActive, setActiveByPageKey,
  };
})();
