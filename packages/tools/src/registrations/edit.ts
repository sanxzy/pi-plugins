import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createEditTool } from "@earendil-works/pi-coding-agent";
import Type, { type Static } from "typebox";
import { canonicalProjectRoot, canonicalizeWriteEditTarget, loadPonytailState, ponytailStateExists, resolveSettingsForProject } from "@xzy-ai/runtime";
import { isWithinScope } from "@xzy-ai/runtime";
import { PONYTAIL_OPERATIONS, TOOL_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { errorResult, textResult } from "../results.ts";

/**
 * Ponytail-aware wrapper around the built-in `edit` tool.
 *
 * When Ponytail is enabled for the active session the wrapper requires a
 * `ticket` issued by `create_write_edit_ticket` and validates that the ticket
 * is unexpired and its scopes canonically contain the target. When Ponytail is
 * disabled the wrapper delegates directly to the host edit behaviour with no
 * ticket required. Validation is inside the tool execution flow rather than a
 * `tool_call` hook.
 */

export const editParams = Type.Object({
  path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
  edits: Type.Array(Type.Object({
    oldText: Type.String({ description: "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call." }),
    newText: Type.String({ description: "Replacement text for this targeted edit." }),
  }, { additionalProperties: false }), { description: "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead." }),
  ticket: Type.Optional(Type.String({ description: "Ponytail ticket obtained from create_write_edit_ticket when Ponytail is enabled. Required when Ponytail is enabled; omit when Ponytail is disabled.", minLength: 1 })),
}, { additionalProperties: false });

export type EditParams = Static<typeof editParams>;

export interface EditDetails {
  readonly rejected?: boolean;
  readonly reason?: string;
  readonly diff?: string;
  readonly patch?: string;
  readonly firstChangedLine?: number;
}

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

/** Register the Ponytail-aware edit wrapper. It overrides the built-in `edit` definition. */
export function registerEditTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "edit",
    label: "Edit",
    description: "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
    promptSnippet: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
    promptGuidelines: ["Use edit for precise changes (edits[].oldText must match exactly)", "When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls", "Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.", "Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions."],
    parameters: editParams,
    async execute(
      _toolCallId: string,
      params: EditParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<EditDetails>> {
      return processWithLog({ operation: TOOL_OPERATIONS.EDIT_EXECUTE, parameters: { path: params.path } }, () => executeEdit(params, ctx, signal));
    },
  });
}

/** Execute one edit request with Ponytail ticket validation baked into the tool flow. */
export async function executeEdit(
  params: EditParams,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<AgentToolResult<EditDetails>> {
  const sessionId = ctx.sessionManager?.getSessionId?.();
  if (typeof sessionId !== "string" || sessionId.length === 0 || !SAFE_SESSION_ID.test(sessionId)) {
    const reason = "Ponytail requires a valid session identity for write/edit authorization.";
    return logDecision("edit", "blocked", errorResult(reason, { rejected: true, reason }));
  }

  const rawTarget = params.path;
  if (typeof rawTarget !== "string" || rawTarget.length === 0) {
    const reason = "Ponytail requires a target path for write/edit authorization.";
    return logDecision("edit", "blocked", errorResult(reason, { rejected: true, reason }));
  }

  const projectRoot = canonicalProjectRoot(ctx.cwd);
  const target = canonicalizeWriteEditTargetFromCwd(ctx.cwd, rawTarget);

  if (!target || !isWithinProject(target, projectRoot)) {
    const reason = "Ponytail cannot authorize this write/edit target path. Request a correctly scoped ticket first.";
    return logDecision("edit", "blocked", errorResult(reason, { rejected: true, reason }));
  }

  const now = Date.now();
  const state = loadPonytailState(sessionId, now);

  if (!state) {
    if (ponytailStateExists(sessionId)) {
      const reason = "Ponytail state is malformed or unrecoverable for this session. Write/edit is blocked until the state is repaired or reset.";
      return logDecision("edit", "blocked", errorResult(reason, { rejected: true, reason }));
    }
    if (!resolveSettingsForProject(ctx.cwd).tools.ponytailEnabled) {
      return logDecision("edit", "allowed", await delegateEdit(target, params.edits, ctx.cwd, signal));
    }
    const reason = "Ponytail is not enabled for this session.";
    return logDecision("edit", "blocked", errorResult(reason, { rejected: true, reason }));
  }

  if (state.enabled === false) {
    return logDecision("edit", "allowed", await delegateEdit(target, params.edits, ctx.cwd, signal));
  }

  const ticketValue = typeof params.ticket === "string" ? params.ticket : "";
  if (ticketValue.length === 0) {
    const reason = "Ponytail ticket is required for this write/edit target. Request a correctly scoped ticket first.";
    return logDecision("edit", "blocked", errorResult(reason, { rejected: true, reason }));
  }

  const matched = state.tickets.find((ticket) => ticket.value === ticketValue && ticket.expiresAt > now);
  if (!matched) {
    const reason = "No unexpired Ponytail ticket covers this write/edit target. Request a correctly scoped ticket first.";
    return logDecision("edit", "blocked", errorResult(reason, { rejected: true, reason }));
  }

  if (!matched.scopes.some((scope) => isWithinScope(scope, target))) {
    const reason = "No unexpired Ponytail ticket covers this write/edit target. Request a correctly scoped ticket first.";
    return logDecision("edit", "blocked", errorResult(reason, { rejected: true, reason }));
  }

  return logDecision("edit", "allowed", await delegateEdit(target, params.edits, ctx.cwd, signal));
}

async function delegateEdit(
  canonicalTarget: string,
  edits: EditParams["edits"],
  cwd: string,
  signal?: AbortSignal,
): Promise<AgentToolResult<EditDetails>> {
  try {
    const hostEdit = createEditTool(canonicalProjectRoot(cwd));
    const result = await hostEdit.execute("edit", { path: canonicalTarget, edits }, signal);
    const text = result.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
    const details = result.details as { diff?: string; patch?: string; firstChangedLine?: number } | undefined;
    return textResult(text, {
      diff: details?.diff,
      patch: details?.patch,
      firstChangedLine: details?.firstChangedLine,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(message, { rejected: true, reason: message });
  }
}
