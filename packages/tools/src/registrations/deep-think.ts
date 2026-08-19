import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import Type, { type Static } from "typebox";
import { nanoid } from "nanoid";
import { DEFAULT_THINKING_REQUIRED_TURNS, loadThinkingState, mutateThinkingState } from "@xzy-ai/runtime";
import { TOOL_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { errorResult, textResult } from "../results.ts";
import { renderToolCall, renderToolOutcome, toolResultFailed } from "../render.ts";

export const deepThinkParams = Type.Object({
  thoughts: Type.String({ description: "Thought content to append to the thinking scratchpad for deliberate reasoning." }),
  id: Type.Optional(Type.String({ description: "Optional scratchpad identifier to continue a previous thinking chain." })),
}, { additionalProperties: false });

export type DeepThinkParams = Static<typeof deepThinkParams>;

export interface DeepThinkDetails {
  readonly id: string;
  readonly recorded: number;
  readonly scratchpad: readonly string[];
  readonly instruction: string;
}

const INSTRUCTION = "Continue thinking, or answer/act now...";

const SAFE_SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function isValidSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === "string" && sessionId.length > 0 && SAFE_SESSION_ID.test(sessionId);
}

/** Construct the deep_think tool definition. */
export function createDeepThinkTool(): ToolDefinition<typeof deepThinkParams, DeepThinkDetails> {
  return {
    name: "deep_think",
    label: "Deep think",
    description: "Append thoughts to the thinking scratchpad for deliberate reasoning. Use when you need to think more carefully before acting.",
    parameters: deepThinkParams,
    async execute(
      _toolCallId: string,
      params: DeepThinkParams,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<DeepThinkDetails>> {
      return processWithLog({ operation: TOOL_OPERATIONS.DEEP_THINK_EXECUTE, parameters: { id: params.id } }, () => executeDeepThink(params, ctx));
    },
  };
}

/** Register the deep_think tool on an extension API. */
export function registerDeepThinkTool(pi: ExtensionAPI): void {
  pi.registerTool(createDeepThinkTool());
}

export async function executeDeepThink(
  params: DeepThinkParams,
  ctx: ExtensionContext,
): Promise<AgentToolResult<DeepThinkDetails>> {
  const sessionId = ctx.sessionManager?.getSessionId?.();
  if (!isValidSessionId(sessionId)) {
    return errorResult("Thinking tool requires a valid session identity.", {
      id: params.id ?? "",
      recorded: 0,
      scratchpad: [],
      instruction: INSTRUCTION,
    });
  }

  const thoughts = typeof params.thoughts === "string" ? params.thoughts : "";
  if (thoughts.length === 0) {
    return errorResult("Thoughts must not be empty.", {
      id: params.id ?? "",
      recorded: 0,
      scratchpad: [],
      instruction: INSTRUCTION,
    });
  }

  const now = Date.now();
  const state = loadThinkingState(sessionId, now);
  if (!state || state.enabled !== true) {
    return errorResult("Thinking tool is not enabled for this session. Enable it with /c2-setup-thinking-tool.", {
      id: params.id ?? "",
      recorded: 0,
      scratchpad: [],
      instruction: INSTRUCTION,
    });
  }

  const requestedId = typeof params.id === "string" && params.id.length > 0 ? params.id : undefined;
  let effectiveId = requestedId;
  let recorded = 0;
  let scratchpad: string[] = [];

  try {
    const next = await mutateThinkingState(sessionId, now, (current) => {
      const base = current ?? { version: 1 as const, enabled: true, requiredTurns: DEFAULT_THINKING_REQUIRED_TURNS, scratchpad: [], scratchpads: {} };
      const requiredTurns = typeof (base as unknown as { requiredTurns?: unknown }).requiredTurns === "number"
        ? (base as { requiredTurns: number }).requiredTurns
        : DEFAULT_THINKING_REQUIRED_TURNS;
      // Normalize legacy shape
      const globalScratchpad = Array.isArray((base as unknown as { scratchpad?: unknown }).scratchpad) ? [...(base.scratchpad as string[])] : [];
      const perId = (base as unknown as { scratchpads?: Record<string, string[]> }).scratchpads && typeof (base as unknown as { scratchpads?: unknown }).scratchpads === "object"
        ? { ...(base.scratchpads as Record<string, string[]>) }
        : {};

      // Determine id to use
      const idToUse = requestedId ?? nanoid(7);
      effectiveId = idToUse;

      // For global tracking, always append to global scratchpad
      const nextGlobal = [...globalScratchpad, thoughts];

      // For per-id, maintain isolated scratchpad per id
      const currentPerId = perId[idToUse] ? [...perId[idToUse]!] : [];
      const nextPerId = [...currentPerId, thoughts];
      perId[idToUse] = nextPerId;

      // Scoped by id: each id is an isolated thread. Omitting id starts a new thread.
      recorded = nextPerId.length;
      scratchpad = [...nextPerId];

      return {
        version: 1,
        enabled: base.enabled,
        requiredTurns,
        scratchpad: nextGlobal,
        scratchpads: perId,
      };
    });

    // If mutate didn't run (should not happen), fallback to computed
    if (!effectiveId) effectiveId = requestedId ?? nanoid(7);
    if (scratchpad.length === 0 && next) {
      // In case of race where recorded wasn't set due to outside computation,
      // derive from persisted next state (scoped by id)
      const persistedPerId = next.scratchpads[effectiveId!];
      if (persistedPerId) {
        recorded = persistedPerId.length;
        scratchpad = [...persistedPerId];
      } else {
        recorded = next.scratchpad.length;
        scratchpad = [...next.scratchpad];
      }
    }

    const id = effectiveId!;
    const details: DeepThinkDetails = {
      id,
      recorded,
      scratchpad,
      instruction: INSTRUCTION,
    };
    const payload = JSON.stringify(details, null, 2);
    return textResult(payload, details);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(message, {
      id: requestedId ?? "",
      recorded: 0,
      scratchpad: [],
      instruction: INSTRUCTION,
    });
  }
}
