# AF Bucket — File Storage API

Apps Father provides a built-in per-project file storage called the **AF Bucket**.
Use it when the app needs to store or serve files: images, audio tracks, voice messages, videos, PDFs, etc.

## Endpoints

### Upload a file (server-side, from routes.js)
```
POST /bucket/:projectId/upload
Header: x-af-internal: <AF_INTERNAL_SECRET env var>
Body: { "data": "data:<mime>;base64,<base64data>", "name": "optional-filename.mp3" }
Returns: { "file_id": "uuid", "direct_link": "/bucket/projectId/uuid.mp3", "filename": "uuid.mp3", "size": 102400, "mime": "audio/mpeg" }
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

## How to use in routes.js

### Example: upload a user-sent image and return its public URL

```js
const fs   = require('fs');
const path = require('path');

router.post('/upload-image', async (req, res) => {
  const { imageBase64, mimeType } = req.body;
  if (!imageBase64 || !mimeType) return res.status(400).json({ error: 'Missing fields' });

  // Build the data URL
  const dataUrl = `data:${mimeType};base64,${imageBase64}`;

  // Call the AF Bucket upload endpoint internally
  const response = await fetch(`http://localhost:${process.env.PORT || 3000}/bucket/${env.PROJECT_ID}/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-af-internal': env.AF_INTERNAL_SECRET,
    },
    body: JSON.stringify({ data: dataUrl }),
  });

  if (!response.ok) return res.status(500).json({ error: 'Upload failed' });

  const { file_id, direct_link } = await response.json();
  // direct_link = "/bucket/projectId/uuid.jpg"
  // Full URL = `${env.BASE_URL}${direct_link}`
  res.json({ fileId: file_id, url: `${env.BASE_URL}${direct_link}` });
});
```

### Example: music app — list all tracks from bucket

```js
router.get('/tracks', async (req, res) => {
  // The bucket directory is at: /opt/apps-father-dev/bucket/<projectId>/
  // Use the direct_link to build public URLs
  const tracks = [
    { title: 'Track 1', url: `${env.BASE_URL}/bucket/${env.PROJECT_ID}/uuid1.mp3` },
    { title: 'Track 2', url: `${env.BASE_URL}/bucket/${env.PROJECT_ID}/uuid2.mp3` },
  ];
  res.json({ tracks });
});
```

### Example: voice message in a chat app

```js
router.post('/send-voice', async (req, res) => {
  const { userId, voiceBase64 } = req.body;

  const dataUrl = `data:audio/ogg;base64,${voiceBase64}`;
  const uploadRes = await fetch(`http://localhost:${process.env.PORT || 3000}/bucket/${env.PROJECT_ID}/upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-af-internal': env.AF_INTERNAL_SECRET },
    body: JSON.stringify({ data: dataUrl }),
  });
  const { direct_link } = await uploadRes.json();

  // Save the message to your DB with the URL
  await db.run(
    'INSERT INTO messages (user_id, type, content) VALUES (?, ?, ?)',
    [userId, 'voice', `${env.BASE_URL}${direct_link}`]
  );

  res.json({ ok: true, url: `${env.BASE_URL}${direct_link}` });
});
```

## Environment variables available in routes.js

| Variable            | Description                                  |
|---------------------|----------------------------------------------|
| `env.PROJECT_ID`    | The current project's ID                     |
| `env.BASE_URL`      | The public base URL of the app               |
| `env.AF_INTERNAL_SECRET` | Secret header value for internal bucket calls |

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
- There are no per-project size limits currently
- Use `env.BASE_URL` + `direct_link` for the full absolute URL (needed for Telegram messages, etc.)
- The `x-af-internal` header must never be exposed to frontend code — only use it in `routes.js` (server-side)
