/* ── Per-tab navigation stack (back/forward inside a single tab) ──
   Each Tab owns one Router. Router.push({ pageKey, params, title, icon })
   renders that page into the tab panel, and remembers history so the back
   button can pop back to the previous view. */
(function () {
  "use strict";

  function createRouter(tab, panelEl) {
    const stack = []; // [{ pageKey, params, title, icon, scroll }]

    function currentEntry() {
      return stack[stack.length - 1] || null;
    }

    function rememberScroll() {
      const top = stack[stack.length - 1];
      if (top) top.scroll = panelEl.scrollTop;
    }

    function rerender() {
      const entry = currentEntry();
      if (!entry) {
        panelEl.innerHTML = "";
        return;
      }
      const def = window.AdminPages && window.AdminPages[entry.pageKey];
      if (!def) {
        panelEl.innerHTML = `<div class="error-state"><div class="big">!</div>Unknown page: <code>${Fmt.escapeHtml(entry.pageKey)}</code></div>`;
        return;
      }

      // Build the host: optional back button + page container.
      panelEl.innerHTML = "";
      if (stack.length > 1) {
        const back = Fmt.h("button", {
          class: "panel-back",
          onClick: pop,
          html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg> Back`,
        });
        panelEl.appendChild(back);
      }
      const host = Fmt.h("div", { class: "page-host", style: { flex: "1", display: "flex", flexDirection: "column" } });
      panelEl.appendChild(host);

      // Update tab chrome.
      tab.title = entry.title || def.title || entry.pageKey;
      tab.icon  = entry.icon  || def.icon  || "";
      if (window.TabBar && typeof window.TabBar.refresh === "function") window.TabBar.refresh();

      // Render the page.
      if (!entry.state) entry.state = {};
      const ctx = {
        tab,
        params: entry.params || {},
        state: entry.state,
        push,
        pop,
        replace,
        toast: Fmt.toast,
      };
      try {
        const ret = def.render(host, ctx);
        if (ret && typeof ret.then === "function") {
          ret.catch(err => {
            host.innerHTML = `<div class="error-state"><div class="big">!</div>${Fmt.escapeHtml(err && err.message || "Failed to load")}</div>`;
          });
        }
      } catch (err) {
        host.innerHTML = `<div class="error-state"><div class="big">!</div>${Fmt.escapeHtml(err && err.message || "Render error")}</div>`;
      }

      // Restore scroll on back/forward.
      if (typeof entry.scroll === "number") {
        requestAnimationFrame(() => { panelEl.scrollTop = entry.scroll; });
      }
    }

    function push(entry) {
      rememberScroll();
      stack.push(Object.assign({ scroll: 0 }, entry));
      rerender();
    }
    function pop() {
      if (stack.length <= 1) return;
      stack.pop();
      rerender();
    }
    function replace(entry) {
      if (stack.length === 0) return push(entry);
      stack[stack.length - 1] = Object.assign({ scroll: 0 }, entry);
      rerender();
    }
    function reset(entry) {
      stack.length = 0;
      push(entry);
    }

    return {
      stack,
      push, pop, replace, reset,
      current: currentEntry,
      rerender,
    };
  }

  window.Router = { create: createRouter };
})();
