/* ── Tiny fetch wrapper around /admin/api with bearer + 401 handling ── */
(function () {
  "use strict";

  const TOKEN_KEY = "af_admin_token";

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || "";
  }

  function setToken(token) {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else       localStorage.removeItem(TOKEN_KEY);
  }

  /**
   * @param {string} pathOrUrl  — "/stats" → /admin/api/stats. Absolute paths starting with "/admin" pass through.
   * @param {Object} [opts]     — fetch options. `body` (object) auto-stringified.
   */
  async function request(pathOrUrl, opts) {
    opts = opts || {};
    const url = pathOrUrl.startsWith("/admin")
      ? pathOrUrl
      : "/admin/api" + pathOrUrl;

    const headers = Object.assign(
      { "Content-Type": "application/json" },
      opts.headers || {},
    );
    const token = getToken();
    if (token) headers["Authorization"] = "Bearer " + token;

    const init = {
      method: opts.method || "GET",
      headers,
    };
    if (opts.body !== undefined) {
      init.body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    }

    const res = await fetch(url, init);

    if (res.status === 401) {
      setToken("");
      // re-render login screen if the rest of the app has already booted
      if (window.AdminApp && typeof window.AdminApp.boot === "function") {
        window.AdminApp.boot();
      }
      throw new Error("Unauthorized");
    }

    let data = null;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      try { data = await res.json(); } catch (_) { data = null; }
    } else {
      data = await res.text();
    }

    if (!res.ok) {
      const msg = (data && (data.error || data.message)) || res.statusText || "Request failed";
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  async function login(password) {
    const res = await fetch("/admin/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.token) {
      throw new Error(data.error || "Login failed");
    }
    setToken(data.token);
    return data.token;
  }

  function logout() {
    setToken("");
  }

  window.Api = { request, login, logout, getToken, setToken };
})();
