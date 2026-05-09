/**
 * App Store service — listing CRUD, screenshot management, validation,
 * publication workflow.
 *
 *   draft                — owner editing fields
 *   ready                — all required data filled (frontend gate, not strict)
 *   submitting           — user clicked Submit; awaiting publish-fee TON tx
 *   pending              — fee received, in admin review queue
 *   approved             — admin approved; user signs Jetton master deploy
 *   deployed_pending_lp  — Jetton master deployed by user; awaiting LP-init
 *   published            — listing live + LP pool funded
 *   rejected             — admin rejected; owner can edit + resubmit
 */

import { prisma } from "../db";
import fs from "fs";
import path from "path";
import { runtimeConfig } from "./runtime-config.service";
import { BUCKET_ROOT } from "../web/routes/bucket.routes";
import {
  spotPriceNano,
  marketCapNano,
  tokensToAtomic,
  type PoolState,
} from "./liquidity-amm.service";
import {
  buildDeployAndMintMessage,
  deriveJettonWalletAddress,
  buildJettonTransferMessage,
  buildTonTransferMessage,
  publishConfigSnapshot,
  platformVaultAddress,
  isJettonInfraReady,
} from "./jetton-tx-builder.service";
import { config } from "../config";

const TOKEN_LOGO_PREFIX = "token-logo-";
const SCREENSHOT_PREFIX = "store-screenshot-";
const BANNER_PREFIX = "store-banner-";
const APP_LOGO_PREFIX = "app-logo-";

export type ListingStatus =
  | "draft"
  | "ready"
  | "submitting"
  | "pending"
  | "approved"
  | "deployed_pending_lp"
  | "published"
  | "rejected";

export interface ListingDraftInput {
  /** Display name shown on the listing (App Store card title). */
  appName?: string;
  shortDescription?: string;
  longDescription?: string;
  socials?: { telegram?: string; twitter?: string; website?: string; other?: string };
  category?: string;
  /** 0–10 short tags shown on the App Store card. Empty array clears them. */
  tags?: string[];
  /** Bucket filename for the App Store hero/banner image. */
  bannerFilename?: string;
  tokenName?: string;
  tokenSymbol?: string;
  /** Optional Jetton metadata description. Empty string clears the field. */
  tokenDescription?: string;
  tokenLogoFilename?: string;
  initialLiquidityTon?: number;
  initialLiquidityTokenShare?: number;
  /** Internal liquidity amount in TON (stored, not on-chain). */
  liquidityTon?: number;
  /** Per-language overrides (stored as JSON on the listing). */
  translations?: Record<string, { name?: string; short?: string; long?: string }>;
}

function ensureProjectBucketDir(projectId: string): string {
  const safe = projectId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const dir = path.join(BUCKET_ROOT, safe);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function validateTokenName(name: string) {
  if (typeof name !== "string") throw new Error("Token name required");
  const trimmed = name.trim();
  if (trimmed.length < 3 || trimmed.length > 32) throw new Error("Token name must be 3-32 chars");
}

function validateTokenSymbol(symbol: string) {
  if (typeof symbol !== "string") throw new Error("Token symbol required");
  const upper = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9]{3,10}$/.test(upper)) throw new Error("Symbol must be 3-10 uppercase alphanumeric");
}

class AppStoreService {
  // ── Listing CRUD ──────────────────────────────────────────────────────────

  /** Get-or-create the listing draft for a project. */
  async getOrCreateDraft(projectId: string) {
    const existing = await prisma.appListing.findUnique({
      where: { projectId },
      include: { token: true, project: { select: { name: true, botUsername: true, userId: true } } },
    });
    if (existing) {
      // Backfill the auto-suggested token name on legacy drafts that were
      // created before we started seeding the token row.
      if (!existing.token && existing.project?.name) {
        await this._ensureTokenRow(existing, { name: existing.project.name.slice(0, 32) });
        return prisma.appListing.findUnique({
          where: { id: existing.id },
          include: { token: true, project: { select: { name: true, botUsername: true, userId: true } } },
        });
      }
      return existing;
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, botUsername: true, userId: true, appDescription: true, appLongDescription: true },
    });
    if (!project) throw new Error("Project not found");

    const created = await prisma.appListing.create({
      data: {
        projectId,
        status: "draft",
        // Note: shortDescription is the *App* short description shown on the
        // store card, NOT the Jetton metadata description. The metadata
        // description is intentionally optional (and empty by default) to
        // match minter.ton.org behaviour.
        shortDescription: project.appDescription?.slice(0, 120) || null,
        longDescription: project.appLongDescription || null,
      },
      include: { token: true, project: { select: { name: true, botUsername: true, userId: true } } },
    });

    // Seed the AppToken row with the project's app name as the suggested
    // token name (mirrors the "Name: App Name" preset in minter.ton.org).
    if (project.name) {
      await this._ensureTokenRow(
        { id: created.id, projectId: created.projectId },
        { name: project.name.slice(0, 32) },
      );
      return prisma.appListing.findUnique({
        where: { id: created.id },
        include: { token: true, project: { select: { name: true, botUsername: true, userId: true } } },
      });
    }

    return created;
  }

  async getListing(listingId: string) {
    return prisma.appListing.findUnique({
      where: { id: listingId },
      include: {
        token: true,
        project: { select: { id: true, name: true, botUsername: true, userId: true } },
      },
    });
  }

  /** Public listing fetch by project id (used for share links). */
  async getListingByProject(projectId: string) {
    return prisma.appListing.findUnique({
      where: { projectId },
      include: {
        token: true,
        project: { select: { id: true, name: true, botUsername: true, userId: true } },
      },
    });
  }

  async updateDraft(listingId: string, input: ListingDraftInput) {
    const listing = await prisma.appListing.findUnique({ where: { id: listingId }, include: { token: true } });
    if (!listing) throw new Error("Listing not found");
    // Once the listing is fully published we lock the metadata. Earlier
    // states (draft / submitting / pending / approved / deployed_pending_lp)
    // remain editable so the publisher can correct typos before the
    // on-chain LP-init lands.
    if (listing.status === "published") {
      throw new Error("Listing already published — cannot edit core fields");
    }

    const data: any = {};
    if (input.appName !== undefined) data.appName = input.appName?.slice(0, 64) || null;
    if (input.shortDescription !== undefined) data.shortDescription = input.shortDescription?.slice(0, 120) || null;
    if (input.longDescription !== undefined) data.longDescription = input.longDescription || null;
    if (input.socials !== undefined) data.socials = input.socials || null;
    if (input.category !== undefined) data.category = input.category || null;
    if (input.tags !== undefined) {
      const cleaned = (Array.isArray(input.tags) ? input.tags : [])
        .map((t) => String(t || "").trim().slice(0, 24))
        .filter(Boolean);
      const unique = Array.from(new Set(cleaned)).slice(0, 10);
      data.tags = unique.length ? (unique as any) : null;
    }
    if (input.bannerFilename !== undefined) data.bannerFilename = input.bannerFilename || null;
    if (input.liquidityTon !== undefined && typeof input.liquidityTon === "number") {
      data.initialLiquidityTon = Math.max(5, input.liquidityTon);
    }
    if (input.translations !== undefined && typeof input.translations === "object") {
      data.translations = input.translations as any;
    }

    await prisma.appListing.update({ where: { id: listingId }, data });

    if (
      input.tokenName !== undefined ||
      input.tokenSymbol !== undefined ||
      input.tokenLogoFilename !== undefined ||
      input.tokenDescription !== undefined
    ) {
      if (listing.token?.status === "live") {
        throw new Error("Token already deployed — cannot edit");
      }
      const upsertData: any = {};
      if (input.tokenName) {
        validateTokenName(input.tokenName);
        upsertData.name = input.tokenName.trim();
      } else if (input.appName && !listing.token?.name) {
        // Auto-use app name as token name when not explicitly provided
        upsertData.name = input.appName.slice(0, 32);
      }
      if (input.tokenSymbol) {
        validateTokenSymbol(input.tokenSymbol);
        upsertData.symbol = input.tokenSymbol.trim().toUpperCase();
      }
      if (input.tokenLogoFilename) upsertData.logoFilename = input.tokenLogoFilename;
      if (input.tokenDescription !== undefined) {
        // Empty string clears the field — matches minter.ton.org default.
        const trimmed = input.tokenDescription.trim();
        upsertData.metadataDescription = trimmed.length ? trimmed.slice(0, 200) : null;
      }

      if (listing.token) {
        await prisma.appToken.update({ where: { id: listing.token.id }, data: upsertData });
      } else {
        await this._ensureTokenRow(listing, upsertData);
      }
    }

    return this.getListing(listingId);
  }

  /**
   * Lazily create the AppToken row. Reserves and supply are zero — they are
   * populated only after the user signs the on-chain LP-init transfer (the
   * V2 flow). `totalSupply` is set from runtime config so the metadata.json
   * we serve to wallets is correct.
   */
  private async _ensureTokenRow(
    listing: { id: string; projectId: string },
    fields: { name?: string; symbol?: string; logoFilename?: string; metadataDescription?: string | null } = {},
  ) {
    const existing = await prisma.appToken.findUnique({ where: { listingId: listing.id } });
    if (existing) {
      const update: any = {};
      if (fields.name && !existing.name) update.name = fields.name;
      if (fields.symbol && !existing.symbol) update.symbol = fields.symbol;
      if (fields.logoFilename) update.logoFilename = fields.logoFilename;
      if (fields.metadataDescription !== undefined) update.metadataDescription = fields.metadataDescription;
      if (Object.keys(update).length) {
        await prisma.appToken.update({ where: { id: existing.id }, data: update });
      }
      return;
    }
    const cfg = runtimeConfig.get().appStore;
    const totalSupply = tokensToAtomic(cfg.tokenTotalSupply);
    await prisma.appToken.create({
      data: {
        projectId: listing.projectId,
        listingId: listing.id,
        name: fields.name || "",
        symbol: fields.symbol || "",
        logoFilename: fields.logoFilename || "",
        // Empty by default — matches minter.ton.org behaviour.
        metadataDescription: fields.metadataDescription ?? null,
        totalSupply,
        status: "pending_deploy",
      },
    });
  }

  // ── Screenshots ───────────────────────────────────────────────────────────

  async addScreenshot(listingId: string, projectId: string, buf: Buffer, ext: string): Promise<string> {
    const cfg = runtimeConfig.get().appStore;
    const listing = await prisma.appListing.findUnique({ where: { id: listingId } });
    if (!listing) throw new Error("Listing not found");

    const current = (listing.screenshots as string[] | null) || [];
    if (current.length >= cfg.maxScreenshots) {
      throw new Error(`Max ${cfg.maxScreenshots} screenshots`);
    }

    const safeExt = (ext || "png").toLowerCase().replace(/[^a-z0-9]/g, "");
    const filename = `${SCREENSHOT_PREFIX}${Date.now()}-${Math.random().toString(16).slice(2, 8)}.${safeExt || "png"}`;
    const dir = ensureProjectBucketDir(projectId);
    fs.writeFileSync(path.join(dir, filename), buf);

    const updated = [...current, filename];
    await prisma.appListing.update({ where: { id: listingId }, data: { screenshots: updated } });
    return filename;
  }

  async removeScreenshot(listingId: string, projectId: string, filename: string) {
    const listing = await prisma.appListing.findUnique({ where: { id: listingId } });
    if (!listing) throw new Error("Listing not found");
    const current = (listing.screenshots as string[] | null) || [];
    const next = current.filter((f) => f !== filename);
    await prisma.appListing.update({ where: { id: listingId }, data: { screenshots: next } });
    try {
      const dir = ensureProjectBucketDir(projectId);
      const full = path.join(dir, filename);
      if (filename.startsWith(SCREENSHOT_PREFIX) && fs.existsSync(full)) fs.unlinkSync(full);
    } catch {}
  }

  async setTokenLogo(listingId: string, projectId: string, buf: Buffer, ext: string): Promise<string> {
    const safeExt = (ext || "png").toLowerCase().replace(/[^a-z0-9]/g, "");
    const filename = `${TOKEN_LOGO_PREFIX}${Date.now()}.${safeExt || "png"}`;
    const dir = ensureProjectBucketDir(projectId);
    fs.writeFileSync(path.join(dir, filename), buf);

    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(TOKEN_LOGO_PREFIX) && f !== filename) {
          fs.unlinkSync(path.join(dir, f));
        }
      }
    } catch {}

    const listing = await prisma.appListing.findUnique({ where: { id: listingId } });
    if (listing) {
      await this._ensureTokenRow(listing, { logoFilename: filename });
    }

    return filename;
  }

  /**
   * Save a hero/banner image for the App Store detail page. Replaces any
   * previous banner file for the same listing (one-banner-per-listing rule).
   */
  /**
   * Save an App Store-specific app logo (used as the listing avatar).
   * Replaces any previous app-logo file for the same listing.
   */
  async setAppLogo(listingId: string, projectId: string, buf: Buffer, ext: string): Promise<string> {
    const safeExt = (ext || "png").toLowerCase().replace(/[^a-z0-9]/g, "");
    const filename = `${APP_LOGO_PREFIX}${Date.now()}.${safeExt || "png"}`;
    const dir = ensureProjectBucketDir(projectId);
    fs.writeFileSync(path.join(dir, filename), buf);

    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(APP_LOGO_PREFIX) && f !== filename) {
          fs.unlinkSync(path.join(dir, f));
        }
      }
    } catch {}

    await prisma.appListing.update({ where: { id: listingId }, data: { appLogoFilename: filename } });
    return filename;
  }

  async setBanner(listingId: string, projectId: string, buf: Buffer, ext: string): Promise<string> {
    const safeExt = (ext || "png").toLowerCase().replace(/[^a-z0-9]/g, "");
    const filename = `${BANNER_PREFIX}${Date.now()}.${safeExt || "png"}`;
    const dir = ensureProjectBucketDir(projectId);
    fs.writeFileSync(path.join(dir, filename), buf);

    // Drop any older banners on disk so the bucket doesn't grow unbounded.
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(BANNER_PREFIX) && f !== filename) {
          fs.unlinkSync(path.join(dir, f));
        }
      }
    } catch {}

    await prisma.appListing.update({ where: { id: listingId }, data: { bannerFilename: filename } });
    return filename;
  }

  async removeBanner(listingId: string, projectId: string) {
    const listing = await prisma.appListing.findUnique({ where: { id: listingId } });
    if (!listing) throw new Error("Listing not found");
    const fname = (listing as any).bannerFilename as string | null;
    if (fname) {
      try {
        const dir = ensureProjectBucketDir(projectId);
        const full = path.join(dir, fname);
        if (fs.existsSync(full)) fs.unlinkSync(full);
      } catch {}
    }
    await prisma.appListing.update({ where: { id: listingId }, data: { bannerFilename: null } });
  }

  /**
   * Compute the 7-step publish readiness for a project. The frontend renders
   * this as a progress panel (stepper) on the App Settings page.
   *
   * Steps:
   *   1. created           — project row exists (always true once fetched)
   *   2. botConnected      — project.botUsername is set
   *   3. appInfo           — name + description + avatar present on the project
   *   4. pageInfo          — listing.category, ≥3 tags, banner, ≥4 screenshots
   *   5. tokenInfo         — token has name + symbol + logo + ticker accepted
   *   6. review            — listing.status in pending/approved/deployed_pending_lp
   *   7. published         — listing.status === "published" AND token live
   */
  async getReadiness(projectId: string): Promise<{
    steps: Array<{
      id: number;
      key: string;
      title: string;
      done: boolean;
      missing: string[];
    }>;
    currentStep: number;
    listingId: string | null;
    /** Status of the listing as a single string for the panel header. */
    summary: string;
    status: string;
    rejectedReason: string | null;
  }> {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        botUsername: true,
        appDescription: true,
        appLongDescription: true,
      },
    }) as any;
    if (!project) throw new Error("Project not found");

    const listing = await prisma.appListing.findUnique({
      where: { projectId },
      include: { token: true },
    }) as any;

    const tags = (listing?.tags as string[] | null) || [];
    const screenshots = (listing?.screenshots as string[] | null) || [];
    const cfg = runtimeConfig.get().appStore;

    // --- step calculations ---
    const step1Done = true;

    const step2Missing: string[] = [];
    if (!project.botUsername) step2Missing.push("Connect a Telegram bot");
    const step2Done = step2Missing.length === 0;

    // App information is stored on the *listing* (App-Store-facing fields)
    // rather than the project (which holds AI-internal copy). The listing's
    // shortDescription is what shows up on the App Store card. The avatar
    // is set directly on the connected Telegram bot via @BotFather (not
    // stored in our DB), so we don't gate this step on it server-side —
    // the frontend still surfaces an upload control for convenience.
    const step3Missing: string[] = [];
    if (!project.name || project.name.trim().length < 3) step3Missing.push("App name");
    if (!listing?.shortDescription || String(listing.shortDescription).trim().length < 10) step3Missing.push("Short description");
    const step3Done = step3Missing.length === 0;

    const step4Missing: string[] = [];
    if (!listing?.category) step4Missing.push("Category");
    if (!tags.length || tags.length < 3) step4Missing.push("≥ 3 tags");
    if (!listing?.bannerFilename) step4Missing.push("Banner image");
    if (screenshots.length < (cfg.minScreenshots || 3)) {
      step4Missing.push(`≥ ${cfg.minScreenshots || 3} screenshots`);
    }
    const step4Done = step4Missing.length === 0;

    const step5Missing: string[] = [];
    const token = listing?.token;
    if (!token?.symbol) step5Missing.push("Token ticker");
    if (!token?.creationPaidAt) step5Missing.push("Pay initial liquidity");
    const step5Done = step5Missing.length === 0;

    const reviewStatuses = new Set(["review", "pending", "approved", "deployed_pending_lp", "published", "rejected"]);
    const step6Done = listing ? reviewStatuses.has(listing.status) : false;

    const step7Done = listing?.status === "published";

    const steps = [
      { id: 1, key: "created",   title: "Project created",   done: step1Done, missing: [] as string[] },
      { id: 2, key: "bot",       title: "Bot connected",      done: step2Done, missing: step2Missing },
      { id: 3, key: "info",      title: "App information",    done: step3Done, missing: step3Missing },
      { id: 4, key: "page",      title: "App Store page",     done: step4Done, missing: step4Missing },
      { id: 5, key: "token",     title: "App token",          done: step5Done, missing: step5Missing },
      { id: 6, key: "review",    title: "Review",             done: step6Done, missing: step6Done ? [] : ["Submit for review"] },
      { id: 7, key: "published", title: "Published",          done: step7Done, missing: step7Done ? [] : ["Awaiting publication"] },
    ];

    // First step that is *not* done becomes the "current" step the user
    // should focus on. If everything is done, currentStep = 7.
    const firstUndone = steps.find((s) => !s.done)?.id ?? 7;

    return {
      steps,
      currentStep: firstUndone,
      listingId: listing?.id ?? null,
      summary: listing?.status ?? "draft",
      status: listing?.status ?? "draft",
      rejectedReason: (listing as any)?.rejectedReason ?? null,
    };
  }

  // ── Submission ────────────────────────────────────────────────────────────

  async submit(listingId: string) {
    const listing = await prisma.appListing.findUnique({
      where: { id: listingId },
      include: { token: true, project: { select: { name: true, botUsername: true } } },
    });
    if (!listing) throw new Error("Listing not found");
    if (listing.status === "published") throw new Error("Already published");
    if (listing.status === "review") throw new Error("Already under review");

    // Validate minimum required fields
    const missing: string[] = [];
    if (!listing.project?.botUsername) missing.push("Bot connection");
    if (!listing.appName && !listing.project?.name) missing.push("App name");
    if (!listing.shortDescription || listing.shortDescription.length < 3) missing.push("Short description");
    if (!listing.token?.symbol || !listing.token?.creationPaidAt) missing.push("App token");
    if (missing.length) throw new Error(`Required fields missing: ${missing.join(", ")}`);

    await prisma.appListing.update({
      where: { id: listingId },
      data: { status: "review", submittedAt: new Date(), rejectedReason: null },
    });

    return { ok: true };
  }

  /**
   * Create the App Token for a listing. Deducts the initial liquidity
   * (in TON) from the user's internal `tonBalance` and locks the token —
   * once created, ticker and liquidity become read-only.
   */
  async createToken(
    listingId: string,
    userId: number,
    input: { ticker: string; liquidityTon: number },
  ) {
    const listing = await prisma.appListing.findUnique({
      where: { id: listingId },
      include: { token: true, project: { select: { name: true, userId: true } } },
    });
    if (!listing) throw new Error("Listing not found");
    if (listing.project?.userId !== userId) throw new Error("Not the owner");
    if (listing.token?.creationPaidAt) {
      throw new Error("Token already created");
    }

    const ticker = (input.ticker || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{3,10}$/.test(ticker)) {
      throw new Error("Ticker must be 3-10 uppercase alphanumeric characters");
    }
    const liquidityTon = Number(input.liquidityTon);
    if (!isFinite(liquidityTon) || liquidityTon < 5) {
      throw new Error("Initial liquidity must be at least 5 TON");
    }

    // Atomic deduction with balance check — prevents race conditions.
    const result = await prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, select: { tonBalance: true } });
      if (!user) throw new Error("User not found");
      const balance = Number(user.tonBalance);
      if (balance < liquidityTon) {
        throw new Error(`Insufficient TON balance. You have ${balance.toFixed(4)} TON but need ${liquidityTon} TON. Top up in Wallet.`);
      }

      // Deduct
      await tx.user.update({
        where: { id: userId },
        data: { tonBalance: { decrement: liquidityTon } },
      });

      // Create or update token row
      const tokenName = listing.appName || listing.project?.name || ticker;
      const cfg = runtimeConfig.get().appStore;
      const totalSupply = tokensToAtomic(cfg.tokenTotalSupply);
      let token = listing.token;
      if (!token) {
        token = await tx.appToken.create({
          data: {
            projectId: listing.projectId,
            listingId: listing.id,
            name: tokenName.slice(0, 32),
            symbol: ticker,
            logoFilename: "",
            totalSupply,
            status: "live",
            creationPaidAt: new Date(),
            creationLockedLiquidityTon: liquidityTon as any,
          },
        });
      } else {
        token = await tx.appToken.update({
          where: { id: token.id },
          data: {
            symbol: ticker,
            name: tokenName.slice(0, 32),
            status: "live",
            creationPaidAt: new Date(),
            creationLockedLiquidityTon: liquidityTon as any,
          },
        });
      }

      // Update listing
      await tx.appListing.update({
        where: { id: listingId },
        data: { initialLiquidityTon: liquidityTon },
      });

      return { tokenId: token.id, ticker, liquidityTon };
    });

    return result;
  }

  /** Public: get the user's TON balance (formatted as Number). */
  async getUserTonBalance(userId: number): Promise<number> {
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { tonBalance: true } });
    return u ? Number(u.tonBalance) : 0;
  }

  platformWalletAddress(): string {
    return platformVaultAddress();
  }

  // ── V2 Publish flow: prepare-deploy / prepare-lp-init ────────────────────

  /**
   * Step A — return a TonConnect message that, when signed by the user,
   * deploys their Jetton master (admin = user) and pre-mints the full
   * supply to their wallet. Status flips approved → awaiting on-chain
   * confirmation. The TON monitor advances the listing once the master
   * is confirmed.
   *
   * If the production Jetton BoCs are not present (`isJettonInfraReady()`
   * returns false), this method falls back to immediately marking the
   * deploy as completed with a SIM_ address, so the rest of the flow keeps
   * working in development.
   */
  async preparePublishDeploy(listingId: string, opts: { userWalletAddress: string }) {
    const listing = await prisma.appListing.findUnique({
      where: { id: listingId },
      include: { token: true },
    });
    if (!listing) throw new Error("Listing not found");
    if (!listing.token) throw new Error("Token row missing");
    // V2: deploy is permissionless — the user owns the contract on-chain, so
    // we allow signing from any pre-deploy state. Re-deploys (idempotent for
    // the same wallet/metadata, since the master address is deterministic)
    // are also allowed from `deployed_pending_lp`.
    const allowedStatuses = new Set([
      "draft", "submitting", "pending", "approved", "deployed_pending_lp",
    ]);
    if (!allowedStatuses.has(listing.status)) {
      throw new Error(`Cannot deploy from status=${listing.status}`);
    }
    if (listing.token.status === "live") throw new Error("Token already live");
    if (!listing.token.name || !listing.token.symbol) {
      throw new Error("Token name and ticker are required before deploying");
    }

    // Build the on-chain metadata exactly as minter.ton.org would: name,
    // symbol, decimals (string per TIP-64), optional description and a
    // logo URL pointing to our bucket. Wallets read the metadata directly
    // from the contract; they only fetch the image URL on demand.
    const baseUrl = config.baseUrl;
    const projectId = listing.projectId;
    const tokenLogoFilename = (listing.token as any).logoFilename;
    const imageUrl = tokenLogoFilename
      ? `${baseUrl}/bucket/${projectId}/${tokenLogoFilename}`
      : undefined;
    const metadataDescription = (listing.token as any).metadataDescription as string | null | undefined;

    const result = buildDeployAndMintMessage({
      userWalletAddress: opts.userWalletAddress,
      metadata: {
        name: listing.token.name,
        symbol: listing.token.symbol,
        decimals: "9",
        ...(metadataDescription && metadataDescription.trim().length > 0
          ? { description: metadataDescription.trim() }
          : {}),
        ...(imageUrl ? { image: imageUrl } : {}),
      },
      amountToMint: listing.token.totalSupply,
    });

    // Persist the eventual master address (deterministic) and the publisher
    // wallet so the TON monitor can match later.
    await prisma.appToken.update({
      where: { id: listing.token.id },
      data: {
        jettonMasterAddress: result.jettonMasterAddress,
        ownerWalletAddress: opts.userWalletAddress,
      },
    });

    // Optimistically mark the listing as `deployed_pending_lp` once the user
    // has been handed the deploy message. The master address is deterministic
    // so even if the user abandons signing, retrying from this state is safe
    // (the same address is regenerated). The TON monitor will set
    // `token.status = live` once the LP-init transfer is detected on-chain.
    if (listing.status === "draft" || listing.status === "submitting" || listing.status === "pending" || listing.status === "approved") {
      await prisma.appListing.update({
        where: { id: listingId },
        data: { status: "deployed_pending_lp" },
      });
    }

    return {
      ok: true,
      simulated: false,
      jettonMasterAddress: result.jettonMasterAddress,
      validUntil: result.validUntil,
      messages: [result.message],
      // Frontend should poll for token.status === "deployed_pending_lp"
      // before showing the LP step.
      pollEndpoint: `/telegram-mini-app/api/store/listings/${listingId}/status`,
    };
  }

  /**
   * Step B — return a TonConnect tx (multi-message) that the user signs to
   * fund the initial liquidity. Two legs:
   *   1. Jetton transfer from user's jetton wallet → vault's jetton wallet
   *   2. Plain TON transfer from user → vault
   * Both carry comment `lp_init:<listingId>`.
   *
   * `tonAmount` and `tokenShare` are sent by the publisher in the body and
   * validated against runtime min/max bounds.
   */
  async preparePublishLpInit(listingId: string, opts: {
    userWalletAddress: string;
    tonAmount: number;
    tokenShare: number; // 0..1
  }) {
    const listing = await prisma.appListing.findUnique({
      where: { id: listingId },
      include: { token: true },
    });
    if (!listing) throw new Error("Listing not found");
    if (!listing.token) throw new Error("Token row missing");
    if (listing.status !== "deployed_pending_lp") {
      throw new Error(`LP init only valid in status=deployed_pending_lp (current=${listing.status})`);
    }
    if (!listing.token.jettonMasterAddress) throw new Error("Jetton master address not set");
    // Reject stale SIM_/legacy placeholder addresses with a clear hint —
    // these come from drafts created before the on-chain deploy was wired
    // up. The user simply needs to re-run the deploy step (which overwrites
    // the address with a real, deterministic master address).
    if (!/^([EU]Q|0:|-1:)/.test(String(listing.token.jettonMasterAddress))) {
      throw new Error(
        "Token master address looks invalid. Please tap 'Save & deploy with my wallet' on the previous step to (re)deploy the contract first.",
      );
    }

    const cfg = runtimeConfig.get().appStore;
    if (opts.tonAmount < cfg.minInitialLiquidityTon) {
      throw new Error(`Initial liquidity must be ≥ ${cfg.minInitialLiquidityTon} TON`);
    }
    if (opts.tokenShare < cfg.minInitialLiquidityTokenShare || opts.tokenShare > 0.95) {
      throw new Error(`Token share must be between ${cfg.minInitialLiquidityTokenShare * 100}% and 95%`);
    }

    const tokensToLock = (listing.token.totalSupply * BigInt(Math.round(opts.tokenShare * 1_000_000))) / 1_000_000n;
    const vault = platformVaultAddress();

    // Derive the user's jetton wallet (so the jetton-transfer message is
    // sent FROM the user wallet TO their own jetton wallet).
    const userJW = deriveJettonWalletAddress({
      jettonMasterAddress: listing.token.jettonMasterAddress,
      ownerAddress: opts.userWalletAddress,
    });

    // Persist intent — useful for monitor + UI display.
    await prisma.appListing.update({
      where: { id: listingId },
      data: {
        // Re-use the existing publishFeeTxHash slot for the LP-init tx
        // hash; it's where the TON-leg lands. (Plus we record the comment.)
      },
    });

    const messages = [];
    if (!userJW.simulated) {
      messages.push(buildJettonTransferMessage({
        userJettonWalletAddress: userJW.address,
        destinationOwnerAddress: vault,
        amountAtomic: tokensToLock,
        textComment: `lp_init:${listingId}`,
        attachedTon: "0.1",
        forwardTon: "0.05",
      }));
    }
    messages.push(buildTonTransferMessage({
      to: vault,
      tonAmount: String(opts.tonAmount),
      textComment: `lp_init:${listingId}`,
    }));

    return {
      ok: true,
      simulated: userJW.simulated,
      messages,
      validUntil: Math.floor(Date.now() / 1000) + 600,
      tonAmount: opts.tonAmount,
      tokensLocked: tokensToLock.toString(),
      tokenShare: opts.tokenShare,
      vaultAddress: vault,
      userJettonWalletAddress: userJW.address,
    };
  }

  /** Public config snapshot used by the publish form. */
  publishConfigSnapshot() {
    return publishConfigSnapshot();
  }

  /** Returns liquidity infrastructure readiness flag for UI hints. */
  isJettonInfraReady() {
    return isJettonInfraReady();
  }

  // ── Liquidity management (post-launch) ───────────────────────────────────

  /**
   * Build the TonConnect tx for a follow-up liquidity ADD. Caller specifies
   * the TON amount they want to add; the matching token amount is computed
   * from current pool ratios.
   */
  async prepareLpAdd(listingId: string, opts: {
    userWalletAddress: string;
    tonAmount: number;
  }) {
    const listing = await prisma.appListing.findUnique({
      where: { id: listingId },
      include: { token: true },
    });
    if (!listing?.token) throw new Error("Listing/token not found");
    if (listing.token.status !== "live") throw new Error("Token not live yet");
    if (!listing.token.jettonMasterAddress) throw new Error("Jetton not deployed");

    const cfg = runtimeConfig.get().appStore;
    if (opts.tonAmount < cfg.minInitialLiquidityTon) {
      throw new Error(`Add must be ≥ ${cfg.minInitialLiquidityTon} TON`);
    }
    if (listing.token.realTonReserve <= 0n || listing.token.realTokenReserve <= 0n) {
      throw new Error("Pool empty");
    }

    // Δtokens = Δton * tokenReserve / tonReserve, at current price.
    const tonNanoIn = BigInt(Math.round(opts.tonAmount * 1e9));
    const tokensIn = (tonNanoIn * listing.token.realTokenReserve) / listing.token.realTonReserve;

    const userJW = deriveJettonWalletAddress({
      jettonMasterAddress: listing.token.jettonMasterAddress,
      ownerAddress: opts.userWalletAddress,
    });
    const vault = platformVaultAddress();

    const messages = [];
    if (!userJW.simulated) {
      messages.push(buildJettonTransferMessage({
        userJettonWalletAddress: userJW.address,
        destinationOwnerAddress: vault,
        amountAtomic: tokensIn,
        textComment: `lp_add:${listingId}`,
        attachedTon: "0.1",
        forwardTon: "0.05",
      }));
    }
    messages.push(buildTonTransferMessage({
      to: vault,
      tonAmount: String(opts.tonAmount),
      textComment: `lp_add:${listingId}`,
    }));

    return {
      ok: true,
      messages,
      validUntil: Math.floor(Date.now() / 1000) + 600,
      tonAmount: opts.tonAmount,
      tokensRequired: tokensIn.toString(),
      vaultAddress: vault,
    };
  }

  /**
   * Initiate a liquidity REMOVE. Custodial: user signs an off-chain request
   * (validated by Telegram init data), backend's hot wallet then dispatches
   * the proportional TON + Jetton payouts. Returns the quote synchronously
   * so the UI shows what the user will receive.
   */
  async previewLpRemove(listingId: string, opts: {
    userWalletAddress: string;
    sharesToBurn?: bigint;
    fraction?: number; // 0..1 alternative to sharesToBurn
  }) {
    const listing = await prisma.appListing.findUnique({
      where: { id: listingId },
      include: { token: true },
    });
    if (!listing?.token) throw new Error("Listing/token not found");

    const position = await prisma.liquidityPosition.findUnique({
      where: {
        tokenId_ownerWalletAddress: {
          tokenId: listing.token.id,
          ownerWalletAddress: opts.userWalletAddress,
        },
      },
    });
    if (!position) throw new Error("No LP position for this wallet");

    let shares = opts.sharesToBurn;
    if (!shares && opts.fraction) {
      const f = Math.max(0, Math.min(1, opts.fraction));
      shares = (position.shares * BigInt(Math.round(f * 1_000_000))) / 1_000_000n;
    }
    if (!shares || shares <= 0n) throw new Error("Provide sharesToBurn or fraction");
    if (shares > position.shares) throw new Error("Not enough shares");

    const total = listing.token.lpTotalShares;
    const tonOut = (shares * listing.token.realTonReserve) / total;
    const tokenOut = (shares * listing.token.realTokenReserve) / total;

    return {
      ok: true,
      sharesToBurn: shares.toString(),
      tonOutNano: tonOut.toString(),
      tokenOut: tokenOut.toString(),
      yourShares: position.shares.toString(),
      totalShares: total.toString(),
    };
  }

  // ── Admin moderation ──────────────────────────────────────────────────────

  async listForReview(status?: string) {
    const where: any = {};
    if (status === "review") {
      // "review" tab groups legacy "pending" + new "review" status
      where.status = { in: ["review", "pending"] };
    } else if (status === "published") {
      // "live" tab groups published + legacy approved/deployed_pending_lp
      where.status = { in: ["published", "approved", "deployed_pending_lp"] };
    } else if (status === "draft") {
      where.status = { in: ["draft", "submitting", "ready"] };
    } else if (status) {
      where.status = status;
    }
    return prisma.appListing.findMany({
      where,
      include: {
        token: true,
        project: {
          select: {
            id: true, name: true, botUsername: true, userId: true,
            user: { select: { id: true, telegramId: true, username: true, firstName: true } },
          },
        },
      },
      orderBy: { submittedAt: "desc" },
      take: 100,
    });
  }

  async approve(listingId: string, adminUserId: number) {
    const listing = await prisma.appListing.findUnique({
      where: { id: listingId },
      include: { token: true },
    });
    if (!listing) throw new Error("Listing not found");
    if (listing.status !== "pending" && listing.status !== "review") throw new Error(`Cannot approve from status=${listing.status}`);

    await prisma.appListing.update({
      where: { id: listingId },
      data: {
        status: "published",
        approvedAt: new Date(),
        approvedBy: adminUserId,
        publishedAt: new Date(),
      },
    });

    // Notify the listing owner
    try {
      const project = await prisma.project.findUnique({
        where: { id: listing.projectId },
        include: { user: true },
      });
      if (project?.user && config.botToken) {
        const appName = listing.appName || project.name || "your app";
        const msg = `🎉 <b>Your app is live!</b>\n\n<b>${appName}</b> has been approved and is now published in the App Store.`;
        await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: project.user.telegramId.toString(), text: msg, parse_mode: "HTML" }),
        }).catch(() => {});
      }
    } catch {}

    return { ok: true };
  }

  async reject(listingId: string, reason: string) {
    const listing = await prisma.appListing.findUnique({
      where: { id: listingId },
      include: { project: { include: { user: true } } },
    });
    await prisma.appListing.update({
      where: { id: listingId },
      data: {
        status: "rejected",
        rejectedReason: reason || "rejected",
      },
    });

    // Notify the listing owner
    try {
      if (listing?.project?.user && config.botToken) {
        const appName = listing.appName || listing.project.name || "your app";
        const msg = `❌ <b>App rejected</b>\n\n<b>${appName}</b> was not approved.\n\n<blockquote>${reason}</blockquote>\n\nYou can fix the issues and resubmit from App Settings.`;
        await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: listing.project.user.telegramId.toString(), text: msg, parse_mode: "HTML" }),
        }).catch(() => {});
      }
    } catch {}

    return { ok: true };
  }

  async setHidden(listingId: string, hidden: boolean) {
    await prisma.appListing.update({ where: { id: listingId }, data: { hidden } });
    return { ok: true };
  }

  // ── Public browse ─────────────────────────────────────────────────────────

  async listPublished(opts: { tab?: "trending" | "new" | "top"; limit?: number; offset?: number; q?: string }) {
    const limit = Math.min(opts.limit || 20, 50);
    const offset = opts.offset || 0;

    const orderBy =
      opts.tab === "trending"
        ? [{ volume24hNanoTon: "desc" as const }, { publishedAt: "desc" as const }]
        : opts.tab === "top"
          ? [{ marketCapNanoTon: "desc" as const }]
          : [{ publishedAt: "desc" as const }];

    const where: any = { status: "published", hidden: false };
    if (opts.q && opts.q.trim()) {
      where.OR = [
        { token: { is: { name: { contains: opts.q.trim(), mode: "insensitive" } } } },
        { token: { is: { symbol: { contains: opts.q.trim(), mode: "insensitive" } } } },
        { project: { is: { name: { contains: opts.q.trim(), mode: "insensitive" } } } },
      ];
    }

    const [rows, total] = await Promise.all([
      prisma.appListing.findMany({
        where, orderBy, take: limit, skip: offset,
        include: {
          token: true,
          project: { select: { id: true, name: true, botUsername: true } },
        },
      }),
      prisma.appListing.count({ where }),
    ]);

    return { items: rows.map((r) => this.toCardJson(r)), total, limit, offset };
  }

  toCardJson(row: any) {
    const token = row.token;
    let priceNano = 0n;
    let mcap = row.marketCapNanoTon ?? 0n;
    if (token) {
      const state: PoolState = {
        realTonReserve: token.realTonReserve,
        realTokenReserve: token.realTokenReserve,
        lpTotalShares: token.lpTotalShares,
      };
      priceNano = spotPriceNano(state);
      if (mcap === 0n) mcap = marketCapNano(state, token.totalSupply);
    }
    // The App avatar (listing.appLogoFilename) is the canonical image and
    // overrides the token's standalone logoFilename anywhere the token is
    // displayed (App Store detail, Wallet, Swap).
    const displayLogo = row.appLogoFilename || token?.logoFilename || null;
    return {
      listingId: row.id,
      projectId: row.projectId,
      projectName: row.project?.name,
      botUsername: row.project?.botUsername,
      shortDescription: row.shortDescription,
      category: row.category,
      tags: (row.tags as string[] | null) || [],
      appLogoFilename: row.appLogoFilename || null,
      bannerFilename: row.bannerFilename || null,
      publishedAt: row.publishedAt,
      screenshots: (row.screenshots as string[] | null) || [],
      token: token ? {
        id: token.id,
        name: token.name,
        symbol: token.symbol,
        logoFilename: displayLogo,
        priceTon: Number(priceNano) / 1e9,
        marketCapTon: Number(mcap) / 1e9,
        volume24hTon: Number(row.volume24hNanoTon ?? 0n) / 1e9,
        soldSupply: token.soldSupply.toString(),
        totalSupply: token.totalSupply.toString(),
        realTonReserve: token.realTonReserve.toString(),
        realTokenReserve: token.realTokenReserve.toString(),
        lpTotalShares: token.lpTotalShares.toString(),
        ownerWalletAddress: token.ownerWalletAddress,
        jettonMasterAddress: token.jettonMasterAddress,
        change24h: null as number | null,
      } : null,
    };
  }

  // ── Token detail JSON for the listing detail page ────────────────────────

  async getTokenDetail(listingId: string) {
    const listing = await prisma.appListing.findUnique({
      where: { id: listingId },
      include: {
        token: true,
        project: { select: { id: true, name: true, botUsername: true, userId: true } },
      },
    });
    if (!listing) throw new Error("Listing not found");

    const trades = listing.token
      ? await prisma.tokenTrade.findMany({
          where: { tokenId: listing.token.id, status: { in: ["received", "settled"] } },
          orderBy: { createdAt: "desc" },
          take: 200,
          select: {
            id: true, type: true, tonAmount: true, tokenAmount: true,
            priceNanoTon: true, createdAt: true, userId: true,
          },
        })
      : [];
    const holdersCount = listing.token
      ? await prisma.tokenHolding.count({ where: { tokenId: listing.token.id, balance: { gt: 0n } } })
      : 0;

    const lpPositions = listing.token
      ? await prisma.liquidityPosition.findMany({
          where: { tokenId: listing.token.id, shares: { gt: 0n } },
          orderBy: { shares: "desc" },
          take: 10,
        })
      : [];

    const card = this.toCardJson(listing);
    return {
      ...card,
      longDescription: listing.longDescription,
      socials: listing.socials,
      screenshots: (listing.screenshots as string[] | null) || [],
      holdersCount,
      lpProvidersCount: lpPositions.length,
      lpPositions: lpPositions.map((p) => ({
        ownerWalletAddress: p.ownerWalletAddress,
        shares: p.shares.toString(),
      })),
      trades: trades.reverse().map((t) => ({
        id: t.id,
        type: t.type,
        tonAmount: Number(t.tonAmount) / 1e9,
        tokenAmount: Number(t.tokenAmount) / 1e9,
        priceTon: Number(t.priceNanoTon) / 1e9,
        createdAt: t.createdAt,
      })),
    };
  }

  /** Pool state + caller's LP position. Used by the Liquidity card. */
  async getLiquidityForListing(listingId: string, opts: { userWalletAddress?: string }) {
    const listing = await prisma.appListing.findUnique({
      where: { id: listingId },
      include: { token: true },
    });
    if (!listing?.token) throw new Error("Listing/token not found");
    const t = listing.token;

    let yourShares = 0n;
    let yourTon = 0n;
    let yourTokens = 0n;
    if (opts.userWalletAddress && t.lpTotalShares > 0n) {
      const pos = await prisma.liquidityPosition.findUnique({
        where: { tokenId_ownerWalletAddress: { tokenId: t.id, ownerWalletAddress: opts.userWalletAddress } },
      });
      if (pos) {
        yourShares = pos.shares;
        yourTon = (pos.shares * t.realTonReserve) / t.lpTotalShares;
        yourTokens = (pos.shares * t.realTokenReserve) / t.lpTotalShares;
      }
    }

    return {
      tokenId: t.id,
      poolTonReserve: t.realTonReserve.toString(),
      poolTokenReserve: t.realTokenReserve.toString(),
      lpTotalShares: t.lpTotalShares.toString(),
      ownerWalletAddress: t.ownerWalletAddress,
      yourShares: yourShares.toString(),
      yourTonNano: yourTon.toString(),
      yourTokens: yourTokens.toString(),
      yourSharePct: t.lpTotalShares > 0n ? Number((yourShares * 10_000n) / t.lpTotalShares) / 100 : 0,
    };
  }

  // ── User portfolio ────────────────────────────────────────────────────────

  async getPortfolio(userId: number) {
    const holdings = await prisma.tokenHolding.findMany({
      where: { userId, balance: { gt: 0n } },
      include: {
        token: {
          include: {
            listing: {
              include: { project: { select: { id: true, name: true, botUsername: true } } },
            },
          },
        },
      },
    });

    return holdings.map((h) => {
      const t = h.token;
      const state: PoolState = {
        realTonReserve: t.realTonReserve,
        realTokenReserve: t.realTokenReserve,
        lpTotalShares: t.lpTotalShares,
      };
      const priceNano = spotPriceNano(state);
      const balance = h.balance;
      const valueNano = (priceNano * balance) / BigInt(1e9);
      const costNano = (h.avgBuyNanoTon * balance) / BigInt(1e9);
      // App avatar wins over standalone token logo for display purposes.
      const displayLogo = (t.listing as any)?.appLogoFilename || t.logoFilename || null;
      return {
        tokenId: t.id,
        listingId: t.listingId,
        projectId: t.projectId,
        projectName: t.listing?.project?.name,
        symbol: t.symbol,
        name: t.name,
        logoFilename: displayLogo,
        balance: Number(balance) / 1e9,
        avgBuyTon: Number(h.avgBuyNanoTon) / 1e9,
        priceTon: Number(priceNano) / 1e9,
        valueTon: Number(valueNano) / 1e9,
        costTon: Number(costNano) / 1e9,
        pnlTon: Number(valueNano - costNano) / 1e9,
      };
    });
  }
}

export const appStoreService = new AppStoreService();
