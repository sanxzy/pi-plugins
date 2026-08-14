import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TOOL_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { homeRoot } from "@xzy-ai/runtime";

export interface WikiEntry {
  title: string;
  source: "web_search" | "web_fetch";
  queryOrUrl: string;
  format: string;
  timestamp?: string;
  text: string;
  page: string;
}

export const WIKI_ENTRY_START = "<!-- pi-c2-wiki-entry -->";
export const WIKI_ENTRY_END = "<!-- pi-c2-wiki-entry-end -->";
export const WIKI_PAGE_START = "<!-- pi-c2-wiki-page -->";
export const WIKI_PAGE_END = "<!-- pi-c2-wiki-page-end -->";
export const WIKI_MAX_SLUG_LENGTH = 80;
export const WIKI_PAGE_SIZE = 256 * 1024;
export const MAX_WIKI_DISCOVERY_PAGES = 500;
export const MAX_WIKI_DISCOVERY_OUTPUT_BYTES = 64 * 1024;

export interface WikiPageHeader {
  topic: string;
  page: number;
  totalPages: number;
  previous?: string;
  next?: string;
}

export interface WikiPageResult extends WikiPageHeader {
  file: string;
  content: string;
}

export interface WikiTopicDiscovery {
  topic: string;
  pages: Array<Omit<WikiPageHeader, "topic"> & { file: string }>;
  truncated?: boolean;
}

/** Discover wiki topics and page metadata without parsing or ranking entry content. */
export async function discoverWikiTopics(
  root: string,
  options: { topic?: string; maxTopics?: number } = {},
): Promise<WikiTopicDiscovery[]> {
  let names: string[];
  try {
    names = (await readdir(root)).filter((name) => name.endsWith(".md"));
  } catch {
    return [];
  }
  const topicFilter = options.topic === undefined ? undefined : slugify(options.topic);
  const topics = new Map<string, WikiTopicDiscovery>();
  for (const file of names.sort((left, right) => left.localeCompare(right))) {
    const topic = file.replace(/\.part-\d{3}\.md$/, "").replace(/\.md$/, "");
    if (topicFilter !== undefined && topic !== topicFilter) continue;
    let document: string;
    try {
      document = await readFile(join(root, file), "utf8");
    } catch {
      continue;
    }
    if (!document.includes(WIKI_PAGE_START) || !document.includes(WIKI_PAGE_END)) continue;
    const header = parsePageHeader(document);
    let discovery = topics.get(topic);
    if (!discovery) {
      discovery = { topic, pages: [] };
      topics.set(topic, discovery);
    }
    discovery.pages.push({
      file,
      page: header.page,
      totalPages: header.totalPages,
      ...(header.previous ? { previous: header.previous } : {}),
      ...(header.next ? { next: header.next } : {}),
    });
  }
  const maxTopics = Math.min(Math.max(options.maxTopics ?? Number.MAX_SAFE_INTEGER, 0), 50);
  return [...topics.values()]
    .sort((left, right) => left.topic.localeCompare(right.topic))
    .slice(0, maxTopics)
    .map((topic) => {
      const pages = topic.pages.sort((left, right) => pageNumber(left.file) - pageNumber(right.file) || left.file.localeCompare(right.file));
      if (pages.length <= MAX_WIKI_DISCOVERY_PAGES) return { ...topic, pages };
      return {
        ...topic,
        pages: pages.slice(0, MAX_WIKI_DISCOVERY_PAGES),
        truncated: true,
      };
    });
}

export interface WikiEntryInput {
  topic: string;
  source: "web_search" | "web_fetch";
  queryOrUrl: string;
  format: string;
  title: string;
  text: string;
  timestamp?: string;
  pageSize?: number;
}

export interface WikiSaveResult {
  saved: boolean;
  topic: string;
  pages: string[];
  error?: string;
}

export const WIKI_SAVE_ERROR = "Unable to save wiki entry";

/** Production wiki root: the pi-c2 runtime home `wikis` directory. */
export function wikiRoot(): string {
  return join(homeRoot(), "wikis");
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
    const secretKey = /(?:token|code|secret|password|credential|api[-_]?key|api[-_]?secret|authorization|client[-_]?secret|client[-_]?id|private[-_]?key)/i;
    for (const [key, item] of query) parts.push(key, secretKey.test(key) ? "redacted" : item);
    if (url.username || url.password) parts.splice(1, 0, "redacted");
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

const writeQueues = new Map<string, Promise<unknown>>();

/** Best-effort append to a topic's growing paginated corpus. Never throws. */
export async function saveWikiEntry(input: WikiEntryInput & { root?: string }): Promise<WikiSaveResult> {
  const topic = slugify(input.topic);
  const root = input.root ?? wikiRoot();
  const key = `${root}\u0000${topic}`;
  const prior = writeQueues.get(key) ?? Promise.resolve();
  const operation = prior.catch(() => undefined).then(() => writePaginatedWikiEntry(input, root, topic));
  const settled = operation.finally(() => {
    if (writeQueues.get(key) === settled) writeQueues.delete(key);
  });
  writeQueues.set(key, settled);
  try {
    return await settled;
  } catch {
    return { saved: false, topic, pages: [], error: WIKI_SAVE_ERROR };
  }
}

async function writePaginatedWikiEntry(input: WikiEntryInput, root: string, topic: string): Promise<WikiSaveResult> {
  return processWithLog({ operation: TOOL_OPERATIONS.WIKI_EXECUTE, parameters: { topic, root } }, async () => {
  const pageSize = Math.max(input.pageSize ?? WIKI_PAGE_SIZE, 256);
  await mkdir(root, { recursive: true });
  const existingPages = await listTopicPages(root, topic);
  const bodies: string[] = [];
  for (const file of existingPages) {
    const document = await readFile(join(root, file), "utf8");
    bodies.push(extractPageBody(document));
  }
  if (bodies.length === 0) bodies.push("");

  const chunks = splitEntryForPages(input, pageSize);
  for (const chunk of chunks) {
    const last = bodies.length - 1;
    if (bodies[last] && bodies[last].length + chunk.length > pageSize) bodies.push(chunk);
    else bodies[last] = `${bodies[last]}${chunk}`;
  }

  const pages = bodies.map((_body, index) => pageFilename(topic, index + 1));
  for (let index = 0; index < bodies.length; index++) {
    const previous = index > 0 ? pages[index - 1] : undefined;
    const next = index + 1 < pages.length ? pages[index + 1] : undefined;
    const document = formatPage(pages[index]!, topic, index + 1, pages.length, bodies[index]!, previous, next);
    await atomicWrite(join(root, pages[index]!), document);
  }
  return { saved: true, topic, pages };
  });
}

async function listTopicPages(root: string, topic: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  return names
    .filter((name) => name === `${topic}.md` || new RegExp(`^${escapeRegExp(topic)}\\.part-\\d{3}\\.md$`).test(name))
    .sort((left, right) => pageNumber(left) - pageNumber(right));
}

function pageNumber(file: string): number {
  const part = /\.part-(\d{3})\.md$/.exec(file);
  return part ? Number(part[1]) : 1;
}

function pageFilename(topic: string, page: number): string {
  return page === 1 ? `${topic}.md` : `${topic}.part-${String(page).padStart(3, "0")}.md`;
}

export async function retrieveWikiPage(root: string, topicInput: string, selector: string): Promise<WikiPageResult | undefined> {
  const topic = slugify(topicInput);
  const pages = await listTopicPages(root, topic);
  if (pages.length === 0) return undefined;
  const numeric = /^\d+$/.test(selector) ? Number(selector) : undefined;
  const file = numeric === undefined ? pages.find((candidate) => candidate === selector) : pages[numeric - 1];
  if (!file) return undefined;
  try {
    const content = await readFile(join(root, file), "utf8");
    const header = parsePageHeader(content);
    return { ...header, file, content, topic: header.topic || topic, totalPages: header.totalPages || pages.length };
  } catch {
    return undefined;
  }
}

export function parsePageHeader(document: string): WikiPageHeader {
  const end = document.indexOf(WIKI_PAGE_END);
  const header = end >= 0 ? document.slice(0, end) : "";
  const fields: Record<string, string> = {};
  for (const line of header.split("\n")) {
    const separator = line.indexOf(":");
    if (separator > 0) fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return {
    topic: fields.topic ?? "",
    page: Number(fields.page ?? 1),
    totalPages: Number(fields.totalPages ?? 1),
    ...(fields.previous ? { previous: fields.previous } : {}),
    ...(fields.next ? { next: fields.next } : {}),
  };
}

function extractPageBody(document: string): string {
  const end = document.indexOf(WIKI_PAGE_END);
  return end >= 0 ? document.slice(end + WIKI_PAGE_END.length).replace(/^\n+/, "") : document;
}

function formatPage(
  file: string,
  topic: string,
  page: number,
  totalPages: number,
  body: string,
  previous?: string,
  next?: string,
): string {
  const lines = [WIKI_PAGE_START, `topic: ${topic}`, `page: ${page}`, `totalPages: ${totalPages}`];
  if (previous) lines.push(`previous: ${previous}`);
  if (next) lines.push(`next: ${next}`);
  lines.push("");
  if (previous) lines.push(`[Previous](./${previous})`);
  if (next) lines.push(`[Next](./${next})`);
  lines.push(WIKI_PAGE_END, "", body);
  void file;
  return lines.join("\n");
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    await writeFile(temporary, content, "utf8");
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function splitEntryForPages(input: WikiEntryInput, pageSize: number): string[] {
  const whole = formatWikiEntry(input);
  if (whole.length <= pageSize) return [whole];
  const overhead = formatWikiEntry({ ...input, text: "" }).length;
  const textBudget = Math.max(pageSize - overhead - 16, 1);
  const chunks: string[] = [];
  let remaining = input.text;
  while (remaining.length > textBudget) {
    let cut = remaining.lastIndexOf("\n\n", textBudget);
    if (cut < Math.floor(textBudget / 2)) cut = remaining.lastIndexOf("\n", textBudget);
    if (cut < Math.floor(textBudget / 2)) cut = remaining.lastIndexOf(" ", textBudget);
    if (cut <= 0) cut = textBudget;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }
  chunks.push(remaining);
  return chunks.map((text, index) =>
    formatWikiEntry({ ...input, title: index === 0 ? input.title : `${input.title} (continued ${index + 1})`, text }),
  );
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
    .replaceAll(WIKI_ENTRY_START, "&lt;!-- pi-c2-wiki-entry --&gt;")
    .replaceAll(WIKI_ENTRY_END, "&lt;!-- pi-c2-wiki-entry-end --&gt;");
}

function unescapeMarkers(value: string): string {
  return value
    .replaceAll("&lt;!-- pi-c2-wiki-entry --&gt;", WIKI_ENTRY_START)
    .replaceAll("&lt;!-- pi-c2-wiki-entry-end --&gt;", WIKI_ENTRY_END);
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