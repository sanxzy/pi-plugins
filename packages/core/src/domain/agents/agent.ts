import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/**
 * Agent-definition types.
 *
 * An agent is a named, described unit of delegation that a child session can
 * run. The name is opaque here — it is resolved by an infrastructure seam, never
 * by the registry or the domain model.
 */

/**
 * Metadata and prompt body loaded from an agent Markdown file.
 *
 * The filesystem source fields stay on the infrastructure-facing definition;
 * the domain still treats the prompt as data and does not know how it was read.
 */
export interface DiscoveredAgent {
  readonly name: string;
  readonly description: string;
  /** Present only when frontmatter explicitly supplies a non-empty list. */
  readonly tools?: string[];
  /** Present only when frontmatter explicitly supplies a model. */
  readonly model?: string;
  /** Present only when frontmatter explicitly supplies a thinking level. */
  readonly thinking?: ThinkingLevel;
  /** Markdown body applied as the child system prompt. */
  readonly systemPrompt: string;
  readonly source: "user" | "project";
  readonly filePath: string;
}

/** A resolved agent loaded from disk. */
export type ResolvedAgent = DiscoveredAgent;

/** All thinking levels, in ascending order, as accepted by the SDK. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Structural view of a model's thinking capability (subset of `Model`). */
export interface ThinkingCapableModel {
  readonly reasoning: boolean;
  readonly thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}

/**
 * The thinking levels a model supports, mirroring `getSupportedThinkingLevels`
 * from `@earendil-works/pi-ai`: non-reasoning models only support `off`;
 * reasoning models support the extended set filtered by their level map.
 */
export function supportedThinkingLevels(model: ThinkingCapableModel): readonly ThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}