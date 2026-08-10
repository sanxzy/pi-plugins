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
  /** Markdown body applied as the child system prompt. */
  readonly systemPrompt: string;
  readonly source: "user" | "project";
  readonly filePath: string;
}

/** A resolved agent loaded from disk. */
export type ResolvedAgent = DiscoveredAgent;