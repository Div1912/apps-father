export interface AskContext {
  readonly projectId: string;
  /** Resolved live-app directory (development/ or latest commit). */
  readonly projectDir: string | null;
}
