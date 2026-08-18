import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createWriteTool } from "@earendil-works/pi-coding-agent";
import Type, { type Static } from "typebox";
import { canonicalProjectRoot, canonicalizeWriteEditTarget, loadPonytailState, ponytailStateExists } from "@xzy-ai/runtime";
import { isWithinScope } from "@xzy-ai/runtime";
import { PONYTAIL_OPERATIONS, TOOL_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { errorResult, textResult } from "../results.ts";

/**
 * Ponytail-aware `write` tool.
 *
 * The definition is registered ONLY for sessions whose effective Ponytail
 * state is enabled (root sessions at `session_start`, child sessions through
 * their isolated custom-tools list). When Ponytail is disabled the definition
 * is absent and the host built-in `write` operates normally. The schema
 * therefore requires a `ticket` issued by `create_write_edit_ticket`: the
 * model must hold a valid unexpired ticket whose canonical scopes contain the
 * target before any file is written. Validation happens inside the tool
 * execution flow; the host `tool_call` hook is not used.
 */

export const writeParams = Type.Object({
  path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
  content: Type.String({ description: "Content to write to the file" }),
  ticket: Type.String({ description: "Ponytail ticket obtained from create_write_edit_ticket. Required: write/edit is authorized only with a valid unexpired ticket covering the target." }),
}, { additionalProperties: false });

export type WriteParams = Static<typeof writeParams>;

export interface WriteDetails {
  readonly rejected?: boolean;
  readonly reason?: string;
  readonly bytes?: number;
}

/** Same storage-safe identity rule used by the runtime state paths. */
const SAFE_SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/");
}

function joinPath(cwd: string, tail: string): string {
  return `${cwd.replace(/\/+$/, "")}/${tail.replace(/^\/+/, "")}`;
}

function canonicalizeWriteEditTargetFromCwd(cwd: string, rawTarget: string): string | undefined {
  const candidate = isAbsolutePath(rawTarget) ? rawTarget : joinPath(cwd, rawTarget);
  return canonicalizeWriteEditTarget(candidate);
}

function isWithinProject(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return candidate.startsWith(prefix);
}

function logDecision<T>(tool: string, outcome: "allowed" | "blocked", result: T): T {
  return processWithLog({ operation: PONYTAIL_OPERATIONS.ENFORCE, parameters: { tool, outcome } }, () => result);
}

/** Construct the Ponytail-aware `write` definition (root registration and child custom tools). */
export function createPonytailWriteTool(): ToolDefinition<typeof writeParams, WriteDetails> {
  return {
    name: "write",
    label: "Write",
    description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    promptSnippet: "Create or overwrite files",
    promptGuidelines: ["Use write only for new files or complete rewrites."],
    parameters: writeParams,
    async execute(
      _toolCallId: string,
      params: WriteParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<WriteDetails>> {
      return processWithLog({ operation: TOOL_OPERATIONS.WRITE_EXECUTE, parameters: { path: params.path } }, () => executeWrite(params, ctx, signal));
    },
  };
}

/** Register the Ponytail-aware write definition on an extension API. */
export function registerWriteTool(pi: ExtensionAPI): void {
  pi.registerTool(createPonytailWriteTool());
}

/** Execute one write request with Ponytail ticket validation baked into the tool flow. */
export async function executeWrite(
  params: WriteParams,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<AgentToolResult<WriteDetails>> {
  const sessionId = ctx.sessionManager?.getSessionId?.();
  if (typeof sessionId !== "string" || sessionId.length === 0 || !SAFE_SESSION_ID.test(sessionId)) {
    const reason = "Ponytail requires a valid session identity for write/edit authorization.";
    return logDecision("write", "blocked", errorResult(reason, { rejected: true, reason }));
  }

  const rawTarget = params.path;
  if (typeof rawTarget !== "string" || rawTarget.length === 0) {
    const reason = "Ponytail requires a target path for write/edit authorization.";
    return logDecision("write", "blocked", errorResult(reason, { rejected: true, reason }));
  }

  const projectRoot = canonicalProjectRoot(ctx.cwd);
  const target = canonicalizeWriteEditTargetFromCwd(ctx.cwd, rawTarget);

  // Enforce project containment before any state check so escapes are never authorized.
  if (!target || !isWithinProject(target, projectRoot)) {
    const reason = "Ponytail cannot authorize this write/edit target path. Request a correctly scoped ticket first.";
    return logDecision("write", "blocked", errorResult(reason, { rejected: true, reason }));
  }

  const now = Date.now();
  const state = loadPonytailState(sessionId, now);

  // The definition only exists for enabled sessions. Missing state is therefore
  // abnormal (for example the state file was deleted mid-session) and fails
  // closed; malformed state fails closed like the former hook. An explicitly
  // disabled state is a stale-runtime edge (state changed after registration)
  // and delegates without a ticket.
  if (!state) {
    if (ponytailStateExists(sessionId)) {
      const reason = "Ponytail state is malformed or unrecoverable for this session. Write/edit is blocked until the state is repaired or reset.";
      return logDecision("write", "blocked", errorResult(reason, { rejected: true, reason }));
    }
    const reason = "Ponytail state is missing for this session. Write/edit is blocked until the state is repaired or reset.";
    return logDecision("write", "blocked", errorResult(reason, { rejected: true, reason }));
  }

  if (state.enabled === false) {
    return logDecision("write", "allowed", await delegateWrite(target, params.content, ctx.cwd, signal));
  }

  // Ponytail is enabled – a valid ticket is required and must cover the target.
  const ticketValue = typeof params.ticket === "string" ? params.ticket : "";
  if (ticketValue.length === 0) {
    const reason = "Ponytail ticket is required for this write/edit target. Request a correctly scoped ticket first.";
    return logDecision("write", "blocked", errorResult(reason, { rejected: true, reason }));
  }

  const matched = state.tickets.find((ticket) => ticket.value === ticketValue && ticket.expiresAt > now);
  if (!matched) {
    const reason = "No unexpired Ponytail ticket covers this write/edit target. Request a correctly scoped ticket first.";
    return logDecision("write", "blocked", errorResult(reason, { rejected: true, reason }));
  }

  if (!matched.scopes.some((scope) => isWithinScope(scope, target))) {
    const reason = "No unexpired Ponytail ticket covers this write/edit target. Request a correctly scoped ticket first.";
    return logDecision("write", "blocked", errorResult(reason, { rejected: true, reason }));
  }

  return logDecision("write", "allowed", await delegateWrite(target, params.content, ctx.cwd, signal));
}

async function delegateWrite(
  canonicalTarget: string,
  content: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<AgentToolResult<WriteDetails>> {
  try {
    const hostWrite = createWriteTool(canonicalProjectRoot(cwd));
    const result = await hostWrite.execute("write", { path: canonicalTarget, content }, signal);
    const text = result.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
    return textResult(text, { bytes: content.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(message, { rejected: true, reason: message });
  }
}
