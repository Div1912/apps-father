import type { AskContext } from "./AskContext";

export interface AskTool {
  name: string;
  definition: object;
  execute(args: Record<string, any>, ctx: AskContext): Promise<string>;
}
