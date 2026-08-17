import { randomBytes } from "node:crypto";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import Type, { type Static } from "typebox";
import {
  mutatePonytailState,
  resolveSettingsForProject,
  resolveTicketScopes,
  type PonytailPersistence,
  type PonytailTicket,
} from "@xzy-ai/runtime";
import { errorResult, textResult } from "../results.ts";

export const createWriteEditTicketParams = Type.Object({
  directories: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, description: "One or more project-relative directory paths." }),
  doesNeedToExist: Type.Boolean(),
  alreadyAvailableInCodebase: Type.Boolean(),
  standardLibraryOrNativePlatformCanHandleIt: Type.Boolean(),
  installedDependencyCanHandleIt: Type.Boolean(),
  canBeOneLine: Type.Boolean(),
  requiresNewDependency: Type.Boolean(),
  hasClearVerificationPath: Type.Boolean(),
}, { additionalProperties: false });

export type CreateWriteEditTicketParams = Static<typeof createWriteEditTicketParams>;

export interface CreateWriteEditTicketDetails {
  readonly ticket?: string;
  readonly mode: "issued" | "yagni" | "error";
}

export interface CreateWriteEditTicketOptions {
  readonly now?: () => number;
  readonly persistence?: PonytailPersistence;
}

const YAGNI = "Skip it and state why in one line. YAGNI — do not add code that does not need to exist.";

/** Register the Ponytail single-attempt ticket tool. */
export function registerWriteEditTicketTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "create_write_edit_ticket",
    label: "Create write/edit ticket",
    description: "Create a reusable write/edit authorization ticket for project-relative directories. Supply every directory and all seven required boolean evaluations. If doesNeedToExist is false, no ticket is issued and you should skip the implementation; otherwise the tool returns the ticket and deterministic advisor guidance. Reuse an unexpired ticket within its scopes.",
    parameters: createWriteEditTicketParams,
    async execute(_toolCallId: string, params: CreateWriteEditTicketParams, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext): Promise<AgentToolResult<CreateWriteEditTicketDetails>> {
      return executeCreateWriteEditTicket(params, ctx);
    },
  });
}

/** Execute one complete, validated, single-attempt ticket request. */
export async function executeCreateWriteEditTicket(
  params: CreateWriteEditTicketParams,
  ctx: ExtensionContext,
  options: CreateWriteEditTicketOptions = {},
): Promise<AgentToolResult<CreateWriteEditTicketDetails>> {
  const sessionId = ctx.sessionManager?.getSessionId?.();
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return errorResult("Ponytail requires a valid session identity.", { mode: "error" });
  }
  if (!params.doesNeedToExist) return textResult(YAGNI, { mode: "yagni" });

  const now = options.now?.() ?? Date.now();
  try {
    const settings = resolveSettingsForProject(ctx.cwd);
    const scopes = resolveTicketScopes({ projectRoot: ctx.cwd, directories: params.directories }).map((scope) => scope.canonical);
    let issuedTicket: string | undefined;
    await mutatePonytailState(sessionId, now, (current) => {
      if (!current || !current.enabled) {
        throw new Error("Ponytail is not enabled for this session.");
      }
      issuedTicket = randomBytes(32).toString("base64url");
      const ticket: PonytailTicket = {
        value: issuedTicket,
        scopes,
        createdAt: now,
        expiresAt: now + settings.tools.writeEditTicketTtlMs,
      };
      return { version: 1, enabled: current.enabled, tickets: [...current.tickets, ticket] };
    }, options.persistence);
    if (!issuedTicket) throw new Error("Unable to create the write/edit ticket.");
    return textResult(formatIssuedTicket(issuedTicket, params), { mode: "issued", ticket: issuedTicket });
  } catch {
    return errorResult("Unable to persist the write/edit ticket. No new ticket was activated.", { mode: "error" });
  }
}

function formatIssuedTicket(ticket: string, params: CreateWriteEditTicketParams): string {
  const guidance = [
    params.doesNeedToExist
      ? "Good — the implementation has been justified as necessary. Continue evaluating the remaining checks and keep the change minimal."
      : YAGNI,
    params.alreadyAvailableInCodebase
      ? "Prefer reusing the existing codebase capability instead of duplicating it. Extend the established implementation only where necessary."
      : "No existing codebase capability was identified. Keep the new implementation focused, follow nearby repository patterns, and avoid duplicating unrelated functionality.",
    params.standardLibraryOrNativePlatformCanHandleIt
      ? "Prefer the available standard-library or native platform feature instead of recreating it. Use the smallest correct integration with the existing capability."
      : "No suitable standard-library or native platform feature was identified. Keep the implementation focused and avoid adding complexity that does not serve the required behavior.",
    params.installedDependencyCanHandleIt
      ? "Prefer the installed dependency that already provides this capability. Do not add duplicate implementation or another package unless there is a clear limitation."
      : "No installed dependency already solves this need. Prefer the standard library, native platform, or focused existing-code solution before considering a new package.",
    params.canBeOneLine
      ? "Good — you are choosing a very efficient solution."
      : "Make sure the change is well traced and verified. Use available linting, testing, or similar codebase checks to preserve code quality and avoid regressions.",
    params.requiresNewDependency
      ? "Make sure you use the dependency properly. Wrap it behind an adapter before using it so that, if it needs to be replaced with another package or dependency in the future, other developers can replace it without unnecessary pain."
      : "Good — no new dependency is required. Prefer the existing codebase, standard library, native platform, or installed dependencies and keep the change minimal.",
    params.hasClearVerificationPath
      ? "Good — you have a clear verification path. Run the relevant checks and confirm the change preserves existing behavior."
      : "Make sure the change is well traced and verified. Use available linting, testing, or similar codebase checks to preserve code quality and avoid regressions.",
  ];
  return `Write/edit ticket: ${ticket}\nAdvisor:\n${guidance.map((line) => `- ${line}`).join("\n")}`;
}
