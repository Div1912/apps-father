/* ── Formatting & DOM helpers (port of mini_app helpers, slightly trimmed) ──
   Exposed on window so all other modules can use without imports. */
(function () {
  "use strict";

  const Fmt = {};

  Fmt.escapeHtml = function (s) {
    if (s === null || s === undefined) return "";
    const div = document.createElement("div");
    div.textContent = String(s);
    return div.innerHTML;
  };

  Fmt.money = function (n, decimals) {
    const v = Number(n || 0);
    const d = decimals === undefined ? (Math.abs(v) >= 100 ? 0 : 2) : decimals;
    return "$" + v.toFixed(d);
  };

  /** Format an integer credit balance as plain text, e.g. 1234 → "1,234 cr" */
  Fmt.credits = function (n) {
    const v = Math.round(Number(n || 0));
    return v.toLocaleString("en-US") + " cr";
  };

  const _COIN_PATH = 'M129.743,95.01c-15.97-.027-35.976,5.02-55.714,15.292-19.706,10.273-35.326,23.73-44.495,36.873-9.174,13.1-11.654,25.3-7.141,34,4.517,8.658,15.938,13.637,31.948,13.637,16.01.045,36.017-5.024,55.709-15.252,19.738-10.273,35.348-23.775,44.5-36.873,9.2-13.1,11.618-25.3,7.132-34-4.531-8.658-15.925-13.677-31.939-13.677Zm41.225,31.531a60.545,60.545,0,0,1-9.779,20.769C151.051,161.8,134.5,175.93,113.774,186.7c-20.725,10.811-41.763,16.239-59.437,16.239a60.477,60.477,0,0,1-22.6-3.9l4.75,9.151c4.522,8.7,15.911,13.682,31.93,13.682s36.021-5.024,55.714-15.3c19.738-10.228,35.348-23.73,44.5-36.873,9.151-13.1,11.663-25.3,7.132-33.958Zm12.919,7.536c5.024,11.977.987,26.556-8.613,40.238-8.478,12.157-21.442,23.954-37.5,33.823a144.6,144.6,0,0,0,15.476.807c22.2,0,42.3-4.755,56.477-12.157,14.22-7.4,22.025-17.091,22.025-26.87s-7.805-19.468-22.025-26.87a103.163,103.163,0,0,0-25.838-8.972Zm47.864,55.983a61.176,61.176,0,0,1-18.257,13.906c-15.7,8.164-36.874,13.054-60.245,13.054a155.816,155.816,0,0,1-27.229-2.333A152.678,152.678,0,0,1,95.113,226.4c.538.314,1.077.583,1.66.9,14.175,7.4,34.272,12.157,56.477,12.157s42.3-4.755,56.477-12.157c14.22-7.4,22.025-17.091,22.025-26.87Z';

  /** Format credits as HTML with the coin icon (do NOT wrap with escapeHtml) */
  Fmt.creditsHtml = function (n, fill) {
    const v = Math.round(Number(n || 0));
    const color = fill || 'currentColor';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="12" viewBox="0 0 211.551 144.439" fill="${color}" style="vertical-align:middle;flex-shrink:0;margin-right:3px" aria-hidden="true"><path d="${_COIN_PATH}" transform="translate(-20.199 -95.01)"/></svg>`;
    return `<span style="display:inline-flex;align-items:center;gap:2px">${svg}${v.toLocaleString("en-US")} cr</span>`;
  };

  Fmt.number = function (n) {
    const v = Number(n || 0);
    if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
    return String(v);
  };

  Fmt.intK = function (n) {
    const v = Number(n || 0);
    if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
    if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(0) + "K";
    return String(v);
  };

  Fmt.percent = function (n, decimals) {
    const v = Number(n || 0) * 100;
    const d = decimals === undefined ? (Math.abs(v) >= 10 ? 0 : 1) : decimals;
    return v.toFixed(d) + "%";
  };

  Fmt.date = function (d) {
    if (!d) return "—";
    try {
      return new Date(d).toLocaleString("en-US", {
        month: "short", day: "numeric", year: "numeric",
        hour: "2-digit", minute: "2-digit",
      });
    } catch (_) { return String(d); }
  };

  Fmt.dateShort = function (d) {
    if (!d) return "—";
    try {
      return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    } catch (_) { return String(d); }
  };

  Fmt.relativeTime = function (d) {
    if (!d) return "—";
    const diffMs = Date.now() - new Date(d).getTime();
    if (diffMs < 60_000)        return "just now";
    if (diffMs < 3_600_000)     return Math.floor(diffMs / 60_000) + "m ago";
    if (diffMs < 86_400_000)    return Math.floor(diffMs / 3_600_000) + "h ago";
    if (diffMs < 604_800_000)   return Math.floor(diffMs / 86_400_000) + "d ago";
    return Fmt.dateShort(d);
  };

  Fmt.statusBadge = function (status) {
    const s = String(status || "").toLowerCase();
    let cls = "";
    if (s === "deployed" || s === "active" || s === "running" || s === "confirmed") cls = "success";
    else if (s === "building" || s === "pending" || s === "processing") cls = "warn";
    else if (s === "error" || s === "failed" || s === "stopped") cls = "danger";
    else if (s === "created" || s === "draft") cls = "accent";
    return `<span class="badge ${cls}"><span class="dot"></span>${Fmt.escapeHtml(s || "—")}</span>`;
  };

  /** Lightweight DOM builder. Returns a single Element. */
  Fmt.h = function (tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === "class")        el.className = v;
        else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
        else if (k === "dataset") for (const [dk, dv] of Object.entries(v)) el.dataset[dk] = dv;
        else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === "html")    el.innerHTML = v;
        else                      el.setAttribute(k, v);
      }
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      if (child instanceof Node) el.appendChild(child);
      else el.appendChild(document.createTextNode(String(child)));
    }
    return el;
  };

  /** Toast: type ∈ {ok, err, info} */
  Fmt.toast = function (msg, type) {
    const stack = document.getElementById("toast-stack");
    if (!stack) return;
    const t = document.createElement("div");
    t.className = "toast " + (type || "info");
    t.textContent = msg;
    stack.appendChild(t);
    setTimeout(() => {
      t.style.transition = "opacity 200ms ease";
      t.style.opacity = "0";
      setTimeout(() => t.remove(), 220);
    }, 2800);
  };

  Fmt.confirm = function (message) {
    return Promise.resolve(window.confirm(message));
  };

  Fmt.copyToClipboard = function (text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } finally { ta.remove(); }
    return Promise.resolve();
  };

  window.Fmt = Fmt;
})();
