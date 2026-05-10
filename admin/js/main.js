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
    { key: "listings",  label: "App Store",
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l1-6h16l1 6"/><path d="M5 9v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9"/><path d="M9 13h6"/></svg>` },
    { key: "vouchers",  label: "Vouchers",
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12V8a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v4a2 2 0 0 1 0 4v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4a2 2 0 0 1 0-4z"/><line x1="12" y1="6" x2="12" y2="18"/></svg>` },
    { key: "bundles",   label: "Bundles",
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>` },
    { key: "config",    label: "Configuration",
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>` },
    { key: "models",    label: "Agent",
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>` },
    { key: "tasks",     label: "Tasks",
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>` },
    { key: "agent-lessons", label: "Agent Lessons",
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 0 7 4.5v15A2.5 2.5 0 0 0 9.5 22h11"/><path d="M14 2v20"/><path d="M2 9.5h5"/><path d="M2 14.5h5"/></svg>` },
    { key: "agent-feedback", label: "Agent Feedback",
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>` },
    { key: "sessions",  label: "Sessions",
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>` },
    { key: "logs",      label: "Logs",
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>` },
    { key: "ledger",    label: "Ledger",
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>` },
    { key: "withdrawals", label: "Withdrawals",
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.4 19.4q-.5.2-.95-.09T3 18.5V14l8-2-8-2V5.5q0-.55.45-.84t.95-.09l15.4 6.5q.625.275.625.925t-.625.925z"/></svg>` },
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
          <span class="uptime-badge" id="uptime-badge" title="Server uptime since last restart">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;flex-shrink:0"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            <span id="uptime-value">—</span>
          </span>
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
        // Behaviour:
        //   plain click       → focus existing tab of this category, or open one
        //   middle / ctrl/cmd → force a brand-new tab (browser-style)
        // Reusing avoids duplicate tabs whose data only refreshes in the older
        // copy (websocket/poll handlers are bound to that DOM).
        const forceNew = e.metaKey || e.ctrlKey || e.button === 1;
        TabBar.openTab({
          pageKey: item.key,
          title: item.label,
          icon: item.icon,
          pinned: false,
          focus: true,
          reuseSamePage: !forceNew,
        });
      });
      // Middle-click also opens (in background = stays on current tab).
      btn.addEventListener("auxclick", e => {
        if (e.button !== 1) return;
        e.preventDefault();
        TabBar.openTab({
          pageKey: item.key,
          title: item.label,
          icon: item.icon,
          pinned: false,
          focus: false,
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

    // ── Uptime timer ─────────────────────────────────────────────────────
    (function startUptimeTimer() {
      let serverUptime = 0; // seconds, from API
      let localTick = 0;    // increments every second client-side between fetches

      function fmt(secs) {
        const d = Math.floor(secs / 86400);
        const h = Math.floor((secs % 86400) / 3600);
        const m = Math.floor((secs % 3600) / 60);
        const s = secs % 60;
        if (d > 0) return d + 'd ' + String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
        return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
      }

      function tick() {
        localTick++;
        const el = document.getElementById('uptime-value');
        if (el) el.textContent = fmt(serverUptime + localTick);
      }

      async function fetchUptime() {
        try {
          const data = await Api.request('/uptime');
          serverUptime = data.uptimeSeconds || 0;
          localTick = 0;
          const el = document.getElementById('uptime-value');
          if (el) el.textContent = fmt(serverUptime);
        } catch (_) {}
      }

      fetchUptime();
      setInterval(tick, 1000);
      setInterval(fetchUptime, 30000); // resync every 30 s
    })();

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
