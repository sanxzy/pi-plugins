import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const WIKI_ENTRY_START = "<!-- pi-code-wiki-entry -->";
export const WIKI_ENTRY_END = "<!-- pi-code-wiki-entry-end -->";
export const WIKI_MAX_SLUG_LENGTH = 80;

export interface WikiEntryInput {
  topic: string;
  source: "web_search" | "web_fetch";
  queryOrUrl: string;
  format: string;
  title: string;
  text: string;
  timestamp?: string;
}

export interface WikiSaveResult {
  saved: boolean;
  topic: string;
  pages: string[];
  error?: string;
}

export const WIKI_SAVE_ERROR = "Unable to save wiki entry";

/** Production wiki root: parent of the PI agent directory plus `wikis`. */
export function wikiRoot(): string {
  return join(dirname(getAgentDir()), "wikis");
}

/** Normalize a value into a filesystem-safe slug (lowercase, dash-separated). */
export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, WIKI_MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
  return slug || "untitled";
}

export function slugifyQuery(query: string): string {
  return slugify(query);
}

/** Derive a stable topic slug from a URL (host, non-default port, path, sorted query). */
export function slugifyUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    const parts = [url.hostname];
    const isDefaultPort =
      (url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80");
    if (url.port && !isDefaultPort) parts.push(url.port);
    const path = url.pathname.replace(/^\/+|\/+$/g, "");
    if (path) parts.push(path);
    const query = [...url.searchParams.entries()].sort(
      ([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue),
    );
    for (const [key, item] of query) parts.push(key, item);
    return slugify(parts.join("-"));
  } catch {
    return slugify(value);
  }
}

/** Build the Markdown entry block delimited by wiki entry markers. */
export function formatWikiEntry(input: WikiEntryInput): string {
  const timestamp = input.timestamp ?? new Date().toISOString();
  const heading = metadataValue(input.title) || "Untitled research";
  const key = input.source === "web_search" ? "query" : "url";
  return [
    WIKI_ENTRY_START,
    `## ${heading}`,
    `timestamp: ${metadataValue(timestamp)}`,
    `source: ${input.source}`,
    `${key}: ${metadataValue(input.queryOrUrl)}`,
    `format: ${metadataValue(input.format)}`,
    `title: ${heading}`,
    "",
    input.text,
    WIKI_ENTRY_END,
    "",
  ].join("\n");
}

/** Best-effort append of one entry to the topic's base page. Never throws. */
export async function saveWikiEntry(input: WikiEntryInput & { root?: string }): Promise<WikiSaveResult> {
  const topic = slugify(input.topic);
  const filename = `${topic}.md`;
  const root = input.root ?? wikiRoot();
  try {
    await mkdir(root, { recursive: true });
    await appendFile(join(root, filename), formatWikiEntry(input), "utf8");
    return { saved: true, topic, pages: [filename] };
  } catch {
    return { saved: false, topic, pages: [], error: WIKI_SAVE_ERROR };
  }
}

function metadataValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}