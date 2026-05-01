export type AgentMode = "new" | "update";
export type ProjectKind = "app" | "game" | "textBot";

export const VALID_PROJECT_KINDS = new Set<ProjectKind>(["app", "game", "textBot"]);
export const DEFAULT_PROJECT_KIND: ProjectKind = "app";

export function normalizeProjectKind(kind?: string | null): ProjectKind {
  return VALID_PROJECT_KINDS.has(kind as ProjectKind) ? kind as ProjectKind : DEFAULT_PROJECT_KIND;
}
