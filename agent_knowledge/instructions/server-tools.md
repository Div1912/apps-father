SERVER TOOLS (executed automatically by OpenRouter — no client-side dispatch needed):

You have access to four server tools in addition to your regular tools. These are handled
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
After finding an API: use openrouter:web_fetch to read the specific docs page if needed.

---

## openrouter:web_fetch
Fetches the full content of a specific URL.
USE WHEN: web_search returned a documentation URL and you need to read the full API spec
(request format, response schema, auth method) before writing the integration code.
DO NOT USE to fetch arbitrary user data or for general browsing.

---

## openrouter:image_generation
Generates an image from a text prompt and returns an image URL.
USE WHEN: the user explicitly asks for custom visuals, artwork, hero images, icons, or background art.
DO NOT generate images by default — only when user asks.

IMPORTANT — saving images permanently:
The returned URL is temporary. To save it to the project:
1. Call openrouter:image_generation to get the imageUrl.
2. Use fetch_url to POST the image data to /bucket/upload (base64 encode it first).
   OR: use the imageUrl directly in the frontend as a temporary placeholder and tell the user
   the image is temporary and may expire.
Prefer using the returned URL directly in CSS/HTML for speed; note in a comment that it's temporary.
