import * as path from "path";
import { config } from "../config";

/**
 * Where per-project trees live on disk.
 *
 * - in-process mode (legacy / PROD): <cwd>/projects/<id>/{release,development}/...
 * - worker mode (DEV):                /srv/apps-father/projects/<id>/...
 *
 * Both modes share the same on-disk layout: <id>/{release,development}/{frontend,backend,data}.
 * Only the root differs, so swapping the base via this helper is enough for
 * commit/agent/builder/deploy services to land files in the right place.
 *
 * Resolved once at import time (config is frozen) so callers can keep doing
 * `const PROJECTS_DIR = getProjectsDir()` at module top-level.
 */
export function getProjectsDir(): string {
  if (config.runtimeMode === "worker") {
    return config.runnerProjectsRoot;
  }
  return path.join(process.cwd(), "projects");
}
