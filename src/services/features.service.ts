import { prisma } from "../db";
import { Decimal } from "@prisma/client/runtime/library";
import { writeLedger } from "./ledger.service";

export interface PaidFeature {
  id: string;
  label: string;
  price: number;        // USD price (legacy / fallback)
  creditsPrice: number; // Credits price (primary)
  description: string;
}

// 1 USD ≈ 50 credits by default; creditsPrice = price * 50
export const PAID_FEATURES: PaidFeature[] = [
  { id: "stars_payment", label: "Stars Payment System", price: 15, creditsPrice: 750,  description: "Enable Telegram Stars payment integration in your app" },
  { id: "ton_payment",   label: "TON Payment System",   price: 25, creditsPrice: 1250, description: "Enable TON blockchain payment integration in your app" },
  { id: "admin_panel",   label: "Admin Panel",           price: 30, creditsPrice: 1500, description: "Unlock the Admin Panel for your app" },
  { id: "disable_splash",label: "Disable Splash",        price: 10, creditsPrice: 500,  description: "Remove the 'Made by Apps Father' splash screen" },
];

const FEATURE_MAP = new Map(PAID_FEATURES.map(f => [f.id, f]));

// "Get Everything" bundle — sold once per project at a flat discounted price.
// Includes every paid feature except admin_panel (which is hidden in the UI
// and managed separately).
export const BUNDLE_FEATURES: string[] = [
  "stars_payment",
  "ton_payment",
  "disable_splash",
];
export const BUNDLE_PRICE = 50;
export const BUNDLE_CREDITS_PRICE = 2000; // discounted bundle in credits

export function getBundleFullPrice(): number {
  return BUNDLE_FEATURES.reduce((sum, id) => sum + (FEATURE_MAP.get(id)?.price || 0), 0);
}

export function getBundleFullCreditsPrice(): number {
  return BUNDLE_FEATURES.reduce((sum, id) => sum + (FEATURE_MAP.get(id)?.creditsPrice || 0), 0);
}

/**
 * Quote the bundle for a given owned-features list.
 *
 * Behaviour:
 *  - If everything in BUNDLE_FEATURES is already owned → not available.
 *  - Otherwise the bundle covers only the still-missing features at a flat
 *    50% discount of their regular total. This way the offer keeps making
 *    sense even after the user bought one or two features individually
 *    (it's always a strictly better deal than buying the rest one by one).
 *  - When the bundle covers the full set we keep the headline price at the
 *    canonical $50 (in case rounding ever drifts), so the marketing
 *    "Get Everything for $50, save $50" still holds.
 */
export function getBundleQuote(owned: string[]): {
  missingIds: string[];
  fullPrice: number;
  bundlePrice: number;
  saveAmount: number;
  fullCreditsPrice: number;
  bundleCreditsPrice: number;
  saveCredits: number;
  available: boolean;
} {
  const missingIds = BUNDLE_FEATURES.filter(id => !owned.includes(id));
  const fullPrice = missingIds.reduce((s, id) => s + (FEATURE_MAP.get(id)?.price || 0), 0);
  const isFullSet = missingIds.length === BUNDLE_FEATURES.length;
  let bundlePrice = isFullSet ? BUNDLE_PRICE : Math.round(fullPrice / 2);
  if (bundlePrice >= fullPrice) bundlePrice = Math.max(1, fullPrice - 1);
  const saveAmount = Math.max(0, fullPrice - bundlePrice);

  const fullCreditsPrice = missingIds.reduce((s, id) => s + (FEATURE_MAP.get(id)?.creditsPrice || 0), 0);
  let bundleCreditsPrice = isFullSet ? BUNDLE_CREDITS_PRICE : Math.round(fullCreditsPrice / 2);
  if (bundleCreditsPrice >= fullCreditsPrice) bundleCreditsPrice = Math.max(1, fullCreditsPrice - 1);
  const saveCredits = Math.max(0, fullCreditsPrice - bundleCreditsPrice);

  return {
    missingIds,
    fullPrice,
    bundlePrice,
    saveAmount,
    fullCreditsPrice,
    bundleCreditsPrice,
    saveCredits,
    available: missingIds.length > 0,
  };
}

export function getFeatureById(featureId: string): PaidFeature | undefined {
  return FEATURE_MAP.get(featureId);
}

export async function getProjectFeatures(projectId: string): Promise<string[]> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { features: true },
  });
  if (!project?.features) return [];
  try {
    return JSON.parse(project.features);
  } catch {
    return [];
  }
}

export async function hasFeature(projectId: string, featureId: string): Promise<boolean> {
  const features = await getProjectFeatures(projectId);
  return features.includes(featureId);
}

export async function purchaseFeature(
  userId: number,
  projectId: string,
  featureId: string,
  payWith: "credits" | "balance" = "credits",
): Promise<{ newBalance: number; newCredits?: number }> {
  const feature = FEATURE_MAP.get(featureId);
  if (!feature) throw new Error("Unknown feature");

  const existing = await getProjectFeatures(projectId);
  if (existing.includes(featureId)) throw new Error("Feature already purchased");

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { balance: true, credits: true } });
  if (!user) throw new Error("User not found");

  const updated = [...existing, featureId];

  if (payWith === "credits") {
    if (user.credits < feature.creditsPrice) throw new Error("Insufficient credits");
    const result = await prisma.$transaction(async (tx) => {
      const updatedUser = await tx.user.update({
        where: { id: userId },
        data: { credits: { decrement: feature.creditsPrice } },
      });
      await tx.project.update({ where: { id: projectId }, data: { features: JSON.stringify(updated) } });
      return { newBalance: Number(updatedUser.balance), newCredits: updatedUser.credits };
    });
    writeLedger(userId, "credits", -feature.creditsPrice, "feature_purchase",
      { featureId, featureLabel: feature.label, projectId });
    return result;
  } else {
    if (Number(user.balance) < feature.price) throw new Error("Insufficient balance");
    const result = await prisma.$transaction(async (tx) => {
      const updatedUser = await tx.user.update({
        where: { id: userId },
        data: { balance: { decrement: new Decimal(feature.price.toFixed(4)) } },
      });
      await tx.project.update({ where: { id: projectId }, data: { features: JSON.stringify(updated) } });
      return { newBalance: Number(updatedUser.balance) };
    });
    writeLedger(userId, "USD", -feature.price, "feature_purchase",
      { featureId, featureLabel: feature.label, projectId });
    return result;
  }
}

/**
 * Purchase the "Get Everything" bundle.
 *
 * Rules:
 *  - The bundle stays available until ALL bundle features are owned.
 *  - When some features are already owned, the bundle covers only the missing
 *    ones at the 50%-off price returned by getBundleQuote().
 *  - All missing BUNDLE_FEATURES are granted atomically; previously-owned
 *    features are kept untouched.
 */
export async function purchaseBundle(
  userId: number,
  projectId: string,
  payWith: "credits" | "balance" = "credits",
): Promise<{ newBalance: number; newCredits?: number; granted: string[]; charged: number }> {
  const existing = await getProjectFeatures(projectId);
  const quote = getBundleQuote(existing);
  if (!quote.available || quote.missingIds.length === 0) {
    throw new Error("All bundle features already owned");
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { balance: true, credits: true } });
  if (!user) throw new Error("User not found");

  const updated = Array.from(new Set([...existing, ...quote.missingIds]));

  if (payWith === "credits") {
    if (user.credits < quote.bundleCreditsPrice) throw new Error("Insufficient credits");
    const result = await prisma.$transaction(async (tx) => {
      const updatedUser = await tx.user.update({
        where: { id: userId },
        data: { credits: { decrement: quote.bundleCreditsPrice } },
      });
      await tx.project.update({ where: { id: projectId }, data: { features: JSON.stringify(updated) } });
      return { newBalance: Number(updatedUser.balance), newCredits: updatedUser.credits, granted: quote.missingIds.slice(), charged: quote.bundleCreditsPrice };
    });
    writeLedger(userId, "credits", -quote.bundleCreditsPrice, "feature_purchase",
      { bundle: true, projectId, granted: quote.missingIds });
    return result;
  } else {
    if (Number(user.balance) < quote.bundlePrice) throw new Error("Insufficient balance");
    const result = await prisma.$transaction(async (tx) => {
      const updatedUser = await tx.user.update({
        where: { id: userId },
        data: { balance: { decrement: new Decimal(quote.bundlePrice.toFixed(4)) } },
      });
      await tx.project.update({ where: { id: projectId }, data: { features: JSON.stringify(updated) } });
      return { newBalance: Number(updatedUser.balance), granted: quote.missingIds.slice(), charged: quote.bundlePrice };
    });
    writeLedger(userId, "USD", -quote.bundlePrice, "feature_purchase",
      { bundle: true, projectId, granted: quote.missingIds });
    return result;
  }
}
