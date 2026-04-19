import { config } from "./config";
import { connectDatabase, prisma } from "./db";
import { createBot } from "./bot";
import { startWebServer, getExpressApp } from "./web/server";
import { botRunnerService } from "./services/bot-runner.service";
import { webhookCallback } from "grammy";
import { processingProjects } from "./bot/processing";
import { commitService } from "./services/commit.service";
import { startRetentionScheduler } from "./services/retention.service";

async function recoverStuckProjects() {
  const stuck = await prisma.project.findMany({ where: { status: "building" } });
  for (const p of stuck) {
    const newStatus = p.generatedCode ? "deployed" : p.plan ? "planning" : "created";
    await prisma.project.update({ where: { id: p.id }, data: { status: newStatus } });
    console.log(`[Recovery] Project "${p.name}" (${p.id}): building -> ${newStatus}`);
  }
  if (stuck.length > 0) console.log(`[Recovery] Recovered ${stuck.length} stuck project(s)`);
}

async function main() {
  console.log("🏗️  Apps Father starting...\n");

  console.log("[1/4] Connecting to database...");
  await connectDatabase();

  await recoverStuckProjects();

  console.log("[1.5/4] Migrating existing projects to version control...");
  const migrated = await commitService.migrateExistingProjects();
  if (migrated > 0) console.log(`[Migration] Migrated ${migrated} project(s) to version control`);

  console.log("[2/4] Starting web server...");
  await startWebServer();

  console.log("[3/4] Loading managed bots...");
  await botRunnerService.loadAllBots();

  console.log("[4/4] Starting Apps Father bot...");
  const bot = createBot();

  if (config.nodeEnv === "production") {
    const app = getExpressApp();
    if (app) {
      app.post("/bot-webhook", webhookCallback(bot, "express"));
    }
    const webhookUrl = `${config.baseUrl}/bot-webhook`;
    await bot.api.setWebhook(webhookUrl, {
      secret_token: config.webhookSecret,
    });
    console.log(`[Bot] Webhook set: ${webhookUrl}`);
  } else {
    bot.start({
      onStart: (info: any) => {
        console.log(`[Bot] Apps Father bot started as @${info.username}`);
      },
    });
  }

  startRetentionScheduler();

  console.log("\n✅ Apps Father is running!");
  console.log(`   Domain: ${config.domain}`);
  console.log(`   Port: ${config.port}`);
  console.log(`   Mode: ${config.nodeEnv}`);
  console.log(`   Managed bots: ${botRunnerService.getRunningCount()}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

let shuttingDown = false;
async function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[Shutdown] ${signal} received.`);

  if (processingProjects.size === 0) {
    console.log("[Shutdown] No active agents. Exiting.");
    process.exit(0);
  }

  console.log(`[Shutdown] Waiting for ${processingProjects.size} active agent(s) to finish...`);
  const start = Date.now();
  const MAX_WAIT = 5 * 60 * 1000;

  while (processingProjects.size > 0 && Date.now() - start < MAX_WAIT) {
    console.log(`[Shutdown] ${processingProjects.size} agent(s) still running (${Math.round((Date.now() - start) / 1000)}s elapsed)`);
    await new Promise(r => setTimeout(r, 5000));
  }

  if (processingProjects.size > 0) {
    console.log(`[Shutdown] Timeout reached. ${processingProjects.size} agent(s) still running. Force exiting.`);
  } else {
    console.log("[Shutdown] All agents finished. Exiting.");
  }
  process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
