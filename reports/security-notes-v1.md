# Security Notes v1 — Apps Father Platform

> Generated: May 14 2026  
> Scope: Platform server + Docker worker runtime  
> Status: Active production deployment

---

## 1. Docker Worker Containerization

### What's implemented

Every user project runs inside its own Docker container (`apps-father-runner` image) spawned by `DockerRunnerService`.

**Resource limits (per container):**

| Control | Value |
|---------|-------|
| Memory | `heapMb × 2` MB (default 1024 MB) |
| Swap | Same as memory — no extra swap |
| CPU | `--cpus 0.5` |
| PIDs | `--pids-limit 100` (prevents fork bombs) |
| Root filesystem | `--read-only` |
| `/tmp` tmpfs | 256 MB RAM-backed |
| `/home/node/.npm` tmpfs | 512 MB RAM-backed (uid=1000) |
| `/workspace` | Bind-mount of project dir only |
| Host port | `127.0.0.1:<random>` — localhost only |

**Filesystem isolation:**
- Root filesystem is read-only. Writes are only possible in `/tmp`, `/home/node/.npm`, and `/workspace` (the project's bind-mount).
- `/workspace` = `/srv/apps-father/projects/<id>/` — one project's files only. No access to other projects or platform code.

**Network isolation:**
- Containers are on the `apps-father-runners` bridge with ICC (inter-container communication) disabled.
- `scripts/setup-docker-network.sh` installs iptables rules in `DOCKER-USER` chain to block access to host gateway and private IP ranges (RFC 1918).
- Containers **have internet access** (by design — apps need to call external APIs).

**Secret isolation:**
- Container does NOT receive: `DATABASE_URL`, platform LLM keys, `ENCRYPTION_KEY`, `WALLET_MNEMONIC`, or any other platform secrets.
- Container receives: decrypted `BOT_TOKEN` for the project, `RUNNER_SECRET` (gating internal health routes), `AF_INTERNAL_SECRET` (for bucket proxy), and keys from the project's own `backend/.env`.
- Inside `worker-entry.js`, all platform secrets are **deleted from `process.env`** and the env is frozen before user `routes.js` is loaded. User code sees only `BASE_URL`, `PROJECT_ID`, and its own env vars.

**Known gap — Docker hardening flags not set:**
- No `--security-opt seccomp=<profile>`, no `--cap-drop ALL`, no `--no-new-privileges` in the `docker run` invocation.
- This relies on the read-only filesystem + cgroup limits as the primary isolation layer.
- **Recommended:** Add `--cap-drop ALL --no-new-privileges --security-opt no-new-privileges:true` to `spawnContainer` in `docker-runner.service.ts`.

**Known gap — iptables dependency:**
- If `setup-docker-network.sh` was not run or iptables is unavailable, worker containers can reach the host's internal services (e.g. PostgreSQL on localhost). The script has a runtime warning for this but does not fail-safe.

---

## 2. Telegram initData HMAC Verification

### What's implemented

`src/web/middleware/initdata.ts` implements the standard Telegram Web App verification:

1. Parse the `x-telegram-init-data` header.
2. Sort all `key=value` pairs alphabetically, join with `\n`.
3. Compute `secretKey = HMAC-SHA256("WebAppData", botToken)`.
4. Compute `hash = HMAC-SHA256(secretKey, dataCheckString)`.
5. Compare using **`crypto.timingSafeEqual`** — safe against timing attacks.

### Runner proxy (correct pattern)
`runner-proxy.ts` verifies initData, then **strips** `x-telegram-init-data` before forwarding to the worker container and substitutes `x-telegram-user` from the verified `req.telegramUser`. Workers cannot be fooled by client-supplied identity headers.

### Gaps

| Issue | Detail |
|-------|--------|
| `/devapi/` skips HMAC | `initdata.ts` returns `next()` immediately for dev API routes — used during agent development |
| Missing initData | If header is absent, middleware calls `next()` with no user — routes must check `req.telegramUser` themselves |
| No bot token | If a project has no `botTokenEncrypted`, HMAC is skipped and the parsed-but-unverified user is trusted |
| `validateAuth` non-constant-time | The mini-app-facing `validateAuth` function in `server.ts` uses `!==` string comparison instead of `timingSafeEqual`, unlike `initdata.ts` |

---

## 3. Server Control & Maintenance Mode

### Per-project maintenance (project owners)

- Implemented via a `.maintenance` flag file + in-memory cache (`maintenance.service.ts`).
- When enabled, all requests to `/app/:projectId/*` return a 503 HTML maintenance page.
- Toggle via `POST /telegram-mini-app/api/server-control/:projectId/maintenance`.
- Authenticated via `validateAuth` (Apps Father bot initData) + owner or admin check.

### Platform service mode (admin only)

- Controlled via runtime config (`runtimeConfig.isServiceMode()`).
- When enabled, all `/telegram-mini-app/api` endpoints return 503 **except `/init` and requests from admin Telegram IDs**.
- Admin bypass uses `config.adminTelegramIds` sourced from `ADMIN_TELEGRAM_IDS` env var.

### Gap — admin ID source inconsistency

The platform has **two different admin lists** that can diverge:

| Location | Source |
|----------|--------|
| Service mode middleware | `config.adminTelegramIds` (from `ADMIN_TELEGRAM_IDS` env) |
| Mini-app admin routes (`isAdminTelegramId`) | **Hardcoded** array in `server.ts` |

If a new admin ID is added via env, they may not have access to all admin mini-app routes. Both lists should reference the same source.

---

## 4. Admin CRM Panel

### What's implemented

- `POST /admin/api/login` — password against `config.adminPassword` (`ADMIN_PASSWORD` env, required, rejected if `"admin"`).
- On success: generates a **32-byte random hex token**, stored in an **in-memory Set**.
- `authMiddleware` checks `Authorization: Bearer <token>` or `?token=` query param.
- Tokens are also used for WebSocket console access (`isValidAdminToken`).

### Gaps

| Issue | Detail |
|-------|--------|
| No token expiry | Tokens live until PM2 restart; no TTL, no revocation |
| Query string tokens | `?token=` for file downloads can appear in web server logs, referrer headers |
| Single shared password | No per-user accounts; if password leaks, all admin sessions are compromised |
| Tokens lost on restart | After PM2 restart all active admin sessions are invalidated |

---

## 5. npm Package Allowlist

### What's implemented

Packages must be on the allowlist (`runner-npm-allowlist.json`) before they can be installed in a project container.

**Three paths to allowlist entry:**
1. **Manual admin approval** — via admin panel (`POST /admin/api/runner-allowlist`), atomic write via temp file + rename.
2. **Agent `npm_install` tool** — validates against allowlist; if unknown, checks **npm weekly downloads ≥ 100,000** and auto-approves.
3. **Pre-seeded list** — ships with the codebase.

**Installation is always:**
```
npm install --ignore-scripts --no-audit --no-fund --save-exact
```

`--ignore-scripts` prevents package `postinstall` scripts from executing arbitrary code.

### Gaps

| Issue | Detail |
|-------|--------|
| Popularity ≠ safety | 100K weekly downloads is not a security review; popular packages can still be malicious or typosquatted |
| Auto-approve write path | `NpmInstallTool` uses non-atomic `writeFileSync` vs admin panel's atomic rename — potential race condition under concurrent installs |

---

## 6. Encryption

### What's implemented

- `ENCRYPTION_KEY` env var required at startup.
- Bot tokens stored encrypted in the database as `botTokenEncrypted` using CryptoJS AES.
- Decrypted only in platform code; decrypted `BOT_TOKEN` injected into worker container env.
- Key rotation script: `scripts/rotate-encryption-key.js` — decrypt-all with old key, re-encrypt with new key, update `.env`.

### Gap — CryptoJS AES semantics

CryptoJS AES with a passphrase string uses an OpenSSL-compatible KDF internally (MD5-based EVP_BytesToKey), not a modern PBKDF2/Argon2 derivation, and does not use authenticated encryption (no AEAD/GCM). Consider migrating to Node `crypto` with `AES-256-GCM` for explicit IV, salt, and integrity verification.

---

## 7. Agent Shell Tool Security

### What's implemented

`ShellTool` routes to two backends:

- **Docker mode**: `docker exec --user node -w /workspace` inside the project's container. Container has no platform secrets, 30s timeout, 1MB output cap.
- **Legacy mode**: `execAsync` on the platform host (used only for local dev / fallback).

**Blocked patterns:**
- `rm -rf /`, `shutdown`, `reboot`, etc.
- All package manager calls (`npm`, `yarn`, `pnpm`, `npx`, `bun`) — must use `npm_install` tool instead.
- Platform infrastructure commands (no reading `DATABASE_URL`, no platform env inspection).

### Gap — filesystem mismatch (now documented in tool)

In Docker mode, `ShellTool` runs in the container's `/workspace` (the **deployed** state), while `WriteFileTool`/`EditFileTool` operate on the agent's **build commit directory** (`commits/<N>/`). If the agent uses shell to write files pre-deploy, those writes land in the deployed filesystem and are overwritten on the next `deploy_to_dev`. This is now documented in the tool description and the `write_file` error messages explicitly forbid the shell heredoc pattern.

---

## 8. Webhook Security

### Gap — no `X-Telegram-Bot-Api-Secret-Token` validation

`webhook.routes.ts` does not validate the `X-Telegram-Bot-Api-Secret-Token` header that Telegram sends when a webhook secret is configured. Any request to the webhook endpoint is processed. **Recommended:** Set a webhook secret via `setWebhook` and validate the header with `timingSafeEqual`.

---

## Summary: Security Posture

| Layer | Status |
|-------|--------|
| Container resource limits | ✅ Memory, CPU, PID, read-only FS |
| Container filesystem isolation | ✅ Bind-mount per-project only |
| Platform secrets in containers | ✅ Not exposed |
| User code secret isolation | ✅ Removed from env before `routes.js` |
| Network isolation | ✅ ICC disabled, iptables rules (requires setup script) |
| Telegram initData HMAC | ✅ `timingSafeEqual`, enforced on most routes |
| Maintenance / service mode | ✅ Implemented with admin bypass |
| npm `--ignore-scripts` | ✅ Applied on all installs |
| ENCRYPTION_KEY for bot tokens | ✅ |
| Docker cap-drop / seccomp | ⚠️ Not configured |
| Webhook secret validation | ⚠️ Missing |
| Admin token expiry | ⚠️ No TTL |
| Admin ID source consistency | ⚠️ Two lists (env vs hardcoded) |
| `validateAuth` timing safety | ⚠️ `!==` instead of `timingSafeEqual` |
| npm auto-approve by popularity | ⚠️ Popularity ≠ security review |
| CryptoJS AES (no AEAD) | ⚠️ Legacy, no integrity check |
| iptables setup | ⚠️ Optional script, not enforced |
