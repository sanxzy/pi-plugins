import type { InlineExtension, ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";

/**
 * Process-wide registry of inline extension factories that child sessions must
 * load.
 *
 * A child creates its own `DefaultResourceLoader` (`createAgentSession`) so it
 * never inherits the parent host's inline extension factories. The pi-c2
 * extension is launched as an inline factory by the host (for example
 * `pi -e plugins/packages/pi-c2/index.ts`), so without this
 * registry a child loader sees an empty extension set and its allowlisted
 * extension tools (agent-family, web) are never constructible.
 *
 * The registry lives on `globalThis` under a symbol so it survives extension
 * factory reloads without a module import cycle between @xzy-ai/runtime and the
 * pi-c2 composition root.
 *
 * Reload safety: named extensions are keyed by their display name so a
 * re-registration replaces the previous entry instead of accumulating
 * duplicates. Anonymous factories are keyed by a stable per-object id so
 * re-registering the same reference (for example a factory re-executed within
 * the same module graph) is idempotent while distinct anonymous factories stay
 * independent. A factory closure from a fresh module evaluation registers
 * under its own new id, so the registry only ever accumulates across distinct
 * module graphs.
 */

const CHILD_EXTENSION_FACTORIES_KEY = Symbol.for("@xzy-ai/pi-c2:child-extension-factories");
const ANON_ID_KEY = Symbol.for("@xzy-ai/pi-c2:anon-factory-id");

type FactoryRegistry = Map<string, InlineExtension>;

function anonId(factory: ExtensionFactory): string {
  const f = factory as ExtensionFactory & { [ANON_ID_KEY]?: string };
  f[ANON_ID_KEY] ??= `func-${Math.random().toString(36).slice(2, 10)}`;
  return f[ANON_ID_KEY]!;
}

function registries(): FactoryRegistry {
  const root = globalThis as unknown as Record<symbol, FactoryRegistry | undefined>;
  root[CHILD_EXTENSION_FACTORIES_KEY] ??= new Map<string, InlineExtension>();
  return root[CHILD_EXTENSION_FACTORIES_KEY]!;
}

function keyOf(input: InlineExtension): string {
  if (typeof input !== "function" && input.name) return input.name;
  const factory = (typeof input === "function" ? input : input.factory) as ExtensionFactory;
  return anonId(factory);
}

/** Register an inline extension factory so isolated child loaders inherit it. */
export function registerChildExtensionFactory(input: InlineExtension): void {
  registries().set(keyOf(input), input);
}

/** The current set of extension factories a child loader should inherit. */
export function getChildExtensionFactories(): InlineExtension[] {
  return [...registries().values()];
}

/**
 * Process-wide registry of Ponytail `write`/`edit` tool definitions that child
 * sessions must inject through their isolated custom-tools list.
 *
 * Children create their own `AgentSession` and never emit `session_start`, so
 * they cannot register tools through the extension lifecycle. The composition
 * root publishes the same Ponytail wrapper definitions here that it registers
 * for root sessions; the child adapter appends them to `customTools` only when
 * the child's effective Ponytail state is enabled. A re-registration replaces
 * the previous entry (single slot), mirroring the factory registry's reload
 * safety.
 */

export interface ChildPonytailTools {
  readonly write: ToolDefinition<any, any, any>;
  readonly edit: ToolDefinition<any, any, any>;
}

const CHILD_PONYTAIL_TOOLS_KEY = Symbol.for("@xzy-ai/pi-c2:child-ponytail-tools");

function ponytailToolsSlot(): { current?: ChildPonytailTools } {
  const root = globalThis as unknown as Record<symbol, { current?: ChildPonytailTools } | undefined>;
  root[CHILD_PONYTAIL_TOOLS_KEY] ??= {};
  return root[CHILD_PONYTAIL_TOOLS_KEY]!;
}

/** Publish the Ponytail write/edit definitions isolated child loaders should inject. */
export function registerChildPonytailTools(tools: ChildPonytailTools): void {
  ponytailToolsSlot().current = tools;
}

/** The current Ponytail write/edit definitions for child custom-tools injection. */
export function getChildPonytailTools(): ChildPonytailTools | undefined {
  return ponytailToolsSlot().current;
}
