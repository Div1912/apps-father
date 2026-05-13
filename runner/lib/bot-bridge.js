/* eslint-disable */
"use strict";

const { Bot, webhookCallback } = require("grammy");

/**
 * Bot bridge — instantiates a grammY Bot for the project's release runtime
 * and dispatches Telegram updates received via /__worker/bot-update.
 *
 * The dispatch path is identical to the legacy in-process bot-runner:
 *   1. Build a fake req/res
 *   2. Hand the update to the loaded /bot-webhook handler if the user
 *      registered one, OR fall back to letting grammY route through.
 *
 * Phase 1 keeps it simple: we accept the raw Telegram update and forward it
 * through the loaded release runtime's Express router so /bot-webhook
 * registrations keep working as before. If the user's routes.js does NOT
 * expose /bot-webhook, we fall through to grammY's default dispatcher (which
 * processes commands/messages via bot.command(), bot.on(), etc. — none of
 * which user code typically registers in routes.js).
 */
function createBotBridge({ token, projectId, runtime }) {
  const bot = new Bot(token);

  async function handleUpdate(update) {
    if (!update || typeof update !== "object") {
      throw new Error("invalid_update");
    }

    if (!runtime.loaded || !runtime.cachedRouter) {
      throw new Error("runtime_not_loaded");
    }

    // Try to dispatch through the user's /bot-webhook handler if it exists.
    const dispatched = await dispatchToWebhookRoute(runtime.cachedRouter, update);
    if (dispatched) return;

    // Fallback: process via grammY directly (best-effort — most projects
    // don't have anything registered here).
    try {
      await bot.handleUpdate(update);
    } catch (err) {
      console.error(`[worker:bot] grammy dispatch failed:`, err && err.message);
    }
  }

  return { handleUpdate };
}

function dispatchToWebhookRoute(router, update) {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (val) => {
      if (resolved) return;
      resolved = true;
      resolve(val);
    };

    const fakeReq = {
      method: "POST",
      url: "/bot-webhook",
      path: "/bot-webhook",
      headers: { "content-type": "application/json" },
      body: update,
      // Tell body-parser the body is already parsed — prevents it from trying
      // to pipe a non-existent stream and swallowing the route handler call.
      _body: true,
      params: {},
      query: {},
      get(h) { return h === "content-type" ? "application/json" : undefined; },
    };
    const fakeRes = {
      statusCode: 200,
      _headers: {},
      get headersSent() { return resolved; },
      setHeader(k, v) { this._headers[k] = v; },
      status(code) { this.statusCode = code; return this; },
      json() { done(true); return this; },
      send() { done(true); return this; },
      end() { done(true); return this; },
      get() { return undefined; },
      set() { return this; },
      type() { return this; },
    };

    let matched = false;
    const stack = (router && router.stack) || [];
    for (const layer of stack) {
      const route = layer && layer.route;
      const routePath = route && route.path;
      const matches = Array.isArray(routePath)
        ? routePath.includes("/bot-webhook")
        : routePath === "/bot-webhook";
      if (matches && route && route.methods && route.methods.post) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      return done(false);
    }

    try {
      router(fakeReq, fakeRes, () => done(true));
    } catch (err) {
      console.error(`[worker:bot] route dispatch error:`, err && err.message);
      done(true);
    }

    setTimeout(() => done(true), 5_000);
  });
}

module.exports = { createBotBridge };
