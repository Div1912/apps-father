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
