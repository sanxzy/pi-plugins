import type { ThemeLibrary } from "./types.ts";
import { getBuiltinThemeFallback, loadThemeLibrary } from "./library.ts";

/** A fresh assignment that advances the cursor only after the job is recorded. */
export interface ThemeAssignmentReservation {
  readonly themeId: string;
  commit(): void;
  rollback(): void;
}

/** Process-local round-robin state for fresh child theme assignments. */
export interface ThemeAssignmentCursor {
  /**
   * Reserve the next rotation profile. When `avoidThemeId` matches the picked
   * profile, the next profile is used instead so a fresh child never shares its
   * parent's theme. The cursor advances only on commit.
   */
  reserveThemeId(avoidThemeId?: string): ThemeAssignmentReservation;
  nextThemeId(): string;
  reset(): void;
}

/**
 * Create a non-durable theme assignment cursor.
 *
 * The loader is injectable so assignment ordering can be tested without
 * touching home storage. Production callers use the self-healing library.
 */
export function createThemeAssignmentCursor(load: () => ThemeLibrary = loadThemeLibrary): ThemeAssignmentCursor {
  let cursor = 0;

  const reserveThemeId = (avoidThemeId?: string): ThemeAssignmentReservation => {
    const library = load();
    const profiles = library.profiles;
    let index = profiles.length > 0 ? ((cursor % profiles.length) + profiles.length) % profiles.length : -1;
    if (index >= 0 && avoidThemeId !== undefined && profiles[index]!.themeId === avoidThemeId) {
      index = (index + 1) % profiles.length;
    }
    const themeId = index >= 0
      ? profiles[index]!.themeId
      : getBuiltinThemeFallback().themeId;
    let settled = false;
    return {
      themeId,
      commit(): void {
        if (settled) return;
        settled = true;
        cursor += 1;
      },
      rollback(): void {
        settled = true;
      },
    };
  };

  return {
    reserveThemeId,
    nextThemeId(): string {
      const reservation = reserveThemeId();
      reservation.commit();
      return reservation.themeId;
    },
    reset(): void {
      cursor = 0;
    },
  };
}
