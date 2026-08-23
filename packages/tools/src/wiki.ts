import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { TOOL_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { homeRoot, homeSessionDirFromRoot, ensurePrivateDirectory, readPrivateJson, writePrivateJson } from "@xzy-ai/runtime";

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
export const WIKI_HISTORY_FILE = "wiki-history.json";
export const MAX_WIKI_HISTORY_RECORDS = 50;
export type WikiHistoryRecord = [topic: string, file: string, openCount: number, lastOpenedMs: number];
export interface WikiHistoryEnvelope {
  v: 1;
  r: WikiHistoryRecord[];
}

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

export interface WikiHistoryOptions {
  projectRoot?: string;
  sessionId?: string;
  rootSessionId?: string;
  nowMs?: () => number;
}

function historyPath(options: WikiHistoryOptions): string | undefined {
  if (!options.projectRoot || !options.sessionId && !options.rootSessionId) return undefined;
  const rootSessionId = options.rootSessionId ?? options.sessionId;
  if (!rootSessionId) return undefined;
  try {
    return join(homeSessionDirFromRoot(options.projectRoot, rootSessionId), WIKI_HISTORY_FILE);
  } catch {
    return undefined;
  }
}

function validHistoryRecord(value: unknown): value is WikiHistoryRecord {
  return Array.isArray(value) && value.length === 4 &&
    typeof value[0] === "string" && value[0].length > 0 &&
    typeof value[1] === "string" && value[1].length > 0 &&
    Number.isSafeInteger(value[2]) && value[2] >= 1 &&
    Number.isSafeInteger(value[3]) && value[3] >= 0;
}

export function normalizeWikiHistory(raw: unknown): WikiHistoryEnvelope {
  if (!raw || typeof raw !== "object" || (raw as { v?: unknown }).v !== 1 || !Array.isArray((raw as { r?: unknown }).r)) {
    return { v: 1, r: [] };
  }
  const merged = new Map<string, WikiHistoryRecord>();
  for (const candidate of (raw as { r: unknown[] }).r) {
    if (!validHistoryRecord(candidate)) continue;
    const key = `${candidate[0]}\u0000${candidate[1]}`;
    const prior = merged.get(key);
    if (!prior) {
      merged.set(key, [...candidate]);
      continue;
    }
    prior[2] += candidate[2];
    prior[3] = Math.max(prior[3], candidate[3]);
  }
  const records = [...merged.values()]
    .sort((left, right) => right[3] - left[3] || right[1].localeCompare(left[1]))
    .slice(0, MAX_WIKI_HISTORY_RECORDS);
  return { v: 1, r: records };
}

function readWikiHistory(options: WikiHistoryOptions): WikiHistoryEnvelope {
  const path = historyPath(options);
  if (!path) return { v: 1, r: [] };
  try {
    return normalizeWikiHistory(readPrivateJson<unknown>(path));
  } catch {
    return { v: 1, r: [] };
  }
}

function writeWikiHistory(options: WikiHistoryOptions, history: WikiHistoryEnvelope): void {
  const path = historyPath(options);
  if (!path) return;
  try {
    ensurePrivateDirectory(dirname(path));
    writePrivateJson(path, history);
  } catch {
    // History is a best-effort side effect of a successful wiki operation.
  }
}

export function recordWikiPageOpen(options: WikiHistoryOptions, topic: string, file: string): void {
  if (!historyPath(options)) return;
  const history = readWikiHistory(options);
  const nowMs = options.nowMs?.() ?? Date.now();
  const index = history.r.findIndex((record) => record[0] === topic && record[1] === file);
  if (index >= 0) {
    const record = history.r[index]!;
    record[2] += 1;
    record[3] = nowMs;
  } else {
    history.r.push([topic, file, 1, nowMs]);
  }
  writeWikiHistory(options, normalizeWikiHistory(history));
}

export interface WikiDiscoveryPage extends Omit<WikiPageHeader, "topic"> {
  file: string;
  title: string;
  openCount?: number;
  lastOpened?: number;
}

export interface WikiTopicDiscovery {
  topic: string;
  pages: WikiDiscoveryPage[];
  truncated?: boolean;
}

interface CurrentWikiPage {
  topic: string;
  file: string;
  page: number;
  totalPages: number;
  previous?: string;
  next?: string;
  title: string;
}

interface DiscoveryHistoryState {
  usable: boolean;
  history: WikiHistoryEnvelope;
  needsRewrite: boolean;
}

async function currentWikiPages(root: string, topicFilter?: string): Promise<CurrentWikiPage[] | undefined> {
  let names: string[];
  try {
    names = (await readdir(root)).filter((name) => name.endsWith(".md"));
  } catch {
    return undefined;
  }
  const pages: CurrentWikiPage[] = [];
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
    const firstEntry = parseWikiEntries(document, file)[0];
    pages.push({
      topic,
      file,
      page: header.page,
      totalPages: header.totalPages,
      ...(header.previous ? { previous: header.previous } : {}),
      ...(header.next ? { next: header.next } : {}),
      title: firstEntry?.title || humanizeTopic(topic),
    });
  }
  return pages;
}

async function readDiscoveryHistory(options: WikiHistoryOptions): Promise<DiscoveryHistoryState> {
  const path = historyPath(options);
  if (!path) return { usable: false, history: { v: 1, r: [] }, needsRewrite: false };
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return { usable: false, history: { v: 1, r: [] }, needsRewrite: false };
  }
  if (!raw || typeof raw !== "object" || (raw as { v?: unknown }).v !== 1 || !Array.isArray((raw as { r?: unknown }).r)) {
    return { usable: false, history: { v: 1, r: [] }, needsRewrite: false };
  }
  const rawRecords = (raw as { r: unknown[] }).r;
  const valid = rawRecords.filter(validHistoryRecord);
  if (valid.length === 0) return { usable: false, history: { v: 1, r: [] }, needsRewrite: rawRecords.length > 0 };
  const history = normalizeWikiHistory(raw);
  return { usable: true, history, needsRewrite: JSON.stringify({ v: 1, r: valid }) !== JSON.stringify(history) };
}

/** Discover current wiki pages, optionally projecting root-session open history. */
export async function discoverWikiTopics(
  root: string,
  options: { topic?: string; maxResults?: number; history?: WikiHistoryOptions } = {},
): Promise<WikiTopicDiscovery[]> {
  const topicFilter = options.topic === undefined ? undefined : slugify(options.topic);
  const current = await currentWikiPages(root, topicFilter);
  if (!current) return [];

  const historyState = options.history ? await readDiscoveryHistory(options.history) : { usable: false, history: { v: 1, r: [] }, needsRewrite: false };
  const currentByKey = new Map(current.map((page) => [`${page.topic}\u0000${page.file}`, page]));
  const hasMarkerValidHistory = historyState.usable && historyState.history.r.some((record) => currentByKey.has(`${record[0]}\u0000${record[1]}`));
  let selected: Array<CurrentWikiPage & { openCount?: number; lastOpened?: number }>;
  if (historyState.usable) {
    const retained = historyState.history.r
      .filter((record) => currentByKey.has(`${record[0]}\u0000${record[1]}`));
    if (retained.length > 0) {
      selected = retained.map((record) => ({
        ...currentByKey.get(`${record[0]}\u0000${record[1]}`)!,
        openCount: record[2],
        lastOpened: record[3],
      }));
    } else {
      selected = current;
    }
    const normalized = { v: 1 as const, r: retained };
    if (options.history && (historyState.needsRewrite || JSON.stringify(normalized) !== JSON.stringify(historyState.history))) writeWikiHistory(options.history, normalized);
  } else {
    selected = current;
    if (options.history && historyState.needsRewrite) writeWikiHistory(options.history, { v: 1, r: [] });
  }

  if (hasMarkerValidHistory && selected.some((page) => page.openCount !== undefined)) {
    selected.sort((left, right) => (right.openCount ?? 0) - (left.openCount ?? 0) || (right.lastOpened ?? 0) - (left.lastOpened ?? 0) || left.file.localeCompare(right.file));
  } else {
    selected.sort((left, right) => left.topic.localeCompare(right.topic) || pageNumber(left.file) - pageNumber(right.file) || left.file.localeCompare(right.file));
  }
  const maxResults = Math.min(Math.max(options.maxResults ?? 20, 1), 50);
  const topics = new Map<string, WikiTopicDiscovery>();
  for (const page of selected.slice(0, maxResults)) {
    let topic = topics.get(page.topic);
    if (!topic) {
      topic = { topic: page.topic, pages: [] };
      topics.set(page.topic, topic);
    }
    topic.pages.push({
      file: page.file,
      page: page.page,
      totalPages: page.totalPages,
      ...(page.previous ? { previous: page.previous } : {}),
      ...(page.next ? { next: page.next } : {}),
      title: page.title,
      ...(page.openCount === undefined ? {} : { openCount: page.openCount }),
      ...(page.lastOpened === undefined ? {} : { lastOpened: page.lastOpened }),
    });
  }
  return [...topics.values()].map((topic) => {
    if (!hasMarkerValidHistory) topic.pages.sort((left, right) => pageNumber(left.file) - pageNumber(right.file) || left.file.localeCompare(right.file));
    return topic;
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
  /** Optional maximum number of lines in each persisted page body. */
  pageLineSize?: number;
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
  const pageLineSize = input.pageLineSize === undefined
    ? undefined
    : Math.max(Math.floor(input.pageLineSize), 1);
  await mkdir(root, { recursive: true });
  const existingPages = await listTopicPages(root, topic);
  const bodies: string[] = [];
  for (const file of existingPages) {
    const document = await readFile(join(root, file), "utf8");
    bodies.push(extractPageBody(document));
  }
  if (bodies.length === 0) bodies.push("");

  const chunks = splitEntryForPages(input, pageSize, pageLineSize);
  for (const chunk of chunks) {
    const last = bodies.length - 1;
    const exceedsBytes = bodies[last]!.length + chunk.length > pageSize;
    const exceedsLines = pageLineSize !== undefined && countLines(bodies[last]!) + countLines(chunk) > pageLineSize;
    if (bodies[last] && (exceedsBytes || exceedsLines)) bodies.push(chunk);
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

export async function retrieveWikiPage(
  root: string,
  topicInput: string,
  selector: string,
  historyOptions?: WikiHistoryOptions,
): Promise<WikiPageResult | undefined> {
  const topic = slugify(topicInput);
  const pages = await listTopicPages(root, topic);
  if (pages.length === 0) return undefined;
  const numeric = /^\d+$/.test(selector) ? Number(selector) : undefined;
  const file = numeric === undefined ? pages.find((candidate) => candidate === selector) : pages[numeric - 1];
  if (!file) return undefined;
  try {
    const content = await readFile(join(root, file), "utf8");
    const header = parsePageHeader(content);
    const result = { ...header, file, content, topic: header.topic || topic, totalPages: header.totalPages || pages.length };
    if (historyOptions) recordWikiPageOpen(historyOptions, result.topic, file);
    return result;
  } catch {
    return undefined;
  }
}

/**
 * Derive the topic slug from a page file path, e.g. 'react.part-002.md' → 'react'.
 * Page files always embed their topic as the file-name prefix, so callers never
 * need to supply a topic separately.
 */
export function topicFromPageFile(file: string): string {
  return slugify(file.replace(/\.part-\d{3}\.md$/, "").replace(/\.md$/, ""));
}

/**
 * Open a saved wiki page directly by its file path (for example the page path
 * returned by a search, discovery, or previous-page navigation result). The
 * topic is derived from the file name.
 */
export async function retrieveWikiPageByFile(
  root: string,
  file: string,
  historyOptions?: WikiHistoryOptions,
): Promise<WikiPageResult | undefined> {
  return retrieveWikiPage(root, topicFromPageFile(file), file, historyOptions);
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

function splitEntryForPages(input: WikiEntryInput, pageSize: number, pageLineSize?: number): string[] {
  if (pageLineSize !== undefined) return splitEntryForLinePages(input, pageLineSize);
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

function splitEntryForLinePages(input: WikiEntryInput, pageLineSize: number): string[] {
  const whole = formatWikiEntry(input);
  if (countLines(whole) <= pageLineSize) return [whole];
  const emptyEntryLines = countLines(formatWikiEntry({ ...input, text: "" }));
  const textLineBudget = Math.max(pageLineSize - emptyEntryLines + 1, 1);
  const lines = input.text.split("\n");
  const chunks: string[] = [];
  for (let offset = 0; offset < lines.length; offset += textLineBudget) {
    chunks.push(lines.slice(offset, offset + textLineBudget).join("\n"));
  }
  return chunks.map((text, index) =>
    formatWikiEntry({ ...input, title: index === 0 ? input.title : `${input.title} (continued ${index + 1})`, text }),
  );
}

function countLines(value: string): number {
  return value.split("\n").length;
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

/** BM25 defaults for the local wiki corpus. */
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const TITLE_WEIGHT = 3;
const METADATA_WEIGHT = 2;
const BODY_WEIGHT = 1;
const ENGLISH_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "does", "for", "from", "how", "if", "in", "into", "is", "it",
  "no", "not", "of", "on", "or", "such", "that", "the", "their", "then", "there", "these", "they", "this", "to", "was", "will", "with",
]);

/** Tokenize text using the shared exact-search normalization contract. */
function tokenize(value: string): string[] {
  const normalized = value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return normalized
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 0 && !ENGLISH_STOPWORDS.has(token));
}

interface WeightedDocument {
  terms: Map<string, number>;
  length: number;
}

function weightedDocument(entry: WikiEntry): WeightedDocument {
  const terms = new Map<string, number>();
  let length = 0;
  const addField = (value: string, weight: number): void => {
    for (const token of tokenize(value)) {
      terms.set(token, (terms.get(token) ?? 0) + weight);
      length += weight;
    }
  };
  addField(entry.title, TITLE_WEIGHT);
  addField(`${entry.queryOrUrl} ${entry.format} ${entry.source}`, METADATA_WEIGHT);
  addField(entry.text, BODY_WEIGHT);
  return { terms, length };
}

function idf(documentCount: number, documentFrequency: number): number {
  return Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
}

function bm25Score(
  queryTokens: readonly string[],
  document: WeightedDocument,
  corpus: readonly WeightedDocument[],
): number {
  const averageLength = corpus.reduce((total, item) => total + item.length, 0) / corpus.length;
  const safeAverageLength = averageLength > 0 ? averageLength : 1;
  let score = 0;
  for (const token of queryTokens) {
    const termFrequency = document.terms.get(token) ?? 0;
    if (termFrequency === 0) continue;
    const documentFrequency = corpus.reduce((count, item) => count + (item.terms.has(token) ? 1 : 0), 0);
    const normalization = termFrequency + BM25_K1 * (1 - BM25_B + BM25_B * document.length / safeAverageLength);
    score += idf(corpus.length, documentFrequency) * (termFrequency * (BM25_K1 + 1)) / normalization;
  }
  return score;
}

/** Wrap a snippet around the first token occurrence. */
function makeExcerpt(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3)}\u2026`;
}

function humanizeTopic(topic: string): string {
  return topic
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

/** Search the wiki corpus for the best matching entries with exact BM25. */
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
    title?: string;
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
      for (const entry of parseWikiEntries(document, file)) entries.push({ entry, file });
    }),
  );

  const pageCounts = new Map<string, number>();
  for (const file of files) {
    const topic = file.replace(/\.part-\d{3}\.md$/, "").replace(/\.md$/, "");
    pageCounts.set(topic, (pageCounts.get(topic) ?? 0) + 1);
  }
  const queryTokens = [...new Set(tokenize(query))];
  const documents = entries.map(({ entry }) => weightedDocument(entry));
  const matches = entries
    .map(({ entry, file }, index) => {
      const topic = file.replace(/\.part-\d{3}\.md$/, "").replace(/\.md$/, "");
      const part = /\.part-(\d{3})\.md$/.exec(file);
      const page = part ? Number(part[1]) : 1;
      return {
        entry,
        file,
        topic,
        page,
        totalPages: pageCounts.get(topic) ?? 1,
        score: documents.length === 0 ? 0 : bm25Score(queryTokens, documents[index]!, documents),
      };
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
    title?: string;
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
      title: entry.title || humanizeTopic(topic),
      score: Number(score.toFixed(6)),
      excerpt: makeExcerpt(entry.text, 2048),
    };
    const nextLength = JSON.stringify(result).length;
    if (results.length > 0 && serializedLength + nextLength > 64 * 1024) break;
    results.push(result);
    serializedLength += nextLength;
  }
  return results;
}