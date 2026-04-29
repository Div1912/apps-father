/**
 * Apps Father Bucket — general-purpose image storage.
 * POST /bucket/upload  → { url: "/bucket/uuid.ext", filename }
 * GET  /bucket/:file   → serves the image file
 *
 * Images are stored in {cwd}/bucket/ and survive deployments.
 * No auth required; the upload endpoint is rate-limited per IP.
 */
import { Router, Request, Response } from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";

const router = Router();

const BUCKET_DIR = path.join(process.cwd(), "bucket");

// Ensure the bucket directory exists on startup
if (!fs.existsSync(BUCKET_DIR)) {
  fs.mkdirSync(BUCKET_DIR, { recursive: true });
  console.log("[Bucket] Created bucket directory at", BUCKET_DIR);
}

const EXT_MAP: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/bmp": "bmp",
};

// Simple per-IP rate limiting: 30 uploads per minute
const uploadRateMap = new Map<string, { count: number; reset: number }>();

function checkUploadRate(ip: string): boolean {
  const now = Date.now();
  const entry = uploadRateMap.get(ip);
  if (!entry || now > entry.reset) {
    uploadRateMap.set(ip, { count: 1, reset: now + 60_000 });
    return true;
  }
  if (entry.count >= 30) return false;
  entry.count++;
  return true;
}

// POST /bucket/upload — accepts { data: "data:image/...;base64,...", name?: string }
router.post("/upload", (req: Request, res: Response) => {
  try {
    const ip = (req.headers["x-forwarded-for"] as string || req.socket.remoteAddress || "").split(",")[0].trim();
    if (!checkUploadRate(ip)) {
      res.status(429).json({ error: "Too many uploads, slow down" });
      return;
    }

    const { data, name } = req.body || {};
    if (!data || typeof data !== "string") {
      res.status(400).json({ error: "No data provided" });
      return;
    }

    // Parse data:image/...;base64,<data>
    const m = data.match(/^data:(image\/[a-zA-Z+.-]+);base64,(.+)$/s);
    if (!m) {
      res.status(400).json({ error: "Invalid data URL — must be a base64-encoded image" });
      return;
    }

    const mimeType = m[1];
    const buf = Buffer.from(m[2], "base64");

    if (buf.length > 12 * 1024 * 1024) {
      res.status(413).json({ error: "File too large (max 12 MB)" });
      return;
    }

    const ext = EXT_MAP[mimeType] || "jpg";
    const filename = crypto.randomUUID() + "." + ext;
    const filePath = path.join(BUCKET_DIR, filename);
    fs.writeFileSync(filePath, buf);

    console.log("[Bucket] Saved", filename, Math.round(buf.length / 1024) + "KB");
    res.json({ url: `/bucket/${filename}`, filename });
  } catch (err) {
    console.error("[Bucket] Upload error:", err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// GET /bucket/:filename — serve uploaded images
router.get("/:filename", (req: Request, res: Response) => {
  const raw = String(req.params.filename);
  // Sanitise: only allow uuid-style filenames with safe extensions
  const filename = raw.replace(/[^a-zA-Z0-9._-]/g, "");
  if (!filename || filename !== raw) {
    res.status(400).send("Bad filename");
    return;
  }
  const filePath = path.join(BUCKET_DIR, filename);
  if (!filePath.startsWith(BUCKET_DIR + path.sep) || !fs.existsSync(filePath)) {
    res.status(404).send("Not found");
    return;
  }
  // Cache for 1 year (content-addressed by UUID)
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.sendFile(filePath);
});

export default router;
