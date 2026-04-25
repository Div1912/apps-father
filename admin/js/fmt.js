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
