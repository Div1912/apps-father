import { prisma } from "../db";
import { encryptToken, decryptToken } from "./crypto.service";
import { ProjectStatus } from "../types";
import { notifyNewUser } from "./notify.service";

export class ProjectService {
  async getOrCreateUser(telegramId: number, username?: string, firstName?: string, referredBy?: number, utmSource?: string | null) {
    const existing = await prisma.user.findUnique({ where: { telegramId: BigInt(telegramId) } });
    const isNew = !existing;
    const createData: any = { telegramId: BigInt(telegramId), username, firstName, balance: 0.2 };
    if (isNew && referredBy && referredBy !== telegramId) {
      createData.referredBy = BigInt(referredBy);
    }
    if (isNew && utmSource) {
      createData.utmSource = utmSource;
    }
    const user = await prisma.user.upsert({
      where: { telegramId: BigInt(telegramId) },
      update: { username, firstName },
      create: createData,
    });
    if (isNew) {
      notifyNewUser(telegramId, username, firstName, referredBy !== telegramId ? referredBy : undefined);
    }
    return { user, isNew };
  }

  async createProject(userId: number, name: string) {
    return prisma.project.create({
      data: { userId, name, status: "created" },
    });
  }

  async setProjectBot(
    projectId: string,
    botUserId: number,
    botUsername: string,
    botToken: string
  ) {
    return prisma.project.update({
      where: { id: projectId },
      data: {
        botUserId: BigInt(botUserId),
        botUsername,
        botTokenEncrypted: encryptToken(botToken),
        status: "planning",
      },
    });
  }

  async updateProjectStatus(projectId: string, status: ProjectStatus) {
    return prisma.project.update({
      where: { id: projectId },
      data: { status },
    });
  }

  async updateProjectPlan(projectId: string, plan: string) {
    return prisma.project.update({
      where: { id: projectId },
      data: { plan, status: "planning" },
    });
  }

  async updateProjectDescription(projectId: string, description: string) {
    return prisma.project.update({
      where: { id: projectId },
      data: { description },
    });
  }

  async getProject(projectId: string) {
    return prisma.project.findUnique({ where: { id: projectId } });
  }

  async getProjectsByUser(userId: number) {
    return prisma.project.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
  }

  async getProjectByBotUserId(botUserId: number) {
    return prisma.project.findFirst({
      where: { botUserId: BigInt(botUserId) },
    });
  }

  async getAllActiveProjects() {
    return prisma.project.findMany({
      where: {
        botTokenEncrypted: { not: null },
        status: { in: ["planning", "building", "deployed", "released"] },
      },
    });
  }

  async getProjectToken(projectId: string): Promise<string | null> {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { botTokenEncrypted: true },
    });
    if (!project?.botTokenEncrypted) return null;
    return decryptToken(project.botTokenEncrypted);
  }

  async createVersion(projectId: string, version: string, changelog?: string) {
    await prisma.project.update({
      where: { id: projectId },
      data: { currentVersion: version },
    });
    return prisma.version.create({
      data: { projectId, version, changelog },
    });
  }

  async saveAsset(projectId: string, fileId: string, filePath: string, fileName?: string, description?: string) {
    return prisma.asset.create({
      data: { projectId, fileId, filePath, fileName, description },
    });
  }

  async getProjectAssets(projectId: string) {
    return prisma.asset.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
    });
  }

  async storeGeneratedCode(projectId: string, code: string) {
    return prisma.project.update({
      where: { id: projectId },
      data: { generatedCode: code, status: "deployed" },
    });
  }

  async updateProjectSummary(projectId: string, summary: string) {
    return prisma.project.update({
      where: { id: projectId },
      data: { projectSummary: summary },
    });
  }

  async setTonWallet(projectId: string, wallet: string) {
    return prisma.project.update({
      where: { id: projectId },
      data: { tonWallet: wallet },
    });
  }

  async getTonWallet(projectId: string): Promise<string | null> {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { tonWallet: true },
    });
    return project?.tonWallet ?? null;
  }

  async deleteProject(projectId: string) {
    await prisma.asset.deleteMany({ where: { projectId } });
    await prisma.version.deleteMany({ where: { projectId } });
    await prisma.project.delete({ where: { id: projectId } });
  }

  async getUserSlotInfo(userId: number): Promise<{ used: number; total: number }> {
    const [user, count] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { appSlots: true } }),
      prisma.project.count({ where: { userId } }),
    ]);
    return { used: count, total: user?.appSlots ?? 1 };
  }

  async canCreateApp(userId: number): Promise<boolean> {
    const { used, total } = await this.getUserSlotInfo(userId);
    return used < total;
  }

  async getUserByUsername(username: string) {
    return prisma.user.findFirst({ where: { username } });
  }

  async transferProject(projectId: string, newOwnerId: number) {
    return prisma.project.update({
      where: { id: projectId },
      data: { userId: newOwnerId },
    });
  }

  async buySlot(userId: number): Promise<{ newSlots: number; newBalance: number }> {
    const SLOT_PRICE = 5;
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { balance: true, appSlots: true } });
    if (!user || Number(user.balance) < SLOT_PRICE) throw new Error("Insufficient balance");
    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        balance: { decrement: SLOT_PRICE },
        appSlots: { increment: 1 },
      },
    });
    return { newSlots: updated.appSlots, newBalance: Number(updated.balance) };
  }
}

export const projectService = new ProjectService();
