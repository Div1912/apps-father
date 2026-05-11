/**
 * Rotate the platform ENCRYPTION_KEY for every `projects.bot_token_encrypted`
 * row in the database.
 *
 * The encryption key (AES via crypto-js) protects bot tokens at rest. If the
 * key leaks, you can't just swap it in .env — `decryptToken` would silently
 * return garbage and every managed bot would fail to start.
 *
 * Behaviour:
 *   1. Reads OLD_ENCRYPTION_KEY and NEW_ENCRYPTION_KEY from env vars.
 *   2. Iterates every project that has a non-null bot_token_encrypted.
 *   3. Decrypts with OLD, validates the plaintext matches the Telegram bot
 *      token format (digits:base64ish), then re-encrypts with NEW and writes
 *      the row back.
 *   4. If a row already decrypts cleanly with NEW (interrupted previous run),
 *      it is skipped — the script is safe to re-run.
 *   5. Anything that decrypts cleanly with NEITHER key is logged as a
 *      failure and left untouched.
 *
 * Default mode is DRY-RUN. Pass --apply to actually write.
 *
 * Usage (on the server, in /opt/apps-father):
 *
 *   OLD_ENCRYPTION_KEY=<old hex> \
 *   NEW_ENCRYPTION_KEY=<new hex> \
 *   node scripts/rotate-encryption-key.js            # dry-run
 *
 *   OLD_ENCRYPTION_KEY=<old hex> \
 *   NEW_ENCRYPTION_KEY=<new hex> \
 *   node scripts/rotate-encryption-key.js --apply    # write
 */
const CryptoJS = require("crypto-js");
const { PrismaClient } = require("@prisma/client");

const OLD_KEY = process.env.OLD_ENCRYPTION_KEY;
const NEW_KEY = process.env.NEW_ENCRYPTION_KEY;
const APPLY = process.argv.includes("--apply");
const VERBOSE = process.argv.includes("--verbose");

const BOT_TOKEN_RE = /^\d{6,15}:[A-Za-z0-9_-]{30,80}$/;

function fail(msg) {
  console.error(`[rotate-encryption-key] FATAL: ${msg}`);
  process.exit(1);
}

if (!OLD_KEY) fail("OLD_ENCRYPTION_KEY env var is required");
if (!NEW_KEY) fail("NEW_ENCRYPTION_KEY env var is required");
if (OLD_KEY === NEW_KEY) fail("OLD_ENCRYPTION_KEY and NEW_ENCRYPTION_KEY are identical — nothing to do");
if (OLD_KEY.length < 32) fail(`OLD_ENCRYPTION_KEY looks too short (${OLD_KEY.length} chars). Aborting.`);
if (NEW_KEY.length < 32) fail(`NEW_ENCRYPTION_KEY looks too short (${NEW_KEY.length} chars). Aborting.`);

function tryDecrypt(encrypted, key) {
  try {
    const bytes = CryptoJS.AES.decrypt(encrypted, key);
    const plain = bytes.toString(CryptoJS.enc.Utf8);
    if (!plain) return null;
    return plain;
  } catch {
    return null;
  }
}

function encryptWith(plain, key) {
  return CryptoJS.AES.encrypt(plain, key).toString();
}

async function main() {
  console.log("============================================================");
  console.log(" ENCRYPTION KEY ROTATION");
  console.log("============================================================");
  console.log(` mode:    ${APPLY ? "APPLY (will write to DB)" : "DRY-RUN (no writes)"}`);
  console.log(` old key: ${OLD_KEY.substring(0, 8)}…${OLD_KEY.substring(OLD_KEY.length - 4)} (${OLD_KEY.length} chars)`);
  console.log(` new key: ${NEW_KEY.substring(0, 8)}…${NEW_KEY.substring(NEW_KEY.length - 4)} (${NEW_KEY.length} chars)`);
  console.log("------------------------------------------------------------");

  const prisma = new PrismaClient();

  try {
    const rows = await prisma.project.findMany({
      where: { botTokenEncrypted: { not: null } },
      select: { id: true, name: true, botUsername: true, botTokenEncrypted: true },
    });

    console.log(`Found ${rows.length} project(s) with an encrypted bot token.\n`);

    let migrated = 0;
    let alreadyNew = 0;
    let failed = 0;
    const failures = [];

    for (const row of rows) {
      const enc = row.botTokenEncrypted;
      const short = `${row.id.substring(0, 8)} (${row.botUsername || row.name || "?"})`;

      const plainOld = tryDecrypt(enc, OLD_KEY);
      if (plainOld && BOT_TOKEN_RE.test(plainOld)) {
        const reEncrypted = encryptWith(plainOld, NEW_KEY);

        const verify = tryDecrypt(reEncrypted, NEW_KEY);
        if (!verify || verify !== plainOld) {
          failed += 1;
          failures.push({ id: row.id, name: short, reason: "re-encrypt verify failed" });
          continue;
        }

        if (APPLY) {
          await prisma.project.update({
            where: { id: row.id },
            data: { botTokenEncrypted: reEncrypted },
          });
        }
        migrated += 1;
        if (VERBOSE) {
          console.log(`  [${APPLY ? "MIGRATED" : "would migrate"}] ${short}  →  token ${plainOld.substring(0, 10)}…`);
        }
        continue;
      }

      const plainNew = tryDecrypt(enc, NEW_KEY);
      if (plainNew && BOT_TOKEN_RE.test(plainNew)) {
        alreadyNew += 1;
        if (VERBOSE) {
          console.log(`  [SKIP — already on NEW key] ${short}`);
        }
        continue;
      }

      failed += 1;
      const reason = plainOld
        ? `OLD decrypts to invalid token (${plainOld.substring(0, 20)}…)`
        : plainNew
          ? `NEW decrypts to invalid token (${plainNew.substring(0, 20)}…)`
          : "neither OLD nor NEW key decrypts cleanly";
      failures.push({ id: row.id, name: short, reason });
    }

    console.log("\n------------------------------------------------------------");
    console.log(" SUMMARY");
    console.log("------------------------------------------------------------");
    console.log(` total scanned:           ${rows.length}`);
    console.log(` ${APPLY ? "migrated to NEW key:    " : "would be migrated:      "} ${migrated}`);
    console.log(` already on NEW key:      ${alreadyNew}`);
    console.log(` failed (left untouched): ${failed}`);

    if (failures.length > 0) {
      console.log("\n FAILURES:");
      for (const f of failures) {
        console.log(`  - ${f.name}  —  ${f.reason}`);
      }
    }

    if (!APPLY) {
      console.log("\n DRY-RUN — no rows were written. Re-run with --apply to commit.");
    } else if (failed === 0) {
      console.log("\n ✅ All tokens re-encrypted. NEXT STEPS:");
      console.log("   1. Update .env  →  ENCRYPTION_KEY=<the NEW value>");
      console.log("   2. Restart apps-father:  pm2 restart apps-father  (or full start)");
      console.log("   3. Watch the logs to confirm all bots load.");
    } else {
      console.log(`\n ⚠️  ${failed} row(s) failed and were left untouched. Investigate before swapping .env.`);
    }

    process.exit(failed === 0 ? 0 : 2);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("[rotate-encryption-key] uncaught error:", err);
  process.exit(1);
});
