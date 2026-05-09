/**
 * Custodial bonding-curve service.
 *
 * Pump.fun-style virtual constant-product market maker. Reserves and supply
 * live in our DB; trades are settled by our backend (TonConnect TON in/out
 * + jetton mint/burn from the platform hot wallet).
 *
 * Curve formula:  x * y = k  with virtual reserves
 *   x = virtualTonReserve + realTonReserve  (TON, in nanoTON)
 *   y = virtualTokenReserve - soldSupply     (tokens, in atomic units)
 *   k = virtualTonReserve₀ * virtualTokenReserve₀  (constant from launch)
 *
 * Buy `Δx` TON in (after fee subtracted):
 *   Δy = y - k / (x + Δx)         ← tokens minted
 *
 * Sell `Δy` tokens in:
 *   Δx_gross = x - k / (y + Δy)   ← TON the curve gives back
 *   user receives Δx_gross × (1 - fee%)
 *   fee is taken from the gross amount, NOT added on top of reserves.
 *
 * All math here is BigInt (nanoTON / atomic token units). Public quote APIs
 * also expose floating numbers for the UI but the source of truth is BigInt.
 */

import { prisma } from "../db";
import { runtimeConfig } from "./runtime-config.service";

// 1 TON = 10^9 nanoTON. Our token decimals = 9 (matches TON convention).
export const NANO = 1_000_000_000n;
export const TOKEN_DECIMALS = 9;
const TOKEN_UNIT = 1_000_000_000n;

export function tonToNano(ton: number | string): bigint {
  const s = String(ton);
  if (!s.match(/^-?\d+(\.\d+)?$/)) throw new Error(`tonToNano: invalid number ${s}`);
  const [whole, frac = ""] = s.split(".");
  const fracPadded = (frac + "000000000").slice(0, 9);
  return BigInt(whole) * NANO + BigInt(fracPadded || "0");
}

export function nanoToTon(nano: bigint): number {
  return Number(nano) / Number(NANO);
}

export function tokensToAtomic(tokens: number | string): bigint {
  return tonToNano(tokens);
}

export function atomicToTokens(atomic: bigint): number {
  return Number(atomic) / Number(TOKEN_UNIT);
}

// ── Pure curve math ──────────────────────────────────────────────────────────

export interface CurveState {
  virtualTonReserve: bigint;
  virtualTokenReserve: bigint;
  realTonReserve: bigint;
  soldSupply: bigint;
  curveSupplyCap: bigint;
}

/**
 * Quote a buy: how many tokens does the user get for `tonIn` (gross,
 * including fee)? Returns { tokensOut, feeNano, netTonNano }.
 */
export function quoteBuy(
  state: CurveState,
  tonInNano: bigint,
  feePercent: number,
): { tokensOut: bigint; feeNano: bigint; netTonNano: bigint } {
  if (tonInNano <= 0n) {
    return { tokensOut: 0n, feeNano: 0n, netTonNano: 0n };
  }

  // Fee taken from the gross. Use 1bps precision (×10000).
  const feeBps = BigInt(Math.round(feePercent * 100));
  const feeNano = (tonInNano * feeBps) / 10_000n;
  const netTon = tonInNano - feeNano;

  const x = state.virtualTonReserve + state.realTonReserve;
  const y = state.virtualTokenReserve - state.soldSupply;
  const k = state.virtualTonReserve * state.virtualTokenReserve;

  // Δy = y - k / (x + Δx)
  const newX = x + netTon;
  const newY = k / newX;
  let tokensOut = y - newY;
  if (tokensOut < 0n) tokensOut = 0n;

  // Cap at remaining curve supply (curveSupplyCap - soldSupply).
  const remaining = state.curveSupplyCap - state.soldSupply;
  if (tokensOut > remaining) tokensOut = remaining;

  return { tokensOut, feeNano, netTonNano: netTon };
}

/**
 * Quote a sell: how much TON does the user get for `tokensIn`?
 * Returns { tonOutNet, tonOutGross, feeNano }.
 */
export function quoteSell(
  state: CurveState,
  tokensIn: bigint,
  feePercent: number,
): { tonOutNet: bigint; tonOutGross: bigint; feeNano: bigint } {
  if (tokensIn <= 0n || tokensIn > state.soldSupply) {
    return { tonOutNet: 0n, tonOutGross: 0n, feeNano: 0n };
  }

  const x = state.virtualTonReserve + state.realTonReserve;
  const y = state.virtualTokenReserve - state.soldSupply;
  const k = state.virtualTonReserve * state.virtualTokenReserve;

  // Δx = x - k / (y + Δy)
  const newY = y + tokensIn;
  const newX = k / newY;
  let tonOutGross = x - newX;
  if (tonOutGross < 0n) tonOutGross = 0n;

  // Sells must be coverable by the real reserve (the virtual portion is
  // the launch seed and stays in the curve forever).
  if (tonOutGross > state.realTonReserve) tonOutGross = state.realTonReserve;

  const feeBps = BigInt(Math.round(feePercent * 100));
  const feeNano = (tonOutGross * feeBps) / 10_000n;
  const tonOutNet = tonOutGross - feeNano;

  return { tonOutNet, tonOutGross, feeNano };
}

/** Current spot price of one whole token in nanoTON. */
export function spotPriceNano(state: CurveState): bigint {
  const x = state.virtualTonReserve + state.realTonReserve;
  const y = state.virtualTokenReserve - state.soldSupply;
  if (y <= 0n) return 0n;
  // price-per-atomic-unit = x / y, scale up to 1 token = 10^9 atomic.
  return (x * TOKEN_UNIT) / y;
}

/** Total fully-diluted market cap in nanoTON. */
export function marketCapNano(state: CurveState, totalSupply: bigint): bigint {
  const price = spotPriceNano(state);
  return (price * totalSupply) / TOKEN_UNIT;
}

// ── Curve construction ──────────────────────────────────────────────────────

/**
 * Build the initial reserves for a brand-new token. `totalSupply` and
 * `curveSupplyCap` are in whole tokens (will be scaled to atomic units).
 */
export function makeInitialReserves(opts?: {
  initialVirtualTon?: number;
  totalSupply?: number;
  curveSupplyShare?: number;
}): {
  virtualTonReserve: bigint;
  virtualTokenReserve: bigint;
  totalSupply: bigint;
  curveSupplyCap: bigint;
} {
  const cfg = runtimeConfig.get().appStore;
  const initialVirtualTon = opts?.initialVirtualTon ?? cfg.initialVirtualTon;
  const totalSupplyTokens = opts?.totalSupply ?? cfg.tokenTotalSupply;
  const curveShare = opts?.curveSupplyShare ?? cfg.curveSupplyShare;

  const virtualTonReserve = tonToNano(initialVirtualTon);
  const totalSupply = tokensToAtomic(totalSupplyTokens);
  const curveSupplyCap =
    (totalSupply * BigInt(Math.round(curveShare * 1_000_000))) / 1_000_000n;
  // Virtual token reserve = full curve cap so initial price = vTon / supply.
  const virtualTokenReserve = curveSupplyCap;

  return { virtualTonReserve, virtualTokenReserve, totalSupply, curveSupplyCap };
}

// ── DB-transactional buy / sell ──────────────────────────────────────────────

export interface ExecuteBuyResult {
  tokenId: string;
  userId: number;
  tokensOut: bigint;
  feeNano: bigint;
  priceNano: bigint;     // effective price for this trade
  newSoldSupply: bigint;
  newRealTonReserve: bigint;
}

/**
 * Apply a confirmed buy to the DB inside a transaction:
 *   - re-quote with the latest reserves (snapshot from this tx)
 *   - update reserves + soldSupply on the token row
 *   - upsert the user's holding (balance + new avg buy price)
 *   - update fee balances
 *
 * NB: The trade row itself is created by the routes layer (status flips
 * pending_payment → received) and passed in for status updates.
 */
export async function executeBuy(opts: {
  tokenId: string;
  userId: number;
  tonInNano: bigint;
  tradeId: string;
  txHashIn?: string;
}): Promise<ExecuteBuyResult> {
  const cfg = runtimeConfig.get().appStore;
  const feePercent = cfg.tradingFeePercent;
  const creatorShare = cfg.creatorFeeShare;

  return prisma.$transaction(async (tx) => {
    const token = await tx.appToken.findUniqueOrThrow({ where: { id: opts.tokenId } });
    if (token.status !== "live") throw new Error(`Token ${opts.tokenId} is not live`);

    const state: CurveState = {
      virtualTonReserve: token.virtualTonReserve,
      virtualTokenReserve: token.virtualTokenReserve,
      realTonReserve: token.realTonReserve,
      soldSupply: token.soldSupply,
      curveSupplyCap: token.curveSupplyCap,
    };

    const { tokensOut, feeNano, netTonNano } = quoteBuy(state, opts.tonInNano, feePercent);
    if (tokensOut <= 0n) throw new Error("Buy yields zero tokens — curve exhausted or amount too small");

    const newSoldSupply = token.soldSupply + tokensOut;
    const newRealTonReserve = token.realTonReserve + netTonNano;
    const creatorFee = (feeNano * BigInt(Math.round(creatorShare * 1_000_000))) / 1_000_000n;
    const platformFee = feeNano - creatorFee;
    const priceNano = (opts.tonInNano * TOKEN_UNIT) / tokensOut;

    await tx.appToken.update({
      where: { id: opts.tokenId },
      data: {
        soldSupply: newSoldSupply,
        realTonReserve: newRealTonReserve,
        feeBalanceNanoTon: token.feeBalanceNanoTon + platformFee,
        creatorFeeBalanceNanoTon: token.creatorFeeBalanceNanoTon + creatorFee,
      },
    });

    // Upsert holding with weighted-average buy price.
    const holding = await tx.tokenHolding.findUnique({
      where: { tokenId_userId: { tokenId: opts.tokenId, userId: opts.userId } },
    });
    let newBalance: bigint;
    let newAvg: bigint;
    if (!holding) {
      newBalance = tokensOut;
      newAvg = priceNano;
    } else {
      newBalance = holding.balance + tokensOut;
      // weighted: (oldBal*oldAvg + tokensOut*price) / newBal
      newAvg = newBalance > 0n
        ? (holding.balance * holding.avgBuyNanoTon + tokensOut * priceNano) / newBalance
        : 0n;
    }
    await tx.tokenHolding.upsert({
      where: { tokenId_userId: { tokenId: opts.tokenId, userId: opts.userId } },
      create: {
        tokenId: opts.tokenId,
        userId: opts.userId,
        balance: newBalance,
        avgBuyNanoTon: newAvg,
      },
      update: { balance: newBalance, avgBuyNanoTon: newAvg },
    });

    await tx.tokenTrade.update({
      where: { id: opts.tradeId },
      data: {
        tokenAmount: tokensOut,
        priceNanoTon: priceNano,
        feeTonAmount: feeNano,
        txHashIn: opts.txHashIn,
        status: "received",
      },
    });

    // Cached counters on the listing row (volume + market cap) — useful for
    // fast Trending sort. 24h volume is approximated as a rolling sum that
    // a separate cron trims; here we just bump it.
    const newState: CurveState = {
      ...state,
      soldSupply: newSoldSupply,
      realTonReserve: newRealTonReserve,
    };
    const mcap = marketCapNano(newState, token.totalSupply);
    await tx.appListing.update({
      where: { id: token.listingId },
      data: {
        volume24hNanoTon: { increment: opts.tonInNano },
        marketCapNanoTon: mcap,
      },
    });

    return {
      tokenId: opts.tokenId,
      userId: opts.userId,
      tokensOut,
      feeNano,
      priceNano,
      newSoldSupply,
      newRealTonReserve,
    };
  });
}

export interface ExecuteSellResult {
  tokenId: string;
  userId: number;
  tonOutNet: bigint;
  feeNano: bigint;
  priceNano: bigint;
  newSoldSupply: bigint;
  newRealTonReserve: bigint;
}

/**
 * Apply a confirmed sell to the DB. The user has already sent jettons to
 * the platform wallet; the backend will then send TON back.
 */
export async function executeSell(opts: {
  tokenId: string;
  userId: number;
  tokensIn: bigint;
  tradeId: string;
  txHashIn?: string;
}): Promise<ExecuteSellResult> {
  const cfg = runtimeConfig.get().appStore;
  const feePercent = cfg.tradingFeePercent;
  const creatorShare = cfg.creatorFeeShare;

  return prisma.$transaction(async (tx) => {
    const token = await tx.appToken.findUniqueOrThrow({ where: { id: opts.tokenId } });
    if (token.status !== "live") throw new Error(`Token ${opts.tokenId} is not live`);

    const state: CurveState = {
      virtualTonReserve: token.virtualTonReserve,
      virtualTokenReserve: token.virtualTokenReserve,
      realTonReserve: token.realTonReserve,
      soldSupply: token.soldSupply,
      curveSupplyCap: token.curveSupplyCap,
    };

    const { tonOutNet, tonOutGross, feeNano } = quoteSell(state, opts.tokensIn, feePercent);
    if (tonOutGross <= 0n) throw new Error("Sell yields zero TON");

    const newSoldSupply = token.soldSupply - opts.tokensIn;
    const newRealTonReserve = token.realTonReserve - tonOutGross;
    const creatorFee = (feeNano * BigInt(Math.round(creatorShare * 1_000_000))) / 1_000_000n;
    const platformFee = feeNano - creatorFee;
    const priceNano = (tonOutGross * TOKEN_UNIT) / opts.tokensIn;

    await tx.appToken.update({
      where: { id: opts.tokenId },
      data: {
        soldSupply: newSoldSupply,
        realTonReserve: newRealTonReserve,
        feeBalanceNanoTon: token.feeBalanceNanoTon + platformFee,
        creatorFeeBalanceNanoTon: token.creatorFeeBalanceNanoTon + creatorFee,
      },
    });

    // Decrement holding (validation done by caller / earlier code path).
    const holding = await tx.tokenHolding.findUnique({
      where: { tokenId_userId: { tokenId: opts.tokenId, userId: opts.userId } },
    });
    if (!holding || holding.balance < opts.tokensIn) {
      throw new Error("Insufficient holding for sell");
    }
    const newBalance = holding.balance - opts.tokensIn;
    await tx.tokenHolding.update({
      where: { tokenId_userId: { tokenId: opts.tokenId, userId: opts.userId } },
      data: { balance: newBalance },
    });

    await tx.tokenTrade.update({
      where: { id: opts.tradeId },
      data: {
        tonAmount: tonOutNet,   // user-received TON, denormalised for charts
        priceNanoTon: priceNano,
        feeTonAmount: feeNano,
        txHashIn: opts.txHashIn,
        status: "received",
      },
    });

    const newState: CurveState = {
      ...state,
      soldSupply: newSoldSupply,
      realTonReserve: newRealTonReserve,
    };
    const mcap = marketCapNano(newState, token.totalSupply);
    await tx.appListing.update({
      where: { id: token.listingId },
      data: {
        volume24hNanoTon: { increment: tonOutGross },
        marketCapNanoTon: mcap,
      },
    });

    return {
      tokenId: opts.tokenId,
      userId: opts.userId,
      tonOutNet,
      feeNano,
      priceNano,
      newSoldSupply,
      newRealTonReserve,
    };
  });
}

/** Mark a trade as `settled` (outgoing tx hash is known). */
export async function markTradeSettled(tradeId: string, txHashOut?: string) {
  await prisma.tokenTrade.update({
    where: { id: tradeId },
    data: { status: "settled", txHashOut, settledAt: new Date() },
  });
}
