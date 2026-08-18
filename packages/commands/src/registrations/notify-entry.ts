import type { EntryRenderer, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

/**
 * Custom transcript entry for host notifications (goal triggers, background
 * agent completions). Rendered by the host as a yellow `※ ` line and kept out
 * of LLM context by the custom-entry boundary.
 */
export const NOTIFY_ENTRY_TYPE = "pi-c2:notify";

export interface NotifyEntryData {
  readonly message: string;
}

export const notifyEntryRenderer: EntryRenderer<NotifyEntryData> = (entry, _options, theme) => {
  const data = entry.data as NotifyEntryData | undefined;
  if (!data || typeof data.message !== "string" || data.message.length === 0) return undefined;
  return new Text(theme.fg("warning", `※ ${data.message}`), 1, 0);
};

/**
 * Append a yellow `※ ` notification entry to the current session transcript.
 *
 * Custom entries never participate in LLM context and the renderer is
 * registered once by `registerNotifyEntry`.
 */
export function appendNotifyEntry(pi: ExtensionAPI, message: string): void {
  pi.appendEntry(NOTIFY_ENTRY_TYPE, { message } satisfies NotifyEntryData);
}

// Tracks whether the host accepted the custom-entry renderer. When the host
// lacks `registerEntryRenderer`/`appendEntry` (older runtime, isolated test
// seam) notifications degrade to the host notify UI instead.
let entryRendererAvailable = false;

/** Register the notification entry renderer once. */
export function registerNotifyEntry(pi: ExtensionAPI): void {
  if (typeof pi.registerEntryRenderer !== "function" || typeof pi.appendEntry !== "function") {
    entryRendererAvailable = false;
    return;
  }
  pi.registerEntryRenderer<NotifyEntryData>(NOTIFY_ENTRY_TYPE, notifyEntryRenderer);
  entryRendererAvailable = true;
}

/**
 * Deliver a host notification as a yellow `※ ` transcript entry when the host
 * supports the custom-entry renderer, or the host notify UI otherwise.
 *
 * The fallback keeps the message visible on hosts that do not render custom
 * entries: `ctx.ui.notify(message, "info")` surfaces it in the status area
 * without the `Warning:` prefix of the warning channel.
 */
export function notifyHost(pi: ExtensionAPI, ctx: ExtensionContext, message: string): void {
  if (ctx.hasUI && entryRendererAvailable) {
    appendNotifyEntry(pi, message);
  } else if (typeof ctx.ui?.notify === "function") {
    ctx.ui.notify(message, "info");
  }
}
