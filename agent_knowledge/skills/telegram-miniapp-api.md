# Telegram Mini App API — Quick Reference

Load: `<script src="https://telegram.org/js/telegram-web-app.js"></script>`
Global: `window.Telegram.WebApp` (alias as `const tg = Telegram.WebApp`)

---

## Initialization (call on every page load)

```js
tg.ready();                          // signal UI is ready (hides loading)
tg.expand();                         // expand to full height
tg.disableVerticalSwipes();          // prevent swipe-to-close on scroll
if (['android','ios'].includes(tg.platform)) tg.requestFullscreen?.();
tg.setHeaderColor('#000000');
tg.setBackgroundColor('#000000');
tg.setBottomBarColor('#000000');
```

---

## Key Properties

| Property | Type | Description |
|----------|------|-------------|
| `initData` | string | Raw query string — send to server for validation |
| `initDataUnsafe` | object | Parsed `{ user, start_param, auth_date, hash, … }` — do NOT trust on server |
| `initDataUnsafe.user` | object | `{ id, first_name, last_name, username, language_code, is_premium }` |
| `initDataUnsafe.start_param` | string | Value after `?startapp=` deep link parameter |
| `platform` | string | `'android'`, `'ios'`, `'tdesktop'`, `'weba'`, `'unknown'` |
| `colorScheme` | string | `'light'` or `'dark'` |
| `themeParams` | object | See ThemeParams below |
| `viewportHeight` | number | Current visible height (px) |
| `viewportStableHeight` | number | Stable height excluding keyboard |
| `isExpanded` | boolean | Whether app is expanded to full height |
| `isFullscreen` | boolean | Whether fullscreen is active |
| `version` | string | Bot API version |

---

## ThemeParams (CSS variables available as `var(--tg-theme-*)`)

```
bg_color, text_color, hint_color, link_color, button_color, button_text_color,
secondary_bg_color, header_bg_color, bottom_bar_bg_color, accent_text_color,
section_bg_color, section_header_text_color, subtitle_text_color, destructive_text_color
```

Use in CSS: `color: var(--tg-theme-text-color)`, `background: var(--tg-theme-bg-color)`

---

## Methods

```js
tg.close()                               // close the mini app
tg.expand()                              // expand to max height
tg.requestFullscreen()                   // enter fullscreen (mobile only)
tg.exitFullscreen()                      // exit fullscreen
tg.enableClosingConfirmation()           // ask before close
tg.disableClosingConfirmation()
tg.enableVerticalSwipes()
tg.disableVerticalSwipes()
tg.lockOrientation()
tg.unlockOrientation()

tg.openLink(url, { try_instant_view: false })   // open external URL in browser
tg.openTelegramLink(url)                         // open telegram.me/... or t.me/... link
tg.openInvoice(url, callback)                    // open payment invoice

tg.showAlert(message, callback)          // async alert dialog
tg.showConfirm(message, callback)        // async confirm dialog → callback(bool)
tg.showPopup({ title, message, buttons }, callback)  // custom popup

tg.sendData(data)                        // send string to bot (closes app); max 4096 bytes
tg.switchInlineQuery(query, chat_types)  // switch to inline mode

tg.isVersionAtLeast('6.1')               // feature gating before calling new APIs

tg.readTextFromClipboard(callback)       // callback(text|null)
tg.requestWriteAccess(callback)          // callback(bool)
tg.requestContact(callback)             // callback(bool)
tg.addToHomeScreen()
tg.downloadFile({ url, file_name }, callback)
```

---

## MainButton / SecondaryButton (BottomButton)

```js
const btn = tg.MainButton;   // or tg.SecondaryButton

btn.setParams({
  text: 'Submit',
  color: '#2563eb',          // background colour
  text_color: '#ffffff',
  is_visible: true,
  is_active: true,
  has_shine_effect: false,
});

btn.show();  btn.hide();
btn.enable(); btn.disable();
btn.showProgress(false);     // show spinner (false = disable button too)
btn.hideProgress();

btn.onClick(handler);        // attach click handler
btn.offClick(handler);       // detach

// SecondaryButton position: 'left'|'right'|'top'|'bottom' (relative to MainButton)
tg.SecondaryButton.setParams({ position: 'left' });
```

---

## BackButton

```js
tg.BackButton.show();
tg.BackButton.hide();
tg.BackButton.onClick(handler);
tg.BackButton.offClick(handler);
tg.BackButton.isVisible;   // bool
```

---

## HapticFeedback

```js
tg.HapticFeedback.impactOccurred('light');    // 'light'|'medium'|'heavy'|'rigid'|'soft'
tg.HapticFeedback.notificationOccurred('success'); // 'success'|'error'|'warning'
tg.HapticFeedback.selectionChanged();
```

---

## CloudStorage (server-less per-user key-value, 1024 keys, 4096 chars/value)

```js
tg.CloudStorage.setItem(key, value, callback)         // callback(err, bool)
tg.CloudStorage.getItem(key, callback)                // callback(err, value|null)
tg.CloudStorage.getItems([key1, key2], callback)      // callback(err, {key:value})
tg.CloudStorage.removeItem(key, callback)
tg.CloudStorage.removeItems([key1, key2], callback)
tg.CloudStorage.getKeys(callback)                     // callback(err, [keys])

// Keys: A-Za-z0-9_- only, 1–128 chars. Use with localStorage fallback:
function storageGet(key, cb) {
  tg.CloudStorage.getItem(key, (err, val) => {
    cb(!err && val != null ? val : localStorage.getItem(key));
  });
}
```

---

## Events

```js
tg.onEvent('eventType', handler);
tg.offEvent('eventType', handler);
```

| Event | Fires when |
|-------|-----------|
| `themeChanged` | Telegram theme changes |
| `viewportChanged` | `{ isStateStable }` — viewport resize / keyboard |
| `mainButtonClicked` | Main button tapped |
| `secondaryButtonClicked` | Secondary button tapped |
| `backButtonClicked` | Back button tapped |
| `settingsButtonClicked` | Settings gear tapped |
| `activated` / `deactivated` | App gains/loses focus |
| `fullscreenChanged` | Fullscreen state changes |
| `safeAreaChanged` | Safe area insets change |

---

## Safe Area (for padding)

```css
/* Use in CSS for proper inset handling */
padding-top: max(12px, calc(
  var(--tg-content-safe-area-inset-top, 0px) +
  var(--tg-safe-area-inset-top, 0px)
));
padding-bottom: max(12px, var(--tg-safe-area-inset-bottom, 0px));
```

```js
// Or in JS:
const top = tg.safeAreaInset?.top ?? 0;
const bottom = tg.safeAreaInset?.bottom ?? 0;
```
