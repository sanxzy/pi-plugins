import { join } from "node:path";
import { runtimeDir } from "@xzy-ai/runtime";
import { readJsonFile, writeJsonFileAtomic } from "./helpers.ts";

/**
 * The serialized transport lifecycle for one canonical project cwd.
 *
 * `starting` is set after a valid configuration is found and API validation
 * begins; readiness is only reached after the first completed `getUpdates`
 * cycle. `recovering` is a transient transport failure that can return to
 * `connected`; `blocked` is an authentication, ownership-conflict, or other
 * unrecoverable failure; `stopped` is an intentional shutdown.
 */
export type ChannelLifecycleState =
  | "unconfigured"
  | "starting"
  | "connected"
  | "recovering"
  | "blocked"
  | "stopped";

export interface ChannelStatusSnapshot {
  state: ChannelLifecycleState;
  /** Sanitized safe-message explaining the current state (never a raw token). */
  lastError?: string;
  /** Safe next step for the user, keyed to the current state. */
  nextStep?: string;
  updatedAt: string;
}

export function channelStatusPath(projectRoot: string): string {
  return join(runtimeDir(projectRoot), "channel-status.json");
}

/** Tolerant read: missing or malformed snapshots resolve to stopped no-op. */
export function loadChannelStatus(projectRoot: string): ChannelStatusSnapshot | null {
  const raw = readJsonFile(channelStatusPath(projectRoot));
  if (raw === null || typeof raw !== "object") return null;
  const snapshot = raw as Partial<ChannelStatusSnapshot>;
  if (
    (snapshot.state !== "unconfigured" &&
      snapshot.state !== "starting" &&
      snapshot.state !== "connected" &&
      snapshot.state !== "recovering" &&
      snapshot.state !== "blocked" &&
      snapshot.state !== "stopped") ||
    typeof snapshot.updatedAt !== "string"
  ) {
    return null;
  }
  return {
    state: snapshot.state,
    lastError: typeof snapshot.lastError === "string" ? snapshot.lastError : undefined,
    nextStep: typeof snapshot.nextStep === "string" ? snapshot.nextStep : undefined,
    updatedAt: snapshot.updatedAt,
  };
}

/** Persist a sanitized status snapshot atomically. */
export function saveChannelStatus(projectRoot: string, snapshot: ChannelStatusSnapshot): void {
  writeJsonFileAtomic(channelStatusPath(projectRoot), snapshot);
}