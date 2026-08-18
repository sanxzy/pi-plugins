import { existsSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createWriteTool } from "@earendil-works/pi-coding-agent";
import { canonicalProjectRoot, canonicalizeWriteEditTarget } from "@xzy-ai/runtime";
import { TOOL_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { errorResult, textResult } from "../results.ts";
import Type, { type Static } from "typebox";

/**
 * Ticket-free Markdown/Text write tool.
 *
 * The dedicated tool is ticket-free only because its target policy is
 * narrower: the canonical target must stay inside the active project and its
 * final component must end in `.md`, `.mdx`, or `.txt` (case-insensitive).
 * Generic built-in `write` remains governed by the Ponytail ticket boundary.
 */

export const writeMarkdownParams = Type.Object({
  path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
  content: Type.String({ description: "Content to write to the file" }),
}, { additionalProperties: false });

export type WriteMarkdownParams = Static<typeof writeMarkdownParams>;

/** Allowed Markdown/Text extensions, matched case-insensitively against the final path component. */
const ALLOWED_EXTENSIONS = new Set([".md", ".mdx", ".txt"]);

export interface WriteMarkdownDetails {
  readonly rejected?: boolean;
  readonly reason?: string;
  readonly bytes?: number;
}

/** Resolve and canonicalize the target, then classify the final component's extension. */
export function admitWriteMarkdownTarget(rawTarget: string, cwd: string): { ok: true; path: string } | { ok: false; reason: string } {
  const absolute = isAbsolute(rawTarget) ? rawTarget : resolve(cwd, rawTarget);
  const canonical = canonicalizeWriteEditTarget(absolute);
  if (!canonical) return { ok: false, reason: "The target path is unsafe or outside the project." };
  const projectRoot = canonicalProjectRoot(cwd);
  if (!isWithinProject(canonical, projectRoot)) return { ok: false, reason: "The target path is outside the active project." };
  const finalComponent = canonical.split(/[\\/]/).pop() ?? "";
  if (!ALLOWED_EXTENSIONS.has(extname(finalComponent).toLowerCase())) {
    return { ok: false, reason: "Only .md, .mdx, and .txt targets are allowed for this tool." };
  }
  return { ok: true, path: canonical };
}

/** True when `candidate` is `root` or nested inside it. */
function isWithinProject(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return candidate.startsWith(prefix);
}

/** Register the ticket-free Markdown/Text write tool. */
export function registerWriteMarkdownTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "write_markdown",
    label: "Write markdown",
    description:
      "Write Markdown or text content to a file inside the active project. Creates the file if it does not exist, overwrites if it does, and automatically creates parent directories. Only .md, .mdx, and .txt targets are allowed.",
    parameters: writeMarkdownParams,
    async execute(
      _toolCallId: string,
      params: WriteMarkdownParams,
      signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult<WriteMarkdownDetails>> {
      return processWithLog({ operation: TOOL_OPERATIONS.WRITE_MARKDOWN_EXECUTE, parameters: { path: params.path } }, () => executeWriteMarkdown(params, ctx, signal));
    },
  });
}

/** Execute one write_markdown request through the host's write mutation behavior. */
export async function executeWriteMarkdown(
  params: WriteMarkdownParams,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<AgentToolResult<WriteMarkdownDetails>> {
  const admitted = admitWriteMarkdownTarget(params.path, ctx.cwd);
  if (!admitted.ok) {
    return processWithLog({ operation: TOOL_OPERATIONS.WRITE_MARKDOWN_REJECT, parameters: { reason: admitted.reason } }, () =>
      errorResult(admitted.reason, { rejected: true, reason: admitted.reason }));
  }
  try {
    const hostWrite = createWriteTool(canonicalProjectRoot(ctx.cwd));
    const result = await hostWrite.execute("write_markdown", { path: admitted.path, content: params.content }, signal);
    const text = result.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
    return textResult(text, { bytes: params.content.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(message, { rejected: true, reason: message });
  }
}
