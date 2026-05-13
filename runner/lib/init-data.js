/* eslint-disable */
"use strict";

const crypto = require("crypto");

/**
 * HMAC-SHA256 verifier for Telegram WebApp initData. Identical semantics to
 * src/web/middleware/initdata.ts on the platform side — kept as a separate
 * file so the worker can populate `req.telegramUser` for handlers that read
 * it without going back through main.
 *
 * Phase 1: not actively wired into the per-runtime mount points (the proxy
 * forwards verified initData from main as a header). This module exists so
 * future iterations can plug it in without re-deriving the math.
 */
function validateTelegramInitData(initData, botToken) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return false;

    params.delete("hash");
    const entries = Array.from(params.entries());
    entries.sort(([a], [b]) => a.localeCompare(b));
    const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(botToken)
      .digest();

    const computedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    return computedHash === hash;
  } catch {
    return false;
  }
}

function parseInitDataUser(initData) {
  try {
    const params = new URLSearchParams(initData);
    const userStr = params.get("user");
    if (!userStr) return null;
    return JSON.parse(userStr);
  } catch {
    return null;
  }
}

module.exports = { validateTelegramInitData, parseInitDataUser };
