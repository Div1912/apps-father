# AF SDK — Apps Father SDK Reference

The AF SDK (`/af-sdk.js`) is automatically injected into every user app by the platform.
It is available as the global `AF` object **before** `app.js` runs.

---

## AF.init(opts)

Must be the **first** call in `app.js`. Handles all Telegram WebApp bootstrapping.

```js
AF.init({
  project_id: 'YOUR_PROJECT_UUID',   // required — set to the project's UUID
  colors: {
    header:     '#0a0e1a',           // optional — header bar color
    bottom:     '#0a0e1a',           // optional — bottom bar color
    background: '#0a0e1a'            // optional — app background color
  }
});
```

What AF.init() does automatically:
- `tg.ready()` + `tg.expand()`
- `tg.disableVerticalSwipes()`
- `tg.requestFullscreen()` on Android / iOS
- Sets header, bottom, and background colors
- Detects environment (`/dev/` vs `/app/`) and configures `AF.apiBase` and `AF.wsBase`

**Never call these yourself — AF.init() handles all of them.**

---

## AF.api(endpoint, fetchOptions?)

Send API requests. Endpoint is **relative, no leading slash**.

```js
// GET
const rates = await AF.api('rates').then(r => r.json());

// GET with query string
const result = await AF.api(`convert?from=USD&to=EUR&amount=100`).then(r => r.json());

// POST
await AF.api('save', {
  method: 'POST',
  body: JSON.stringify({ key: 'value' })
});

// DELETE
await AF.api('history', { method: 'DELETE' });
```

AF.api() automatically:
- Routes to `/devapi/{id}/` in dev, `/api/{id}/` in production
- Adds `Content-Type: application/json`
- Adds `x-telegram-init-data` header for auth

**NEVER** define your own `apiCall()` or `API_BASE` — use `AF.api()`.

---

## AF.openWS(handlers)

```js
const ws = AF.openWS({
  onMessage: (data, event) => { /* data is parsed JSON */ },
  onOpen:    (event) => {},
  onClose:   (event) => {},
  onError:   (event) => {}
});

// Send a message
ws.send(JSON.stringify({ type: 'ping' }));

// Close
ws.close();
```

---

## AF.haptic(type)

```js
AF.haptic('light');      // impact: light | medium | heavy | rigid | soft
AF.haptic('success');    // notification: success | error | warning
AF.haptic('selection');  // selectionChanged (tabs, pickers)
```

---

## AF.user

```js
const user = AF.user;
// → { id, first_name, last_name, username, photo_url, language_code } | null

if (user) {
  welcomeEl.textContent = `Hello, ${user.first_name}!`;
}
```

---

## AF.storage

Project-namespaced localStorage (keys auto-prefixed with `af:{projectId}:`).

```js
AF.storage.set('theme', 'dark');
const theme = AF.storage.get('theme');   // → 'dark' | null
AF.storage.remove('theme');
```

---

## AF.back(handler | null)

```js
// Show BackButton and register handler (replaces any previous handler)
AF.back(() => showScreen('main'));

// Hide BackButton and remove handler
AF.back(null);
```

---

## AF.isDev

```js
if (AF.isDev) console.log('dev mode');   // true when URL is /dev/{id}/...
```

---

## AF.tg

Raw `Telegram.WebApp` object for APIs not wrapped by AF SDK (popups, MainButton, etc).

```js
const tg = AF.tg;
tg.MainButton.setText('Pay').show();
tg.showPopup({ message: 'Done!' });
tg.close();
```

---

## Full app template

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
  <title>My App</title>
  <link rel="stylesheet" href="styles.css">
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <script src="/af-sdk.js"></script>
</head>
<body>
  <div class="app" id="app"></div>
  <script src="app.js"></script>
</body>
</html>
```

```js
// app.js — skeleton
const PROJECT_ID = 'YOUR_PROJECT_UUID';

AF.init({
  project_id: PROJECT_ID,
  colors: { header: '#0a0e1a', bottom: '#0a0e1a', background: '#0a0e1a' }
});

async function init() {
  const data = await AF.api('data').then(r => r.json());
  render(data);
}

init();
```

---

## Validator checklist (run before finish())

Before calling `finish()`, verify:

1. `index.html` includes `<script src="/af-sdk.js">` before `app.js`? If not → add it.
2. `app.js` calls `AF.init({project_id, colors})`? If not → replace manual `tg.*` calls.
3. `app.js` defines its own `apiCall()` / `API_BASE` / `API_URL`? If yes → delete and use `AF.api()`.
4. Any `AF.api()` call has endpoint starting with `/`? If yes → remove the leading slash.
5. `app.js` uses `localStorage` directly? If yes → replace with `AF.storage`.
6. `app.js` calls `tg.HapticFeedback` directly? If yes → replace with `AF.haptic()`.
7. `app.js` calls `tg.BackButton` directly? If yes → replace with `AF.back()`.
8. `app.js` calls `Telegram.WebApp.initDataUnsafe?.user` directly? If yes → replace with `AF.user`.
