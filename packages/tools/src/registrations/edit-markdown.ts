import { dirname, extname, isAbsolute, resolve } from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createEditTool } from "@earendil-works/pi-coding-agent";
import { canonicalProjectRoot } from "@xzy-ai/runtime";
import { TOOL_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { errorResult, textResult } from "../results.ts";
import { admitWriteMarkdownTarget } from "./write-markdown.ts";
import Type, { type Static } from "typebox";

/**
 * Ticket-free Markdown/Text edit tool.
 *
 * Like `write_markdown`, the dedicated tool is ticket-free because its target
 * policy is narrower: the canonical target must stay inside the active project
 * and its final component must end in `.md`, `.mdx`, or `.txt`
 * (case-insensitive). All mutation behavior (exact replacement validation,
 * multiple disjoint edits, BOM and line-ending handling, diff/patch details,
 * abort handling, serialized mutation) is delegated to the host edit tool, and
 * every rejection happens before any read or write of the target.
 */

export const editMarkdownParams = Type.Object({
  path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
  edits: Type.Array(Type.Object({
    oldText: Type.String({ description: "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call." }),
    newText: Type.String({ description: "Replacement text for this targeted edit." }),
  }, { additionalProperties: false }), { description: "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead." }),
}, { additionalProperties: false });

export type EditMarkdownParams = Static<typeof editMarkdownParams>;

export interface EditMarkdownDetails {
  readonly rejected?: boolean;
  readonly reason?: string;
  readonly diff?: string;
  readonly patch?: string;
  readonly firstChangedLine?: number;
}

/** Register the ticket-free Markdown/Text edit tool. */
export function registerEditMarkdownTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "edit_markdown",
    label: "Edit markdown",
    description:
      "Edit a Markdown or text file inside the active project using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. Only .md, .mdx, and .txt targets are allowed.",
    parameters: editMarkdownParams,
    async execute(
      _toolCallId: string,
      params: EditMarkdownParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<EditMarkdownDetails>> {
      return processWithLog({ operation: TOOL_OPERATIONS.EDIT_MARKDOWN_EXECUTE, parameters: { path: params.path } }, () => executeEditMarkdown(params, ctx, signal));
    },
  });
}

/** Execute one edit_markdown request through the host's edit mutation behavior. */
export async function executeEditMarkdown(
  params: EditMarkdownParams,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<AgentToolResult<EditMarkdownDetails>> {
  const admitted = admitWriteMarkdownTarget(params.path, ctx.cwd);
  if (!admitted.ok) {
    return processWithLog({ operation: TOOL_OPERATIONS.EDIT_MARKDOWN_REJECT, parameters: { reason: admitted.reason } }, () =>
      errorResult(admitted.reason, { rejected: true, reason: admitted.reason }));
  }
  try {
    const hostEdit = createEditTool(canonicalProjectRoot(ctx.cwd));
    const result = await hostEdit.execute("edit_markdown", { path: admitted.path, edits: params.edits }, signal);
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
