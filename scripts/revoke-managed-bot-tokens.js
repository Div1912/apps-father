/**
 * Revoke managed bot tokens using Telegram's replaceManagedBotToken API.
 *
 * For every project that has a botUserId, this script:
 *   1. Calls replaceManagedBotToken via the main APPS_FATHER_TOKEN
 *   2. Receives the new token
 *   3. Re-registers the production webhook with the new token hash
 *   4. Encrypts the new token and saves it to the database
 *
 * Without --apply the script is a DRY-RUN (no API calls, no DB writes).
 * Use --limit N to process only the first N rows (for a test run).
 *
 * Usage (on the production server):
 *
 *   # Test with 5 bots (dry-run):
 *   node scripts/revoke-managed-bot-tokens.js --limit 5
 *
 *   # Test with 5 bots (LIVE — actually revokes):
 *   node scripts/revoke-managed-bot-tokens.js --limit 5 --apply
 *
 *   # All bots (LIVE):
 *   node scripts/revoke-managed-bot-tokens.js --apply
 */

const CryptoJS = require("crypto-js");
const crypto   = require("crypto");
const { PrismaClient } = require("@prisma/client");

// ── Required env ────────────────────────────────────────────────────────────
const APPS_FATHER_TOKEN = process.env.APPS_FATHER_TOKEN;
const ENCRYPTION_KEY    = process.env.ENCRYPTION_KEY;

function decryptToken(encrypted) {
  try {
    const bytes = CryptoJS.AES.decrypt(encrypted, ENCRYPTION_KEY);
    return bytes.toString(CryptoJS.enc.Utf8) || null;
  } catch { return null; }
}

/** Trim a token for display: show first 10 chars + "…" + last 6 chars */
function trimToken(token) {
  if (!token) return "(unknown)";
  if (token.length <= 20) return token;
  return token.substring(0, 10) + "…" + token.substring(token.length - 6);
}
const DOMAIN            = process.env.DOMAIN || "apps-father.com";

function fail(msg) {
  console.error(`\n[revoke-tokens] FATAL: ${msg}`);
  process.exit(1);
}

if (!APPS_FATHER_TOKEN) fail("APPS_FATHER_TOKEN env var is required");
if (!ENCRYPTION_KEY)    fail("ENCRYPTION_KEY env var is required");

// ── CLI flags ───────────────────────────────────────────────────────────────
const APPLY = process.argv.includes("--apply");
const limitArg = process.argv.find(a => a.startsWith("--limit"));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1] ?? process.argv[process.argv.indexOf(limitArg) + 1], 10) : null;

// ── Helpers ──────────────────────────────────────────────────────────────────
const BOT_TOKEN_RE = /^\d{6,15}:[A-Za-z0-9_-]{30,80}$/;

function encryptToken(plain) {
  return CryptoJS.AES.encrypt(plain, ENCRYPTION_KEY).toString();
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex").substring(0, 16);
}

/** Call replaceManagedBotToken via the Bot API using the platform token. */
async function replaceManagedBotToken(botUserId) {
  const url = `https://api.telegram.org/bot${APPS_FATHER_TOKEN}/replaceManagedBotToken`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: Number(botUserId) }),
  });
  const json = await res.json();
  if (!json.ok) {
    throw new Error(`Telegram error: ${json.description || JSON.stringify(json)}`);
  }
  return json.result; // new token string
}

/** Register webhook for the newly issued token. */
async function setWebhook(newToken, webhookSecret) {
  const newHash = hashToken(newToken);
  const webhookUrl = `https://${DOMAIN}/webhook/${newHash}`;
  const url = `https://api.telegram.org/bot${newToken}/setWebhook`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: webhookSecret,
      allowed_updates: [],
    }),
  });
  const json = await res.json();
  if (!json.ok) {
    throw new Error(`setWebhook error: ${json.description || JSON.stringify(json)}`);
  }
  return webhookUrl;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "default-secret";

  console.log("════════════════════════════════════════════════════════════");
  console.log("  MANAGED BOT TOKEN REVOCATION");
  console.log("════════════════════════════════════════════════════════════");
  console.log(`  mode:    ${APPLY ? "⚡ APPLY — tokens will be revoked & DB updated" : "🔍 DRY-RUN — no API calls, no DB writes"}`);
  console.log(`  limit:   ${LIMIT ?? "all"}`);
  console.log(`  domain:  ${DOMAIN}`);
  console.log("────────────────────────────────────────────────────────────\n");

  const prisma = new PrismaClient();

  let ok = 0, skipped = 0, failed = 0;
  const failures = [];

  try {
    const rows = await prisma.project.findMany({
      where: { botUserId: { not: null }, botTokenEncrypted: { not: null } },
      select: { id: true, name: true, botUsername: true, botUserId: true, botTokenEncrypted: true },
      orderBy: { createdAt: "asc" },
      ...(LIMIT ? { take: LIMIT } : {}),
    });

    const total = rows.length;
    console.log(`Found ${total} project(s) with a managed bot${LIMIT ? ` (capped at ${LIMIT})` : ""}.\n`);

    if (total === 0) {
      console.log("Nothing to do.");
      return;
    }

    const CONCURRENCY = 20; // parallel workers
    const pad = String(total).length;

    if (!APPLY) {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const label = `@${row.botUsername || "?"}  [${row.id.substring(0, 8)}]  bot_id=${row.botUserId}`;
        const progress = `[${String(i + 1).padStart(pad, " ")}/${total}]`;
        const oldToken = row.botTokenEncrypted ? decryptToken(row.botTokenEncrypted) : null;
        console.log(`${progress}  🔍  ${label}`);
        console.log(`         old token: ${oldToken ? trimToken(oldToken) : "(could not decrypt)"}`);
        console.log(`         → would revoke`);
        ok++;
      }
    } else {
      // Process in parallel batches of CONCURRENCY
      for (let batch = 0; batch < rows.length; batch += CONCURRENCY) {
        const chunk = rows.slice(batch, batch + CONCURRENCY);

        const results = await Promise.allSettled(
          chunk.map(async (row, ci) => {
            const i = batch + ci;
            const label = `@${row.botUsername || "?"}  [${row.id.substring(0, 8)}]  bot_id=${row.botUserId}`;
            const progress = `[${String(i + 1).padStart(pad, " ")}/${total}]`;
            const oldToken = row.botTokenEncrypted ? decryptToken(row.botTokenEncrypted) : null;
            const oldDisplay = oldToken ? trimToken(oldToken) : "(could not decrypt)";

            try {
              const newToken = await replaceManagedBotToken(row.botUserId);

              if (!BOT_TOKEN_RE.test(newToken)) {
                throw new Error(`Invalid token format: "${newToken.substring(0, 20)}…"`);
              }

              // Give Telegram ~1s to activate the new token before setWebhook
              await new Promise(r => setTimeout(r, 1000));

              const webhookUrl = await setWebhook(newToken, WEBHOOK_SECRET);

              const encrypted = encryptToken(newToken);
              await prisma.project.update({
                where: { id: row.id },
                data: { botTokenEncrypted: encrypted },
              });

              console.log(`${progress}  ✅  ${label}`);
              console.log(`         old: ${oldDisplay}`);
              console.log(`         new: ${trimToken(newToken)}`);
              console.log(`         webhook: ${webhookUrl}`);
              return { ok: true };
            } catch (err) {
              const msg = err?.message || String(err);
              console.log(`${progress}  ❌  ${label}`);
              console.log(`         old: ${oldDisplay}`);
              console.log(`         error: ${msg}`);
              return { ok: false, label, reason: msg };
            }
          })
        );

        for (const r of results) {
          if (r.status === "fulfilled") {
            if (r.value.ok) { ok++; }
            else { failed++; failures.push({ label: r.value.label, reason: r.value.reason }); }
          } else {
            failed++;
            failures.push({ label: "unknown", reason: r.reason?.message || String(r.reason) });
          }
        }

        // Brief pause between batches
        if (batch + CONCURRENCY < rows.length) {
          await new Promise(r => setTimeout(r, 500));
        }
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log("\n────────────────────────────────────────────────────────────");
  console.log("  SUMMARY");
  console.log("────────────────────────────────────────────────────────────");
  if (!APPLY) {
    console.log(`  would revoke: ${ok}`);
    console.log("\n  DRY-RUN — no changes made. Re-run with --apply to execute.");
  } else {
    console.log(`  ✅ revoked & saved: ${ok}`);
    console.log(`  ❌ failed:          ${failed}`);
    if (failures.length) {
      console.log("\n  FAILURES:");
      for (const f of failures) {
        console.log(`    - ${f.label}`);
        console.log(`      ${f.reason}`);
      }
    }
    if (failed === 0) {
      console.log("\n  All tokens rotated. Apps-father will pick up new tokens");
      console.log("  on the next bot request (webhook cache auto-refreshes).");
    } else {
      console.log(`\n  ⚠️  ${failed} bot(s) failed. Investigate above and re-run.`);
      console.log("  Already-revoked bots will get a 'ALREADY_REVOKED' error");
      console.log("  and can be safely skipped.");
    }
  }

  process.exit(failed > 0 ? 2 : 0);
}

main().catch(err => {
  console.error("\n[revoke-tokens] uncaught error:", err);
  process.exit(1);
});
