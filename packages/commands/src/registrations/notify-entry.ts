import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Deliver a host notification through the session UI's notify channel.
 *
 * Notifications render as a yellow `※ ` line: the message is prefixed with
 * `※ ` and delivered through the `warning` notify type, which the host maps to
 * its warning color. This matches the previous custom-entry renderer output
 * without depending on host custom-entry support. When no UI is available the
 * notify is a no-op.
 */
export function notifyHost(_pi: ExtensionAPI, ctx: ExtensionContext, message: string): void {
  if (typeof ctx.ui?.notify === "function") ctx.ui.notify(`※ ${message}`, "warning");
}
