import { prisma } from "../db";
import { Decimal } from "@prisma/client/runtime/library";

export interface PaidFeature {
  id: string;
  label: string;
  price: number;
  description: string;
}

export const PAID_FEATURES: PaidFeature[] = [
  { id: "stars_payment", label: "Stars Payment System", price: 15, description: "Enable Telegram Stars payment integration in your app" },
  { id: "ton_payment", label: "TON Payment System", price: 25, description: "Enable TON blockchain payment integration in your app" },
  { id: "admin_panel", label: "Admin Panel", price: 30, description: "Unlock the Admin Panel for your app" },
  { id: "disable_splash", label: "Disable Splash", price: 10, description: "Remove the 'Made by Apps Father' splash screen" },
  { id: "get_code", label: "Get Code", price: 50, description: "Access and edit the source code of your app" },
];

const FEATURE_MAP = new Map(PAID_FEATURES.map(f => [f.id, f]));

// "Get Everything" bundle — sold once per project at a flat discounted price.
// Includes every paid feature except admin_panel (which is hidden in the UI
// and managed separately).
export const BUNDLE_FEATURES: string[] = [
  "stars_payment",
  "ton_payment",
  "disable_splash",
  "get_code",
];
export const BUNDLE_PRICE = 50;

export function getBundleFullPrice(): number {
  return BUNDLE_FEATURES.reduce((sum, id) => sum + (FEATURE_MAP.get(id)?.price || 0), 0);
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
  available: boolean;
} {
  const missingIds = BUNDLE_FEATURES.filter(id => !owned.includes(id));
  const fullPrice = missingIds.reduce((s, id) => s + (FEATURE_MAP.get(id)?.price || 0), 0);
  const isFullSet = missingIds.length === BUNDLE_FEATURES.length;
  // 50% off, rounded to the nearest whole dollar so prices stay clean.
  let bundlePrice = isFullSet ? BUNDLE_PRICE : Math.round(fullPrice / 2);
  // Defensive: never charge more than retail if rounding ever exceeds it.
  if (bundlePrice >= fullPrice) bundlePrice = Math.max(1, fullPrice - 1);
  const saveAmount = Math.max(0, fullPrice - bundlePrice);
  return {
    missingIds,
    fullPrice,
    bundlePrice,
    saveAmount,
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
): Promise<{ newBalance: number }> {
  const feature = FEATURE_MAP.get(featureId);
  if (!feature) throw new Error("Unknown feature");

  const existing = await getProjectFeatures(projectId);
  if (existing.includes(featureId)) throw new Error("Feature already purchased");

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { balance: true } });
  if (!user || Number(user.balance) < feature.price) throw new Error("Insufficient balance");

  const updated = [...existing, featureId];

  const result = await prisma.$transaction(async (tx) => {
    const updatedUser = await tx.user.update({
      where: { id: userId },
      data: { balance: { decrement: new Decimal(feature.price.toFixed(4)) } },
    });

    await tx.project.update({
      where: { id: projectId },
      data: { features: JSON.stringify(updated) },
    });

    return { newBalance: Number(updatedUser.balance) };
  });

  return result;
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
): Promise<{ newBalance: number; granted: string[]; charged: number }> {
  const existing = await getProjectFeatures(projectId);
  const quote = getBundleQuote(existing);
  if (!quote.available || quote.missingIds.length === 0) {
    throw new Error("All bundle features already owned");
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { balance: true } });
  if (!user || Number(user.balance) < quote.bundlePrice) throw new Error("Insufficient balance");

  // Preserve any non-bundle features (e.g. admin_panel) that may already exist.
  const updated = Array.from(new Set([...existing, ...quote.missingIds]));

  const result = await prisma.$transaction(async (tx) => {
    const updatedUser = await tx.user.update({
      where: { id: userId },
      data: { balance: { decrement: new Decimal(quote.bundlePrice.toFixed(4)) } },
    });

    await tx.project.update({
      where: { id: projectId },
      data: { features: JSON.stringify(updated) },
    });

    return {
      newBalance: Number(updatedUser.balance),
      granted: quote.missingIds.slice(),
      charged: quote.bundlePrice,
    };
  });

  return result;
}
