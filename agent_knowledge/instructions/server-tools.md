SERVER TOOLS (executed automatically by OpenRouter — no client-side dispatch needed):

You have access to three server tools in addition to your regular tools. These are handled
transparently by OpenRouter during the API call — you call them like normal tools.

---

## openrouter:datetime
Returns the current UTC date and time.
USE WHEN: building any date-aware feature (timers, "today's date", "days until X", scheduling).
Example call: call openrouter:datetime with no arguments before writing any code that references
the current date, so you use the real date instead of guessing.

---

## openrouter:web_search
Searches the web and returns results (title, URL, snippet).
Parameters auto-set: max_results=5, max_total_results=15.
USE WHEN:
- You need to find a working free public API endpoint (crypto, weather, news, sports, etc.)
- You need the current URL/format for a well-known API
- The user asks to integrate a service and you don't know the exact endpoint
DO NOT USE for: general coding knowledge, HTML/CSS/JS syntax, Telegram API — you already know these.
After finding an API: use fetch_url to read the specific docs page if needed.

---

## image_generate
Generates an AI image and saves it permanently to the project bucket.
Parameters: prompt (required), filename (required, .png), aspect_ratio, style, rgb_colors, background_rgb_color.

USE WHEN:
- Building or updating an app that has visual elements (banners, hero images, illustrations, icons, backgrounds).
- The user asks for images/illustrations/visuals to make the app look better.
- Proactively use it if the app clearly benefits from a custom visual (e.g. a landing page needs a hero banner).

DO NOT use for purely functional/data apps where images don't add value.

HOW TO USE:
- Plan image filenames in technical_plan BEFORE generating — this lets you reference them in HTML/CSS early.
- Call image_generate BEFORE writing the frontend code that uses those images.
- Use the saved image in code: <img src="/bucket/{projectId}/{filename}"> or background-image: url('/bucket/{projectId}/{filename}')
- Max 3 images per build/update session.
- aspect_ratio: 16:9 (banners/headers), 1:1 (icons/avatars), 9:16 (portrait heroes), 4:3 (illustrations).
- style: 'Illustration', 'Vector art', 'Pixel art', '3D render', 'Watercolor', etc. → uses Recraft V3.
  Omit style for highest-quality photorealistic output (Recraft V4 Pro).
- rgb_colors: [[r,g,b], ...] — color hints (up to 5) to match the app's palette.

CRITICAL — background blending (prevents ugly white boxes):
Generated images always have a solid background; there is NO transparent PNG option.
- For illustrations / characters / icons / cards placed ON the app UI:
  ALWAYS pass background_rgb_color matching the app's CSS background-color.
  Extract it from frontend/styles.css (e.g. body { background: #111827 } → [17, 24, 39]).
  Without this the image has a white/gray box that looks terrible on dark themes.
- For full-bleed banners / hero images that FILL their container: background_rgb_color is part of the design.
- Rule: if the image sits inside a card or floats on any background → match that background color.

DO NOT use openrouter:image_generation — it returns a temporary URL. Use image_generate instead, which
saves the image to the project bucket and gives a permanent URL.
