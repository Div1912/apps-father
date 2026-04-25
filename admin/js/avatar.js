/* ── Avatar helpers (port of mini_app userAvatarHtml/getGradient/getInitials) ── */
(function () {
  "use strict";

  const GRADIENTS = [
    ["#FF6B6B", "#EE5A6F"],
    ["#4FACFE", "#00F2FE"],
    ["#43E97B", "#38F9D7"],
    ["#FA709A", "#FEE140"],
    ["#A8EDEA", "#FED6E3"],
    ["#FBC2EB", "#A6C1EE"],
    ["#FFD86F", "#FC6262"],
    ["#48C6EF", "#6F86D6"],
    ["#FFC796", "#FF6B95"],
    ["#5EE7DF", "#B490CA"],
    ["#FAACA8", "#DDD6F3"],
    ["#84FAB0", "#8FD3F4"],
  ];

  function hashSeed(seed) {
    const s = String(seed || "?");
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) - h) + s.charCodeAt(i);
      h |= 0;
    }
    return Math.abs(h);
  }

  function getGradient(seed) {
    const idx = hashSeed(seed) % GRADIENTS.length;
    const [a, b] = GRADIENTS[idx];
    return `linear-gradient(135deg, ${a}, ${b})`;
  }

  function getInitials(name) {
    const s = String(name || "").trim();
    if (!s) return "?";
    const parts = s.split(/\s+/);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return s.slice(0, 2).toUpperCase();
  }

  /**
   * Render an avatar element.
   * @param {Object} opts
   * @param {string} opts.name       — display name used for initials & seed.
   * @param {string} [opts.seed]     — explicit seed (id) for color stability.
   * @param {string} [opts.imageUrl] — optional photo URL.
   * @param {32|40|56} [opts.size=40]
   */
  function avatarHtml(opts) {
    opts = opts || {};
    const size = opts.size || 40;
    const seed = opts.seed != null ? String(opts.seed) : (opts.name || "?");
    const initials = getInitials(opts.name);
    const grad = getGradient(seed);
    const img = opts.imageUrl
      ? `<img src="${Fmt.escapeHtml(opts.imageUrl)}" alt="" onerror="this.remove()" />`
      : "";
    return `<div class="avatar size-${size}" style="background:${grad}">${img}${img ? "" : Fmt.escapeHtml(initials)}</div>`;
  }

  // Module-scoped promise cache so repeated lookups for the same entity
  // (across pages, tab restores, etc.) don't refetch.
  const urlCache = new Map(); // `${kind}/${id}` → Promise<string|null>
  const RESOLVED = new Map(); // `${kind}/${id}` → string|null (fast path)

  function fetchAvatarUrl(kind, id) {
    const key = `${kind}/${id}`;
    if (RESOLVED.has(key)) return Promise.resolve(RESOLVED.get(key));
    if (urlCache.has(key)) return urlCache.get(key);
    const p = (async () => {
      try {
        const r = await Api.request(`/avatar/${kind}/${encodeURIComponent(id)}`);
        const url = (r && typeof r.url === "string") ? r.url : null;
        RESOLVED.set(key, url);
        return url;
      } catch (_) {
        RESOLVED.set(key, null);
        return null;
      }
    })();
    urlCache.set(key, p);
    return p;
  }

  /**
   * Render a placeholder gradient/initials avatar that lazily upgrades to a
   * real photo URL fetched from the backend.
   *
   * @param {Object} opts
   * @param {"user"|"project"} opts.kind
   * @param {string|number} opts.id
   * @param {string} opts.name
   * @param {string} [opts.seed]
   * @param {32|40|56} [opts.size=40]
   */
  function lazyAvatarHtml(opts) {
    opts = opts || {};
    const size = opts.size || 40;
    const seed = opts.seed != null ? String(opts.seed) : (opts.name || "?");
    const grad = getGradient(seed);
    const initials = getInitials(opts.name);
    const key = `${opts.kind}/${opts.id}`;

    // Fast path: if we've already resolved this entity in this session, render
    // the <img> directly so there's zero flash.
    if (RESOLVED.has(key)) {
      const url = RESOLVED.get(key);
      if (url) {
        return `<div class="avatar size-${size}" style="background:${grad}" data-avatar="${Fmt.escapeHtml(key)}"><img src="${Fmt.escapeHtml(url)}" alt="" onerror="this.remove()"/></div>`;
      }
    }

    // Schedule an async upgrade after this microtask so the placeholder is
    // visible immediately. queueMicrotask keeps everything ordered.
    queueMicrotask(() => {
      fetchAvatarUrl(opts.kind, opts.id).then((url) => {
        if (!url) return;
        document.querySelectorAll(`[data-avatar="${cssEscape(key)}"]`).forEach((el) => {
          if (el.querySelector("img")) return;
          const img = document.createElement("img");
          img.src = url;
          img.alt = "";
          img.onerror = () => img.remove();
          el.textContent = "";
          el.appendChild(img);
        });
      });
    });

    return `<div class="avatar size-${size}" style="background:${grad}" data-avatar="${Fmt.escapeHtml(key)}">${Fmt.escapeHtml(initials)}</div>`;
  }

  function cssEscape(s) {
    if (window.CSS && typeof CSS.escape === "function") return CSS.escape(s);
    return String(s).replace(/["\\]/g, "\\$&");
  }

  window.Avatar = { avatarHtml, lazyAvatarHtml, getGradient, getInitials };
})();
