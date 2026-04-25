/* ── Login screen ── */
(function () {
  "use strict";

  function isDevHost() {
    return /^dev\./i.test(window.location.hostname) || /\.local$/i.test(window.location.hostname);
  }

  function envLabel() {
    return isDevHost() ? "DEV" : "PROD";
  }

  function envClass() {
    return isDevHost() ? "dev" : "";
  }

  function render(onSuccess) {
    const root = document.getElementById("root");
    root.innerHTML = `
      <div class="login-wrap">
        <form class="login-card" id="login-form" autocomplete="off">
          <div class="logo">A</div>
          <h1>Apps Father — Admin</h1>
          <div class="sub">Sign in with the admin password to continue.</div>

          <label class="input-label" for="login-password">Password</label>
          <input class="input" id="login-password" name="password" type="password" autocomplete="current-password" required />

          <div class="err" id="login-err"></div>

          <div style="margin-top:18px;display:flex;align-items:center;gap:10px;justify-content:space-between;">
            <span class="env-pill ${envClass()}"><span class="dot"></span>${envLabel()}</span>
            <button class="btn btn-primary" type="submit" id="login-btn">Sign In</button>
          </div>
        </form>
      </div>
    `;

    const form = document.getElementById("login-form");
    const pw   = document.getElementById("login-password");
    const err  = document.getElementById("login-err");
    const btn  = document.getElementById("login-btn");
    pw.focus();

    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      err.textContent = "";
      btn.disabled = true;
      btn.textContent = "Signing in…";
      try {
        await Api.login(pw.value);
        if (typeof onSuccess === "function") onSuccess();
      } catch (ex) {
        err.textContent = ex.message || "Login failed";
        pw.value = "";
        pw.focus();
      } finally {
        btn.disabled = false;
        btn.textContent = "Sign In";
      }
    });
  }

  window.Auth = { render, isDevHost, envLabel };
})();
