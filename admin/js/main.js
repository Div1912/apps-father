/* ── Bootstrap: decide login vs app shell, wire sidebar/env-switch/logout ── */
(function () {
  "use strict";

  const SIDEBAR = [
    { key: "dashboard", label: "Dashboard",
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>` },
    { key: "sources",   label: "Sources",
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>` },
    { key: "users",     label: "Users",
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>` },
    { key: "apps",      label: "Apps",
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>` },
    { key: "vouchers",  label: "Vouchers",
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12V8a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v4a2 2 0 0 1 0 4v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4a2 2 0 0 1 0-4z"/><line x1="12" y1="6" x2="12" y2="18"/></svg>` },
    { key: "bundles",   label: "Bundles",
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>` },
    { key: "config",    label: "Configuration",
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>` },
    { key: "models",    label: "Models",
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>` },
    { key: "tasks",     label: "Tasks",
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>` },
    { key: "logs",      label: "Logs",
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>` },
  ];

  const SWITCH_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`;

  const ICON_MOON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
  const ICON_SUN  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="6.34" y2="6.34"/><line x1="17.66" y1="17.66" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="6.34" y2="17.66"/><line x1="17.66" y1="6.34" x2="19.07" y2="4.93"/></svg>`;

  // ── Theme handling ────────────────────────────────────────────────────
  const THEME_KEY = "af_admin_theme";
  function getTheme() {
    try { return localStorage.getItem(THEME_KEY) || "dark"; } catch (_) { return "dark"; }
  }
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch (_) {}
    const btn = document.getElementById("theme-toggle-btn");
    if (btn) {
      btn.innerHTML = theme === "light" ? ICON_MOON : ICON_SUN;
      btn.title = theme === "light" ? "Switch to dark theme" : "Switch to light theme";
    }
  }
  // Apply early so login screen also matches the user's saved choice.
  applyTheme(getTheme());

  function envSwitchTarget() {
    const host = window.location.hostname;
    const isDev = /^dev\./i.test(host);
    let target;
    if (isDev) {
      target = host.replace(/^dev\./i, "");
    } else {
      target = "dev." + host;
    }
    return {
      url: window.location.protocol + "//" + target + "/admin/",
      label: isDev ? "Switch to PROD" : "Switch to DEV",
      currentLabel: isDev ? "DEV" : "PROD",
      currentClass: isDev ? "dev" : "",
    };
  }

  function renderShell() {
    const root = document.getElementById("root");
    const sw = envSwitchTarget();
    const theme = getTheme();
    const themeIcon = theme === "light" ? ICON_MOON : ICON_SUN;

    root.innerHTML = `
      <div class="app">
        <div class="app-brand">
          <span class="logo-dot">A</span>
          <span>Apps Father</span>
          <span class="brand-sub">Admin</span>
        </div>

        <div class="app-header">
          <span class="env-pill ${sw.currentClass}"><span class="dot"></span>${sw.currentLabel}</span>
          <a class="env-switch" href="${sw.url}" title="Switch environment">${SWITCH_ICON}<span>${sw.label}</span></a>
          <span class="spacer"></span>
          <button class="icon-btn" id="theme-toggle-btn" title="Toggle theme">${themeIcon}</button>
          <button class="header-btn" id="logout-btn" title="Sign out">Sign out</button>
        </div>

        <div class="app-sidebar">
          <div class="sidebar-section-label">Workspace</div>
          <div class="sidebar-list" id="sidebar-list"></div>
          <div class="sidebar-foot">v1 · Phase 1 shell</div>
        </div>

        <div class="app-main">
          <div class="tab-bar" id="tab-bar"></div>
          <div class="tab-content" id="tab-content"></div>
        </div>
      </div>
    `;

    // Re-apply theme so the toggle button picks up the right title/icon.
    applyTheme(theme);

    const listEl = root.querySelector("#sidebar-list");
    SIDEBAR.forEach(item => {
      const btn = document.createElement("button");
      btn.className = "sidebar-item";
      btn.dataset.key = item.key;
      btn.innerHTML = `<span class="ic">${item.icon}</span><span>${Fmt.escapeHtml(item.label)}</span>`;
      btn.addEventListener("click", e => {
        const openInBackground = e.metaKey || e.ctrlKey;
        // Always spawn a fresh tab per sidebar click (browser-style); no tabs
        // are pinned anymore — every category is closeable just like browser
        // tabs.
        TabBar.openTab({
          pageKey: item.key,
          title: item.label,
          icon: item.icon,
          pinned: false,
          focus: !openInBackground,
          reuseSamePage: false,
        });
      });
      listEl.appendChild(btn);
    });

    root.querySelector("#theme-toggle-btn").addEventListener("click", () => {
      const next = getTheme() === "dark" ? "light" : "dark";
      applyTheme(next);
    });

    root.querySelector("#logout-btn").addEventListener("click", () => {
      Api.logout();
      try { localStorage.removeItem("af_admin_tabs_v1"); } catch (_) {}
      boot();
    });

    // Init the tab manager.
    TabBar.init({
      stripEl: root.querySelector("#tab-bar"),
      panelsEl: root.querySelector("#tab-content"),
    });

    // Try to restore previous session, otherwise open the Dashboard.
    const restored = TabBar.restore();
    if (!restored) {
      TabBar.openTab({
        pageKey: "dashboard",
        title: "Dashboard",
        icon: SIDEBAR[0].icon,
        pinned: false,
        focus: true,
      });
    }
  }

  function syncSidebar(activePageKey) {
    document.querySelectorAll(".sidebar-item").forEach(el => {
      el.classList.toggle("active", el.dataset.key === activePageKey);
    });
  }

  function boot() {
    if (!Api.getToken()) {
      Auth.render(boot);
    } else {
      renderShell();
    }
  }

  window.AdminApp = { boot, syncSidebar };
  document.addEventListener("DOMContentLoaded", boot);
})();
