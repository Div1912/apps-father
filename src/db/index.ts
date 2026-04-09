import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();

export async function connectDatabase(): Promise<void> {
  await prisma.$connect();
  console.log("[DB] Connected to PostgreSQL");
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  console.log("[DB] Disconnected from PostgreSQL");
}
