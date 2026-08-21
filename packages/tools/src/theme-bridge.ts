import { Theme } from "@earendil-works/pi-coding-agent";
import {
  THEME_BACKGROUND_TOKENS,
  THEME_FOREGROUND_TOKENS,
  type ThemeColorValue,
  type ThemeProfile,
} from "@xzy-ai/runtime";

/** The optional capability installed by the pi-c2 host patch. */
export interface ThemeHostUI {
  readonly _hostGetThemeInstance?: () => Theme | undefined;
  readonly getTheme?: (name: string) => Theme | undefined;
  readonly getThemeSetting?: () => string | undefined;
  readonly setTheme: (theme: Theme) => { success: boolean; error?: string };
}

export interface ThemeFrame {
  /** Apply a newly loaded profile to the active child window. */
  refresh(profile: ThemeProfile): boolean;
  /** Restore the exact captured parent instance. Safe to call repeatedly. */
  restore(): boolean;
}

type HostColorMap = Record<string, ThemeColorValue>;

function resolveColor(value: ThemeColorValue, vars: Readonly<Record<string, ThemeColorValue>>, seen: Set<string>): ThemeColorValue {
  if (typeof value !== "string" || value === "") return value;
  const replacement = vars[value];
  if (replacement === undefined || seen.has(value)) return value;
  seen.add(value);
  return resolveColor(replacement, vars, seen);
}

function resolveColors(profile: ThemeProfile, tokens: readonly string[]): HostColorMap {
  const colors: HostColorMap = {};
  for (const token of tokens) {
    const value = profile.colors[token as keyof typeof profile.colors];
    if (value !== undefined) colors[token] = resolveColor(value, profile.vars, new Set());
  }
  return colors;
}

/** Construct the host SDK's native Theme without changing host settings. */
export function createNativeTheme(profile: ThemeProfile): Theme {
  const foreground = resolveColors(profile, THEME_FOREGROUND_TOKENS);
  const background = resolveColors(profile, THEME_BACKGROUND_TOKENS);
  return new Theme(foreground as ConstructorParameters<typeof Theme>[0], background as ConstructorParameters<typeof Theme>[1], profile.colorMode, {
    name: profile.name,
  });
}

function profileSignature(profile: ThemeProfile): string {
  return JSON.stringify(profile);
}

function captureParentTheme(ui: ThemeHostUI): Theme | undefined {
  try {
    const native = ui._hostGetThemeInstance?.();
    if (native) return native;
  } catch {
    // An unavailable optional capability is a normal degraded-host condition.
  }
  try {
    const setting = ui.getThemeSetting?.();
    if (setting && !setting.startsWith("auto")) return ui.getTheme?.(setting);
  } catch {
    // Fall through without mutating the parent.
  }
  return undefined;
}

/**
 * Capture the parent theme and apply one child profile. If the host cannot
 * expose an exact parent instance, fail closed rather than changing a theme
 * that cannot be restored safely.
 */
export function createThemeFrame(ui: ThemeHostUI, profile: ThemeProfile): ThemeFrame | undefined {
  const parent = captureParentTheme(ui);
  if (!parent) return undefined;

  let currentSignature = profileSignature(profile);
  let restored = false;
  const apply = (next: Theme): boolean => {
    try {
      return ui.setTheme(next).success === true;
    } catch {
      return false;
    }
  };

  if (!apply(createNativeTheme(profile))) return undefined;

  return {
    refresh(nextProfile) {
      if (restored) return false;
      const nextSignature = profileSignature(nextProfile);
      if (nextSignature === currentSignature) return false;
      if (!apply(createNativeTheme(nextProfile))) return false;
      currentSignature = nextSignature;
      return true;
    },
    restore() {
      if (restored) return true;
      restored = true;
      try {
        return ui.setTheme(parent).success === true;
      } catch {
        return false;
      }
    },
  };
}
