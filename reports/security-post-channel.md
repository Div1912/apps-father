# Channel Post — Security Update

---

🔒 **We've significantly hardened the Apps Father platform security.**
Every user app now runs in a fully isolated Docker container, completely separated from the platform and from other projects. Here's what we've shipped:

- 🐳 **Docker container isolation** — each project runs in its own container; no project can see another's data or code
- 🌐 **Network isolation** — containers cannot reach internal platform services; inter-container communication is disabled at the network bridge level
- 🔑 **Telegram identity verification** — all Mini App requests are verified with HMAC-SHA256 before any user action is processed; constant-time comparison to prevent timing attacks
- 📦 **npm package allowlist** — only pre-approved packages can be installed in project containers; `postinstall` scripts are always blocked to prevent supply-chain attacks
- 🔐 **Encrypted credentials at rest** — bot tokens and sensitive project credentials are stored AES-encrypted in the database and decrypted only at container startup
- 🗂️ **Platform secret isolation** — infrastructure credentials (database, API keys, etc.) are never passed into user containers; user code sees only its own project environment
- 🧊 **Read-only container filesystem** — the container root is mounted read-only; user code can only write to its designated project workspace
- 🧱 **Process isolation** — each container has a hard cap on the number of processes it can spawn, preventing fork bomb attacks
- 🔒 **Localhost-only container ports** — worker containers bind exclusively to localhost; they are never directly reachable from the internet
- 🧹 **Environment cleanup** — all platform-level secrets are deleted from the process environment and frozen before user `routes.js` code is loaded
- 🛡️ **Shell tool restrictions** — the AI agent's shell access runs as an unprivileged user inside the container; raw package manager commands are blocked and must go through the allowlist-enforced install tool
- 🔄 **Encryption key rotation** — built-in migration script to re-encrypt all stored credentials with a new key without downtime
- 🚦 **Platform service mode** — operators can take the platform offline for all non-admin users instantly, while admin access remains fully functional
- 🔏 **Verified identity forwarding** — when requests are proxied to worker containers, the raw Telegram initData header is stripped and replaced with the verified user identity; containers never process unverified client-supplied headers
