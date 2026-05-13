/* eslint-disable */
"use strict";

const url = require("url");
const http = require("http");
const https = require("https");

/**
 * Worker-local bucket proxy. Forwards `/bucket/:projectId/...` requests to
 * `${BASE_URL}/bucket/:projectId/...` with the captured AF_INTERNAL_SECRET
 * injected as `x-af-internal`.
 *
 * Security: the worker only proxies its OWN project's bucket calls
 * (`req.params.projectId === ownProjectId` is enforced).
 */
function proxyBucket(req, res, opts) {
  const ownProjectId = opts.ownProjectId;
  const baseUrl      = opts.baseUrl;
  const secret       = opts.afInternalSecret;

  // Extract :projectId from the URL — works whether Express set req.params or not.
  // Path always starts with "/bucket/<id>/...".
  const m = /^\/bucket\/([^/]+)(\/.*)?$/.exec(req.path || req.url || "");
  if (!m) {
    res.status(400).json({ error: "bad_bucket_path" });
    return;
  }
  const reqProjectId = m[1];
  const tail = m[2] || "";

  if (reqProjectId !== ownProjectId) {
    res.status(403).json({ error: "cross_project_bucket_forbidden" });
    return;
  }

  if (!baseUrl) {
    res.status(500).json({ error: "bucket_misconfigured", message: "BASE_URL not set" });
    return;
  }

  const target = url.parse(`${baseUrl}/bucket/${reqProjectId}${tail}`);
  const lib = target.protocol === "https:" ? https : http;

  // Strip hop-by-hop and host-only headers; keep content-type/length so
  // body shapes (multipart, raw octet stream, JSON) all work.
  const fwdHeaders = {};
  for (const k of Object.keys(req.headers || {})) {
    const lower = k.toLowerCase();
    if (lower === "host" || lower === "connection" || lower === "x-af-internal") continue;
    fwdHeaders[k] = req.headers[k];
  }
  fwdHeaders["x-af-internal"] = secret;

  const upstream = lib.request(
    {
      protocol: target.protocol,
      host: target.hostname,
      port: target.port,
      path: target.path,
      method: req.method,
      headers: fwdHeaders,
    },
    (upRes) => {
      // Forward status + headers + body.
      res.status(upRes.statusCode || 502);
      for (const k of Object.keys(upRes.headers)) {
        // Express handles content-encoding; passthrough as-is.
        try { res.setHeader(k, upRes.headers[k]); } catch {}
      }
      upRes.pipe(res);
    }
  );

  upstream.on("error", (err) => {
    if (!res.headersSent) {
      res.status(502).json({ error: "bucket_upstream_failed", message: err.message });
    } else {
      try { res.end(); } catch {}
    }
  });

  // Pipe the request body upstream.
  // Express has already buffered req.body for some content types — for raw
  // streams (octet-stream / multipart) we passthrough the underlying socket.
  if (req.readable) {
    req.pipe(upstream);
  } else if (req.body !== undefined && req.body !== null) {
    let payload;
    if (Buffer.isBuffer(req.body)) payload = req.body;
    else if (typeof req.body === "string") payload = Buffer.from(req.body);
    else payload = Buffer.from(JSON.stringify(req.body));
    upstream.end(payload);
  } else {
    upstream.end();
  }
}

module.exports = { proxyBucket };
