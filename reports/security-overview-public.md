# Apps Father — Security Architecture Overview

> Platform version: v1 (Docker worker runtime)  
> Published: May 2026

---

## Overview

Apps Father runs user applications in a multi-tenant environment where each project is fully isolated from every other project and from the platform itself. This document describes the security architecture we have built to ensure safe execution for both platform operators and end users.

---

## 1. Isolated Execution Environments

Every project runs inside its own **Docker container** — a completely separate Linux environment that has no visibility into other projects or the platform server.

**What each container gets:**
- Its own filesystem, process tree, and network stack
- Access only to its own project files
- Its own bot token (so the project can interact with Telegram)
- Variables defined in the project's own `.env` settings

**What each container does NOT get:**
- Access to the platform database
- Access to other users' projects or data
- Any platform API keys, infrastructure credentials, or internal secrets
- The ability to read files outside its project folder

User code (`routes.js`) runs after all platform-level secrets have been removed from the process environment. The runtime is frozen so user code cannot add new environment variables that masquerade as platform secrets.

---

## 2. Container Resource Limits

To prevent any single project from impacting platform stability or other users, every container is subject to strict resource limits:

| Resource | Limit |
|----------|-------|
| Memory | 1 GB (configurable per deployment) |
| CPU | 0.5 cores |
| Processes | 100 maximum (prevents fork bombs) |
| Root filesystem | Read-only |
| Temporary storage | RAM-backed tmpfs — data is never written to host disk |
| Network port | Bound to localhost only — not directly reachable from the internet |

---

## 3. Network Isolation

Containers can make outbound internet requests (required for apps to call external APIs and Telegram), but they are prevented from reaching other containers or internal platform services:

- **Inter-container communication is disabled** — containers on the same host cannot talk to each other directly.
- **Host network access is blocked** — iptables rules prevent containers from connecting to the host's internal services (databases, platform APIs, etc.).
- Outbound internet traffic is permitted and unrestricted so that user apps function normally.

---

## 4. Telegram Identity Verification

All requests from Telegram Mini Apps are verified using the **official Telegram initData HMAC-SHA256 scheme**:

1. The platform receives `initData` from the Telegram client.
2. It derives a secret key from the project's bot token.
3. It verifies the `hash` field using a constant-time comparison (safe against timing attacks).
4. Only after verification does the platform attach a user identity to the request.

When requests are forwarded to a worker container, the raw `initData` header is **stripped** and replaced with the verified user identity — the container never sees unverified client-supplied identity data.

---

## 5. npm Package Allowlist

Agents and users can request npm packages for their projects. To prevent supply-chain attacks:

- All packages must be on an **admin-approved allowlist** before installation.
- New packages can be auto-approved if they meet a minimum weekly download threshold (indicating widespread, actively-maintained usage).
- All installations run with **`--ignore-scripts`** — package lifecycle scripts (`postinstall`, etc.) are never executed, eliminating a major class of supply-chain injection attacks.

---

## 6. Secure Shell Access

Administrators can open an interactive terminal into a project's container for debugging. This console:

- Runs as an unprivileged user (`node`, not root) inside the container.
- Is authenticated via a time-limited admin session token.
- Operates entirely within the container's isolated environment — there is no path from the container shell to the host server or other containers.

The agent's own shell tool is also restricted: raw package manager commands (`npm`, `yarn`, etc.) are blocked and must go through the allowlist-enforced install tool instead.

---

## 7. Encrypted Credentials

Bot tokens and other sensitive per-project credentials are stored **encrypted at rest** in the platform database. They are decrypted only at runtime when a container is spawned, and are injected directly into the container environment — they are never written to disk in plaintext.

The encryption key can be rotated at any time using a built-in migration script that re-encrypts all stored credentials without downtime.

---

## 8. Platform Access Controls

**Admin panel (CRM):**
- Protected by a strong password set at deployment time.
- Session tokens are cryptographically random (256-bit).
- Default and weak passwords (`admin`, etc.) are rejected at startup.

**Telegram Mini App admin functions:**
- Admin actions (maintenance mode, server control, worker management) require a verified Telegram identity from a pre-configured list of admin user IDs.
- Platform service mode allows taking the platform offline for all non-admin users while admins retain full access.

---

## Summary

| Security Layer | Implementation |
|----------------|----------------|
| Project isolation | One Docker container per project |
| Resource abuse prevention | Memory, CPU, PID limits per container |
| Filesystem isolation | Read-only root + project-scoped bind mount |
| Network isolation | ICC disabled + iptables host rules |
| Secret isolation | Platform secrets never enter containers |
| User identity verification | Telegram HMAC-SHA256, constant-time compare |
| Package supply chain | Admin allowlist + `--ignore-scripts` |
| Credential storage | AES-encrypted at rest, decrypted at runtime only |
| Admin access | Strong password + random session tokens |
| Container console | Unprivileged user, admin-authenticated |
