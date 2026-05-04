/**
 * AF SDK — Apps Father utility SDK.
 * Pure utilities only — no UI, no styles.
 *
 * Usage:
 *   AF.init({ project_id: '...', colors: { header, bottom, background } });
 *   AF.api('endpoint', fetchOptions?)              → Promise<Response>
 *   AF.openWS({ onMessage, onOpen, onClose, onError }) → WebSocket
 *   AF.haptic('light' | 'success' | 'selection' | ...)
 *   AF.user                                        → Telegram user object | null
 *   AF.isDev                                       → true when running under /dev/
 *   AF.storage.get(key) / .set(key, val) / .remove(key)   (project-namespaced)
 *   AF.back(handler)   show BackButton + register handler
 *   AF.back(null)      hide BackButton + remove handler
 *
 * AF.init() auto-detects the runtime environment from window.location:
 *   /dev/{id}/...  → routes API calls to /devapi/{id}/  (development)
 *   /app/{id}/...  → routes API calls to /api/{id}/     (production)
 */
(function (global) {
  'use strict';

  var _projectId = '';
  var _apiBase   = '';
  var _wsBase    = '';
  var _isDev     = false;

  // ── Environment detection ────────────────────────────────────────────────────
  function _detectBase(projectId) {
    var p = window.location.pathname;
    var dev = p.indexOf('/dev/' + projectId) === 0 ||
              p.indexOf('/dev/' + projectId + '/') !== -1;
    _isDev = dev;
    return {
      api: (dev ? '/devapi/' : '/api/') + projectId + '/',
      ws:  (dev ? '/devws/'  : '/ws/')  + projectId + '/'
    };
  }

  // ── TG accessor ──────────────────────────────────────────────────────────────
  function _tg() {
    return window.Telegram && window.Telegram.WebApp || null;
  }

  // ── AF.init ──────────────────────────────────────────────────────────────────
  function init(opts) {
    opts = opts || {};
    _projectId = opts.project_id || opts.projectId || _projectId;

    var env = _detectBase(_projectId);
    _apiBase = env.api;
    _wsBase  = env.ws;

    var tg = _tg();
    if (!tg) return;

    tg.ready();
    tg.expand();
    if (tg.disableVerticalSwipes) tg.disableVerticalSwipes();

    var c = opts.colors || {};
    try { if (c.header)     tg.setHeaderColor(c.header);         } catch (_) {}
    try { if (c.bottom)     tg.setBottomBarColor(c.bottom);      } catch (_) {}
    try { if (c.background) tg.setBackgroundColor(c.background); } catch (_) {}

    if (tg.requestFullscreen &&
        tg.platform && ['android', 'ios'].indexOf(tg.platform) !== -1) {
      tg.requestFullscreen();
    }
  }

  // ── AF.api ───────────────────────────────────────────────────────────────────
  function api(path, options) {
    if (!_apiBase) {
      // Best-effort fallback if AF.init() was skipped
      var m = window.location.pathname.match(/\/(dev|app)\/([^/]+)/);
      if (m) {
        _isDev     = m[1] === 'dev';
        _projectId = m[2];
        _apiBase   = (_isDev ? '/devapi/' : '/api/') + _projectId + '/';
        _wsBase    = (_isDev ? '/devws/'  : '/ws/')  + _projectId + '/';
      }
    }
    options = options || {};
    var tg = _tg();
    var headers = Object.assign(
      { 'Content-Type': 'application/json',
        'x-telegram-init-data': (tg && tg.initData) || '' },
      options.headers || {}
    );
    return fetch(_apiBase + path, Object.assign({}, options, { headers: headers }));
  }

  // ── AF.openWS ────────────────────────────────────────────────────────────────
  function openWS(handlers) {
    if (!_wsBase) throw new Error('[AF] Call AF.init() before AF.openWS()');
    handlers = handlers || {};
    var proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var ws = new WebSocket(proto + '//' + window.location.host + _wsBase);

    ws.onopen    = function (e) { handlers.onOpen  && handlers.onOpen(e); };
    ws.onclose   = function (e) { handlers.onClose && handlers.onClose(e); };
    ws.onerror   = function (e) { handlers.onError && handlers.onError(e); };
    ws.onmessage = function (e) {
      if (!handlers.onMessage) return;
      var data;
      try { data = JSON.parse(e.data); } catch (_) { data = e.data; }
      handlers.onMessage(data, e);
    };
    return ws;
  }

  // ── AF.haptic ────────────────────────────────────────────────────────────────
  // type: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'  → impact
  //       'success' | 'error' | 'warning'                   → notification
  //       'selection'                                        → selectionChanged
  function haptic(type) {
    var tg = _tg();
    if (!tg || !tg.HapticFeedback) return;
    try {
      if (type === 'success' || type === 'error' || type === 'warning') {
        tg.HapticFeedback.notificationOccurred(type);
      } else if (type === 'selection') {
        tg.HapticFeedback.selectionChanged();
      } else {
        tg.HapticFeedback.impactOccurred(type || 'light');
      }
    } catch (_) {}
  }

  // ── AF.storage ───────────────────────────────────────────────────────────────
  // All keys are namespaced as "af:{projectId}:{key}" so multiple projects
  // on the same origin never collide in localStorage.
  var storage = {
    _key: function (k) { return 'af:' + _projectId + ':' + k; },
    get: function (k) {
      try {
        var raw = localStorage.getItem(this._key(k));
        return raw === null ? null : JSON.parse(raw);
      } catch (_) { return null; }
    },
    set: function (k, v) {
      try { localStorage.setItem(this._key(k), JSON.stringify(v)); } catch (_) {}
    },
    remove: function (k) {
      try { localStorage.removeItem(this._key(k)); } catch (_) {}
    }
  };

  // ── AF.back ──────────────────────────────────────────────────────────────────
  // AF.back(fn)   → shows BackButton, registers fn as the click handler
  // AF.back(null) → hides BackButton, removes the current handler
  var _backHandler = null;
  function back(handler) {
    var tg = _tg();
    if (!tg || !tg.BackButton) return;
    if (_backHandler) {
      try { tg.BackButton.offClick(_backHandler); } catch (_) {}
      _backHandler = null;
    }
    if (typeof handler === 'function') {
      _backHandler = handler;
      tg.BackButton.onClick(_backHandler);
      tg.BackButton.show();
    } else {
      tg.BackButton.hide();
    }
  }

  // ── Public surface ───────────────────────────────────────────────────────────
  global.AF = {
    init:    init,
    api:     api,
    openWS:  openWS,
    haptic:  haptic,
    storage: storage,
    back:    back,
    get projectId() { return _projectId; },
    get apiBase()   { return _apiBase;   },
    get wsBase()    { return _wsBase;    },
    get isDev()     { return _isDev;     },
    get user() {
      var tg = _tg();
      return (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) || null;
    },
    get tg() { return _tg(); }
  };

}(window));
