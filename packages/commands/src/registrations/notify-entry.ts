import type { ExtensionAPI, ExtensionContext, EntryRenderer } from "@earendil-works/pi-coding-agent";
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
  return new Text(theme.fg("warning", `※ ${data.message}`), 0, 0);
};

/**
 * Append a yellow `※ ` notification entry to the current session transcript.
 *
 * Custom entries never participate in LLM context and the renderer is
 * registered once by `registerNotifyEntry`. When the host UI is unavailable
 * the fallback notify keeps the message visible in non-TUI surfaces.
 */
export function appendNotifyEntry(pi: ExtensionAPI, message: string): void {
  pi.appendEntry(NOTIFY_ENTRY_TYPE, { message } satisfies NotifyEntryData);
}

/** Register the notification entry renderer once. */
export function registerNotifyEntry(pi: ExtensionAPI): void {
  // The runtime may lack the custom-entry renderer API (e.g. an older host or
  // the isolated test seam); notifications then degrade to the plain fallback.
  if (typeof pi.registerEntryRenderer !== "function") return;
  pi.registerEntryRenderer<NotifyEntryData>(NOTIFY_ENTRY_TYPE, notifyEntryRenderer);
}

/**
 * Deliver a host notification through the yellow `※ ` entry when the session
 * has a UI, or the plain notify fallback otherwise.
 */
export function notifyHost(pi: ExtensionAPI, ctx: ExtensionContext, message: string): void {
  if (ctx.hasUI) appendNotifyEntry(pi, message);
  else if (typeof ctx.ui?.notify === "function") ctx.ui.notify(message, "info");
}
