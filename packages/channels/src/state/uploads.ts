import { join } from "node:path";
import { runtimeDir, sessionDir } from "@xzy-ai/runtime";

/**
 * Session-scoped uploads directory for inbound Telegram media.
 *
 * Reuses the runtime `sessionDir` convention, which validates the session id
 * and keeps files inside project-local session state. Files are retained
 * indefinitely; no cleanup is added in the first version.
 */
export function uploadsDir(projectRoot: string, sessionId: string): string {
  return join(sessionDir(projectRoot, sessionId), "uploads");
}