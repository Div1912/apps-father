/**
 * TON monitor — polls the platform vault for incoming transactions relevant
 * to the App Store and dispatches them to the right service.
 *
 * Comment formats (text comments in TON transfers + jetton transfer
 * forward_payloads):
 *
 *   "publish:<listingId>"   — V1/V2 publishing fee (still supported)
 *   "lp_init:<listingId>"   — initial liquidity at publish (TON + Jetton legs)
 *   "lp_add:<listingId>"    — additional liquidity (TON + Jetton legs)
 *   "buy:<tradeId>"          — TON paid for a buy
 *   "sell:<tradeId>"         — accompanies the user's outgoing jetton transfer
 *
 * For LP events we need to pair two legs (TON + Jetton) sent in the same
 * batch by TonConnect. We buffer one leg in `pendingLegs` until its sibling
 * arrives, then commit the position atomically.
 *
 * The monitor is intentionally polling-based to match billing.service.ts
 * style (no websocket dependency, plays nicely with pm2 restarts).
 */

import { prisma } from "../db";
import { BillingService } from "./billing.service";
import {
  executeBuy, executeSell, markTradeSettled,
  applyLiquidityDeposit,
} from "./liquidity-amm.service";
import { payoutTon } from "./jetton.service";
import { runtimeConfig } from "./runtime-config.service";

const POLL_INTERVAL_MS = 30_000;
const PLATFORM_WALLET = BillingService.TON_WALLET;

interface IncomingTx {
  hash: string;
  valueNano: bigint;
  /** Jetton amount when this is a jetton-transfer notification, else 0n. */
  jettonAmount: bigint;
  jettonMaster?: string;
  comment: string;
  source?: string;
  utime: number;
}

function decodeTextComment(body: string): string {
  try {
    const { Cell } = require("@ton/core");
    const cell = Cell.fromBase64(body);
    const slice = cell.beginParse();
    if (!slice || slice.remainingBits < 32) return "";
    const op = slice.loadUint(32);
    if (op !== 0) return "";
    return slice.loadStringTail();
  } catch {
    return "";
  }
}

function extractComment(inMsg: any): string {
  const parts: string[] = [];
  const decoded = inMsg?.message_content?.decoded;
  if (decoded?.type === "text_comment" && decoded.comment) parts.push(String(decoded.comment));
  if (typeof inMsg?.message === "string") parts.push(inMsg.message);
  if (typeof inMsg?.comment === "string") parts.push(inMsg.comment);
  const body = inMsg?.message_content?.body || inMsg?.body;
  if (typeof body === "string" && body) {
    parts.push(body);
    const decodedBody = decodeTextComment(body);
    if (decodedBody) parts.push(decodedBody);
  }
  return parts.join("\n");
}

async function fetchRecentTxs(sinceSec: number): Promise<IncomingTx[]> {
  const url = `https://toncenter.com/api/v3/transactions?account=${encodeURIComponent(PLATFORM_WALLET)}&limit=50&sort=desc&start_utime=${sinceSec}`;
  const res = await fetch(url, { headers: { "Content-Type": "application/json" } });
  if (!res.ok) {
    console.warn(`[TonMonitor] toncenter ${res.status}`);
    return [];
  }
  const data: any = await res.json();
  const list = data.transactions || [];
  const out: IncomingTx[] = [];
  for (const tx of list) {
    const inMsg = tx.in_msg;
    if (!inMsg) continue;
    out.push({
      hash: tx.hash || tx.transaction_id?.hash || "",
      valueNano: BigInt(inMsg.value || "0"),
      jettonAmount: 0n,                               // populated by jetton-tx fetcher below
      comment: extractComment(inMsg),
      source: inMsg.source || inMsg.src,
      utime: Number(tx.now || tx.utime || 0),
    });
  }
  return out;
}

/**
 * Pull recent jetton transfers TO the platform vault. Toncenter exposes
 * these via /jetton/transfers; we filter by destination owner (the vault
 * main wallet, not its jetton wallet — toncenter resolves automatically).
 *
 * The `comment` field is reconstructed from the forward_payload text op
 * when present.
 */
async function fetchRecentJettonTransfers(sinceSec: number): Promise<IncomingTx[]> {
  const url = `https://toncenter.com/api/v3/jetton/transfers?direction=in&owner_address=${encodeURIComponent(PLATFORM_WALLET)}&limit=50&start_utime=${sinceSec}`;
  try {
    const res = await fetch(url, { headers: { "Content-Type": "application/json" } });
    if (!res.ok) return [];
    const data: any = await res.json();
    const list = data.jetton_transfers || data.transfers || [];
    const out: IncomingTx[] = [];
    for (const t of list) {
      let comment = "";
      try {
        const fp = t.forward_payload;
        if (typeof fp === "string" && fp.length) {
          comment = decodeTextComment(fp) || "";
        } else if (fp && typeof fp.value === "string") {
          comment = decodeTextComment(fp.value) || "";
        }
      } catch {}
      out.push({
        hash: t.transaction_hash || t.tx_hash || "",
        valueNano: 0n,
        jettonAmount: BigInt(t.amount || "0"),
        jettonMaster: t.jetton_master || t.master_address,
        comment,
        source: t.source_address || t.source || "",
        utime: Number(t.transaction_now || t.utime || 0),
      });
    }
    return out;
  } catch (err: any) {
    console.warn("[TonMonitor] jetton-transfers fetch failed:", err.message);
    return [];
  }
}

// ── Pairing buffer for LP legs ───────────────────────────────────────────────

interface PendingLeg {
  kind: "lp_init" | "lp_add";
  listingId: string;
  tonNano?: bigint;
  jettonAmount?: bigint;
  jettonMaster?: string;
  txHash: string;
  source: string;
  bufferedAt: number;
}

/**
 * In-memory buffer of LP legs. Keyed by `<kind>:<listingId>:<source>` so a
 * single user signing a single batch matches both legs. Drops entries
 * after 30 minutes (in case one leg never lands).
 */
const pendingLegs = new Map<string, PendingLeg>();
const LEG_TTL_MS = 30 * 60 * 1000;

function legKey(p: PendingLeg) {
  return `${p.kind}:${p.listingId}:${p.source}`;
}

function pruneStaleLegs() {
  const now = Date.now();
  for (const [k, v] of pendingLegs.entries()) {
    if (now - v.bufferedAt > LEG_TTL_MS) pendingLegs.delete(k);
  }
}

class TonMonitorService {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  start() {
    if (this.timer) return;
    console.log("[TonMonitor] Started");
    this.timer = setInterval(() => this.tick().catch((e) => console.error("[TonMonitor]", e)), POLL_INTERVAL_MS);
    setTimeout(() => this.tick().catch((e) => console.error("[TonMonitor]", e)), 5000);
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Run one matching pass — exposed so tests / admin can invoke on demand. */
  async tick() {
    if (this.running) return;
    if (!runtimeConfig.get().appStore.enabled) return;
    this.running = true;
    try {
      const since = Math.floor(Date.now() / 1000) - 24 * 3600;
      const [tonTxs, jettonTxs] = await Promise.all([
        fetchRecentTxs(since),
        fetchRecentJettonTransfers(since),
      ]);

      pruneStaleLegs();

      for (const tx of tonTxs) {
        await this.handleIncoming(tx, "ton");
      }
      for (const tx of jettonTxs) {
        await this.handleIncoming(tx, "jetton");
      }
    } finally {
      this.running = false;
    }
  }

  private async handleIncoming(tx: IncomingTx, leg: "ton" | "jetton") {
    if (!tx.comment) return;
    const m = tx.comment.match(/(publish|buy|sell|lp_init|lp_add):([a-zA-Z0-9-]+)/);
    if (!m) return;
    const [, kind, id] = m;
    try {
      if (kind === "publish")  await this.handlePublishFee(id, tx);
      else if (kind === "buy")  await this.handleBuy(id, tx);
      else if (kind === "sell") await this.handleSell(id, tx);
      else if (kind === "lp_init" || kind === "lp_add") {
        await this.handleLpLeg(kind as "lp_init" | "lp_add", id, tx, leg);
      }
    } catch (err: any) {
      console.warn(`[TonMonitor] ${kind}:${id} → ${err?.message || err}`);
    }
  }

  // ── Legacy publish-fee handler (kept for V1 compat) ─────────────────────

  private async handlePublishFee(listingId: string, tx: IncomingTx) {
    const listing = await prisma.appListing.findUnique({ where: { id: listingId } });
    if (!listing) return;
    if (listing.publishFeeTxHash) return;
    if (listing.status !== "submitting" && listing.status !== "ready") return;

    const expectedNano = BigInt(Math.round(runtimeConfig.get().appStore.publishFeeTon * 1e9));
    const minAcceptable = (expectedNano * 95n) / 100n;
    if (tx.valueNano < minAcceptable) {
      console.warn(`[TonMonitor] publish:${listingId} value ${tx.valueNano} < ${minAcceptable}`);
      return;
    }

    await prisma.appListing.update({
      where: { id: listingId },
      data: {
        status: "pending",
        publishFeeTxHash: tx.hash,
        submittedAt: new Date(),
      },
    });
    console.log(`[TonMonitor] Listing ${listingId} → pending (fee tx ${tx.hash})`);
  }

  // ── LP legs (pair TON + Jetton) ─────────────────────────────────────────

  private async handleLpLeg(
    kind: "lp_init" | "lp_add",
    listingId: string,
    tx: IncomingTx,
    leg: "ton" | "jetton",
  ) {
    const source = tx.source || "";
    if (!source) return;

    const key = `${kind}:${listingId}:${source}`;
    const existing = pendingLegs.get(key);

    if (!existing) {
      // First leg — buffer it.
      pendingLegs.set(key, {
        kind, listingId,
        tonNano: leg === "ton" ? tx.valueNano : undefined,
        jettonAmount: leg === "jetton" ? tx.jettonAmount : undefined,
        jettonMaster: leg === "jetton" ? tx.jettonMaster : undefined,
        txHash: tx.hash,
        source,
        bufferedAt: Date.now(),
      });
      console.log(`[TonMonitor] ${kind}:${listingId} buffered ${leg} leg from ${source}`);
      return;
    }

    // Second leg — merge and commit.
    const merged: PendingLeg = { ...existing };
    if (leg === "ton") merged.tonNano = tx.valueNano;
    else { merged.jettonAmount = tx.jettonAmount; merged.jettonMaster = tx.jettonMaster; }

    if (!merged.tonNano || !merged.jettonAmount) {
      // Still incomplete (shouldn't happen here, but be defensive).
      pendingLegs.set(key, merged);
      return;
    }

    pendingLegs.delete(key);
    await this.commitLpDeposit(kind, listingId, merged, tx.hash);
  }

  private async commitLpDeposit(
    kind: "lp_init" | "lp_add",
    listingId: string,
    legs: PendingLeg,
    secondLegTxHash: string,
  ) {
    const listing = await prisma.appListing.findUnique({
      where: { id: listingId }, include: { token: true },
    });
    if (!listing?.token) return;

    // Sanity: jetton master must match.
    if (
      legs.jettonMaster &&
      listing.token.jettonMasterAddress &&
      legs.jettonMaster !== listing.token.jettonMasterAddress
    ) {
      console.warn(`[TonMonitor] ${kind}:${listingId} jetton master mismatch (${legs.jettonMaster} vs ${listing.token.jettonMasterAddress})`);
      return;
    }

    // Look up internal user from the source wallet (best-effort: by Telegram-linked TON wallet).
    let userId: number | null = null;
    try {
      const proj = await prisma.project.findFirst({
        where: { id: listing.projectId },
        select: { userId: true, tonWallet: true },
      });
      if (proj?.tonWallet === legs.source) userId = proj.userId;
    } catch {}

    const result = await applyLiquidityDeposit({
      tokenId: listing.token.id,
      ownerWalletAddress: legs.source,
      userId,
      tonNanoIn: legs.tonNano!,
      tokensIn: legs.jettonAmount!,
      type: kind === "lp_init" ? "init" : "add",
      txHash: legs.txHash + "+" + secondLegTxHash,
    });

    if (kind === "lp_init") {
      await prisma.appListing.update({
        where: { id: listingId },
        data: {
          status: "published",
          publishedAt: new Date(),
          publishFeeTxHash: legs.txHash,
        },
      });
      console.log(`[TonMonitor] LP init committed for ${listingId}: shares=${result.shares}, ton=${result.newTonReserve}, tokens=${result.newTokenReserve}`);
    } else {
      console.log(`[TonMonitor] LP add committed for ${listingId}: shares=${result.shares}`);
    }
  }

  // ── Trades ─────────────────────────────────────────────────────────────

  private async handleBuy(tradeId: string, tx: IncomingTx) {
    const trade = await prisma.tokenTrade.findUnique({ where: { id: tradeId } });
    if (!trade) return;
    if (trade.status !== "pending_payment") return;
    if (trade.type !== "buy") return;

    const expected = trade.tonAmount;
    const minAcceptable = (expected * 98n) / 100n;
    if (tx.valueNano < minAcceptable) {
      console.warn(`[TonMonitor] buy:${tradeId} value ${tx.valueNano} < ${minAcceptable}`);
      return;
    }

    const userAddress = tx.source || "";

    const result = await executeBuy({
      tokenId: trade.tokenId,
      userId: trade.userId,
      tonInNano: tx.valueNano,
      tradeId: trade.id,
      txHashIn: tx.hash,
    });

    // V2: tokens come from the vault's jetton wallet (it received the
    // pool's tokens at publish). The platform hot wallet sends a
    // jetton-transfer from the vault → buyer. We keep `payoutTon` for
    // the legacy custodial path; for V2 this needs a `payoutJetton`
    // helper — added in jetton.service.ts as `mintJetton` is no longer
    // valid (master admin is the user, not us). For now we record the
    // settle status and let the admin payout queue dispatch on a
    // separate path. TODO: implement payoutJetton from vault.
    const token = await prisma.appToken.findUnique({ where: { id: trade.tokenId } });
    if (token?.jettonMasterAddress && userAddress) {
      console.log(`[TonMonitor] buy:${tradeId} settled in DB; jetton payout queued (token=${token.jettonMasterAddress}, to=${userAddress}, amount=${result.tokensOut})`);
    } else {
      console.warn(`[TonMonitor] buy:${tradeId} settled in DB but payout deferred (addr=${userAddress})`);
    }
  }

  private async handleSell(tradeId: string, tx: IncomingTx) {
    const trade = await prisma.tokenTrade.findUnique({ where: { id: tradeId } });
    if (!trade) return;
    if (trade.status !== "pending_payment") return;
    if (trade.type !== "sell") return;

    const result = await executeSell({
      tokenId: trade.tokenId,
      userId: trade.userId,
      tokensIn: trade.tokenAmount,
      tradeId: trade.id,
      txHashIn: tx.hash,
    });

    const userAddress = tx.source || "";
    if (userAddress) {
      try {
        const { txHash } = await payoutTon({
          to: userAddress,
          amountNano: result.tonOutNet,
          comment: `app-store:sell:${tradeId}`,
        });
        await markTradeSettled(trade.id, txHash);
      } catch (err: any) {
        console.error(`[TonMonitor] payout failed for ${trade.id}:`, err.message);
      }
    } else {
      console.warn(`[TonMonitor] sell:${tradeId} curve applied but payout deferred (no source addr)`);
    }
  }
}

export const tonMonitorService = new TonMonitorService();
