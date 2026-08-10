import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface WikiEntry {
  title: string;
  source: "web_search" | "web_fetch";
  queryOrUrl: string;
  format: string;
  timestamp?: string;
  text: string;
  page: string;
}

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
    escapeMarkers(input.text),
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

/** Parse marker-delimited entries and recover their stable metadata. */
export function parseWikiEntries(document: string, page = ""): WikiEntry[] {
  const entries: WikiEntry[] = [];
  const pattern = new RegExp(`${escapeRegExp(WIKI_ENTRY_START)}\\n([\\s\\S]*?)${escapeRegExp(WIKI_ENTRY_END)}`, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(document)) !== null) {
    const lines = (match[1] ?? "").split("\n");
    const title = lines[0]?.replace(/^##\s*/, "").trim() ?? "";
    const metadata: Record<string, string> = {};
    let index = 1;
    while (index < lines.length && lines[index]?.trim() !== "") {
      const line = lines[index] ?? "";
      const separator = line.indexOf(":");
      if (separator > 0) metadata[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
      index++;
    }
    entries.push({
      title,
      source: metadata.source === "web_fetch" ? "web_fetch" : "web_search",
      queryOrUrl: metadata.query ?? metadata.url ?? "",
      format: metadata.format ?? "",
      timestamp: metadata.timestamp,
      text: unescapeMarkers(lines.slice(index).join("\n").trim()),
      page,
    });
  }
  return entries;
}

function escapeMarkers(value: string): string {
  return value
    .replaceAll(WIKI_ENTRY_START, "&lt;!-- pi-code-wiki-entry --&gt;")
    .replaceAll(WIKI_ENTRY_END, "&lt;!-- pi-code-wiki-entry-end --&gt;");
}

function unescapeMarkers(value: string): string {
  return value
    .replaceAll("&lt;!-- pi-code-wiki-entry --&gt;", WIKI_ENTRY_START)
    .replaceAll("&lt;!-- pi-code-wiki-entry-end --&gt;", WIKI_ENTRY_END);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Tokenize a value into normalized query terms. */
function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/** Score how strongly an entry matches a query token. */
function matchWeight(token: string, entry: WikiEntry): number {
  const heading = tokenize(entry.title);
  const metadata = tokenize(`${entry.title} ${entry.queryOrUrl} ${entry.format} ${entry.source}`);
  const body = tokenize(entry.text);
  if (heading.includes(token)) return 3;
  if (metadata.includes(token)) return 2;
  if (body.includes(token)) return 1;
  return 0;
}

/** Wrap a snippet around the first token occurrence. */
function makeExcerpt(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}\u2026`;
}

/**
 * Search the wiki corpus for the best matching entries.
 *
 * Reads every `.md` page under the root, parses entries, ranks them with the
 * fixed heading/metadata/body weights, and returns the top results capped by
 * `max`. Topic filters match the slugified base topic (including continuation
 * pages). Returns an empty array for absent or empty storage.
 */
export async function searchWikis(
  root: string,
  query: string,
  options: { topic?: string; max?: number } = {},
): Promise<
  Array<{
    file: string;
    topic: string;
    page: number;
    totalPages: number;
    timestamp?: string;
    source: string;
    score: number;
    excerpt: string;
  }>
> {
  let files: string[];
  try {
    files = (await readdir(root)).filter((name) => name.endsWith(".md"));
  } catch {
    return [];
  }
  const topicFilter = options.topic === undefined ? undefined : slugify(options.topic);
  const entries: Array<{ entry: WikiEntry; file: string }> = [];
  await Promise.all(
    files.map(async (file) => {
      const topic = file.replace(/\.part-\d{3}\.md$/, "").replace(/\.md$/, "");
      if (topicFilter !== undefined && topic !== topicFilter) return;
      let document: string;
      try {
        document = await readFile(join(root, file), "utf8");
      } catch {
        return;
      }
      const parsed = parseWikiEntries(document, file);
      for (const entry of parsed) entries.push({ entry, file });
    }),
  );

  const pageCounts = new Map<string, number>();
  for (const file of files) {
    const topic = file.replace(/\.part-\d{3}\.md$/, "").replace(/\.md$/, "");
    pageCounts.set(topic, (pageCounts.get(topic) ?? 0) + 1);
  }
  const tokens = tokenize(query);
  const matches = entries
    .map(({ entry, file }) => {
      const score = tokens.reduce((total, token) => total + matchWeight(token, entry), 0);
      const topic = file.replace(/\.part-\d{3}\.md$/, "").replace(/\.md$/, "");
      const part = /\.part-(\d{3})\.md$/.exec(file);
      const page = part ? Number(part[1]) : 1;
      return { entry, file, topic, page, totalPages: pageCounts.get(topic) ?? 1, score };
    })
    .filter((match) => match.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const leftTime = left.entry.timestamp ?? "";
      const rightTime = right.entry.timestamp ?? "";
      if (rightTime !== leftTime) return rightTime < leftTime ? -1 : 1;
      return left.file.localeCompare(right.file);
    });

  const max = options.max ?? 20;
  const cap = Math.min(Math.max(max, 1), 50);
  const results: Array<{
    file: string;
    topic: string;
    page: number;
    totalPages: number;
    timestamp?: string;
    source: string;
    score: number;
    excerpt: string;
  }> = [];
  let serializedLength = 0;
  for (const { entry, file, topic, page, totalPages, score } of matches.slice(0, cap)) {
    const result = {
      file,
      topic,
      page,
      totalPages,
      timestamp: entry.timestamp,
      source: entry.source,
      score,
      excerpt: makeExcerpt(entry.text, 2048),
    };
    const nextLength = JSON.stringify(result).length;
    if (results.length > 0 && serializedLength + nextLength > 64 * 1024) break;
    results.push(result);
    serializedLength += nextLength;
  }
  return results;
}