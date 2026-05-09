/* Apps Father Dev Tools — injected into every /dev/{projectId}/ preview.
   __AFPID__ is replaced server-side with the real project ID at serve time.  */
(function () {
  if (document.getElementById('_af_rdy')) return;
  var _g = document.createElement('meta'); _g.id = '_af_rdy'; document.head.appendChild(_g);
  var PID = '__AFPID__';

  /* ── 1. Log ring buffers ─────────────────────────────────────────────────── */
  // MAXLEN is per-entry — needs to fit a full stack trace (typically 1-3 KB).
  // MAXL × MAXLEN bounds total memory (~150 KB worst-case) so a runaway error
  // loop can't blow up the page.
  var EL = [], RL = [], MAXL = 30, MAXLEN = 5000;
  function _push(arr, m) { arr.push({ t: Date.now(), m: String(m).slice(0, MAXLEN) }); if (arr.length > MAXL) arr.shift(); }
  function _fmt(a) {
    if (a == null) return String(a);
    if (a instanceof Error) return (a.stack || (a.name + ': ' + a.message));
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return String(a); } }
    return String(a);
  }
  var _ce = console.error.bind(console);
  console.error = function () {
    _push(EL, Array.prototype.slice.call(arguments).map(_fmt).join(' '));
    _ce.apply(console, arguments);
  };
  var _cw = console.warn.bind(console);
  console.warn = function () {
    _push(EL, '[warn] ' + Array.prototype.slice.call(arguments).map(_fmt).join(' '));
    _cw.apply(console, arguments);
  };
  window.addEventListener('error', function (e) {
    var loc = e.filename ? ' @ ' + e.filename + ':' + e.lineno + (e.colno ? ':' + e.colno : '') : '';
    var stack = e.error && e.error.stack ? '\n' + e.error.stack : '';
    _push(EL, (e.message || 'JS error') + loc + stack);
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    var msg = r && r.message ? r.message : String(r);
    var stack = r && r.stack ? '\n' + r.stack : '';
    _push(EL, 'Unhandled: ' + msg + stack);
  });

  /* ── 2. Fetch interceptor ────────────────────────────────────────────────── */
  if (window.fetch) {
    var _of = window.fetch.bind(window);
    window.fetch = function () {
      var a = arguments, u = typeof a[0] === 'string' ? a[0] : (a[0] && a[0].url ? a[0].url : '');
      return _of.apply(window, a).then(
        function (r) { if (r.status >= 400 && u.indexOf('/telegram-mini-app') === -1) _push(RL, 'HTTP ' + r.status + ' ' + u); return r; },
        function (e) { _push(RL, 'Fetch error ' + u + ': ' + (e.message || e)); throw e; }
      );
    };
  }

  /* ── 3. Language / i18n ──────────────────────────────────────────────────── */
  var LANG = (function () {
    try {
      var tg = window.Telegram && window.Telegram.WebApp;
      var lc = (tg && tg.initDataUnsafe && tg.initDataUnsafe.user && tg.initDataUnsafe.user.language_code) || 'en';
      return lc.split('-')[0].toLowerCase();
    } catch (e) { return 'en'; }
  })();

  var I18N = {
    en: {
      openEditor: 'Open Editor', applyChanges: 'Apply Changes',
      exitEditor: 'Exit Editor', reportBug: 'Report a Bug',
      sending: 'Sending...', content: 'Content', danger: 'Danger',
      removeEl: 'Remove element', removeConfirm: 'Remove this element from the page?',
      removeYes: 'Yes, Remove', cancel: 'Cancel',
      opacity: 'Opacity', transparent: 'Transparent',
      bugTitle: 'Report a Bug', bugHint: 'What went wrong? (optional)',
      bugSend: 'Send Bug Report', noLogs: 'No errors captured yet.',
      sent: 'Changes sent to agent!', sendFail: 'Failed to send', bugSent: 'Bug report sent!',
    },
    uk: {
      openEditor: 'Відкрити редактор', applyChanges: 'Застосувати',
      exitEditor: 'Вийти', reportBug: 'Повідомити про помилку',
      sending: 'Надсилання...', content: 'Вміст', danger: 'Небезпечно',
      removeEl: 'Видалити елемент', removeConfirm: 'Видалити цей елемент зі сторінки?',
      removeYes: 'Так, видалити', cancel: 'Скасувати',
      opacity: 'Прозорість', transparent: 'Прозорий',
      bugTitle: 'Повідомлення про помилку', bugHint: 'Що пішло не так? (необов\'язково)',
      bugSend: 'Надіслати звіт', noLogs: 'Помилок не знайдено.',
      sent: 'Зміни надіслано агенту!', sendFail: 'Не вдалося надіслати', bugSent: 'Звіт надіслано!',
    },
    ru: {
      openEditor: 'Открыть редактор', applyChanges: 'Применить',
      exitEditor: 'Выйти', reportBug: 'Сообщить об ошибке',
      sending: 'Отправка...', content: 'Содержимое', danger: 'Опасно',
      removeEl: 'Удалить элемент', removeConfirm: 'Удалить этот элемент со страницы?',
      removeYes: 'Да, удалить', cancel: 'Отмена',
      opacity: 'Прозрачность', transparent: 'Прозрачный',
      bugTitle: 'Сообщение об ошибке', bugHint: 'Что пошло не так? (необязательно)',
      bugSend: 'Отправить отчёт', noLogs: 'Ошибок не обнаружено.',
      sent: 'Изменения отправлены!', sendFail: 'Не удалось отправить', bugSent: 'Отчёт отправлен!',
    },
  };
  function t(k) { var d = I18N[LANG] || I18N.en; return d[k] || I18N.en[k] || k; }

  /* ── 4. CSS ──────────────────────────────────────────────────────────────── */
  (function () {
    var s = document.createElement('style');
    s.textContent = [
      '#_af_hi{position:fixed;z-index:2147483621;pointer-events:none;display:none;border:2px solid #2563eb;border-radius:6px;box-shadow:0 0 0 4px rgba(37,99,235,.13);transition:top .07s,left .07s,width .07s,height .07s}',
      '#_af_pn{position:fixed;z-index:2147483625;width:216px;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08),0 8px 40px rgba(0,0,0,.15),0 0 0 1px rgba(0,0,0,.06);opacity:0;pointer-events:none;transform:scale(.9) translateY(-6px);transition:opacity .15s,transform .18s cubic-bezier(.32,.72,0,1)}',
      '#_af_pn.on{opacity:1;pointer-events:all;transform:scale(1) translateY(0)}',
      '._af_ph{display:flex;align-items:center;gap:6px;padding:9px 10px 8px;background:#f9fafb;border-bottom:1px solid rgba(0,0,0,.06)}',
      '._af_bc{flex:1;font:600 10px/1.2 -apple-system,sans-serif;color:#6b7280;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:.5px;text-transform:uppercase}',
      '._af_px{width:20px;height:20px;padding:0;border:none;background:rgba(0,0,0,.06);color:#9ca3af;font:13px/20px sans-serif;cursor:pointer;border-radius:5px;flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:background .12s,color .12s}',
      '._af_px:hover{background:rgba(0,0,0,.12);color:#374151}',
      '._af_ebk{width:24px;height:20px;padding:0;border:none;background:rgba(0,0,0,.06);color:#6b7280;cursor:pointer;border-radius:5px;flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:background .12s,color .12s}',
      '._af_ebk:hover{background:rgba(0,0,0,.12);color:#374151}',
      '._af_scr{overflow-y:auto;max-height:340px;-webkit-overflow-scrolling:touch}',
      '._af_sep{font:600 9px/1 -apple-system,sans-serif;color:#9ca3af;letter-spacing:.6px;text-transform:uppercase;padding:8px 10px 3px;background:#f9fafb;border-bottom:1px solid rgba(0,0,0,.04)}',
      '._af_prow{display:flex;align-items:center;gap:7px;padding:6px 10px;cursor:pointer;border-bottom:1px solid rgba(0,0,0,.04);transition:background .1s;-webkit-tap-highlight-color:transparent}',
      '._af_prow:last-child{border:none}',
      '._af_prow:hover,._af_prow:active{background:#f3f4f6}',
      '._af_ico{width:20px;height:20px;border-radius:6px;display:flex;align-items:center;justify-content:center;font:700 9px/1 -apple-system,sans-serif;color:#fff;flex-shrink:0}',
      '._af_plbl{flex:1;font:12px/1 -apple-system,sans-serif;color:#374151}',
      '._af_cv{font:11px/1 "SF Mono","Fira Mono",monospace;color:#9ca3af;flex-shrink:0;max-width:52px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      /* color swatch in list */
      '._af_chk{background:repeating-conic-gradient(#e5e7eb 0% 25%,#fff 0% 50%) 0 0 / 8px 8px;border:1px solid rgba(0,0,0,.1);border-radius:4px;width:14px;height:14px;flex-shrink:0;position:relative;overflow:hidden}',
      '._af_swc{position:absolute;inset:0}',
      /* color editor */
      '._af_ebody{padding:12px 12px 14px}',
      '._af_ecol{display:flex;gap:8px;align-items:center}',
      '._af_esw{width:44px;height:44px;border-radius:10px;position:relative;overflow:hidden;flex-shrink:0;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.12);background:repeating-conic-gradient(#e5e7eb 0% 25%,#fff 0% 50%) 0 0 / 8px 8px}',
      '._af_swl{position:absolute;inset:0}',
      '._af_esw input[type=color]{position:absolute;inset:-6px;width:160%;height:160%;opacity:0;cursor:pointer}',
      '._af_ehex{flex:1;font:13px/1 "SF Mono","Fira Mono",monospace;color:#111827;background:#f9fafb;border:1.5px solid #e5e7eb;border-radius:8px;padding:9px 8px;outline:none;min-width:0;-webkit-appearance:none;transition:border-color .15s}',
      '._af_ehex:focus{border-color:#2563eb;background:#fff}',
      '._af_orow{margin-top:10px}',
      '._af_olbl{font:11px/1 -apple-system,sans-serif;color:#6b7280;display:flex;align-items:center;justify-content:space-between;margin-bottom:5px}',
      '._af_tbtn{border:none;padding:2px 7px;border-radius:5px;font:11px/1 -apple-system,sans-serif;cursor:pointer;color:#6b7280;background:#f3f4f6;transition:background .12s}',
      '._af_tbtn:hover{background:#e5e7eb;color:#374151}',
      '._af_eslw{margin-bottom:10px}',
      '._af_esl{width:100%;-webkit-appearance:none;height:4px;border-radius:2px;outline:none;cursor:pointer;background:linear-gradient(90deg,#2563eb var(--v,0%),#e5e7eb var(--v,0%))}',
      '._af_esl::-webkit-slider-thumb{-webkit-appearance:none;width:20px;height:20px;border-radius:50%;background:#fff;cursor:grab;box-shadow:0 0 0 2px #2563eb,0 2px 6px rgba(0,0,0,.2)}',
      '._af_esl:active::-webkit-slider-thumb{cursor:grabbing;background:#eff6ff}',
      '._af_enum{display:flex;align-items:center;gap:6px}',
      '._af_nu{width:64px;font:13px/1 "SF Mono","Fira Mono",monospace;color:#111827;background:#f9fafb;border:1.5px solid #e5e7eb;border-radius:8px;padding:7px 8px;text-align:center;outline:none;-webkit-appearance:none;transition:border-color .15s}',
      '._af_nu:focus{border-color:#2563eb;background:#fff}',
      '._af_unit{font:12px/1 -apple-system,sans-serif;color:#9ca3af}',
      '._af_esel{width:100%;font:13px/1 -apple-system,sans-serif;color:#111827;background:#f9fafb;border:1.5px solid #e5e7eb;border-radius:8px;padding:9px 8px;outline:none;-webkit-appearance:none;transition:border-color .15s}',
      '._af_esel:focus{border-color:#2563eb;background:#fff}',
      '._af_etxt{width:100%;box-sizing:border-box;font:13px/1 "SF Mono","Fira Mono",monospace;color:#111827;background:#f9fafb;border:1.5px solid #e5e7eb;border-radius:8px;padding:7px 8px;outline:none;-webkit-appearance:none;transition:border-color .15s}',
      '._af_etxt:focus{border-color:#2563eb;background:#fff}',
      '._af_etx{width:100%;box-sizing:border-box;min-height:90px;resize:vertical;font:11px/1.5 "SF Mono","Fira Mono",monospace;color:#111827;background:#f9fafb;border:1.5px solid #e5e7eb;border-radius:8px;padding:8px;outline:none;-webkit-appearance:none;transition:border-color .15s}',
      '._af_etx:focus{border-color:#2563eb;background:#fff}',
      /* image upload editor */
      '._af_imgprev{width:100%;height:80px;border-radius:10px;background:repeating-conic-gradient(#e5e7eb 0% 25%,#fff 0% 50%) 0 0/12px 12px;margin-bottom:10px;position:relative;overflow:hidden;border:1.5px solid #e5e7eb}',
      '._af_imgprev img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}',
      '._af_imgno{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:12px/1 -apple-system,sans-serif;color:#9ca3af}',
      '._af_imgrow{display:flex;gap:6px;margin-bottom:10px}',
      '._af_upbtn{flex:1;padding:9px 0;border:1.5px dashed #cbd5e1;border-radius:8px;background:#f8fafc;color:#2563eb;font:600 12px/1 -apple-system,sans-serif;cursor:pointer;transition:background .12s,border-color .12s;-webkit-appearance:none;text-align:center}',
      '._af_upbtn:hover{background:#eff6ff;border-color:#93c5fd}',
      '._af_upbtn.loading{color:#9ca3af;border-color:#e5e7eb;pointer-events:none}',
      '._af_rmbg{padding:9px 12px;border:1.5px solid #fee2e2;border-radius:8px;background:#fff;color:#ef4444;font:600 12px/1 -apple-system,sans-serif;cursor:pointer;transition:background .12s;-webkit-appearance:none;flex-shrink:0}',
      '._af_rmbg:hover{background:#fef2f2}',
      '._af_urllbl{font:11px/1 -apple-system,sans-serif;color:#6b7280;margin-bottom:5px}',
      /* remove confirmation */
      '._af_rmconf{padding:12px}',
      '._af_rmp{font:14px/1.5 -apple-system,sans-serif;color:#374151;margin:0 0 12px}',
      '._af_rmyes{width:100%;padding:11px;border:none;border-radius:10px;background:#ef4444;color:#fff;font:600 14px/1 -apple-system,sans-serif;cursor:pointer;-webkit-appearance:none;transition:opacity .15s}',
      '._af_rmyes:active{opacity:.8}',
      '._af_rmno{width:100%;padding:10px;border:1.5px solid #e5e7eb;border-radius:10px;background:#fff;color:#6b7280;font:14px/1 -apple-system,sans-serif;cursor:pointer;margin-top:8px;-webkit-appearance:none;transition:background .12s}',
      '._af_rmno:hover{background:#f9fafb}',
      /* bug modal */
      '#_af_bm{position:fixed;inset:0;z-index:2147483647;background:#09090b;display:flex;flex-direction:column;padding:0 16px max(env(safe-area-inset-bottom,0px),20px);transform:translateY(101%);transition:transform .32s cubic-bezier(.32,.72,0,1)}',
      '#_af_bm.on{transform:translateY(0)}',
      '._af_bh{display:flex;align-items:center;gap:12px;border-bottom:1px solid #18181b;flex-shrink:0;padding:max(env(safe-area-inset-top,0px),16px) 0 14px}',
      '._af_bk{background:#18181b;border:none;color:#a1a1aa;font:14px/1 -apple-system,sans-serif;padding:8px 14px;border-radius:10px;cursor:pointer;flex-shrink:0;-webkit-appearance:none}',
      '._af_btt{font:700 17px/1 -apple-system,sans-serif;color:#fff;flex:1}',
      '._af_bta{width:100%;box-sizing:border-box;background:#18181b;border:1px solid #27272a;border-radius:14px;color:#e4e4e7;font:15px/1.6 -apple-system,sans-serif;padding:14px;margin:14px 0 10px;resize:none;height:110px;outline:none;transition:border-color .15s;-webkit-appearance:none;display:block;flex-shrink:0}',
      '._af_bta:focus{border-color:#3b82f6}',
      '._af_blog{background:#0f0f12;border:1px solid #18181b;border-radius:12px;padding:12px 14px;font:11px/1.7 "SF Mono","Fira Mono",monospace;color:#52525b;flex:1;overflow-y:auto;margin-bottom:14px;white-space:pre-wrap;word-break:break-all;-webkit-overflow-scrolling:touch}',
      '._af_bsnd{width:100%;padding:16px;border:none;border-radius:14px;background:linear-gradient(135deg,#dc2626,#b91c1c);color:#fff;font:600 16px/1 -apple-system,sans-serif;cursor:pointer;flex-shrink:0;box-shadow:0 4px 20px rgba(220,38,38,.3);-webkit-appearance:none;transition:opacity .15s,transform .1s}',
      '._af_bsnd:active{opacity:.85;transform:scale(.98)}',
      '#_af_tk{position:fixed;bottom:80px;left:50%;transform:translateX(-50%) translateY(14px);background:#1f2937;color:#f9fafb;border-radius:14px;padding:10px 18px;font:14px/1 -apple-system,sans-serif;z-index:2147483646;opacity:0;pointer-events:none;transition:opacity .25s,transform .25s;white-space:nowrap;border:1px solid #374151;box-shadow:0 8px 32px rgba(0,0,0,.4)}',
      '#_af_tk.on{opacity:1;transform:translateX(-50%) translateY(0)}',
    ].join('');
    document.head.appendChild(s);
  })();

  /* ── 5. Helpers ──────────────────────────────────────────────────────────── */
  function mk(tag, id) { var e = document.createElement(tag); if (id) e.id = id; return e; }
  function eH(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function eA(s) { return String(s || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function haptic(t) { var tg = window.Telegram && window.Telegram.WebApp; tg && tg.HapticFeedback && tg.HapticFeedback.impactOccurred(t || 'light'); }
  var BACK_SVG = '<svg width="8" height="13" viewBox="0 0 8 13" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M7 1.5L2 6.5L7 11.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /* ── 6. DOM nodes ────────────────────────────────────────────────────────── */
  var hi = mk('div', '_af_hi');
  var pn = mk('div', '_af_pn');
  var bm = mk('div', '_af_bm');
  var tk = mk('div', '_af_tk');

  /* ── 7. State ────────────────────────────────────────────────────────────── */
  var MODE = 'idle'; /* idle | picking | editing | bug */
  var selEl = null, diff = {};

  /* ── 8. Telegram buttons ─────────────────────────────────────────────────── */
  var _tg = window.Telegram && window.Telegram.WebApp;
  var MB = _tg && _tg.MainButton, SB = _tg && _tg.SecondaryButton;

  function bDef() {
    if (MB) MB.setParams({ text: t('openEditor'), color: '#2563eb', text_color: '#ffffff', is_active: true, is_visible: true });
    if (SB) SB.setParams({ text: t('reportBug'), color: '#000000', text_color: '#888888', is_active: true, is_visible: true });
  }
  function bEd() {
    if (MB) MB.setParams({ text: t('applyChanges'), color: '#15803d', text_color: '#ffffff', is_active: true, is_visible: true });
    if (SB) SB.setParams({ text: t('exitEditor'), color: '#000000', text_color: '#888888', is_active: true, is_visible: true });
  }

  /* ── 9. Selector helpers ─────────────────────────────────────────────────── */
  function getSel(el) {
    if (!el || el === document.body) return 'body';
    if (el.id && el.id.indexOf('_af_') === -1) return '#' + el.id;
    var cls = Array.from(el.classList).filter(function (c) { return c.indexOf('_af_') === -1; });
    if (cls.length) {
      var s = el.tagName.toLowerCase() + '.' + cls.slice(0, 2).join('.');
      try { if (document.querySelectorAll(s).length === 1) return s; } catch (x) { }
    }
    return nthPath(el).slice(-80);
  }
  function nthPath(el) {
    if (!el || el === document.documentElement) return '';
    var p = el.parentElement; if (!p) return el.tagName.toLowerCase();
    var sibs = Array.from(p.children).filter(function (c) { return c.tagName === el.tagName; });
    var i = sibs.indexOf(el) + 1;
    var self = el.tagName.toLowerCase() + (sibs.length > 1 ? ':nth-of-type(' + i + ')' : '');
    return nthPath(p) ? nthPath(p) + ' > ' + self : self;
  }
  function getName(el) {
    var txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 22);
    var cls = Array.from(el.classList).filter(function (c) { return c.indexOf('_af_') === -1; }).slice(0, 1)[0] || '';
    if (txt) return (cls ? '.' + cls + ' ' : '') + '"' + txt + '"';
    if (el.id && el.id.indexOf('_af_') === -1) return '#' + el.id;
    return cls ? '.' + cls : el.tagName.toLowerCase();
  }

  /* ── 10. Highlight ───────────────────────────────────────────────────────── */
  function hiEl(el) {
    if (!el) { hi.style.display = 'none'; return; }
    var r = el.getBoundingClientRect();
    hi.style.cssText = 'display:block;top:' + r.top + 'px;left:' + r.left + 'px;width:' + r.width + 'px;height:' + r.height + 'px';
  }

  /* ── 11. Smart panel placement ───────────────────────────────────────────── */
  function placePanel(el) {
    var r = el.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;
    var pw = pn.offsetWidth || 216, ph = pn.offsetHeight || 200, gap = 10;
    var spR = vw - r.right - gap, spL = r.left - gap, spB = vh - r.bottom - gap, spT = r.top - gap;
    var x, y;
    if (spR >= pw) { x = r.right + gap; y = Math.max(6, Math.min(r.top, vh - ph - 6)); }
    else if (spL >= pw) { x = r.left - pw - gap; y = Math.max(6, Math.min(r.top, vh - ph - 6)); }
    else if (spB >= ph) { x = Math.max(6, Math.min(r.left + (r.width - pw) / 2, vw - pw - 6)); y = r.bottom + gap; }
    else if (spT >= ph) { x = Math.max(6, Math.min(r.left + (r.width - pw) / 2, vw - pw - 6)); y = r.top - ph - gap; }
    else {
      var best = Math.max(spR, spL, spB, spT);
      if (best === spR) { x = r.right + gap; y = Math.max(6, Math.min(r.top, vh - ph - 6)); }
      else if (best === spL) { x = r.left - pw - gap; y = Math.max(6, Math.min(r.top, vh - ph - 6)); }
      else if (best === spB) { x = Math.max(6, Math.min(r.left + (r.width - pw) / 2, vw - pw - 6)); y = r.bottom + gap; }
      else { x = Math.max(6, Math.min(r.left + (r.width - pw) / 2, vw - pw - 6)); y = r.top - ph - gap; }
      x = Math.max(6, Math.min(x, vw - pw - 6)); y = Math.max(6, Math.min(y, vh - ph - 6));
    }
    pn.style.left = x + 'px'; pn.style.top = y + 'px';
  }

  /* ── 12. Live style setter — uses !important to beat CSS cascade ─────────── */
  function toCssProp(k) { return k.replace(/([A-Z])/g, function (m) { return '-' + m.toLowerCase(); }); }
  function setLive(el, prop, val) { el.style.setProperty(toCssProp(prop), val, 'important'); }

  /* ── 12b. Color utilities ────────────────────────────────────────────────── */
  function rgba2parts(v) {
    if (!v || v === 'transparent' || v === 'rgba(0, 0, 0, 0)') return { r: 0, g: 0, b: 0, a: 0 };
    var m = v.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?\s*\)/);
    if (!m) return { r: 0, g: 0, b: 0, a: 1 };
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] !== undefined ? +m[4] : 1 };
  }
  function parts2hex(p) {
    return '#' + [p.r, p.g, p.b].map(function (x) { return ('0' + Math.round(x).toString(16)).slice(-2); }).join('');
  }
  function parts2css(p) {
    if (p.a <= 0) return 'transparent';
    if (p.a >= 1) return parts2hex(p);
    return 'rgba(' + Math.round(p.r) + ',' + Math.round(p.g) + ',' + Math.round(p.b) + ',' + p.a.toFixed(2) + ')';
  }
  function ppx(v) { return parseFloat(v) || 0; }
  function updSl(sl) {
    var mn = +sl.min, mx = +sl.max, v = +sl.value;
    sl.style.setProperty('--v', Math.max(0, Math.min(100, Math.round((v - mn) / (mx - mn) * 100))) + '%');
  }

  /* ── 13. Diff tracker ────────────────────────────────────────────────────── */
  function rec(sel, prop, oldV, newV) {
    if (!diff[sel]) diff[sel] = {};
    if (!diff[sel][prop]) diff[sel][prop] = { old: oldV };
    diff[sel][prop].cur = newV;
  }

  /* ── 14. Props sections ──────────────────────────────────────────────────── */
  var SECTIONS = [
    { label: 'Background Image', props: [
      { k: 'backgroundImage',    l: 'Image',    t: 'img', ic: 'bg', bg: '#0284c7' },
      { k: 'backgroundSize',     l: 'Size',     t: 'sel', opts: ['cover','contain','auto','100% 100%'], ic: 'Sz', bg: '#0284c7' },
      { k: 'backgroundPosition', l: 'Position', t: 'sel', opts: ['center','top','bottom','left','right','top center','bottom center'], ic: 'Ps', bg: '#0284c7' },
      { k: 'backgroundRepeat',   l: 'Repeat',   t: 'sel', opts: ['no-repeat','repeat','repeat-x','repeat-y'], ic: 'Rp', bg: '#0284c7' },
    ]},
    { label: 'Colors', props: [
      { k: 'backgroundColor', l: 'Background',   t: 'col', ic: '■', bg: '#f97316' },
      { k: 'color',           l: 'Text color',   t: 'col', ic: 'A', bg: '#8b5cf6' },
      { k: 'borderColor',     l: 'Border color', t: 'col', ic: '□', bg: '#ec4899' },
    ]},
    { label: 'Typography', props: [
      { k: 'fontSize',      l: 'Font size',   t: 'px',  mn: 8,  mx: 96, ic: 'Aa', bg: '#3b82f6' },
      { k: 'fontWeight',    l: 'Weight',      t: 'sel', opts: ['100','200','300','400','500','600','700','800','900'], ic: 'B', bg: '#6366f1' },
      { k: 'textAlign',     l: 'Align',       t: 'sel', opts: ['left','center','right','justify'], ic: '=', bg: '#6366f1' },
      { k: 'letterSpacing', l: 'Ltr spacing', t: 'px',  mn: -3, mx: 12, ic: 'LS', bg: '#6b7280' },
      { k: 'lineHeight',    l: 'Line height', t: 'px',  mn: 10, mx: 80, ic: 'LH', bg: '#6b7280' },
    ]},
    { label: 'Size', props: [
      { k: 'width',    l: 'Width',     t: 'text', ic: 'W', bg: '#059669' },
      { k: 'height',   l: 'Height',   t: 'text', ic: 'H', bg: '#059669' },
      { k: 'minWidth', l: 'Min width', t: 'text', ic: 'mW', bg: '#047857' },
      { k: 'maxWidth', l: 'Max width', t: 'text', ic: 'MW', bg: '#047857' },
    ]},
    { label: 'Border', props: [
      { k: 'borderRadius', l: 'Radius',       t: 'px', mn: 0, mx: 80, ic: 'R', bg: '#10b981' },
      { k: 'borderWidth',  l: 'Border width', t: 'px', mn: 0, mx: 20, ic: 'bW', bg: '#10b981' },
    ]},
    { label: 'Padding', props: [
      { k: 'paddingTop',    l: 'Top',    t: 'px', mn: 0, mx: 80, ic: 'pT', bg: '#0ea5e9' },
      { k: 'paddingBottom', l: 'Bottom', t: 'px', mn: 0, mx: 80, ic: 'pB', bg: '#0ea5e9' },
      { k: 'paddingLeft',   l: 'Left',   t: 'px', mn: 0, mx: 80, ic: 'pL', bg: '#0ea5e9' },
      { k: 'paddingRight',  l: 'Right',  t: 'px', mn: 0, mx: 80, ic: 'pR', bg: '#0ea5e9' },
    ]},
    { label: 'Margin', props: [
      { k: 'marginTop',    l: 'Top',    t: 'px', mn: -80, mx: 80, ic: 'mT', bg: '#7c3aed' },
      { k: 'marginBottom', l: 'Bottom', t: 'px', mn: -80, mx: 80, ic: 'mB', bg: '#7c3aed' },
      { k: 'marginLeft',   l: 'Left',   t: 'px', mn: -80, mx: 80, ic: 'mL', bg: '#7c3aed' },
      { k: 'marginRight',  l: 'Right',  t: 'px', mn: -80, mx: 80, ic: 'mR', bg: '#7c3aed' },
    ]},
    { label: 'Layout', props: [
      { k: 'gap',            l: 'Gap',         t: 'px', mn: 0, mx: 80, ic: 'G',  bg: '#14b8a6' },
      { k: 'flexDirection',  l: 'Flex dir',    t: 'sel', opts: ['row','column','row-reverse','column-reverse'], ic: 'Fd', bg: '#0891b2' },
      { k: 'alignItems',     l: 'Align items', t: 'sel', opts: ['flex-start','center','flex-end','stretch','baseline'], ic: 'Ai', bg: '#0891b2' },
      { k: 'justifyContent', l: 'Justify',     t: 'sel', opts: ['flex-start','center','flex-end','space-between','space-around','space-evenly'], ic: 'Jc', bg: '#0891b2' },
      { k: 'overflow',       l: 'Overflow',    t: 'sel', opts: ['visible','hidden','auto','scroll'], ic: 'Ov', bg: '#64748b' },
    ]},
    { label: 'Effects', props: [
      { k: 'opacity', l: 'Opacity', t: 'pct', ic: 'Op', bg: '#f59e0b' },
    ]},
  ];

  var PROPS_MAP = {};
  SECTIONS.forEach(function (sec) { sec.props.forEach(function (p) { PROPS_MAP[p.k] = p; }); });

  /* ── 15. Render property list ────────────────────────────────────────────── */
  function renderList(el) {
    var cs = getComputedStyle(el);

    var html = '<div class="_af_ph">'
      + '<span class="_af_bc">' + eH(getName(el)) + '</span>'
      + '<button class="_af_px">&#x2715;</button>'
      + '</div><div class="_af_scr">';

    // Content (innerHTML)
    var preview = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 20);
    html += '<div class="_af_sep">' + t('content') + '</div>'
      + '<div class="_af_prow" data-k="__innerHTML__">'
      + '<span class="_af_ico" style="background:#f43f5e">T</span>'
      + '<span class="_af_plbl">innerHTML</span>'
      + '<span class="_af_cv">' + eH(preview || '—') + '</span>'
      + '<span class="_af_arr">&#x203a;</span></div>';

    SECTIONS.forEach(function (sec) {
      html += '<div class="_af_sep">' + sec.label + '</div>';
      sec.props.forEach(function (p) {
        var raw = cs[p.k] || el.style[p.k] || '';
        var val = '';
        if (p.t === 'img') {
          var imgUrl = (raw || '').replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
          if (imgUrl && imgUrl !== 'none') {
            val = '<span class="_af_chk" style="width:24px;height:14px"><span class="_af_swc" style="background:url(\'' + imgUrl.replace(/'/g, '') + '\') center/cover no-repeat"></span></span>';
          } else {
            val = '<span class="_af_cv">none</span>';
          }
        } else if (p.t === 'col') {
          // Show checkered swatch with actual color (supports transparency)
          val = '<span class="_af_chk"><span class="_af_swc" style="background:' + (raw || 'transparent') + '"></span></span>';
        } else if (p.t === 'pct') {
          val = '<span class="_af_cv">' + Math.round((parseFloat(raw) || 1) * 100) + '%</span>';
        } else if (p.t === 'text') {
          val = '<span class="_af_cv">' + eH((raw || 'auto').slice(0, 8)) + '</span>';
        } else {
          val = '<span class="_af_cv">' + (ppx(raw) || 0) + 'px</span>';
        }
        html += '<div class="_af_prow" data-k="' + eA(p.k) + '">'
          + '<span class="_af_ico" style="background:' + p.bg + '">' + p.ic + '</span>'
          + '<span class="_af_plbl">' + p.l + '</span>' + val
          + '<span class="_af_arr">&#x203a;</span></div>';
      });
    });

    // Danger zone
    html += '<div class="_af_sep">' + t('danger') + '</div>'
      + '<div class="_af_prow" data-k="__remove__" style="color:#ef4444">'
      + '<span class="_af_ico" style="background:#ef4444">&#x2715;</span>'
      + '<span class="_af_plbl" style="color:#ef4444">' + t('removeEl') + '</span>'
      + '<span class="_af_arr" style="color:#fca5a5">&#x203a;</span></div>';

    html += '</div>';
    pn.innerHTML = html;
    pn.querySelector('._af_px').onclick = closePanel;
    pn.querySelectorAll('._af_prow').forEach(function (row) {
      row.onclick = function (e) { e.stopPropagation(); openEditor(el, row.dataset.k); haptic(); };
    });
  }

  /* ── 16. Focused property editor ─────────────────────────────────────────── */
  function openEditor(el, propKey) {
    var cs = getComputedStyle(el);
    var sel = getSel(el), sa = eA(sel);
    var control = '', label = propKey, iconBg = '#6b7280', iconTxt = '?';

    if (propKey === '__remove__') {
      pn.innerHTML = '<div class="_af_ph">'
        + '<button class="_af_ebk">' + BACK_SVG + '</button>'
        + '<span class="_af_bc">' + t('removeEl') + '</span>'
        + '<button class="_af_px">&#x2715;</button></div>'
        + '<div class="_af_rmconf">'
        + '<p class="_af_rmp">' + t('removeConfirm') + '</p>'
        + '<button class="_af_rmyes" id="_af_rmyes">' + t('removeYes') + '</button>'
        + '<button class="_af_rmno" id="_af_rmno">' + t('cancel') + '</button>'
        + '</div>';
      pn.onclick = function (e) { e.stopPropagation(); };
      pn.querySelector('._af_ebk').onclick = function () { renderList(el); requestAnimationFrame(function () { placePanel(el); }); };
      pn.querySelector('._af_px').onclick = closePanel;
      document.getElementById('_af_rmyes').onclick = function () {
        rec(getSel(el), '__removed__', 'visible', 'removed');
        el.remove(); closePanel(); haptic('heavy');
      };
      document.getElementById('_af_rmno').onclick = function () { renderList(el); requestAnimationFrame(function () { placePanel(el); }); };
      requestAnimationFrame(function () { placePanel(el); });
      return;
    }

    if (propKey === '__innerHTML__') {
      label = 'innerHTML'; iconBg = '#f43f5e'; iconTxt = 'T';
      control = '<textarea class="_af_etx" data-p="__innerHTML__" data-s="' + sa + '" data-o="' + eA(el.innerHTML) + '">' + eH(el.innerHTML) + '</textarea>';
    } else {
      var prop = PROPS_MAP[propKey]; if (!prop) return;
      label = prop.l; iconBg = prop.bg; iconTxt = prop.ic;
      var raw = el.style[prop.k] || cs[prop.k] || '';

      if (prop.t === 'col') {
        var parts = rgba2parts(raw);
        var hex = parts2hex(parts);
        var alpha = Math.round(parts.a * 100);
        var cssVal = parts2css(parts);
        control = '<div class="_af_ecol">'
          + '<div class="_af_esw" id="_sw_' + prop.k + '">'
          + '<div class="_af_swl" id="_swl_' + prop.k + '" style="background:' + cssVal + '"></div>'
          + '<input type="color" value="' + hex + '" data-p="' + eA(prop.k) + '" data-s="' + sa + '" data-o="' + eA(cssVal) + '"></div>'
          + '<input class="_af_ehex" value="' + hex + '" data-p="' + eA(prop.k) + '" data-s="' + sa + '" data-o="' + eA(cssVal) + '" maxlength="7">'
          + '</div>'
          + '<div class="_af_orow"><div class="_af_olbl"><span>' + t('opacity') + '</span>'
          + '<button class="_af_tbtn" id="_af_tbtn">' + t('transparent') + '</button></div>'
          + '<div class="_af_eslw"><input class="_af_esl" id="_af_osl" type="range" min="0" max="100" value="' + alpha + '" style="--v:' + alpha + '%" data-p="' + eA(prop.k) + '" data-s="' + sa + '" data-o="' + eA(cssVal) + '"></div>'
          + '<div class="_af_enum"><input class="_af_nu" id="_af_onu" type="number" min="0" max="100" value="' + alpha + '"><span class="_af_unit">%</span></div>'
          + '</div>';
      } else if (prop.t === 'px' || prop.t === 'pct') {
        var isPct = prop.t === 'pct';
        var v = isPct ? Math.round((parseFloat(raw) || 1) * 100) : ppx(raw);
        var mn = isPct ? 0 : (prop.mn || 0), mx = isPct ? 100 : (prop.mx || 100);
        var pct = Math.max(0, Math.min(100, Math.round((v - mn) / (mx - mn) * 100)));
        var oldStr = isPct ? (v / 100).toFixed(2) : v + 'px';
        control = '<div class="_af_eslw"><input class="_af_esl" type="range" min="' + mn + '" max="' + mx + '" value="' + v
          + '" style="--v:' + pct + '%" data-p="' + eA(prop.k) + '" data-s="' + sa + '" data-o="' + eA(oldStr) + '"'
          + (isPct ? ' data-pct="1"' : '') + '></div>'
          + '<div class="_af_enum"><input class="_af_nu" type="number" value="' + v + '" min="' + mn + '" max="' + mx + '">'
          + '<span class="_af_unit">' + (isPct ? '%' : 'px') + '</span></div>';
      } else if (prop.t === 'sel') {
        var cur = raw || '';
        control = '<select class="_af_esel" data-p="' + eA(prop.k) + '" data-s="' + sa + '" data-o="' + eA(raw) + '">'
          + prop.opts.map(function (o) { return '<option value="' + o + '"' + (o === cur ? ' selected' : '') + '>' + o + '</option>'; }).join('') + '</select>';
      } else if (prop.t === 'text') {
        control = '<div class="_af_enum"><input class="_af_etxt" type="text" value="' + eA(raw || '') + '"'
          + ' data-p="' + eA(prop.k) + '" data-s="' + sa + '" data-o="' + eA(raw) + '" placeholder="e.g. 100px, 50%, auto">'
          + '</div>';
      } else if (prop.t === 'img') {
        // Extract current URL from background-image: url("...")
        var curUrl = (raw || '').replace(/^url\(["']?/, '').replace(/["']?\)$/, '');
        var isSet = curUrl && curUrl !== 'none';
        control = '<div class="_af_imgprev" id="_af_imgprev">'
          + (isSet ? '<img src="' + eA(curUrl) + '" id="_af_imgthumb">' : '')
          + (!isSet ? '<span class="_af_imgno">No image</span>' : '')
          + '</div>'
          + '<div class="_af_imgrow">'
          + '<button class="_af_upbtn" id="_af_upbtn">+ Upload image</button>'
          + (isSet ? '<button class="_af_rmbg" id="_af_rmbg">Remove</button>' : '')
          + '</div>'
          + '<div class="_af_urllbl">Or enter URL:</div>'
          + '<input class="_af_etxt" id="_af_urlimg" type="url" placeholder="https://..." value="' + eA(isSet ? curUrl : '') + '">'
          + '<input type="file" id="_af_filinp" accept="image/*" style="display:none">';
      }
    }

    var icHtml = '<span style="width:16px;height:16px;border-radius:4px;background:' + iconBg + ';font:700 8px/16px sans-serif;color:#fff;display:inline-flex;align-items:center;justify-content:center;margin-right:3px;flex-shrink:0">' + iconTxt + '</span>';
    pn.innerHTML = '<div class="_af_ph">'
      + '<button class="_af_ebk">' + BACK_SVG + '</button>'
      + '<span class="_af_bc" style="display:flex;align-items:center">' + icHtml + label + '</span>'
      + '<button class="_af_px">&#x2715;</button></div>'
      + '<div class="_af_ebody">' + control + '</div>';

    pn.onclick = function (e) { e.stopPropagation(); };
    pn.querySelector('._af_ebk').onclick = function () { renderList(el); requestAnimationFrame(function () { placePanel(el); }); };
    pn.querySelector('._af_px').onclick = closePanel;

    /* innerHTML textarea */
    var txInp = pn.querySelector('._af_etx');
    if (txInp) txInp.addEventListener('input', function () { el.innerHTML = txInp.value; rec(txInp.dataset.s, '__innerHTML__', txInp.dataset.o, txInp.value); });

    /* ── color picker with rgba ── */
    var colInp = pn.querySelector('input[type=color]');
    var hexInp = pn.querySelector('._af_ehex');
    var osl    = document.getElementById('_af_osl');
    var onu    = document.getElementById('_af_onu');
    var tbtn   = document.getElementById('_af_tbtn');
    var swl    = document.getElementById('_swl_' + (PROPS_MAP[propKey] ? propKey : ''));

    function applyColor() {
      var curParts = rgba2parts(el.style[propKey] || cs[propKey] || '');
      var alpha = osl ? +osl.value / 100 : 1;
      var h = colInp ? colInp.value : parts2hex(curParts);
      var nr = parseInt(h.slice(1, 3), 16), ng = parseInt(h.slice(3, 5), 16), nb = parseInt(h.slice(5, 7), 16);
      var css = parts2css({ r: nr, g: ng, b: nb, a: alpha });
      if (swl) swl.style.background = css;
      if (hexInp) hexInp.value = h;
      if (osl) { updSl(osl); } if (onu) onu.value = Math.round(alpha * 100);
      if (PROPS_MAP[propKey]) setLive(el, propKey, css);
      rec(colInp ? colInp.dataset.s : sa, propKey, colInp ? colInp.dataset.o : '', css);
    }

    if (colInp) colInp.addEventListener('input', applyColor);
    if (hexInp) hexInp.addEventListener('input', function () {
      if (!/^#[0-9a-fA-F]{6}$/.test(hexInp.value)) return;
      if (colInp) colInp.value = hexInp.value;
      applyColor();
    });
    if (osl) {
      osl.addEventListener('input', function () { if (onu) onu.value = osl.value; applyColor(); });
      if (onu) onu.addEventListener('change', function () { osl.value = onu.value; applyColor(); });
    }
    if (tbtn) tbtn.onclick = function () {
      if (osl) { osl.value = 0; if (onu) onu.value = 0; }
      applyColor();
    };

    /* slider (non-color) */
    var sl = pn.querySelector('._af_esl:not(#_af_osl)'), nu = pn.querySelector('._af_nu:not(#_af_onu)');
    if (sl) {
      function applySlider() {
        updSl(sl); var isP = sl.dataset.pct === '1', rv = parseFloat(sl.value);
        var css = isP ? (rv / 100).toFixed(2) : rv + 'px';
        if (nu) nu.value = rv;
        setLive(el, sl.dataset.p, css);
        // borderWidth needs border-style to be visible
        if (sl.dataset.p === 'borderWidth' && rv > 0) {
          var curStyle = el.style.borderStyle || cs.borderStyle;
          if (!curStyle || curStyle === 'none') {
            setLive(el, 'borderStyle', 'solid');
            rec(sl.dataset.s, 'borderStyle', curStyle || 'none', 'solid');
          }
        }
        rec(sl.dataset.s, sl.dataset.p, sl.dataset.o, css);
      }
      sl.addEventListener('input', applySlider);
      if (nu) nu.addEventListener('change', function () { sl.value = nu.value; applySlider(); });
    }

    /* select */
    var selInp = pn.querySelector('._af_esel');
    if (selInp) selInp.addEventListener('change', function () { setLive(el, selInp.dataset.p, selInp.value); rec(selInp.dataset.s, selInp.dataset.p, selInp.dataset.o, selInp.value); haptic(); });

    /* free text (width/height/etc.) */
    var txtInp = pn.querySelector('._af_etxt:not(#_af_urlimg)');
    if (txtInp) txtInp.addEventListener('change', function () { setLive(el, txtInp.dataset.p, txtInp.value); rec(txtInp.dataset.s, txtInp.dataset.p, txtInp.dataset.o, txtInp.value); });

    /* ── image upload ── */
    var upBtn   = document.getElementById('_af_upbtn');
    var filInp  = document.getElementById('_af_filinp');
    var urlInp  = document.getElementById('_af_urlimg');
    var rmbg    = document.getElementById('_af_rmbg');
    var imgPrev = document.getElementById('_af_imgprev');

    function applyBgUrl(url) {
      var fullUrl = url.startsWith('/') ? location.origin + url : url;
      var cssVal = 'url("' + fullUrl + '")';
      setLive(el, 'backgroundImage', cssVal);
      rec(sa, 'backgroundImage', raw, cssVal);
      // Set defaults for size/position/repeat if not already customised
      var curSize = el.style.backgroundSize || cs.backgroundSize;
      if (!el.style.backgroundSize || curSize === 'auto') {
        setLive(el, 'backgroundSize', 'cover');
        rec(sa, 'backgroundSize', curSize, 'cover');
      }
      var curPos = el.style.backgroundPosition || cs.backgroundPosition;
      if (!el.style.backgroundPosition) {
        setLive(el, 'backgroundPosition', 'center');
        rec(sa, 'backgroundPosition', curPos, 'center');
      }
      var curRep = el.style.backgroundRepeat || cs.backgroundRepeat;
      if (!el.style.backgroundRepeat) {
        setLive(el, 'backgroundRepeat', 'no-repeat');
        rec(sa, 'backgroundRepeat', curRep, 'no-repeat');
      }
      // update preview
      if (imgPrev) {
        imgPrev.innerHTML = '<img src="' + eA(fullUrl) + '">';
        if (!document.getElementById('_af_rmbg') && imgPrev.parentNode) {
          var rmb = document.createElement('button');
          rmb.className = '_af_rmbg'; rmb.id = '_af_rmbg'; rmb.textContent = 'Remove';
          rmb.onclick = removeBg;
          var row = imgPrev.nextElementSibling;
          if (row) row.appendChild(rmb);
        }
      }
    }

    function removeBg() {
      setLive(el, 'backgroundImage', 'none');
      rec(sa, 'backgroundImage', raw, 'none');
      if (imgPrev) imgPrev.innerHTML = '<span class="_af_imgno">No image</span>';
      if (urlInp) urlInp.value = '';
      var rb = document.getElementById('_af_rmbg'); if (rb) rb.remove();
    }

    if (upBtn && filInp) {
      upBtn.onclick = function () { filInp.click(); };
      filInp.onchange = function () {
        var file = filInp.files && filInp.files[0];
        if (!file) return;
        if (file.size > 12 * 1024 * 1024) { toast('Image too large (max 12 MB)', false); return; }
        upBtn.textContent = 'Uploading...'; upBtn.classList.add('loading');
        var reader = new FileReader();
        reader.onload = function (ev) {
          fetch('/bucket/upload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: ev.target.result, name: file.name })
          })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            upBtn.textContent = '+ Upload image'; upBtn.classList.remove('loading');
            if (j.url) { if (urlInp) urlInp.value = location.origin + j.url; applyBgUrl(j.url); haptic('medium'); }
            else { toast(j.error || 'Upload failed', false); }
          })
          .catch(function () { upBtn.textContent = '+ Upload image'; upBtn.classList.remove('loading'); toast('Upload failed', false); });
        };
        reader.readAsDataURL(file);
      };
    }

    if (urlInp) {
      urlInp.addEventListener('change', function () {
        var v = urlInp.value.trim();
        if (v) applyBgUrl(v); else removeBg();
      });
    }

    if (rmbg) rmbg.onclick = removeBg;

    requestAnimationFrame(function () { placePanel(el); });
  }

  /* ── 17. Open / close panel ──────────────────────────────────────────────── */
  function openPanel(el) {
    selEl = el; MODE = 'editing';
    renderList(el);
    pn.onclick = function (e) { e.stopPropagation(); };
    hiEl(el);
    pn.classList.add('on');
    requestAnimationFrame(function () { placePanel(el); });
  }

  function closePanel() {
    pn.classList.remove('on'); selEl = null; hi.style.display = 'none'; MODE = 'picking';
  }

  /* ── 18. Click capture ───────────────────────────────────────────────────── */
  var AF_IDS = ['_af_hi', '_af_pn', '_af_bm', '_af_tk'];
  function isAF(el) { return AF_IDS.some(function (id) { return el.closest && el.closest('#' + id); }); }

  function realElAt(x, y) {
    pn.style.pointerEvents = 'none';
    var el = document.elementFromPoint(x, y);
    pn.style.pointerEvents = '';
    return (el && !isAF(el)) ? el : null;
  }

  function onDocClick(e) {
    if (MODE !== 'picking' && MODE !== 'editing') return;
    if (isAF(e.target)) return;
    e.stopPropagation(); e.preventDefault();
    haptic('medium');
    openPanel(e.target);
  }

  function onDocHover(e) {
    // Only track hover when in "picking" mode (no element locked)
    if (MODE !== 'picking' || e.pointerType !== 'mouse') return;
    var el = realElAt(e.clientX, e.clientY);
    if (el) hiEl(el);
  }

  function enterEditor() {
    MODE = 'picking'; diff = {}; closePanel();
    bEd(); haptic();
    document.addEventListener('click', onDocClick, { capture: true });
    document.addEventListener('pointermove', onDocHover);
  }

  function exitEditor() {
    document.removeEventListener('click', onDocClick, { capture: true });
    document.removeEventListener('pointermove', onDocHover);
    hi.style.display = 'none'; pn.classList.remove('on');
    selEl = null; MODE = 'idle'; bDef(); haptic();
  }

  /* ── 19. Prompt builder ──────────────────────────────────────────────────── */
  function mkPrompt() {
    var blocks = [], removals = [], has = false;
    Object.keys(diff).forEach(function (sel) {
      var props = diff[sel], lines = [];
      Object.keys(props).forEach(function (p) {
        var ch = props[p]; if (!ch.cur || ch.old === ch.cur) return;
        if (p === '__removed__') { removals.push(sel); return; }
        if (p === '__innerHTML__') lines.push('  innerHTML: "' + ch.cur.replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 300) + '"');
        else lines.push('  ' + p + ': ' + ch.cur + ';');
      });
      if (lines.length) { has = true; blocks.push(sel + ' {\n' + lines.join('\n') + '\n}'); }
    });
    if (!has && !removals.length) return null;
    var out = 'Edit element styles and content:\n';
    if (blocks.length) out += '\n' + blocks.join('\n\n');
    if (removals.length) out += '\n\nRemove elements:\n' + removals.join('\n');
    return out;
  }

  /* ── 20. POST / toast ────────────────────────────────────────────────────── */
  function doPost(msg, type, cb) {
    fetch('/telegram-mini-app/api/error-report/' + PID, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, stack: '', url: location.href, type: type || 'error' })
    }).then(function () { if (cb) cb(true); }).catch(function () { if (cb) cb(false); });
  }
  function toast(msg, ok) {
    tk.textContent = msg; tk.style.borderColor = ok ? '#16a34a' : '#ef4444';
    tk.classList.add('on'); setTimeout(function () { tk.classList.remove('on'); }, 3000);
  }

  /* ── 21. Button handlers ─────────────────────────────────────────────────── */
  function closePlayer(delay) {
    setTimeout(function () {
      var tg = window.Telegram && window.Telegram.WebApp;
      if (tg && tg.close) { tg.close(); }
    }, delay || 1400);
  }

  function onMB() {
    if (MODE === 'idle') { enterEditor(); return; }
    var p = mkPrompt();
    if (!p) { exitEditor(); return; }
    if (MB) MB.setParams({ text: t('sending'), color: '#92400e', text_color: '#fbbf24', is_visible: true });
    doPost('[Restyle App]\n\n' + p, 'design', function (ok) {
      exitEditor();
      toast(ok ? t('sent') : t('sendFail'), ok);
      if (ok) closePlayer(1400);
    });
  }
  function onSB() {
    if (MODE === 'idle') { openBug(); return; }
    if (MODE === 'picking' || MODE === 'editing') { exitEditor(); return; }
    if (MODE === 'bug') { closeBug(); return; }
  }

  /* ── 22. Bug modal ───────────────────────────────────────────────────────── */
  function openBug() {
    MODE = 'bug';
    // Use the full ring buffers — entries already carry stack traces. The
    // server clamps total payload size; here we want the agent to see
    // everything we captured, not a 12-row preview.
    var log = EL.map(function (e) { return '[error] ' + e.m; })
      .concat(RL.map(function (e) { return '[http]  ' + e.m; })).join('\n\n') || t('noLogs');
    bm.innerHTML = '<div class="_af_bh"><button class="_af_bk" id="_af_bk">&#x2190; Back</button><span class="_af_btt">' + t('bugTitle') + '</span></div>'
      + '<textarea class="_af_bta" id="_af_bta" placeholder="' + eA(t('bugHint')) + '"></textarea>'
      + '<div class="_af_blog">' + eH(log) + '</div>'
      + '<button class="_af_bsnd" id="_af_bsnd">' + t('bugSend') + '</button>';
    bm.classList.add('on');
    if (MB) MB.hide(); if (SB) SB.hide();
    document.getElementById('_af_bk').onclick = closeBug;
    document.getElementById('_af_bsnd').onclick = function () {
      var desc = (document.getElementById('_af_bta').value || '').trim();
      var btn = document.getElementById('_af_bsnd'); btn.textContent = t('sending'); btn.disabled = true;
      doPost('[Bug Report]\n\nBug report from dev preview:\n' + (desc ? '\nUser note:\n' + desc + '\n' : '')
        + '\nCaptured log:\n' + log + '\n\nPlease investigate and fix this issue.', 'error',
        function (ok) { closeBug(); toast(ok ? t('bugSent') : t('sendFail'), ok); if (ok) closePlayer(1400); });
    };
  }
  function closeBug() { bm.classList.remove('on'); MODE = 'idle'; if (MB) MB.show(); if (SB) SB.show(); }

  /* ── 23. Init ────────────────────────────────────────────────────────────── */
  function init() {
    [hi, pn, bm, tk].forEach(function (n) { document.body.appendChild(n); });
    if (MB) MB.onClick(onMB);
    if (SB) SB.onClick(onSB);
    bDef();
  }

  if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }
})();
