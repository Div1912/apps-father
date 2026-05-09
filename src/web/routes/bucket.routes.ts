/**
 * Apps Father Bucket — per-project file storage.
 *
 * Upload (project owner via mini-app, OR server-side routes.js):
 *   POST /bucket/:projectId/upload
 *   Body: { data: "data:<mime>;base64,<b64>", name?: string }
 *   Auth: x-telegram-init-data (owner) OR x-af-internal (server-side)
 *   Returns: { file_id, direct_link, filename, size, mime }
 *
 * Serve (public — anyone with the link):
 *   GET /bucket/:projectId/:filename
 *
 * List files (owner only — via mini-app API):
 *   GET /telegram-mini-app/api/bucket/:projectId       (in server.ts)
 *
 * Delete (owner only — via mini-app API):
 *   DELETE /telegram-mini-app/api/bucket/:projectId/:filename  (in server.ts)
 *
 * Files are stored in {cwd}/bucket/{projectId}/ and survive deployments.
 */
import express, { Router, Request, Response } from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";

const router = Router();

export const BUCKET_ROOT = path.join(process.cwd(), "bucket");

// Ensure root bucket dir exists
if (!fs.existsSync(BUCKET_ROOT)) {
  fs.mkdirSync(BUCKET_ROOT, { recursive: true });
}

// ── MIME type → extension map (images, audio, video, docs) ─────────────────
export const MIME_TO_EXT: Record<string, string> = {
  // Images
  "image/jpeg":    "jpg",
  "image/jpg":     "jpg",
  "image/png":     "png",
  "image/gif":     "gif",
  "image/webp":    "webp",
  "image/svg+xml": "svg",
  "image/avif":    "avif",
  "image/bmp":     "bmp",
  // Audio
  "audio/mpeg":    "mp3",
  "audio/mp3":     "mp3",
  "audio/ogg":     "ogg",
  "audio/wav":     "wav",
  "audio/webm":    "weba",
  "audio/aac":     "aac",
  "audio/flac":    "flac",
  "audio/x-m4a":   "m4a",
  "audio/mp4":     "m4a",
  // Video
  "video/mp4":     "mp4",
  "video/webm":    "webm",
  "video/ogg":     "ogv",
  "video/quicktime":"mov",
  // Docs
  "application/pdf":  "pdf",
  "application/json": "json",
  "text/plain":       "txt",
  "text/csv":         "csv",
};

function getProjectDir(projectId: string): string {
  // sanitise projectId — only allow uuid-safe chars
  const safe = projectId.replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safe || safe !== projectId) throw new Error("Invalid projectId");
  return path.join(BUCKET_ROOT, safe);
}

function ensureProjectDir(projectId: string): string {
  const dir = getProjectDir(projectId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Parse a base64 data URL: data:<mime>;base64,<data> */
function parseDataUrl(data: string): { mime: string; buf: Buffer } | null {
  const m = data.match(/^data:([a-zA-Z0-9\/+.-]+);base64,(.+)$/s);
  if (!m) return null;
  return { mime: m[1], buf: Buffer.from(m[2], "base64") };
}

// ── POST /bucket/:projectId/upload ──────────────────────────────────────────
// Two upload modes:
//   1. JSON  — Content-Type: application/json  → { data: "data:<mime>;base64,..." }
//   2. Binary — Content-Type: <mime>           → raw bytes in body (for large files)
// Auth: x-af-internal header (from routes.js server-side code)
//       OR project ownership validated in server.ts before calling this handler.
router.post(
  "/:projectId/upload",
  express.raw({ type: (req) => (req.headers["content-type"] || "").split(";")[0].trim() !== "application/json", limit: "500mb" }),
  (req: Request, res: Response) => {
    try {
      const isInternal = req.headers["x-af-internal"] === process.env.AF_INTERNAL_SECRET;
      if (!isInternal) {
        res.status(403).json({ error: "Use /telegram-mini-app/api/bucket/:projectId/upload for owner uploads" });
        return;
      }

      const projectId = String(req.params.projectId);

      let buf: Buffer;
      let mime: string;

      if (Buffer.isBuffer(req.body)) {
        // Binary upload path
        mime = ((req.headers["content-type"] || "application/octet-stream").split(";")[0]).trim();
        buf = req.body;
      } else {
        // JSON / base64 path
        const { data } = req.body || {};
        if (!data || typeof data !== "string") {
          res.status(400).json({ error: "Body must be raw binary (Content-Type: <mime>) or JSON { data: 'data:<mime>;base64,...' }" });
          return;
        }
        const parsed = parseDataUrl(data);
        if (!parsed) {
          res.status(400).json({ error: "Invalid data URL — must be data:<mime>;base64,<data>" });
          return;
        }
        buf = parsed.buf;
        mime = parsed.mime;
      }

      const ext = MIME_TO_EXT[mime] || "bin";
      const fileId = crypto.randomUUID();
      const filename = fileId + "." + ext;
      const dir = ensureProjectDir(projectId);
      fs.writeFileSync(path.join(dir, filename), buf);

      const directLink = `/bucket/${projectId}/${filename}`;
      console.log(`[Bucket] Saved ${projectId}/${filename} ${Math.round(buf.length / 1024)}KB`);
      res.json({ file_id: fileId, direct_link: directLink, filename, size: buf.length, mime });
    } catch (err: any) {
      console.error("[Bucket] Upload error:", err);
      res.status(500).json({ error: err.message || "Upload failed" });
    }
  },
);

// ── GET /bucket/:projectId/:filename — public file serving ──────────────────
router.get("/:projectId/:filename", (req: Request, res: Response) => {
  try {
    const rawProject  = String(req.params.projectId);
    const rawFilename = String(req.params.filename);
    // Sanitise both segments
    const projectId = rawProject.replace(/[^a-zA-Z0-9_-]/g, "");
    const filename  = rawFilename.replace(/[^a-zA-Z0-9._-]/g, "");
    if (!projectId || !filename || projectId !== rawProject || filename !== rawFilename) {
      res.status(400).send("Bad request");
      return;
    }
    const dir      = path.join(BUCKET_ROOT, projectId);
    const filePath = path.join(dir, filename);
    // Path traversal guard
    if (!filePath.startsWith(dir + path.sep) || !fs.existsSync(filePath)) {
      res.status(404).send("Not found");
      return;
    }
    // Determine Content-Type from extension
    const ext = path.extname(filename).slice(1).toLowerCase();
    const extToMime: Record<string, string> = {
      jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
      gif: "image/gif",  webp: "image/webp", svg: "image/svg+xml",
      avif: "image/avif", bmp: "image/bmp",
      mp3: "audio/mpeg", ogg: "audio/ogg",  wav: "audio/wav",
      weba: "audio/webm", aac: "audio/aac", flac: "audio/flac", m4a: "audio/mp4",
      mp4: "video/mp4",  webm: "video/webm", ogv: "video/ogg",  mov: "video/quicktime",
      pdf: "application/pdf", json: "application/json", txt: "text/plain", csv: "text/csv",
    };
    const ct = extToMime[ext] || "application/octet-stream";
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.sendFile(filePath);
  } catch (err: any) {
    console.error("[Bucket] Serve error:", err);
    res.status(500).send("Server error");
  }
});

// ── Legacy: GET /bucket/:filename (backward-compat for old flat uploads) ────
router.get("/:filename", (req: Request, res: Response) => {
  const raw      = String(req.params.filename);
  const filename = raw.replace(/[^a-zA-Z0-9._-]/g, "");
  if (!filename || filename !== raw) { res.status(400).send("Bad filename"); return; }
  const filePath = path.join(BUCKET_ROOT, filename);
  if (!filePath.startsWith(BUCKET_ROOT + path.sep) || !fs.existsSync(filePath)) {
    res.status(404).send("Not found");
    return;
  }
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.sendFile(filePath);
});

// ── Helpers exported for server.ts (owner upload + list + delete) ────────────

export interface BucketFileInfo {
  filename: string;
  file_id:  string;
  ext:      string;
  size:     number;
  direct_link: string;
  uploaded_at: string; // ISO string from mtime
}

export function listProjectFiles(projectId: string): BucketFileInfo[] {
  let dir: string;
  try { dir = getProjectDir(projectId); } catch { return []; }
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => !f.startsWith("."))
    .filter(f => !fs.statSync(path.join(dir, f)).isDirectory())
    .map(filename => {
      const stat = fs.statSync(path.join(dir, filename));
      const ext  = path.extname(filename).slice(1);
      const file_id = filename.replace(/\.[^.]+$/, "");
      return {
        filename,
        file_id,
        ext,
        size: stat.size,
        direct_link: `/bucket/${projectId}/${filename}`,
        uploaded_at: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));
}

export function deleteProjectFile(projectId: string, filename: string): boolean {
  let dir: string;
  try { dir = getProjectDir(projectId); } catch { return false; }
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "");
  if (!safe || safe !== filename) return false;
  const filePath = path.join(dir, safe);
  if (!filePath.startsWith(dir + path.sep) || !fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

export function uploadProjectFile(
  projectId: string,
  data: string,
  name?: string,
): { file_id: string; direct_link: string; filename: string; size: number; mime: string } {
  const parsed = parseDataUrl(data);
  if (!parsed) throw new Error("Invalid data URL");
  return uploadProjectFileFromBuffer(projectId, parsed.buf, parsed.mime);
}

export function uploadProjectFileFromBuffer(
  projectId: string,
  buf: Buffer,
  mime: string,
): { file_id: string; direct_link: string; filename: string; size: number; mime: string } {
  const ext      = MIME_TO_EXT[mime] || "bin";
  const fileId   = crypto.randomUUID();
  const filename = fileId + "." + ext;
  const dir      = ensureProjectDir(projectId);
  fs.writeFileSync(path.join(dir, filename), buf);
  console.log(`[Bucket] Saved ${projectId}/${filename} ${Math.round(buf.length / 1024)}KB`);
  return {
    file_id: fileId,
    direct_link: `/bucket/${projectId}/${filename}`,
    filename,
    size: buf.length,
    mime,
  };
}

export default router;
