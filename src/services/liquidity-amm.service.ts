/**
 * Liquidity AMM service — V2 of the App Store token economy.
 *
 * Replaces the virtual-reserve bonding curve with a real Uniswap-V2-style
 * constant-product pool:
 *
 *   x = realTonReserve   (nanoTON held by platform vault)
 *   y = realTokenReserve (atomic Jettons held by platform vault)
 *   k = x * y            (invariant, only changes on add/remove liquidity)
 *
 * Trading (constant-product, fee subtracted from the input):
 *   buy : Δy = y * (Δx_net) / (x + Δx_net)
 *   sell: Δx = x * (Δy)     / (y + Δy)
 *   spot price = x / y     (TON per atomic token)
 *
 * Liquidity (Uniswap V2-style shares):
 *   first add → shares = floor(sqrt(Δx * Δy))
 *   later add → shares = min(Δx * S / x, Δy * S / y)   (S = lpTotalShares)
 *   remove    → tonOut   = shares * x / S
 *               tokenOut = shares * y / S
 *
 * The platform vault custodies the TON + Jettons; the LP "ownership" is
 * tracked off-chain via the LiquidityPosition table (keyed by the
 * publisher's TON wallet address). This is intentionally simpler than
 * minting on-chain LP jettons — we use the publisher's ownership address
 * as the source of truth, which matches how the user signs every deposit
 * and withdrawal from their own TonConnect wallet.
 */

import { prisma } from "../db";
import { runtimeConfig } from "./runtime-config.service";

export const NANO = 1_000_000_000n;
export const TOKEN_UNIT = 1_000_000_000n;

// ── Number / unit conversion ─────────────────────────────────────────────────

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

// Integer sqrt for BigInt (Newton's method).
function bigintSqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("sqrt of negative");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) >> 1n;
  while (y < x) {
    x = y;
    y = (x + n / x) >> 1n;
  }
  return x;
}

// ── Pure AMM math ────────────────────────────────────────────────────────────

export interface PoolState {
  realTonReserve: bigint;
  realTokenReserve: bigint;
  lpTotalShares: bigint;
}

export interface BuyQuote {
  tokensOut: bigint;
  feeNano: bigint;
  netTonNano: bigint;
  newTonReserve: bigint;
  newTokenReserve: bigint;
  priceImpactBps: number;
}

export interface SellQuote {
  tonOutNet: bigint;
  tonOutGross: bigint;
  feeNano: bigint;
  newTonReserve: bigint;
  newTokenReserve: bigint;
  priceImpactBps: number;
}

/**
 * Quote a buy. `tonInNano` is the gross TON the user pays. Fee is taken
 * off the input before the swap, in line with most DEXes.
 */
export function quoteBuy(state: PoolState, tonInNano: bigint, feePercent: number): BuyQuote {
  if (tonInNano <= 0n || state.realTonReserve <= 0n || state.realTokenReserve <= 0n) {
    return {
      tokensOut: 0n, feeNano: 0n, netTonNano: 0n,
      newTonReserve: state.realTonReserve, newTokenReserve: state.realTokenReserve,
      priceImpactBps: 0,
    };
  }
  const feeBps = BigInt(Math.round(feePercent * 100));
  const feeNano = (tonInNano * feeBps) / 10_000n;
  const netTon = tonInNano - feeNano;

  const x = state.realTonReserve;
  const y = state.realTokenReserve;
  // Δy = y * Δx / (x + Δx)
  const tokensOut = (y * netTon) / (x + netTon);

  const newX = x + netTon;
  const newY = y - tokensOut;

  // Spot price moves x/y → newX/newY. Impact = |Δprice| / oldPrice.
  let impactBps = 0;
  if (y > 0n && newY > 0n) {
    // (newX/newY - x/y) / (x/y) = (newX*y - x*newY) / (x*newY)
    const num = newX * y - x * newY;
    const den = x * newY;
    if (den > 0n) impactBps = Number((num * 10_000n) / den);
  }

  return {
    tokensOut, feeNano, netTonNano: netTon,
    newTonReserve: newX, newTokenReserve: newY,
    priceImpactBps: impactBps,
  };
}

/** Quote a sell. `tokensIn` is in atomic units. Fee comes off TON output. */
export function quoteSell(state: PoolState, tokensIn: bigint, feePercent: number): SellQuote {
  if (tokensIn <= 0n || state.realTonReserve <= 0n || state.realTokenReserve <= 0n) {
    return {
      tonOutNet: 0n, tonOutGross: 0n, feeNano: 0n,
      newTonReserve: state.realTonReserve, newTokenReserve: state.realTokenReserve,
      priceImpactBps: 0,
    };
  }

  const x = state.realTonReserve;
  const y = state.realTokenReserve;
  // Δx = x * Δy / (y + Δy)
  let tonOutGross = (x * tokensIn) / (y + tokensIn);
  if (tonOutGross > x) tonOutGross = x;

  const feeBps = BigInt(Math.round(feePercent * 100));
  const feeNano = (tonOutGross * feeBps) / 10_000n;
  const tonOutNet = tonOutGross - feeNano;

  const newX = x - tonOutGross;
  const newY = y + tokensIn;

  let impactBps = 0;
  if (y > 0n && newY > 0n) {
    const num = x * newY - newX * y;
    const den = x * newY;
    if (den > 0n) impactBps = Number((num * 10_000n) / den);
  }

  return {
    tonOutNet, tonOutGross, feeNano,
    newTonReserve: newX, newTokenReserve: newY,
    priceImpactBps: impactBps,
  };
}

/** Spot price in nanoTON per WHOLE token. */
export function spotPriceNano(state: PoolState): bigint {
  if (state.realTokenReserve <= 0n) return 0n;
  return (state.realTonReserve * TOKEN_UNIT) / state.realTokenReserve;
}

/** Fully-diluted market cap (price × totalSupply), in nanoTON. */
export function marketCapNano(state: PoolState, totalSupply: bigint): bigint {
  return (spotPriceNano(state) * totalSupply) / TOKEN_UNIT;
}

// ── Liquidity math ───────────────────────────────────────────────────────────

export interface LiquidityAddQuote {
  shares: bigint;
  /** Adjusted TON to deposit (caller may have been over-quoted). */
  tonNano: bigint;
  /** Adjusted tokens to deposit (caller may have been over-quoted). */
  tokensAtomic: bigint;
  /** True for first-ever deposit; price is set entirely by caller. */
  isFirstDeposit: boolean;
}

/**
 * Quote how many LP shares the depositor receives. For non-empty pools the
 * smaller of the two ratios decides (excess of the other side is silently
 * truncated — the pool keeps its current price untouched).
 */
export function quoteAddLiquidity(
  state: PoolState,
  tonNanoIn: bigint,
  tokensIn: bigint,
): LiquidityAddQuote {
  if (state.lpTotalShares === 0n) {
    if (tonNanoIn <= 0n || tokensIn <= 0n) {
      throw new Error("First liquidity must include both TON and tokens");
    }
    const shares = bigintSqrt(tonNanoIn * tokensIn);
    return { shares, tonNano: tonNanoIn, tokensAtomic: tokensIn, isFirstDeposit: true };
  }

  if (state.realTonReserve <= 0n || state.realTokenReserve <= 0n) {
    throw new Error("Pool reserves are empty (impossible — corrupt state)");
  }

  const sharesFromTon    = (tonNanoIn * state.lpTotalShares) / state.realTonReserve;
  const sharesFromTokens = (tokensIn  * state.lpTotalShares) / state.realTokenReserve;

  // Use the smaller side; truncate the other so the price stays put.
  if (sharesFromTon < sharesFromTokens) {
    const requiredTokens = (tonNanoIn * state.realTokenReserve) / state.realTonReserve;
    return {
      shares: sharesFromTon,
      tonNano: tonNanoIn,
      tokensAtomic: requiredTokens,
      isFirstDeposit: false,
    };
  } else {
    const requiredTon = (tokensIn * state.realTonReserve) / state.realTokenReserve;
    return {
      shares: sharesFromTokens,
      tonNano: requiredTon,
      tokensAtomic: tokensIn,
      isFirstDeposit: false,
    };
  }
}

export interface LiquidityRemoveQuote {
  tonNanoOut: bigint;
  tokensOut: bigint;
}

export function quoteRemoveLiquidity(state: PoolState, sharesToBurn: bigint): LiquidityRemoveQuote {
  if (sharesToBurn <= 0n || state.lpTotalShares <= 0n) return { tonNanoOut: 0n, tokensOut: 0n };
  if (sharesToBurn > state.lpTotalShares) throw new Error("Cannot burn more than total shares");
  const tonNanoOut = (sharesToBurn * state.realTonReserve)   / state.lpTotalShares;
  const tokensOut  = (sharesToBurn * state.realTokenReserve) / state.lpTotalShares;
  return { tonNanoOut, tokensOut };
}

// ── DB-transactional ops ─────────────────────────────────────────────────────

export interface ExecuteBuyResult {
  tokenId: string;
  userId: number;
  tokensOut: bigint;
  feeNano: bigint;
  priceNano: bigint;
}

export async function executeBuy(opts: {
  tokenId: string;
  userId: number;
  tonInNano: bigint;
  tradeId: string;
  txHashIn?: string;
}): Promise<ExecuteBuyResult> {
  const cfg = runtimeConfig.get().appStore;
  return prisma.$transaction(async (tx) => {
    const token = await tx.appToken.findUniqueOrThrow({ where: { id: opts.tokenId } });
    if (token.status !== "live") throw new Error(`Token not live (status=${token.status})`);

    const state: PoolState = {
      realTonReserve: token.realTonReserve,
      realTokenReserve: token.realTokenReserve,
      lpTotalShares: token.lpTotalShares,
    };
    const q = quoteBuy(state, opts.tonInNano, cfg.tradingFeePercent);
    if (q.tokensOut <= 0n) throw new Error("Buy yields zero tokens");

    const creatorFee = (q.feeNano * BigInt(Math.round(cfg.creatorFeeShare * 1_000_000))) / 1_000_000n;
    const platformFee = q.feeNano - creatorFee;
    const priceNano = (opts.tonInNano * TOKEN_UNIT) / q.tokensOut;

    await tx.appToken.update({
      where: { id: opts.tokenId },
      data: {
        realTonReserve: q.newTonReserve,
        realTokenReserve: q.newTokenReserve,
        soldSupply: { increment: q.tokensOut },
        feeBalanceNanoTon: { increment: platformFee },
        creatorFeeBalanceNanoTon: { increment: creatorFee },
      },
    });

    // Holding upsert with weighted-avg buy.
    const holding = await tx.tokenHolding.findUnique({
      where: { tokenId_userId: { tokenId: opts.tokenId, userId: opts.userId } },
    });
    let newBalance: bigint, newAvg: bigint;
    if (!holding) { newBalance = q.tokensOut; newAvg = priceNano; }
    else {
      newBalance = holding.balance + q.tokensOut;
      newAvg = newBalance > 0n
        ? (holding.balance * holding.avgBuyNanoTon + q.tokensOut * priceNano) / newBalance
        : 0n;
    }
    await tx.tokenHolding.upsert({
      where: { tokenId_userId: { tokenId: opts.tokenId, userId: opts.userId } },
      create: { tokenId: opts.tokenId, userId: opts.userId, balance: newBalance, avgBuyNanoTon: newAvg },
      update: { balance: newBalance, avgBuyNanoTon: newAvg },
    });

    await tx.tokenTrade.update({
      where: { id: opts.tradeId },
      data: {
        tokenAmount: q.tokensOut,
        priceNanoTon: priceNano,
        feeTonAmount: q.feeNano,
        txHashIn: opts.txHashIn,
        status: "received",
      },
    });

    const newState: PoolState = {
      realTonReserve: q.newTonReserve,
      realTokenReserve: q.newTokenReserve,
      lpTotalShares: token.lpTotalShares,
    };
    const mcap = marketCapNano(newState, token.totalSupply);
    await tx.appListing.update({
      where: { id: token.listingId },
      data: {
        volume24hNanoTon: { increment: opts.tonInNano },
        marketCapNanoTon: mcap,
      },
    });

    return { tokenId: opts.tokenId, userId: opts.userId, tokensOut: q.tokensOut, feeNano: q.feeNano, priceNano };
  });
}

export interface ExecuteSellResult {
  tokenId: string;
  userId: number;
  tonOutNet: bigint;
  feeNano: bigint;
  priceNano: bigint;
}

export async function executeSell(opts: {
  tokenId: string;
  userId: number;
  tokensIn: bigint;
  tradeId: string;
  txHashIn?: string;
}): Promise<ExecuteSellResult> {
  const cfg = runtimeConfig.get().appStore;
  return prisma.$transaction(async (tx) => {
    const token = await tx.appToken.findUniqueOrThrow({ where: { id: opts.tokenId } });
    if (token.status !== "live") throw new Error(`Token not live (status=${token.status})`);

    const state: PoolState = {
      realTonReserve: token.realTonReserve,
      realTokenReserve: token.realTokenReserve,
      lpTotalShares: token.lpTotalShares,
    };
    const q = quoteSell(state, opts.tokensIn, cfg.tradingFeePercent);
    if (q.tonOutGross <= 0n) throw new Error("Sell yields zero TON");

    const creatorFee = (q.feeNano * BigInt(Math.round(cfg.creatorFeeShare * 1_000_000))) / 1_000_000n;
    const platformFee = q.feeNano - creatorFee;
    const priceNano = (q.tonOutGross * TOKEN_UNIT) / opts.tokensIn;

    await tx.appToken.update({
      where: { id: opts.tokenId },
      data: {
        realTonReserve: q.newTonReserve,
        realTokenReserve: q.newTokenReserve,
        feeBalanceNanoTon: { increment: platformFee },
        creatorFeeBalanceNanoTon: { increment: creatorFee },
      },
    });

    const holding = await tx.tokenHolding.findUnique({
      where: { tokenId_userId: { tokenId: opts.tokenId, userId: opts.userId } },
    });
    if (!holding || holding.balance < opts.tokensIn) throw new Error("Insufficient holding for sell");
    await tx.tokenHolding.update({
      where: { tokenId_userId: { tokenId: opts.tokenId, userId: opts.userId } },
      data: { balance: holding.balance - opts.tokensIn },
    });

    await tx.tokenTrade.update({
      where: { id: opts.tradeId },
      data: {
        tonAmount: q.tonOutNet,
        priceNanoTon: priceNano,
        feeTonAmount: q.feeNano,
        txHashIn: opts.txHashIn,
        status: "received",
      },
    });

    const mcap = marketCapNano(
      { realTonReserve: q.newTonReserve, realTokenReserve: q.newTokenReserve, lpTotalShares: token.lpTotalShares },
      token.totalSupply,
    );
    await tx.appListing.update({
      where: { id: token.listingId },
      data: {
        volume24hNanoTon: { increment: q.tonOutGross },
        marketCapNanoTon: mcap,
      },
    });

    return { tokenId: opts.tokenId, userId: opts.userId, tonOutNet: q.tonOutNet, feeNano: q.feeNano, priceNano };
  });
}

export async function markTradeSettled(tradeId: string, txHashOut?: string) {
  await prisma.tokenTrade.update({
    where: { id: tradeId },
    data: { status: "settled", txHashOut, settledAt: new Date() },
  });
}

// ── Liquidity DB ops ─────────────────────────────────────────────────────────

export interface ApplyLiquidityResult {
  positionId: string;
  shares: bigint;
  newTotalShares: bigint;
  newTonReserve: bigint;
  newTokenReserve: bigint;
}

/**
 * Apply a confirmed liquidity deposit (init or add) to the DB. Both legs
 * (TON + Jetton) must be present in the same call — typically the caller
 * is the TON monitor that buffered the matching pair before invoking.
 */
export async function applyLiquidityDeposit(opts: {
  tokenId: string;
  ownerWalletAddress: string;
  userId?: number | null;
  tonNanoIn: bigint;
  tokensIn: bigint;
  type: "init" | "add";
  txHash?: string;
}): Promise<ApplyLiquidityResult> {
  return prisma.$transaction(async (tx) => {
    const token = await tx.appToken.findUniqueOrThrow({ where: { id: opts.tokenId } });

    const state: PoolState = {
      realTonReserve: token.realTonReserve,
      realTokenReserve: token.realTokenReserve,
      lpTotalShares: token.lpTotalShares,
    };
    const q = quoteAddLiquidity(state, opts.tonNanoIn, opts.tokensIn);

    const newTon = state.realTonReserve + q.tonNano;
    const newTokens = state.realTokenReserve + q.tokensAtomic;
    const newTotalShares = state.lpTotalShares + q.shares;

    // Token state.
    const newStatus = opts.type === "init" ? "live" : token.status;
    const newOwner = opts.type === "init"
      ? (token.ownerWalletAddress || opts.ownerWalletAddress)
      : token.ownerWalletAddress;
    await tx.appToken.update({
      where: { id: opts.tokenId },
      data: {
        realTonReserve: newTon,
        realTokenReserve: newTokens,
        lpTotalShares: newTotalShares,
        status: newStatus,
        ownerWalletAddress: newOwner,
      },
    });

    // Position upsert keyed by (tokenId, ownerWalletAddress).
    const existing = await tx.liquidityPosition.findUnique({
      where: { tokenId_ownerWalletAddress: { tokenId: opts.tokenId, ownerWalletAddress: opts.ownerWalletAddress } },
    });
    let position;
    if (existing) {
      position = await tx.liquidityPosition.update({
        where: { id: existing.id },
        data: {
          shares: existing.shares + q.shares,
          cumTonDepositedNano: existing.cumTonDepositedNano + q.tonNano,
          cumTokenDeposited: existing.cumTokenDeposited + q.tokensAtomic,
          userId: opts.userId ?? existing.userId,
        },
      });
    } else {
      position = await tx.liquidityPosition.create({
        data: {
          tokenId: opts.tokenId,
          ownerWalletAddress: opts.ownerWalletAddress,
          userId: opts.userId ?? null,
          shares: q.shares,
          cumTonDepositedNano: q.tonNano,
          cumTokenDeposited: q.tokensAtomic,
        },
      });
    }

    await tx.liquidityEvent.create({
      data: {
        tokenId: opts.tokenId,
        positionId: position.id,
        ownerWalletAddress: opts.ownerWalletAddress,
        type: opts.type,
        tonNano: q.tonNano,
        tokenAmount: q.tokensAtomic,
        shares: q.shares,
        txHash: opts.txHash,
        status: "settled",
      },
    });

    // Refresh listing market cap.
    const mcap = marketCapNano({
      realTonReserve: newTon, realTokenReserve: newTokens, lpTotalShares: newTotalShares,
    }, token.totalSupply);
    await tx.appListing.update({
      where: { id: token.listingId },
      data: { marketCapNanoTon: mcap },
    });

    return {
      positionId: position.id,
      shares: q.shares,
      newTotalShares,
      newTonReserve: newTon,
      newTokenReserve: newTokens,
    };
  });
}

export interface ApplyLiquidityRemoveResult {
  positionId: string;
  sharesBurned: bigint;
  tonOutNano: bigint;
  tokensOut: bigint;
  newTonReserve: bigint;
  newTokenReserve: bigint;
}

/**
 * Apply a confirmed liquidity withdrawal: burn `sharesToBurn` from the
 * caller's position and credit them with the proportional TON + tokens.
 * Returns the amounts the platform must pay out (the actual on-chain
 * payouts are dispatched by the caller, e.g. a hot-wallet payout step).
 */
export async function applyLiquidityRemove(opts: {
  tokenId: string;
  ownerWalletAddress: string;
  sharesToBurn: bigint;
  txHash?: string;
}): Promise<ApplyLiquidityRemoveResult> {
  return prisma.$transaction(async (tx) => {
    const token = await tx.appToken.findUniqueOrThrow({ where: { id: opts.tokenId } });
    const position = await tx.liquidityPosition.findUnique({
      where: { tokenId_ownerWalletAddress: { tokenId: opts.tokenId, ownerWalletAddress: opts.ownerWalletAddress } },
    });
    if (!position) throw new Error("Position not found");
    if (position.shares < opts.sharesToBurn) throw new Error("Not enough shares to burn");

    const state: PoolState = {
      realTonReserve: token.realTonReserve,
      realTokenReserve: token.realTokenReserve,
      lpTotalShares: token.lpTotalShares,
    };
    const q = quoteRemoveLiquidity(state, opts.sharesToBurn);
    if (q.tonNanoOut <= 0n && q.tokensOut <= 0n) throw new Error("Removal yields nothing");

    const newTon = state.realTonReserve - q.tonNanoOut;
    const newTokens = state.realTokenReserve - q.tokensOut;
    const newTotalShares = state.lpTotalShares - opts.sharesToBurn;

    await tx.appToken.update({
      where: { id: opts.tokenId },
      data: {
        realTonReserve: newTon,
        realTokenReserve: newTokens,
        lpTotalShares: newTotalShares,
      },
    });

    await tx.liquidityPosition.update({
      where: { id: position.id },
      data: {
        shares: position.shares - opts.sharesToBurn,
        cumTonWithdrawnNano: position.cumTonWithdrawnNano + q.tonNanoOut,
        cumTokenWithdrawn: position.cumTokenWithdrawn + q.tokensOut,
      },
    });

    await tx.liquidityEvent.create({
      data: {
        tokenId: opts.tokenId,
        positionId: position.id,
        ownerWalletAddress: opts.ownerWalletAddress,
        type: "remove",
        tonNano: -q.tonNanoOut,
        tokenAmount: -q.tokensOut,
        shares: -opts.sharesToBurn,
        txHash: opts.txHash,
        status: "settled",
      },
    });

    const mcap = marketCapNano({
      realTonReserve: newTon, realTokenReserve: newTokens, lpTotalShares: newTotalShares,
    }, token.totalSupply);
    await tx.appListing.update({
      where: { id: token.listingId },
      data: { marketCapNanoTon: mcap },
    });

    return {
      positionId: position.id,
      sharesBurned: opts.sharesToBurn,
      tonOutNano: q.tonNanoOut,
      tokensOut: q.tokensOut,
      newTonReserve: newTon,
      newTokenReserve: newTokens,
    };
  });
}
