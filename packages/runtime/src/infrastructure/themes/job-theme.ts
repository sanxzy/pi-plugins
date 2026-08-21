import type { Job } from "@xzy-ai/core";
import { resolveThemeProfile, type ThemeProfile } from "./library.ts";

/** Minimal registry surface needed to repair an unavailable persisted profile. */
export interface JobThemeRegistry {
  get(jobId: string): Job | undefined;
  updateJob(jobId: string, update: { themeId?: string }): void;
}

/**
 * Resolve a job's current profile from the home library.
 *
 * Legacy jobs intentionally return no profile so a host can keep rendering
 * with its parent theme. Explicit but unavailable ids use the deterministic
 * built-in fallback and are repaired in the authoritative registry when that
 * write is available; resolution itself remains usable if repair fails.
 */
export function resolveJobTheme(job: Job, registry?: JobThemeRegistry): ThemeProfile | undefined {
  if (job.themeId === undefined) return undefined;
  const resolved = resolveThemeProfile(job.themeId);
  if (resolved.usedFallback && resolved.profile.themeId !== job.themeId && registry) {
    try {
      registry.updateJob(job.jobId, { themeId: resolved.profile.themeId });
    } catch {
      // A visual lookup must never fail because metadata repair is unavailable.
    }
  }
  return resolved.profile;
}
