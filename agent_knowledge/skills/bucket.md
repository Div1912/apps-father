# AF Bucket — File Storage API

Apps Father provides a built-in per-project file storage called the **AF Bucket**.
Use it when the app needs to store or serve files: images, audio tracks, voice messages, videos, PDFs, etc.

## Endpoints

### Upload a file (server-side, from routes.js)

**Binary upload (recommended for all files, required for large files >1MB)**
```
POST /bucket/:projectId/upload
Content-Type: <mime-type>   (e.g. video/mp4, image/jpeg, audio/mpeg)
x-af-internal: <env.AF_INTERNAL_SECRET>
Body: raw binary bytes
Returns: { "file_id": "uuid", "direct_link": "/bucket/projectId/uuid.mp4", "filename": "uuid.mp4", "size": 102400, "mime": "video/mp4" }
```

**JSON / base64 upload (only for tiny files <500KB)**
```
POST /bucket/:projectId/upload
Content-Type: application/json
x-af-internal: <env.AF_INTERNAL_SECRET>
Body: { "data": "data:<mime>;base64,<base64data>" }
Returns: same as above
```

### Serve a file (public — no auth, anyone with the link)
```
GET /bucket/:projectId/:filename
Returns: the file with correct Content-Type and Cache-Control: immutable
```

## Supported file types

| Type   | Extensions                                      |
|--------|-------------------------------------------------|
| Images | jpg, png, gif, webp, svg, avif, bmp             |
| Audio  | mp3, ogg, wav, aac, flac, m4a, weba             |
| Video  | mp4, webm, ogv, mov                             |
| Docs   | pdf, txt, csv, json                             |

## Environment variables available in routes.js

| Variable                   | Description                                                              |
|----------------------------|--------------------------------------------------------------------------|
| `env.PROJECT_ID`           | The current project's ID                                                 |
| `env.BASE_URL`             | Public base URL (for external links, Telegram messages, etc.)            |
| `env.INTERNAL_BASE_URL`    | `http://localhost:{port}` — use THIS for server-side bucket API calls    |
| `env.AF_INTERNAL_SECRET`   | Platform secret for internal bucket calls                                |

> **Always use `env.INTERNAL_BASE_URL` for server-side bucket calls**, not `env.BASE_URL`.
> Using `env.BASE_URL` routes through nginx/Cloudflare which has a 500MB body limit and adds latency.
> `env.AF_INTERNAL_SECRET` must never be exposed to frontend code.

## How to use in routes.js

### Receiving and storing any file (images, audio, video) — STANDARD PATTERN

Use `multer` with `memoryStorage` to receive the file, then POST the raw buffer to the bucket endpoint.
This works for files of any size — no base64 conversion needed.

```js
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

// POST /upload  (multipart/form-data, field name: "file")
router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const bucketUrl = `${env.INTERNAL_BASE_URL}/bucket/${env.PROJECT_ID}/upload`;
  const response = await fetch(bucketUrl, {
    method: 'POST',
    headers: {
      'Content-Type': req.file.mimetype,
      'x-af-internal': env.AF_INTERNAL_SECRET,
    },
    body: req.file.buffer,
  });

  if (!response.ok) return res.status(500).json({ error: 'Upload failed' });

  const { file_id, direct_link } = await response.json();
  // Full public URL: `${env.BASE_URL}${direct_link}`
  res.json({ fileId: file_id, url: `${env.BASE_URL}${direct_link}` });
});
```

### Frontend — sending a file via FormData

```js
// In your frontend JS (index.js or similar)
async function uploadFile(file) {
  const form = new FormData();
  form.append('file', file);
  const res = await AF.api('/upload', { method: 'POST', body: form });
  return res.url; // public URL
}
```

> **Note**: When sending `FormData`, do NOT set `Content-Type` manually — the browser sets it automatically with the correct boundary.

### Example: voice message in a chat app

```js
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

router.post('/send-voice', upload.single('audio'), async (req, res) => {
  const { userId } = req.body;
  if (!req.file) return res.status(400).json({ error: 'No audio file' });

  const uploadRes = await fetch(`${env.BASE_URL}/bucket/${env.PROJECT_ID}/upload`, {
    method: 'POST',
    headers: { 'Content-Type': req.file.mimetype, 'x-af-internal': env.AF_INTERNAL_SECRET },
    body: req.file.buffer,
  });
  const { direct_link } = await uploadRes.json();
  const voiceUrl = `${env.BASE_URL}${direct_link}`;

  db.set(`msg:${Date.now()}`, { userId, type: 'voice', url: voiceUrl });
  res.json({ ok: true, url: voiceUrl });
});
```

### Example: listing bucket files by prefix / type

```js
// You manage the index yourself — store URLs in db after each upload.
// The bucket does not provide listing from routes.js (only from App Settings).

router.get('/tracks', (req, res) => {
  const tracks = db.get('tracks') || [];
  res.json({ tracks });
});
```

## Owner file management (mini app)

App owners can manage bucket files via:
**App Settings → File Bucket**

From there they can:
- Browse all uploaded files with type, size, and date
- Copy the public direct link
- Download a file
- Delete a file

## Important notes

- Files are **public** once uploaded — anyone with the direct link can access them
- Files are stored on the server's filesystem and **survive deployments**
- Use binary upload (raw buffer) for all files — avoid base64 for anything over ~500KB
- The `x-af-internal` header must never be exposed to frontend code — only use it in `routes.js` (server-side)
- Use `env.BASE_URL` + `direct_link` for full absolute URLs (needed for Telegram messages, etc.)
