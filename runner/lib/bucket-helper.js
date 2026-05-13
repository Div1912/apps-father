/* eslint-disable */
"use strict";

/**
 * Typed bucket helper exposed at `db.bucket.{upload, uploadBase64}`.
 *
 * Posts to the worker's own /bucket/:projectId/upload local proxy, which
 * appends the captured AF_INTERNAL_SECRET on the upstream call to apps-father.
 * User code never sees the secret.
 *
 * Returns whatever the upstream bucket service returns:
 *   { file_id, direct_link, ... }
 */
function makeBucketHelper({ internalBaseUrl, projectId }) {
  const uploadUrl = `${internalBaseUrl}/bucket/${projectId}/upload`;

  async function upload(buffer, mime, opts) {
    if (!buffer || !mime) throw new Error("bucket.upload: buffer and mime are required");
    const headers = { "Content-Type": mime };
    if (opts && typeof opts === "object" && opts.filename) {
      headers["x-filename"] = String(opts.filename);
    }
    const res = await fetch(uploadUrl, {
      method: "POST",
      headers,
      body: Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer),
    });
    if (!res.ok) {
      const body = await safeText(res);
      throw new Error(`bucket.upload failed: ${res.status} ${body}`);
    }
    return await res.json();
  }

  async function uploadBase64(dataUrl, opts) {
    if (typeof dataUrl !== "string") throw new Error("bucket.uploadBase64: dataUrl must be a string");
    let mime = "application/octet-stream";
    let b64 = dataUrl;
    const m = /^data:([^;,]+)(?:;base64)?,(.*)$/i.exec(dataUrl);
    if (m) {
      mime = m[1];
      b64 = m[2];
    }
    return upload(Buffer.from(b64, "base64"), mime, opts);
  }

  return { upload, uploadBase64 };
}

async function safeText(res) {
  try { return await res.text(); } catch { return ""; }
}

module.exports = { makeBucketHelper };
