/*!
 * Apps Father UI SDK
 * Modern vanilla JS runtime for generated Telegram Mini Apps.
 * Inspired by iOS 17 / Material You — glassmorphism, smooth springs, vibrant gradients.
 *
 * No build step. Drop into any HTML page:
 *   <script src="./app-ui.js"></script>
 *
 * Quick start:
 *   const app = AFApp.create({ root: "#app", initialPage: "home" });
 *   app.page("home", () => `<section class="af-card"><h1>Hello</h1></section>`);
 *   app.action("start", () => app.navigate("profile"));
 *   app.start();
 */
(function () {
  "use strict";

  const DEFAULTS = {
    root: "#app",
    initialPage: "home",
    transition: "slide",     // "slide" | "fade" | "scale"
    apiBase: null,
    telegram: true,
    theme: "telegram",
    accent: null,            // override accent color, e.g. "#7c3aed"
    persistStateKey: null,
  };

  const ACTION_ATTR = "data-action";
  const PAGE_CLASS = "af-page";
  const ACTIVE_CLASS = "af-page-active";

  function qs(sel, root) { return (root || document).querySelector(sel); }
  function isObject(v) { return v && typeof v === "object" && !Array.isArray(v); }

  function merge(target, patch) {
    const out = Object.assign({}, target || {});
    for (const key of Object.keys(patch || {})) {
      if (isObject(out[key]) && isObject(patch[key])) out[key] = merge(out[key], patch[key]);
      else out[key] = patch[key];
    }
    return out;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function attrs(obj) {
    return Object.entries(obj || {})
      .filter(([, v]) => v !== false && v != null)
      .map(([k, v]) => v === true ? escapeHtml(k) : `${escapeHtml(k)}="${escapeHtml(v)}"`)
      .join(" ");
  }

  function toNode(rendered) {
    if (rendered instanceof Node) return rendered;
    const tpl = document.createElement("template");
    tpl.innerHTML = String(rendered == null ? "" : rendered).trim();
    if (tpl.content.childElementCount === 1) return tpl.content.firstElementChild;
    const wrap = document.createElement("div");
    wrap.appendChild(tpl.content.cloneNode(true));
    return wrap;
  }

  function ensureRoot(selector) {
    let root = typeof selector === "string" ? qs(selector) : selector;
    if (!root) {
      root = document.createElement("main");
      root.id = String(selector || "#app").replace(/^#/, "") || "app";
      document.body.appendChild(root);
    }
    root.classList.add("af-root");
    return root;
  }

  function inferProjectId() {
    const m = location.pathname.match(/\/(?:app|dev)\/([^/]+)/);
    if (m) return decodeURIComponent(m[1]);
    return window.AF_PROJECT_ID || window.projectId || "";
  }

  function inferApiBase(custom) {
    if (custom) return String(custom).replace(/\/?$/, "/");
    const projectId = inferProjectId();
    if (!projectId) return "/api/";
    return `/api/${projectId}/`;
  }

  function endpointUrl(apiBase, endpoint) {
    const ep = String(endpoint || "").replace(/^\/+/, "");
    return apiBase + ep;
  }

  function telegram() {
    return window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  }

  function setupTelegram() {
    const tg = telegram();
    if (!tg) return null;
    try { tg.ready(); } catch {}
    try { tg.expand(); } catch {}
    try { tg.disableVerticalSwipes && tg.disableVerticalSwipes(); } catch {}
    try {
      if (["android", "ios"].includes(tg.platform)) tg.requestFullscreen && tg.requestFullscreen();
    } catch {}
    return tg;
  }

  function haptic(type) {
    const tg = telegram();
    try {
      if (!tg || !tg.HapticFeedback) return;
      if (type === "success" || type === "error" || type === "warning") {
        tg.HapticFeedback.notificationOccurred(type);
      } else if (type === "selection") {
        tg.HapticFeedback.selectionChanged();
      } else {
        tg.HapticFeedback.impactOccurred(type || "light");
      }
    } catch {}
  }

  function injectStyles(opts) {
    if (document.getElementById("af-app-ui-styles")) return;
    const accent = opts.accent || null;
    const style = document.createElement("style");
    style.id = "af-app-ui-styles";
    style.textContent = `
      :root {
        --af-bg-1: var(--tg-theme-bg-color, #0a0e1a);
        --af-bg-2: var(--tg-theme-secondary-bg-color, #131826);
        --af-text: var(--tg-theme-text-color, #f5f7fb);
        --af-text-2: var(--tg-theme-hint-color, #94a3b8);
        --af-card-bg: rgba(255,255,255,0.04);
        --af-card-border: rgba(255,255,255,0.08);
        --af-card-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 12px 32px rgba(0,0,0,0.32);
        --af-accent: ${accent || 'var(--tg-theme-button-color, #6366f1)'};
        --af-accent-2: #8b5cf6;
        --af-accent-text: var(--tg-theme-button-text-color, #ffffff);
        --af-success: #10b981;
        --af-error: #ef4444;
        --af-warning: #f59e0b;
        --af-radius-sm: 14px;
        --af-radius: 20px;
        --af-radius-lg: 28px;
        --af-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
        --af-ease: cubic-bezier(0.4, 0, 0.2, 1);
        --af-tap-scale: 0.97;
      }

      @media (prefers-color-scheme: light) {
        :root {
          --af-bg-1: var(--tg-theme-bg-color, #f8fafc);
          --af-bg-2: var(--tg-theme-secondary-bg-color, #ffffff);
          --af-text: var(--tg-theme-text-color, #0f172a);
          --af-text-2: var(--tg-theme-hint-color, #64748b);
          --af-card-bg: rgba(255,255,255,0.7);
          --af-card-border: rgba(15,23,42,0.06);
          --af-card-shadow: 0 1px 0 rgba(255,255,255,0.6) inset, 0 8px 24px rgba(15,23,42,0.06);
        }
      }

      * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
      html, body {
        margin: 0;
        background: var(--af-bg-1);
        color: var(--af-text);
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", system-ui, sans-serif;
        font-feature-settings: "ss01", "cv11";
        -webkit-font-smoothing: antialiased;
      }
      body {
        background:
          radial-gradient(1200px 600px at 100% -10%, color-mix(in srgb, var(--af-accent) 22%, transparent) 0%, transparent 60%),
          radial-gradient(900px 500px at -10% 100%, color-mix(in srgb, var(--af-accent-2) 18%, transparent) 0%, transparent 55%),
          var(--af-bg-1);
        background-attachment: fixed;
        min-height: 100vh;
        min-height: 100dvh;
      }

      .af-root {
        min-height: 100vh;
        min-height: 100dvh;
        overflow-x: hidden;
        position: relative;
      }

      .af-page-stack {
        position: relative;
        min-height: 100vh;
        min-height: 100dvh;
      }

      .af-page {
        position: absolute;
        top: 0; left: 0; right: 0;
        min-height: 100%;
        opacity: 0;
        pointer-events: none;
        will-change: opacity, transform, filter;
        transition:
          opacity .28s var(--af-ease),
          transform .55s var(--af-spring),
          filter .28s var(--af-ease);
      }

      .af-transition-slide .af-page {
        transform: translate3d(48px, 0, 0) scale(0.94);
        filter: blur(6px);
      }
      .af-transition-fade .af-page {
        transform: scale(1.02);
      }
      .af-transition-scale .af-page {
        transform: scale(1.08);
      }

      .af-page.af-page-active {
        opacity: 1;
        transform: translate3d(0, 0, 0) scale(1);
        filter: blur(0);
        pointer-events: auto;
        position: relative;
      }

      .af-page.af-page-leaving {
        opacity: 0;
        transition-duration: .22s, .35s, .22s;
      }
      .af-transition-slide .af-page.af-page-leaving {
        transform: translate3d(-48px, 0, 0) scale(0.94);
        filter: blur(6px);
      }
      .af-transition-fade .af-page.af-page-leaving {
        transform: scale(0.97);
      }
      .af-transition-scale .af-page.af-page-leaving {
        transform: scale(0.92);
      }

      /* ── Cards ── */
      .af-card {
        position: relative;
        border-radius: var(--af-radius);
        background: var(--af-card-bg);
        border: 1px solid var(--af-card-border);
        box-shadow: var(--af-card-shadow);
        backdrop-filter: blur(20px) saturate(180%);
        -webkit-backdrop-filter: blur(20px) saturate(180%);
        padding: 18px;
        overflow: hidden;
      }
      .af-card-header {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--af-text-2);
        margin: 0 4px 10px;
      }
      .af-card-title {
        font-size: 17px;
        font-weight: 700;
        margin: 0 0 4px;
        letter-spacing: -0.01em;
      }
      .af-card-subtitle {
        font-size: 14px;
        color: var(--af-text-2);
        margin: 0;
      }

      /* ── Buttons ── */
      .af-btn {
        appearance: none;
        border: 0;
        border-radius: 16px;
        padding: 14px 20px;
        background: linear-gradient(135deg, var(--af-accent) 0%, var(--af-accent-2) 100%);
        color: var(--af-accent-text);
        font: inherit;
        font-weight: 600;
        font-size: 15px;
        cursor: pointer;
        transition: transform .15s var(--af-ease), box-shadow .25s var(--af-ease), opacity .15s;
        box-shadow: 0 4px 14px color-mix(in srgb, var(--af-accent) 35%, transparent),
                    0 1px 0 rgba(255,255,255,0.15) inset;
        letter-spacing: -0.01em;
        position: relative;
        overflow: hidden;
        width: 100%;
      }
      .af-btn:hover { box-shadow: 0 6px 20px color-mix(in srgb, var(--af-accent) 50%, transparent),
                                  0 1px 0 rgba(255,255,255,0.2) inset; }
      .af-btn:active { transform: scale(var(--af-tap-scale)); }
      .af-btn[disabled] { opacity: 0.5; cursor: not-allowed; transform: none; }

      .af-btn.secondary {
        background: var(--af-card-bg);
        color: var(--af-text);
        border: 1px solid var(--af-card-border);
        box-shadow: none;
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
      }
      .af-btn.secondary:hover { background: color-mix(in srgb, var(--af-card-bg) 100%, var(--af-text) 6%); }

      .af-btn.ghost {
        background: transparent;
        color: var(--af-accent);
        box-shadow: none;
      }
      .af-btn.danger {
        background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
        box-shadow: 0 4px 14px rgba(239,68,68,0.35), 0 1px 0 rgba(255,255,255,0.15) inset;
      }
      .af-btn.icon-btn {
        width: 44px; height: 44px;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
      }

      /* ── List ── */
      .af-list {
        display: flex;
        flex-direction: column;
        gap: 1px;
        background: var(--af-card-bg);
        border: 1px solid var(--af-card-border);
        border-radius: var(--af-radius);
        overflow: hidden;
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
      }
      .af-list-item {
        padding: 14px 16px;
        display: flex;
        align-items: center;
        gap: 12px;
        cursor: pointer;
        transition: background .15s;
        background: transparent;
        border: 0;
        font: inherit;
        color: var(--af-text);
        text-align: left;
        width: 100%;
      }
      .af-list-item:not(:last-child) {
        border-bottom: 1px solid var(--af-card-border);
      }
      .af-list-item:active {
        background: color-mix(in srgb, var(--af-accent) 12%, transparent);
      }
      .af-list-item-icon {
        width: 32px; height: 32px;
        border-radius: 10px;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        font-size: 16px;
        background: color-mix(in srgb, var(--af-accent) 18%, transparent);
        color: var(--af-accent);
      }
      .af-list-item-content { flex: 1; min-width: 0; }
      .af-list-item-title {
        font-size: 15px;
        font-weight: 500;
        line-height: 1.3;
      }
      .af-list-item-subtitle {
        font-size: 13px;
        color: var(--af-text-2);
        margin-top: 2px;
        line-height: 1.3;
      }
      .af-list-item-trail {
        color: var(--af-text-2);
        font-size: 14px;
        flex-shrink: 0;
      }
      .af-list-item-chevron::after {
        content: "›";
        color: var(--af-text-2);
        font-size: 22px;
        line-height: 1;
        margin-left: 6px;
      }

      /* ── Switch ── */
      .af-switch {
        position: relative;
        width: 50px;
        height: 30px;
        background: rgba(120,120,128,0.32);
        border-radius: 16px;
        flex-shrink: 0;
        transition: background .3s var(--af-ease);
      }
      .af-switch::after {
        content: "";
        position: absolute;
        top: 2px;
        left: 2px;
        width: 26px;
        height: 26px;
        background: #fff;
        border-radius: 50%;
        transition: transform .3s var(--af-spring);
        box-shadow: 0 2px 4px rgba(0,0,0,0.2);
      }
      .af-switch.on {
        background: var(--af-accent);
      }
      .af-switch.on::after {
        transform: translateX(20px);
      }

      /* ── Pills / Tags ── */
      .af-pill {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 4px 10px;
        background: color-mix(in srgb, var(--af-accent) 14%, transparent);
        color: var(--af-accent);
        border-radius: 999px;
        font-size: 12px;
        font-weight: 600;
      }
      .af-pill.success { background: color-mix(in srgb, var(--af-success) 14%, transparent); color: var(--af-success); }
      .af-pill.error   { background: color-mix(in srgb, var(--af-error)   14%, transparent); color: var(--af-error); }
      .af-pill.warning { background: color-mix(in srgb, var(--af-warning) 14%, transparent); color: var(--af-warning); }
      .af-pill.muted   { background: var(--af-card-bg); color: var(--af-text-2); border: 1px solid var(--af-card-border); }

      /* ── Inputs ── */
      .af-input {
        width: 100%;
        padding: 14px 16px;
        background: var(--af-card-bg);
        border: 1px solid var(--af-card-border);
        border-radius: 14px;
        color: var(--af-text);
        font: inherit;
        font-size: 15px;
        outline: none;
        transition: border-color .15s, box-shadow .15s;
        -webkit-appearance: none;
        appearance: none;
      }
      .af-input:focus {
        border-color: var(--af-accent);
        box-shadow: 0 0 0 4px color-mix(in srgb, var(--af-accent) 20%, transparent);
      }
      .af-input::placeholder { color: var(--af-text-2); }

      /* ── Toast ── */
      .af-toast-wrap {
        position: fixed;
        left: 12px;
        right: 12px;
        top: max(16px, calc(var(--tg-content-safe-area-inset-top, 0px) + var(--tg-safe-area-inset-top, 0px) + 12px));
        z-index: 9999;
        display: grid;
        gap: 8px;
        pointer-events: none;
      }
      .af-toast {
        justify-self: center;
        max-width: min(440px, 100%);
        border: 1px solid var(--af-card-border);
        border-radius: 16px;
        background: color-mix(in srgb, var(--af-bg-2) 90%, transparent);
        backdrop-filter: blur(24px) saturate(180%);
        -webkit-backdrop-filter: blur(24px) saturate(180%);
        color: var(--af-text);
        padding: 12px 16px;
        font-size: 14px;
        font-weight: 500;
        box-shadow: 0 12px 36px rgba(0,0,0,0.24);
        animation: afToastIn .35s var(--af-spring) both;
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .af-toast-icon { font-size: 18px; flex-shrink: 0; }
      .af-toast.success { border-left: 3px solid var(--af-success); }
      .af-toast.error   { border-left: 3px solid var(--af-error); }
      .af-toast.warning { border-left: 3px solid var(--af-warning); }
      @keyframes afToastIn {
        from { opacity: 0; transform: translateY(-12px) scale(0.95); }
        to   { opacity: 1; transform: translateY(0) scale(1); }
      }
      .af-toast.leaving {
        animation: afToastOut .25s ease forwards;
      }
      @keyframes afToastOut {
        to { opacity: 0; transform: translateY(-8px) scale(0.95); }
      }

      /* ── Modal ── */
      .af-modal-backdrop {
        position: fixed;
        inset: 0;
        z-index: 9998;
        background: rgba(0,0,0,0.5);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        display: flex;
        align-items: flex-end;
        justify-content: center;
        padding: 16px;
        padding-bottom: max(16px, calc(var(--tg-safe-area-inset-bottom, 0px) + 16px));
        animation: afFadeIn .25s var(--af-ease);
      }
      .af-modal {
        width: 100%;
        max-width: 480px;
        background: var(--af-bg-2);
        border: 1px solid var(--af-card-border);
        border-radius: var(--af-radius-lg);
        padding: 24px;
        box-shadow: 0 24px 64px rgba(0,0,0,0.4);
        animation: afModalIn .4s var(--af-spring);
      }
      @media (min-width: 600px) {
        .af-modal-backdrop { align-items: center; }
      }
      .af-modal-title {
        font-size: 19px;
        font-weight: 700;
        margin: 0 0 8px;
        letter-spacing: -0.01em;
      }
      .af-modal-body {
        font-size: 15px;
        color: var(--af-text-2);
        line-height: 1.5;
        margin: 0 0 20px;
      }
      .af-modal-actions {
        display: flex;
        gap: 10px;
      }
      .af-modal-actions .af-btn { flex: 1; }
      @keyframes afFadeIn {
        from { opacity: 0; }
        to   { opacity: 1; }
      }
      @keyframes afModalIn {
        from { opacity: 0; transform: translateY(40px) scale(0.96); }
        to   { opacity: 1; transform: translateY(0) scale(1); }
      }

      /* ── Skeleton loading ── */
      .af-skeleton {
        background: linear-gradient(
          90deg,
          var(--af-card-bg) 0%,
          color-mix(in srgb, var(--af-text) 8%, var(--af-card-bg)) 50%,
          var(--af-card-bg) 100%
        );
        background-size: 200% 100%;
        animation: afShimmer 1.4s linear infinite;
        border-radius: 12px;
      }
      @keyframes afShimmer {
        from { background-position: 200% 0; }
        to   { background-position: -200% 0; }
      }

      /* ── Empty state ── */
      .af-empty {
        text-align: center;
        padding: 40px 20px;
      }
      .af-empty-icon {
        font-size: 48px;
        margin-bottom: 12px;
        opacity: 0.6;
      }
      .af-empty-title {
        font-size: 17px;
        font-weight: 600;
        margin: 0 0 4px;
      }
      .af-empty-text {
        font-size: 14px;
        color: var(--af-text-2);
        margin: 0;
      }

      /* ── Section title ── */
      .af-section-title {
        font-size: 13px;
        font-weight: 600;
        color: var(--af-text-2);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        margin: 24px 4px 8px;
      }
    `;
    document.head.appendChild(style);
  }

  function createApi(apiBase) {
    async function request(method, endpoint, body, options) {
      const tg = telegram();
      const headers = Object.assign({
        "Content-Type": "application/json",
        "x-telegram-init-data": tg ? (tg.initData || "") : "",
      }, (options && options.headers) || {});

      const resp = await fetch(endpointUrl(apiBase, endpoint), {
        method,
        headers,
        body: body == null ? undefined : JSON.stringify(body),
      });

      let data;
      const text = await resp.text();
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (!resp.ok) {
        const message = data && data.error ? data.error : `HTTP ${resp.status}`;
        const err = new Error(message);
        err.status = resp.status;
        err.body = data;
        throw err;
      }
      return data;
    }

    return {
      base: apiBase,
      get: (endpoint, options) => request("GET", endpoint, null, options),
      post: (endpoint, body, options) => request("POST", endpoint, body, options),
      put: (endpoint, body, options) => request("PUT", endpoint, body, options),
      patch: (endpoint, body, options) => request("PATCH", endpoint, body, options),
      delete: (endpoint, body, options) => request("DELETE", endpoint, body, options),
    };
  }

  function createStorage(keyPrefix) {
    const prefix = keyPrefix || "af:";
    const tg = telegram();
    const cloud = tg && tg.CloudStorage;

    return {
      get(key) {
        return new Promise((resolve) => {
          if (cloud && cloud.getItem) {
            try {
              cloud.getItem(prefix + key, (err, value) => {
                if (!err && value != null) resolve(value);
                else resolve(localStorage.getItem(prefix + key));
              });
              return;
            } catch {}
          }
          resolve(localStorage.getItem(prefix + key));
        });
      },
      set(key, value) {
        const v = String(value);
        try { localStorage.setItem(prefix + key, v); } catch {}
        return new Promise((resolve) => {
          if (cloud && cloud.setItem) {
            try { cloud.setItem(prefix + key, v, () => resolve(true)); return; } catch {}
          }
          resolve(true);
        });
      },
      remove(key) {
        try { localStorage.removeItem(prefix + key); } catch {}
        return new Promise((resolve) => {
          if (cloud && cloud.removeItem) {
            try { cloud.removeItem(prefix + key, () => resolve(true)); return; } catch {}
          }
          resolve(true);
        });
      },
    };
  }

  function createApp(options) {
    const config = merge(DEFAULTS, options || {});
    const root = ensureRoot(config.root);
    const pages = new Map();
    const actions = new Map();
    const listeners = new Map();
    const apiBase = inferApiBase(config.apiBase);
    let started = false;
    let currentPage = "";
    let currentParams = {};
    let pageStack = null;
    let state = {};

    injectStyles(config);
    root.classList.add("af-transition-" + (config.transition || "slide"));
    if (config.telegram) setupTelegram();

    // Page stack container
    pageStack = document.createElement("div");
    pageStack.className = "af-page-stack";
    root.appendChild(pageStack);

    function emit(event, payload) {
      const set = listeners.get(event);
      if (!set) return;
      for (const fn of set) {
        try { fn(payload); } catch (err) { console.error("[AFApp listener]", err); }
      }
    }

    function saveState() {
      if (!config.persistStateKey) return;
      try { localStorage.setItem(config.persistStateKey, JSON.stringify(state)); } catch {}
    }

    function loadState() {
      if (!config.persistStateKey) return;
      try {
        const raw = localStorage.getItem(config.persistStateKey);
        if (raw) state = merge(state, JSON.parse(raw));
      } catch {}
    }

    async function renderPage(name, params) {
      const render = pages.get(name);
      if (!render) throw new Error(`Page "${name}" is not registered`);
      emit("before:navigate", { from: currentPage, to: name, params });
      const rendered = await render({ app, state, params: params || {}, api: app.api });
      const node = toNode(rendered);
      node.classList.add(PAGE_CLASS);
      node.dataset.page = name;

      const old = pageStack.querySelector(`.${PAGE_CLASS}.${ACTIVE_CLASS}`);
      pageStack.appendChild(node);

      requestAnimationFrame(() => {
        node.classList.add(ACTIVE_CLASS);
      });

      if (old) {
        old.classList.add("af-page-leaving");
        old.classList.remove(ACTIVE_CLASS);
        setTimeout(() => { if (old.parentNode) old.remove(); }, 420);
      }

      currentPage = name;
      currentParams = params || {};
      window.scrollTo({ top: 0, behavior: "instant" });
      emit("after:navigate", { page: name, params: currentParams });
    }

    const app = {
      root,
      api: createApi(apiBase),
      storage: createStorage(`af:${inferProjectId()}:`),
      get state() { return state; },
      get pageName() { return currentPage; },
      get params() { return currentParams; },
      get tg() { return telegram(); },

      page(name, renderFn) {
        pages.set(name, renderFn);
        return app;
      },

      action(name, handler) {
        actions.set(name, handler);
        return app;
      },

      on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(handler);
        return () => listeners.get(event).delete(handler);
      },

      emit,

      setState(patch, rerender) {
        state = merge(state, patch || {});
        saveState();
        emit("state", state);
        if (rerender !== false && currentPage) app.navigate(currentPage, currentParams, { replace: true });
        return state;
      },

      navigate(name, params, opts) {
        const hash = "#/" + encodeURIComponent(name);
        if (!opts || !opts.replace) {
          if (location.hash !== hash) history.pushState({ page: name }, "", hash);
        }
        return renderPage(name, params || {});
      },

      back() {
        history.back();
      },

      start(initialState) {
        if (started) return app;
        started = true;
        state = merge(state, initialState || {});
        loadState();

        document.addEventListener("click", async (ev) => {
          const el = ev.target.closest(`[${ACTION_ATTR}]`);
          if (!el) return;
          const name = el.getAttribute(ACTION_ATTR);
          const handler = actions.get(name);
          if (!handler) return;
          ev.preventDefault();
          haptic("light");
          try {
            await handler({ app, state, event: ev, el, params: Object.assign({}, el.dataset) });
          } catch (err) {
            console.error("[AFApp action]", err);
            app.toast(err.message || "Action failed", "error");
          }
        });

        window.addEventListener("popstate", () => {
          const page = decodeURIComponent((location.hash || "").replace(/^#\/?/, "")) || config.initialPage;
          if (pages.has(page)) renderPage(page, {});
        });

        const hashPage = decodeURIComponent((location.hash || "").replace(/^#\/?/, ""));
        const first = hashPage && pages.has(hashPage) ? hashPage : config.initialPage;
        renderPage(first, {});
        return app;
      },

      loading(message) {
        return `<div class="af-empty"><div class="af-empty-icon">⏳</div><div class="af-empty-title">${escapeHtml(message || "Loading...")}</div></div>`;
      },

      error(message) {
        return `<div class="af-empty"><div class="af-empty-icon">⚠️</div><div class="af-empty-title" style="color:var(--af-error)">${escapeHtml(message || "Something went wrong")}</div></div>`;
      },

      toast(message, type, ms) {
        let wrap = qs(".af-toast-wrap");
        if (!wrap) {
          wrap = document.createElement("div");
          wrap.className = "af-toast-wrap";
          document.body.appendChild(wrap);
        }
        const icons = { success: "✓", error: "✕", warning: "⚠", info: "ⓘ" };
        const icon = icons[type] || icons.info;
        const el = document.createElement("div");
        el.className = "af-toast " + (type || "");
        el.innerHTML = `<span class="af-toast-icon">${icon}</span><span>${escapeHtml(message)}</span>`;
        wrap.appendChild(el);
        setTimeout(() => {
          el.classList.add("leaving");
          setTimeout(() => el.remove(), 250);
        }, ms || 2600);
      },

      modal(opts) {
        const o = isObject(opts) ? opts : { title: "", body: String(opts || "") };
        const back = document.createElement("div");
        back.className = "af-modal-backdrop";
        back.innerHTML = `
          <div class="af-modal" role="dialog" aria-modal="true">
            ${o.title ? `<h2 class="af-modal-title">${escapeHtml(o.title)}</h2>` : ""}
            <div class="af-modal-body">${o.html || escapeHtml(o.body || "")}</div>
            <div class="af-modal-actions">
              <button class="af-btn secondary" data-af-close>${escapeHtml(o.cancelText || "Cancel")}</button>
              ${o.confirmText ? `<button class="af-btn ${o.danger ? "danger" : ""}" data-af-confirm>${escapeHtml(o.confirmText)}</button>` : ""}
            </div>
          </div>
        `;
        document.body.appendChild(back);
        return new Promise((resolve) => {
          back.addEventListener("click", (ev) => {
            if (ev.target === back || ev.target.closest("[data-af-close]")) {
              back.remove();
              resolve(false);
            }
            if (ev.target.closest("[data-af-confirm]")) {
              back.remove();
              resolve(true);
            }
          });
        });
      },

      haptic,
    };

    return app;
  }

  /* ── Reusable component builders ── */
  const Components = {
    Button(label, action, options) {
      const o = options || {};
      const cls = "af-btn"
        + (o.variant ? " " + o.variant : "")
        + (o.className ? " " + o.className : "");
      return `<button ${attrs({ class: cls, "data-action": action, type: "button", disabled: o.disabled })}>${escapeHtml(label)}</button>`;
    },
    Card(content, options) {
      const o = options || {};
      return `<section ${attrs({ class: "af-card" + (o.className ? " " + o.className : "") })}>${content || ""}</section>`;
    },
    List(items) {
      const rows = (items || []).map(item => {
        const action = item.action ? `data-action="${escapeHtml(item.action)}"` : "";
        return `
          <button class="af-list-item ${item.chevron === false ? "" : "af-list-item-chevron"}" ${action}>
            ${item.icon ? `<div class="af-list-item-icon">${item.icon}</div>` : ""}
            <div class="af-list-item-content">
              <div class="af-list-item-title">${escapeHtml(item.title)}</div>
              ${item.subtitle ? `<div class="af-list-item-subtitle">${escapeHtml(item.subtitle)}</div>` : ""}
            </div>
            ${item.trail ? `<div class="af-list-item-trail">${item.trail}</div>` : ""}
          </button>
        `;
      }).join("");
      return `<div class="af-list">${rows}</div>`;
    },
    Pill(label, variant) {
      return `<span class="af-pill ${variant || ""}">${escapeHtml(label)}</span>`;
    },
    Switch(on, action) {
      return `<div class="af-switch ${on ? "on" : ""}" ${action ? `data-action="${escapeHtml(action)}"` : ""}></div>`;
    },
    Empty(title, text, icon) {
      return `
        <div class="af-empty">
          <div class="af-empty-icon">${icon || "📭"}</div>
          <div class="af-empty-title">${escapeHtml(title)}</div>
          ${text ? `<div class="af-empty-text">${escapeHtml(text)}</div>` : ""}
        </div>
      `;
    },
    Skeleton(height) {
      return `<div class="af-skeleton" style="height:${height || 60}px"></div>`;
    },
  };

  window.AFApp = {
    create: createApp,
    escapeHtml,
    attrs,
    haptic,
    Components,
  };
})();
