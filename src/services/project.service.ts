import { prisma } from "../db";
import { encryptToken, decryptToken } from "./crypto.service";
import { ProjectStatus } from "../types";
import { notifyNewUser } from "./notify.service";

export class ProjectService {
  async getOrCreateUser(telegramId: number, username?: string, firstName?: string, referredBy?: number, utmSource?: string | null) {
    // Atomic create-or-fetch using the unique constraint on telegramId.
    // This is critical: the Mini App fires several API calls in parallel on
    // load (/api/init, /api/projects, /api/balance, ...). The previous
    // findUnique-then-upsert pattern had a race where multiple parallel
    // calls all saw "not exists", all reported isNew=true, all sent the
    // admin notification, and the random winner of the create decided
    // whether utm_source/referred_by were persisted (only /api/init passes
    // those, so the source data was being lost ~75% of the time).
    const createData: any = { telegramId: BigInt(telegramId), username, firstName, balance: 0.2 };
    if (referredBy && referredBy !== telegramId) {
      createData.referredBy = BigInt(referredBy);
    }
    if (utmSource) {
      createData.utmSource = utmSource;
    }

    let user;
    let isNew = false;
    // True iff this call is the one that first persisted utmSource and/or
    // referredBy for this user (either by creating the row, or by
    // back-filling NULL columns on an existing row that lost the race).
    let attributedNow = false;

    try {
      user = await prisma.user.create({ data: createData });
      isNew = true;
      attributedNow = Boolean(createData.utmSource || createData.referredBy);
    } catch (err: any) {
      if (err?.code === "P2002") {
        // Lost the race — another call already created the row.
        // CRITICAL: back-fill utmSource / referredBy if they're still NULL.
        // Otherwise, when /api/projects (or any other endpoint) wins the
        // race-to-create, /api/init's legitimate attribution data is
        // silently discarded. We only fill, never overwrite — once a user
        // has been attributed, the original source is sticky.
        const existing = await prisma.user.findUnique({
          where: { telegramId: BigInt(telegramId) },
          select: { utmSource: true, referredBy: true },
        });

        const updateData: any = { username, firstName };
        if (utmSource && !existing?.utmSource) {
          updateData.utmSource = utmSource;
          attributedNow = true;
        }
        if (
          referredBy &&
          referredBy !== telegramId &&
          (existing?.referredBy === null || existing?.referredBy === undefined)
        ) {
          updateData.referredBy = BigInt(referredBy);
          attributedNow = true;
        }

        user = await prisma.user.update({
          where: { telegramId: BigInt(telegramId) },
          data: updateData,
        });
      } else {
        throw err;
      }
    }

    if (isNew) {
      // Diagnostic: emit a WARN line whenever a user row is created
      // WITHOUT any attribution. This is the actionable signal that some
      // call-site is reaching getOrCreateUser without source/referrer
      // (frontend not deployed yet, missing helper somewhere, bot-side
      // /start without payload, etc.). Grep prod logs for this line —
      // every hit is a user that will land in #organic stats.
      if (!utmSource && !referredBy) {
        console.warn(
          `[getOrCreateUser] WARN tg=${telegramId} created with NO attribution — will count as #organic until back-fill arrives`,
        );
      } else {
        console.log(
          `[getOrCreateUser] tg=${telegramId} created src=${JSON.stringify(utmSource ?? null)} ref=${referredBy ?? null}`,
        );
      }
      notifyNewUser(
        telegramId,
        username,
        firstName,
        referredBy !== telegramId ? referredBy : undefined,
        utmSource ?? null,
      );
    } else if (attributedNow) {
      // Back-fill case: user existed without attribution, this call
      // landed source/referrer on the row. Both the row itself (for
      // #sources stats) and the admin notification are now correct.
      console.log(
        `[getOrCreateUser] tg=${telegramId} BACKFILLED src=${JSON.stringify(utmSource ?? null)} ref=${referredBy ?? null}`,
      );
      notifyNewUser(
        telegramId,
        username,
        firstName,
        referredBy !== telegramId ? referredBy : undefined,
        utmSource ?? null,
      );
    }

    return { user, isNew, attributedNow };
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

  async updateProjectName(projectId: string, name: string) {
    return prisma.project.update({
      where: { id: projectId },
      data: { name },
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

  /** Returns the user's most-recently-updated project that has no bot linked yet.
   *  Used by the managed_bot handler to link a newly-created bot to an already-built project. */
  async getUnbottedProject(userId: number) {
    return prisma.project.findFirst({
      where: { userId, botTokenEncrypted: null },
      orderBy: { updatedAt: "desc" },
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
    return { used: count, total: user?.appSlots ?? 5 };
  }

  async canCreateApp(userId: number): Promise<boolean> {
    const { used, total } = await this.getUserSlotInfo(userId);
    return used < total;
  }

  async getUserByUsername(username: string) {
    return prisma.user.findFirst({ where: { username: { equals: username, mode: "insensitive" } } });
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
