import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { PONYTAIL_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { canonicalProjectRoot, canonicalizeWriteEditTarget, isWriteEditAuthorized, loadPonytailState, ponytailStateExists, resolveSettingsForProject } from "@xzy-ai/runtime";

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
    if (typeof sessionId !== "string" || sessionId.length === 0 || !SAFE_SESSION_ID.test(sessionId)) {
      return { block: true, reason: "Ponytail requires a valid session identity for write/edit authorization." };
    }
    const rawTarget = (event.input as { path?: string })?.path;
    if (typeof rawTarget !== "string" || rawTarget.length === 0) {
      return { block: true, reason: "Ponytail requires a target path for write/edit authorization." };
    }
    const projectRoot = canonicalProjectRoot(ctx.cwd);
    const state = loadPonytailState(sessionId, Date.now());
    if (!state) {
      // An existing but unusable state file must fail closed even when the home
      // default is disabled; only a genuinely absent file preserves compatibility.
      if (ponytailStateExists(sessionId)) {
        return logDecision(event.toolName, "blocked", { block: true, reason: "Ponytail state is malformed or unrecoverable for this session. Write/edit is blocked until the state is repaired or reset." });
      }
      if (!resolveSettingsForProject(ctx.cwd).tools.ponytailEnabled) return undefined;
    }
    if (state && state.enabled === false) return undefined;
    const target = canonicalizeWriteEditTargetFromCwd(ctx.cwd, rawTarget);
    if (!target || !isWithinProject(target, projectRoot)) {
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

/** True when `candidate` equals `root` or is a true descendant of it. */
function isWithinProject(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return candidate.startsWith(prefix);
}

/** Same storage-safe identity rule used by the runtime state paths. */
const SAFE_SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
