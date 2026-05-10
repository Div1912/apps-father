import type { AskTool } from "./AskTool";
import type { AskContext } from "./AskContext";
import { projectService } from "../../../../../services/project.service";
import { getProjectFeatures, PAID_FEATURES } from "../../../../../services/features.service";

export class ProjectInfoAskTool implements AskTool {
  name = "project_info";
  definition = {
    type: "function",
    function: {
      name: "project_info",
      description: "Get high-level metadata about THIS project: name, description, plan presence, last update, status, and which paid features are LOCKED vs UNLOCKED. Always call this before deciding if a request needs a paid-feature gate.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  };

  async execute(_args: Record<string, any>, ctx: AskContext): Promise<string> {
    const p: any = await projectService.getProject(ctx.projectId);
    if (!p) return "Project not found.";
    const owned = await getProjectFeatures(ctx.projectId).catch(() => [] as string[]);

    // Expose every feature in the catalog so the router knows the full set
    // of unlock-gated capabilities (used for kind="paid-feature" routing).
    const paidFeatures: Record<string, "UNLOCKED" | "LOCKED"> = {};
    for (const f of PAID_FEATURES) {
      paidFeatures[f.id] = owned.includes(f.id) ? "UNLOCKED" : "LOCKED";
    }

    const info = {
      name: p.name || "(unnamed)",
      status: p.status || "unknown",
      description: (p.description || "").substring(0, 1500),
      hasPlan: !!p.plan,
      createdAt: p.createdAt ? new Date(p.createdAt).toISOString().slice(0, 10) : null,
      updatedAt: p.updatedAt ? new Date(p.updatedAt).toISOString().slice(0, 10) : null,
      botUsername: p.botUsername || null,
      paidFeatures,
    };
    return JSON.stringify(info, null, 2);
  }
}
