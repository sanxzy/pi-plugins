import { join } from "node:path";
import { runtimeDir } from "@xzy-ai/runtime";
import { readJsonFile, writeJsonFileAtomic } from "./helpers.ts";

export type ConnectionName = "tui" | "telegram";

export interface ConnectionMarker {
  lastConnection: ConnectionName;
  updatedAt: string;
}

export function connectionMarkerPath(projectRoot: string): string {
  return join(runtimeDir(projectRoot), "user_last_connection.json");
}

/** Missing or malformed markers resolve to `null`, which is not Telegram-safe. */
export function loadConnectionMarker(projectRoot: string): ConnectionMarker | null {
  const raw = readJsonFile(connectionMarkerPath(projectRoot));
  if (raw === null || typeof raw !== "object") return null;
  const marker = raw as Partial<ConnectionMarker>;
  if (
    (marker.lastConnection !== "tui" && marker.lastConnection !== "telegram") ||
    typeof marker.updatedAt !== "string"
  ) {
    return null;
  }
  return { lastConnection: marker.lastConnection, updatedAt: marker.updatedAt };
}

export function saveConnectionMarker(projectRoot: string, marker: ConnectionMarker): void {
  writeJsonFileAtomic(connectionMarkerPath(projectRoot), marker);
}
