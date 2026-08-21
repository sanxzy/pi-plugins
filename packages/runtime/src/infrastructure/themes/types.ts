export const THEME_FOREGROUND_TOKENS = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "searchMatchText",
  "userMessageText",
  "customMessageText",
  "customMessageLabel",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "thinkingMax",
  "bashMode",
] as const;

export const THEME_BACKGROUND_TOKENS = [
  "selectedBg",
  "scrollbarThumb",
  "searchMatchBg",
  "userMessageBg",
  "customMessageBg",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
] as const;

export const THEME_COLOR_TOKENS = [...THEME_FOREGROUND_TOKENS, ...THEME_BACKGROUND_TOKENS] as const;
export const THEME_EXPORT_TOKENS = ["pageBg", "cardBg", "infoBg"] as const;

export type ThemeForegroundToken = (typeof THEME_FOREGROUND_TOKENS)[number];
export type ThemeBackgroundToken = (typeof THEME_BACKGROUND_TOKENS)[number];
export type ThemeColorToken = (typeof THEME_COLOR_TOKENS)[number];
export type ThemeExportToken = (typeof THEME_EXPORT_TOKENS)[number];
export type ThemeColorMode = "truecolor" | "256color";
export type ThemeColorValue = string | number;

export type ThemeVars = Record<string, ThemeColorValue>;
export type ThemeColors = Record<ThemeColorToken, ThemeColorValue>;
export type ThemeExportColors = Partial<Record<ThemeExportToken, ThemeColorValue>>;

/** One complete child-window theme profile, independent of the host renderer. */
export interface ThemeProfile {
  themeId: string;
  name: string;
  colorMode: ThemeColorMode;
  vars: ThemeVars;
  colors: ThemeColors;
  export?: ThemeExportColors;
}

/** Versioned home-scoped aggregate of reusable child-window profiles. */
export interface ThemeLibrary {
  version: 1;
  profiles: ThemeProfile[];
}
