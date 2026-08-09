import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent";
import { saveConnectionMarker } from "@xzy-ai/channels";

/** Optional injectable seam for the marker write (used by tests). */
export interface ConnectionMarkerDeps {
  now?: () => string;
}

function nowIso(now?: () => string): string {
  return now ? now() : new Date().toISOString();
}

/** Write the `tui` marker. Used by the input handler and the setup command. */
export function markTui(projectRoot: string, deps: ConnectionMarkerDeps = {}): void {
  saveConnectionMarker(projectRoot, { lastConnection: "tui", updatedAt: nowIso(deps.now) });
}

/**
 * Wire the connection marker into the extension lifecycle.
 *
 * Any ordinary interactive prompt sets the fresh marker to `tui`. Authorized
 * Telegram input writes `telegram` in the channels inbound path; the setup
 * command writes `tui` explicitly in its own handler because registered
 * extension commands are handled before the `input` event.
 */
export function registerConnectionMarker(pi: ExtensionAPI, deps: ConnectionMarkerDeps = {}): void {
  pi.on("input", (event: InputEvent, ctx: ExtensionContext) => {
    if (event.source === "interactive") {
      markTui(ctx.cwd, deps);
    }
  });
}