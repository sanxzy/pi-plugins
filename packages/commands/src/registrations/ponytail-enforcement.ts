import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { PONYTAIL_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { canonicalizeWriteEditTarget, isWriteEditAuthorized, loadPonytailState, resolveSettingsForProject } from "@xzy-ai/runtime";

/** Tool names enforced by the Ponytail write/edit authorization boundary. */
const ENFORCED_TOOLS = new Set(["write", "edit"]);

/**
 * Register the pre-execution write/edit authorization boundary. The host fires
 * `tool_call` before every built-in operation; returning `{ block: true,
 * reason }` stops execution. Stored scopes are used directly, never
 * re-resolved against a changed cwd.
 */
export function registerPonytailEnforcement(pi: ExtensionAPI): void {
  pi.on("tool_call", (event: ToolCallEvent, ctx: ExtensionContext): { block: true; reason: string } | undefined => {
    if (!ENFORCED_TOOLS.has(event.toolName)) return undefined;
    const sessionId = ctx.sessionManager?.getSessionId?.();
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return { block: true, reason: "Ponytail requires a valid session identity for write/edit authorization." };
    }
    const rawTarget = (event.input as { path?: string })?.path;
    if (typeof rawTarget !== "string" || rawTarget.length === 0) {
      return { block: true, reason: "Ponytail requires a target path for write/edit authorization." };
    }
    const state = loadPonytailState(sessionId, Date.now());
    if (!state && !resolveSettingsForProject(ctx.cwd).tools.ponytailEnabled) return undefined;
    if (state && state.enabled === false) return undefined;
    const target = canonicalizeWriteEditTargetFromCwd(ctx.cwd, rawTarget);
    if (!target) {
      return logDecision(event.toolName, "blocked", { block: true, reason: "Ponytail cannot authorize this write/edit target path. Request a correctly scoped ticket first." });
    }
    const decision = isWriteEditAuthorized(sessionId, target);
    if (!decision.ok) return logDecision(event.toolName, "blocked", { block: true, reason: decision.reason ?? "Ponytail cannot authorize this write/edit target." });
    return logDecision(event.toolName, "allowed", undefined);
  });
}

function logDecision<T>(tool: string, outcome: "allowed" | "blocked", result: T): T {
  return processWithLog({ operation: PONYTAIL_OPERATIONS.ENFORCE, parameters: { tool, outcome } }, () => result);
}

function canonicalizeWriteEditTargetFromCwd(cwd: string, rawTarget: string): string | undefined {
  const candidate = isAbsolutePath(rawTarget) ? rawTarget : joinPath(cwd, rawTarget);
  return canonicalizeWriteEditTarget(candidate);
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/");
}

function joinPath(cwd: string, tail: string): string {
  return `${cwd.replace(/\/+$/, "")}/${tail.replace(/^\/+/, "")}`;
}
