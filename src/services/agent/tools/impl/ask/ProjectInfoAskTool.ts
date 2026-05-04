import type { AskTool } from "./AskTool";
import type { AskContext } from "./AskContext";
import { projectService } from "../../../../../services/project.service";
import { getProjectFeatures } from "../../../../../services/features.service";

export class ProjectInfoAskTool implements AskTool {
  name = "project_info";
  definition = {
    type: "function",
    function: {
      name: "project_info",
      description: "Get high-level metadata about THIS project: name, description, plan presence, last update, status, and which paid features are unlocked.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  };

  async execute(_args: Record<string, any>, ctx: AskContext): Promise<string> {
    const p: any = await projectService.getProject(ctx.projectId);
    if (!p) return "Project not found.";
    const features = await getProjectFeatures(ctx.projectId).catch(() => [] as string[]);
    const info = {
      name: p.name || "(unnamed)",
      status: p.status || "unknown",
      description: (p.description || "").substring(0, 1500),
      hasPlan: !!p.plan,
      createdAt: p.createdAt ? new Date(p.createdAt).toISOString().slice(0, 10) : null,
      updatedAt: p.updatedAt ? new Date(p.updatedAt).toISOString().slice(0, 10) : null,
      botUsername: p.botUsername || null,
      paidFeatures: {
        telegram_stars: features.includes("telegram_stars") ? "UNLOCKED" : "LOCKED",
        ton_payment: features.includes("ton_payment") ? "UNLOCKED" : "LOCKED",
      },
    };
    return JSON.stringify(info, null, 2);
  }
}
