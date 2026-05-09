/**
 * App Store — public endpoints (no auth required).
 *
 * All owner-authenticated endpoints (create draft, upload screenshots, submit,
 * trade) live in server.ts under /telegram-mini-app/api/store/* because they
 * need access to the shared validateAuth + getOrCreateUserFromReq helpers.
 *
 * Public surface:
 *   GET  /api/store/listings                   — browse (?tab=trending|new|top, ?q=, ?limit, ?offset)
 *   GET  /api/store/listings/:id               — single listing + token + trades + holders
 *   GET  /api/store/tokens/:id/metadata.json   — TIP-64 jetton metadata, served at the URL
 *                                                 stored in the on-chain master content cell
 *   GET  /api/store/tokens/:id/trades          — recent trade history for chart
 *   GET  /api/store/tokens/:id/quote           — buy/sell preview at current curve price
 */

import { Router, Request, Response } from "express";
import { prisma } from "../../db";
import { appStoreService } from "../../services/app-store.service";
import {
  quoteBuy, quoteSell,
  tonToNano, tokensToAtomic,
  type PoolState,
} from "../../services/liquidity-amm.service";
import { runtimeConfig } from "../../services/runtime-config.service";
import { config } from "../../config";

const router = Router();

router.get("/listings", async (req: Request, res: Response) => {
  try {
    const tab = (req.query.tab as string) || "new";
    if (!["trending", "new", "top"].includes(tab)) {
      res.status(400).json({ error: "Invalid tab" });
      return;
    }
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
    const offset = parseInt(req.query.offset as string) || 0;
    const q = (req.query.q as string) || "";
    const result = await appStoreService.listPublished({
      tab: tab as "trending" | "new" | "top",
      limit, offset, q,
    });
    res.json(result);
  } catch (err: any) {
    console.error("[Store] list error:", err);
    res.status(500).json({ error: err.message || "Internal error" });
  }
});

router.get("/listings/:id", async (req: Request, res: Response) => {
  try {
    const detail = await appStoreService.getTokenDetail(req.params.id as string);
    res.json(detail);
  } catch (err: any) {
    res.status(404).json({ error: err.message || "Not found" });
  }
});

/**
 * TIP-64 jetton metadata, matching the exact JSON shape produced by
 * minter.ton.org so any TON wallet (TonKeeper, MyTonWallet, Tonhub) renders
 * the token name / ticker / image consistently.
 *
 * Reference: https://github.com/ton-blockchain/TEPs/blob/master/text/0064-token-data-standard.md
 *
 * Output:
 *   {
 *     "name": "<App Name>",
 *     "description": "<optional, may be empty>",
 *     "symbol": "<TICKER>",
 *     "decimals": "9",            ← string (TIP-64 spec)
 *     "image": "https://..."      ← only included when a logo is set
 *   }
 */
router.get("/tokens/:id/metadata.json", async (req: Request, res: Response) => {
  try {
    const token = await prisma.appToken.findUnique({
      where: { id: req.params.id as string },
    }) as any;
    if (!token) { res.status(404).json({ error: "Not found" }); return; }

    const baseUrl = config.baseUrl;
    const projectId = token.projectId;

    const meta: Record<string, string> = {
      name: token.name,
      symbol: token.symbol,
      decimals: "9",
    };
    // Description is optional in TIP-64 and intentionally empty by default to
    // match minter.ton.org. We only emit it when the publisher explicitly set
    // a Jetton description on the token row.
    if (token.metadataDescription && String(token.metadataDescription).trim().length > 0) {
      meta.description = String(token.metadataDescription);
    }
    if (token.logoFilename) {
      meta.image = `${baseUrl}/bucket/${projectId}/${token.logoFilename}`;
    }

    res.set("Access-Control-Allow-Origin", "*");
    res.json(meta);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/tokens/:id/trades", async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const trades = await prisma.tokenTrade.findMany({
      where: { tokenId: req.params.id as string, status: { in: ["received", "settled"] } },
      orderBy: { createdAt: "asc" },
      take: limit,
      select: { id: true, type: true, tonAmount: true, tokenAmount: true, priceNanoTon: true, createdAt: true },
    });
    res.json({
      trades: trades.map((t) => ({
        id: t.id,
        type: t.type,
        tonAmount: Number(t.tonAmount) / 1e9,
        tokenAmount: Number(t.tokenAmount) / 1e9,
        priceTon: Number(t.priceNanoTon) / 1e9,
        createdAt: t.createdAt,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/tokens/:id/quote", async (req: Request, res: Response) => {
  try {
    const type = (req.query.type as string) || "buy";
    if (type !== "buy" && type !== "sell") {
      res.status(400).json({ error: "type must be buy|sell" }); return;
    }
    const amount = String(req.query.amount || "");
    if (!amount.match(/^\d+(\.\d+)?$/)) {
      res.status(400).json({ error: "amount must be a positive number" }); return;
    }

    const token = await prisma.appToken.findUnique({ where: { id: req.params.id as string } });
    if (!token) { res.status(404).json({ error: "Not found" }); return; }
    if (token.status !== "live") { res.status(400).json({ error: "Token not live" }); return; }

    const cfg = runtimeConfig.get().appStore;
    const state: PoolState = {
      realTonReserve: token.realTonReserve,
      realTokenReserve: token.realTokenReserve,
      lpTotalShares: token.lpTotalShares,
    };

    if (type === "buy") {
      const tonInNano = tonToNano(amount);
      const q = quoteBuy(state, tonInNano, cfg.tradingFeePercent);
      res.json({
        type: "buy",
        tonIn: amount,
        tokensOut: Number(q.tokensOut) / 1e9,
        feeTon: Number(q.feeNano) / 1e9,
        netTonIn: Number(q.netTonNano) / 1e9,
        priceTonPerToken: q.tokensOut > 0n
          ? (Number(tonInNano) / 1e9) / (Number(q.tokensOut) / 1e9)
          : 0,
      });
    } else {
      const tokensIn = tokensToAtomic(amount);
      const q = quoteSell(state, tokensIn, cfg.tradingFeePercent);
      res.json({
        type: "sell",
        tokensIn: amount,
        tonOutNet: Number(q.tonOutNet) / 1e9,
        tonOutGross: Number(q.tonOutGross) / 1e9,
        feeTon: Number(q.feeNano) / 1e9,
        priceTonPerToken: tokensIn > 0n
          ? (Number(q.tonOutGross) / 1e9) / (Number(tokensIn) / 1e9)
          : 0,
      });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** Pool state + (optional) caller's LP position. Used by the Liquidity card. */
router.get("/listings/:id/liquidity", async (req: Request, res: Response) => {
  try {
    const userWallet = (req.query.userWallet as string | undefined) || undefined;
    const data = await appStoreService.getLiquidityForListing(req.params.id as string, {
      userWalletAddress: userWallet,
    });
    res.json(data);
  } catch (err: any) {
    res.status(404).json({ error: err.message });
  }
});

/** Snapshot of publish-flow config (fees, LP defaults, vault address). */
router.get("/publish-config", async (_req: Request, res: Response) => {
  try {
    res.json(appStoreService.publishConfigSnapshot());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
