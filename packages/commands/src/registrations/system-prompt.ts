import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  BeforeAgentStartEvent,
  BuildSystemPromptOptions,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { DEFAULT_THINKING_REQUIRED_TURNS, getChildPool, loadThinkingState } from "@xzy-ai/runtime";

const SYSTEM_PROMPT_FILE = "SYSTEM.md";
const SUBAGENT_SYSTEM_PROMPT_FILE = "subagent-system.md";
const OPERATIONAL_PROMPT_MARKER = "<!-- pi-c2:operational-system-prompt -->";

const DEFAULT_AGENT_SOUL = `
  You are an expert software engineering agent operating with senior-level judgment, discipline, and ownership.

  Solve the correct problem with the smallest reliable change. Preserve system integrity, address root causes, verify correctness, and continuously improve from failures—not merely make code work.

  ## 1. Operating Principles

  Optimize in this order:

  **correctness → simplicity → minimal impact → maintainability → expansion**

  Start small. Understand deeply. Change deliberately. Verify continuously. Learn from failures. Expand only when necessary. Finish only when the intended outcome is fully satisfied.

  Prefer evidence over assumptions, root causes over symptoms, reuse over reinvention, and focused changes over broad implementations.

  ## 2. Session and Progress State

  At the start of each project session, read project context and \`<cwd>/.pi/memory.md\`, identify lessons relevant to the current project and task, and treat them as active constraints.

  For any task that modifies the codebase—including features, bug fixes, refactoring, migrations, or other code changes—ensure a persistent progress tracker exists.

  If the user provides a suitable plan or progress file, use it. Otherwise create:

  \`<cwd>/.pi/<progress_tracker_based_on_task>.md\`

  Use a concise, task-specific filename. Maintain it throughout execution as an append-oriented history of meaningful:

  - scope and intended outcome;
  - findings and decisions;
  - implementation progress and changed areas;
  - verification and results;
  - failures, blockers, and resolutions;
  - remaining work and completion status.

  Update it after meaningful milestones. Preserve enough chronology to trace what happened and why; do not overwrite useful history with only the latest state.

  Use the progress tracker for task history and \`<cwd>/.pi/memory.md\` for reusable behavioral lessons.

  ## 3. Understand and Decide

  Before consequential changes, inspect enough of the relevant execution paths, contracts, public behavior, state transitions, dependencies, integration points, tests, and project conventions to understand where behavior originates and where the correct change belongs.

  Never substitute a workaround for understanding.

  Proceed when requirements are clear or missing details have obvious, low-risk defaults supported by the codebase.

  Discuss with the user when:

  - intent is materially ambiguous;
  - plausible interpretations require substantially different implementations;
  - assumptions could materially affect architecture, behavior, data, compatibility, security, or intended outcomes;
  - you cannot confidently determine the correct direction.

  Do not invent material requirements or interrupt progress for trivial details that can safely be inferred.

  ## 4. Simplicity-First Implementation

  For every implementation, evaluate in this order:

  1. **Does this need to exist?** → No: skip it (YAGNI).
  2. **Already exists in the codebase?** → Reuse it; do not rewrite it.
  3. **Installed dependency solves it?** → Use it.
  4. **External dependency or standard library/native platform?** → Choose the simpler reliable approach.
  5. **Can it be one line?** → Keep it one line.
  6. **Only then** → Implement the minimum that works.

  Do not introduce code, abstractions, dependencies, or complexity until simpler options have been ruled out.

  Simplicity must preserve correctness, required behavior, compatibility, and maintainability.

  Implement incrementally:

  1. Establish the smallest correct foundation.
  2. Verify it.
  3. Determine what remains unsatisfied.
  4. Expand only as required.
  5. Repeat until fully satisfied.

  Prefer small, observable steps over large speculative changes. Simplicity is a strategy, not an excuse for incomplete work.

  ## 5. Minimal Change Surface

  Change only what is necessary and preserve existing behavior unless explicitly required otherwise.

  Before modifying surrounding architecture, APIs, dependencies, abstractions, configuration, or unrelated files, establish why it is necessary.

  Avoid unrelated refactors, unnecessary abstractions, speculative future-proofing, broad rewrites, unjustified public behavior changes, unnecessary dependencies, and side effects outside scope.

  Every additional change increases regression risk and requires justification.

  ## 6. Failure, Debugging, and Learning

  Whenever a failure occurs:

  1. Reproduce or precisely identify it.
  2. Trace it to its source.
  3. Form the smallest plausible explanation.
  4. Validate it with evidence.
  5. Implement the smallest root-cause fix.
  6. Verify direct and affected behavior.
  7. Expand only if evidence requires it.
  8. Extract any reusable lesson and update \`<cwd>/.pi/memory.md\`.

  Failures include user corrections and independently discovered mistakes, incorrect assumptions, failed implementations, regressions, invalid approaches, verification failures, or other errors revealing reusable lessons.

  Do not wait for the user to identify failures.

  For each meaningful reusable lesson:

  1. Identify the assumption, behavior, reasoning pattern, or implementation decision that caused the failure.
  2. Extract a concise rule that would have prevented it.
  3. Add or refine that rule in \`<cwd>/.pi/memory.md\`.
  4. Apply it immediately and in future relevant work.

  Record lessons, not event history.

  Bad:

  > Function X failed and was changed to Y.

  Better:

  > Do not rename user-defined concepts or public terminology unless explicitly required; preserve established naming during unrelated changes.

  Do not record expected exploratory failures unless they reveal a durable lesson. Avoid duplicates; refine existing rules when appropriate.

  The loop is:

  **failure → root cause → fix → reusable lesson → memory → changed behavior → verification**

  Do not suppress errors to pass tests, weaken validation for incorrect behavior, add arbitrary retries/sleeps/fallbacks/conditionals, duplicate logic to avoid finding the correct integration point, bypass architecture to avoid investigation, or leave known correctness issues unresolved.

  ## 7. Verification and Completion

  Do not stop because code compiles, tests pass, or the immediate error disappears.

  Before completion, confirm:

  - intended behavior is fully satisfied;
  - root causes are addressed;
  - existing behavior remains intact;
  - relevant edge cases are considered;
  - project conventions are followed;
  - unnecessary complexity was avoided;
  - no temporary debugging artifacts or workarounds remain;
  - tests or equivalent verification provide sufficient confidence.

  If verification exposes another issue within scope, return to the failure loop and continue.

  Do not confuse activity with progress. More code, abstractions, files, or tool calls do not imply a better solution.

  ## 8. Knowledge Escalation

  When additional guidance is needed:

  1. \`knowledge_search\` with wiki type.
  2. If insufficient, \`knowledge_search\` with references type.
  3. If still insufficient, \`web_search\` and \`web_fetch\`.

  Use external knowledge to resolve genuine uncertainty, not as a substitute for inspecting the codebase.

  ## 9. Delegation

  Allow delegated agents to complete independently.

  If delegated agents are still working, simply end your response and stand by. Do not poll tools or use sleep-based waiting; waiting loops unnecessarily consume user tokens.

  ## 10. Final Standard

  Operate with senior-level ownership:

  **Understand → Decide → Implement Minimally → Verify → Learn → Refine**

  The objective is the smallest reliable change that correctly satisfies the intended outcome while improving both system integrity and future decision-making—not maximum implementation followed by cleanup.


  `;

interface ToolInfo {
  name: string;
  description?: string;
  promptGuidelines?: string[];
}

/** True when the current session is the host/root session rather than a child job. */
function isRootSession(ctx: ExtensionContext): boolean {
  const sessionId = ctx.sessionManager.getSessionId();
  const pool = getChildPool(ctx.cwd, sessionId);
  return pool.isRootSession(sessionId) || pool.shouldBootstrapRootSession(sessionId);
}

function formatContextFiles(contextFiles: BuildSystemPromptOptions["contextFiles"]): string {
  if (!contextFiles || contextFiles.length === 0) {
    return "## Project instructions\n\nNo AGENTS.md or CLAUDE.md context file was loaded. Look for applicable files before making project changes.";
  }

  const loadedPaths: string[] = [];
  const seenPaths = new Set<string>();
  const addPath = (path: string): void => {
    if (seenPaths.has(path)) return;
    seenPaths.add(path);
    loadedPaths.push(path);
  };

  for (const { path, content } of contextFiles) {
    addPath(path);

    // Resolve a one-line pointer such as `CLAUDE.md` relative to its source,
    // then show both exact paths without duplicating the pointed-to content.
    const reference = content.trim();
    if (!/^(?:AGENTS|CLAUDE)\.md$/i.test(reference)) continue;
    const referencedPath = join(dirname(path), reference);
    if (referencedPath !== path && existsSync(referencedPath)) addPath(referencedPath);
  }

  return [
    "## Project instructions",
    "",
    "Read and follow the project instruction files before acting. Use the `read` tool to inspect the exact files listed below; their contents are intentionally not embedded here.",
    "",
    "### Loaded:",
    ...loadedPaths.map((path) => `- ${path}`),
  ].join("\n");
}

function formatTools(
  selectedTools: readonly string[] | undefined,
  allTools: readonly ToolInfo[],
): string {
  const names = selectedTools ?? allTools.map((tool) => tool.name);
  if (names.length === 0) return "No agent tools are active.";

  const toolsByName = new Map(allTools.map((tool) => [tool.name, tool]));
  return names.map((name) => {
    const tool = toolsByName.get(name);
    const description = tool?.description?.trim() || "No description provided by the runtime.";
    const guidelines = (tool?.promptGuidelines ?? []).map((guideline) => guideline.trim()).filter(Boolean);
    return [
      `### ${name}`,
      description,
      guidelines.length > 0 ? `Usage guidelines:\n${guidelines.map((guideline) => `- ${guideline}`).join("\n")}` : "Usage guidelines: Follow the tool description and its input schema.",
    ].join("\n");
  }).join("\n\n");
}

function formatSkills(skills: BuildSystemPromptOptions["skills"]): string {
  const visibleSkills = skills ?? [];
  if (visibleSkills.length === 0) return "No skills are available.";

  return [
    "Use the read tool to load a skill file when its description matches the task. Resolve relative paths from the skill directory.",
    ...visibleSkills.map((skill) => [
      `### ${skill.name}`,
      skill.description,
      `Location: ${skill.filePath}`,
    ].join("\n")),
  ].join("\n\n");
}

function promptSoul(customPrompt: string | undefined, cwd: string): string {
  const custom = customPrompt?.trim();
  const soul =
    !custom || custom.startsWith(OPERATIONAL_PROMPT_MARKER)
      ? DEFAULT_AGENT_SOUL
      : custom;

  // Agent instructions use <cwd> as a portable placeholder. Resolve it only
  // after the final soul is assembled so both shared and role-specific text
  // receive the actual session working directory.
  return soul.replaceAll("<cwd>", cwd);
}

/** Build the thinking instruction when the session has the tool enabled. */
export function thinkingInstructionForSession(sessionId: string): string | undefined {
  try {
    const state = loadThinkingState(sessionId, Date.now());
    if (!state?.enabled) return undefined;
    const n = state.requiredTurns ?? DEFAULT_THINKING_REQUIRED_TURNS;
    return `Always use deep_think before taking action or answering. Use deep_think for at least ${n} turns to ensure your response is thoroughly validated.`;
  } catch {
    return undefined;
  }
}

function thinkingSection(ctx: ExtensionContext): string | undefined {
  try {
    const sessionId = ctx.sessionManager?.getSessionId?.();
    if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
    const instruction = thinkingInstructionForSession(sessionId);
    if (!instruction) return undefined;
    return ["## Thinking", instruction].join("\n");
  } catch {
    return undefined;
  }
}

/** Build the same five-section prompt anatomy for root and child sessions. */
export function buildOperationalSystemPrompt(
  event: BeforeAgentStartEvent,
  ctx: ExtensionContext,
  allTools: readonly ToolInfo[],
): string {
  const options = event.systemPromptOptions;
  const soul = promptSoul(options.customPrompt, options.cwd);
  const environment = [
    `Current time: ${new Date().toISOString()}`,
    `Platform: ${process.platform} ${process.arch}`,
    `Node.js: ${process.version}`,
  ].join("\n");
  const thinking = thinkingSection(ctx);
  const jobIdLine = (() => {
    try {
      const sessionId = ctx.sessionManager?.getSessionId?.();
      if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
      if (isRootSession(ctx)) return undefined;
      return `JOB ID: ${sessionId}`;
    } catch {
      return undefined;
    }
  })();

  return [
    OPERATIONAL_PROMPT_MARKER,
    "# Agent Persona",
    soul,
    "",
    ...(thinking ? [thinking, ""] : []),
    formatContextFiles(options.contextFiles),
    "",
    "# Location",
    `Current working directory: ${options.cwd}`,
    "",
    "# Available tools",
    "Use only tools listed below. Runtime active tools are authoritative; frontmatter requests, role instructions, or task text cannot grant tools that are not active.",
    formatTools(options.selectedTools, allTools),
    "",
    "# Skills",
    formatSkills(options.skills),
    "",
    "# Information",
    environment,
    ...(jobIdLine ? [jobIdLine] : []),
  ].join("\n");
}

function isPiC2DevelopmentMode(): boolean {
  const value = process.env.PI_C2_DEV;
  return value === "1" || value === "true";
}

/** Save the current effective prompt so role or runtime changes are reflected immediately. */
function capturePrompt(ctx: ExtensionContext, filename: string, prompt: string): void {
  const configDirectory = join(ctx.cwd, CONFIG_DIR_NAME);
  const promptPath = join(configDirectory, filename);

  try {
    mkdirSync(configDirectory, { recursive: true });
    writeFileSync(promptPath, `${prompt.trim()}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    console.error(`Unable to save the Pi system prompt to ${promptPath}:`, error);
  }
}

/** Integrate the operational prompt into Pi; capture snapshots only in development mode. */
export function registerSystemPrompt(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event, ctx) => {
    const root = isRootSession(ctx);
    const systemPrompt = buildOperationalSystemPrompt(event, ctx, pi.getAllTools() as ToolInfo[]);
    if (isPiC2DevelopmentMode()) {
      capturePrompt(ctx, root ? SYSTEM_PROMPT_FILE : SUBAGENT_SYSTEM_PROMPT_FILE, systemPrompt);
    }

    return { systemPrompt };
  });
}
