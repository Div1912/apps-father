import { Context, SessionFlavor } from "grammy";

export interface AttachedFile {
  localPath: string;  // absolute path on disk
  projectPath: string; // relative path inside project (e.g. "frontend/assets/photo_123.jpg")
  originalName: string;
  caption?: string;
}

export interface SessionData {
  activeProjectId?: string;
  conversationState?: ConversationState;
  pendingPlan?: string;
  pendingDescription?: string;
  pendingAttachments?: AttachedFile[];
  awaitingInput?: "description" | "plan_feedback" | "update_description" | "attach_files" | "version_name" | "topup_amount" | "ton_wallet" | "transfer_owner" | null;
  language?: "en" | "ru" | "ua";
}

export type BotContext = Context & SessionFlavor<SessionData>;

export type ConversationState =
  | "idle"
  | "awaiting_description"
  | "plan_generated"
  | "building"
  | "deployed"
  | "awaiting_update";

export type ProjectStatus =
  | "created"
  | "planning"
  | "building"
  | "deployed"
  | "released"
  | "error";

export interface GeneratedApp {
  plan: string;
  frontend: GeneratedFile[];
  backend: GeneratedFile[];
  schema: string;
  botDescription: string;
  botCommands: Array<{ command: string; description: string }>;
}

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface BuildProgress {
  stage: string;
  message: string;
  percent: number;
}
