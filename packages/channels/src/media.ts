import { CHANNEL_OPERATIONS, processWithLog } from "@xzy-ai/observability";
import { resolveChannelSettings } from "./settings.ts";

/** Telegram's documented upload limits. */
export const MEDIA_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
export const MEDIA_DOCUMENT_MAX_BYTES = 50 * 1024 * 1024;
export const MEDIA_DEFAULT_TIMEOUT_MS = 30_000;
export const MEDIA_MAX_REDIRECTS = 3;

export type TelegramMediaType = "photo" | "document";

export type TelegramMediaInput =
  | { kind: "file_id"; file_id: string }
  | { kind: "artifact_id"; artifact_id: string }
  | { kind: "https"; url: string };

export type TelegramResolvedMediaSource =
  | { kind: "file_id"; fileId: string }
  | { kind: "bytes"; bytes: Uint8Array; contentType: string; filename?: string };

export interface MediaArtifact {
  bytes: Uint8Array;
  contentType: string;
  filename?: string;
}

export interface MediaArtifactScope {
  projectRoot: string;
  sessionId: string;
}

interface StoredMediaArtifact extends MediaArtifact {
  scope: MediaArtifactScope;
}

export type MediaFailureCategory = "telegram_rejected" | "network_error" | "rate_limited" | "not_configured" | "target_not_approved";

export type MediaResolutionResult =
  | { ok: true; source: TelegramResolvedMediaSource }
  | { ok: false; error: string; category: MediaFailureCategory };

export type MediaDownloadResult =
  | { ok: true; bytes: Uint8Array; contentType: string; filename?: string }
  | { ok: false; error: string; category: "telegram_rejected" | "network_error" };

const artifacts = new Map<string, StoredMediaArtifact>();
const ARTIFACT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const EXECUTABLE_TYPES = new Set([
  "application/x-msdownload",
  "application/x-dosexec",
  "application/vnd.microsoft.portable-executable",
  "application/x-elf",
  "application/x-executable",
  "application/x-sh",
  "text/x-shellscript",
  "application/javascript",
  "text/javascript",
  "application/x-bat",
  "application/x-csh",
]);

function normalizeContentType(contentType: string): string {
  return contentType.split(";", 1)[0]!.trim().toLowerCase();
}

/** Convert a host-provided filename into a safe Telegram display basename. */
export function sanitizeMediaFilename(filename: string | undefined): string {
  if (typeof filename !== "string") return "file";
  const basename = filename.replace(/[\\/]+/g, "/").split("/").pop() ?? "";
  const cleaned = basename
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "")
    .replace(/[^A-Za-z0-9._ -]/g, "")
    .trim()
    .slice(0, 255);
  return cleaned || "file";
}

/** Detect a conservative content type from common file signatures. */
export function detectMediaContentType(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a) return "image/png";
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "application/pdf";
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return "application/zip";
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) return "application/x-msdownload";
  if (bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) return "application/x-elf";
  return "application/octet-stream";
}

export function classifyMediaContentType(contentType: string): "image" | "document" | "executable" | "unknown" {
  const normalized = normalizeContentType(contentType);
  if (EXECUTABLE_TYPES.has(normalized)) return "executable";
  if (normalized.startsWith("image/")) return "image";
  if (
    normalized === "application/pdf" || normalized === "application/zip" || normalized === "application/octet-stream" ||
    normalized === "text/plain" || normalized === "text/csv" || normalized === "application/json" ||
    normalized.startsWith("application/vnd.") || normalized === "application/msword" || normalized === "application/rtf"
  ) return normalized === "application/octet-stream" ? "unknown" : "document";
  return "unknown";
}

export type MediaContentValidation =
  | { ok: true }
  | { ok: false; error: string; category: "telegram_rejected" };

/** Validate Telegram's declared media operation against detected MIME. */
export function validateMediaContentType(mediaType: TelegramMediaType, contentType: string): MediaContentValidation {
  const classification = classifyMediaContentType(contentType);
  if (classification === "executable") return { ok: false, error: "Executable media content is not allowed", category: "telegram_rejected" };
  if (mediaType === "photo" && classification !== "image") return { ok: false, error: "Photo content must have an image MIME type", category: "telegram_rejected" };
  if (mediaType === "document" && classification !== "document") return { ok: false, error: "Document content has an unsupported MIME type", category: "telegram_rejected" };
  return { ok: true };
}

/** Test-only/host-controlled registration seam for opaque artifact IDs. */
export function registerMediaArtifact(artifactId: string, artifact: MediaArtifact, scope: MediaArtifactScope): void {
  if (!ARTIFACT_ID_PATTERN.test(artifactId) || !scope.projectRoot || !scope.sessionId) throw new Error("Invalid media artifact registration");
  artifacts.set(artifactId, { ...artifact, scope: { ...scope }, bytes: new Uint8Array(artifact.bytes), contentType: normalizeContentType(artifact.contentType), filename: sanitizeMediaFilename(artifact.filename) });
}

export function clearMediaArtifacts(): void {
  artifacts.clear();
}

export type MediaArtifactResult =
  | { ok: true; source: MediaArtifact }
  | { ok: false; error: string; category: "telegram_rejected" };

export function resolveMediaArtifact(artifactId: string, scope: MediaArtifactScope): MediaArtifactResult {
  if (!ARTIFACT_ID_PATTERN.test(artifactId)) return { ok: false, error: "Media artifact is unavailable", category: "telegram_rejected" };
  const artifact = artifacts.get(artifactId);
  if (!artifact || artifact.scope.projectRoot !== scope.projectRoot || artifact.scope.sessionId !== scope.sessionId) {
    return { ok: false, error: "Media artifact is unavailable", category: "telegram_rejected" };
  }
  return { ok: true, source: { bytes: new Uint8Array(artifact.bytes), contentType: artifact.contentType, filename: artifact.filename } };
}

/** True when a numeric IPv4 octet tuple is a private, loopback, or link-local range. */
function isUnsafePrivateIpv4(parts: number[]): boolean {
  if (parts.length !== 4) return false;
  const [a, b] = parts;
  return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function isUnsafeMediaHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/[\[\]]/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "ip6-localhost" || host.endsWith(".internal")) return true;
  if (host === "::1" || host === "0.0.0.0" || host === "127.0.0.1" || host.startsWith("127.")) return true;
  // IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1 / ::ffff:7f00:1) resolve to an IPv4 host.
  if (host.startsWith("::ffff:")) {
    const tail = host.slice("::ffff:".length);
    if (tail.includes(":")) {
      const groups = tail.split(":");
      if (groups.length === 2 && groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) {
        const hex = groups.map((group) => group.padStart(4, "0")).join("");
        const ip = [0, 2, 4, 6].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
        return isUnsafePrivateIpv4(ip);
      }
    } else if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) {
      return isUnsafePrivateIpv4(tail.split(".").map(Number));
    }
  }
  const parts = host.split(".").map(Number);
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    return isUnsafePrivateIpv4(parts);
  }
  return false;
}

function parseSafeHttpsUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") || isUnsafeMediaHost(url.hostname)) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function mediaLimit(mediaType: TelegramMediaType, projectRoot?: string): number {
  if (projectRoot) {
    const settings = resolveChannelSettings(projectRoot);
    return mediaType === "photo" ? settings.mediaPhotoMaxBytes : settings.mediaDocumentMaxBytes;
  }
  return mediaType === "photo" ? MEDIA_PHOTO_MAX_BYTES : MEDIA_DOCUMENT_MAX_BYTES;
}

function safeFilenameFromUrl(url: URL): string {
  try {
    return sanitizeMediaFilename(decodeURIComponent(url.pathname.split("/").pop() ?? "file"));
  } catch {
    return "file";
  }
}

/**
 * Collect a media response body without allowing an unbounded response into
 * memory. A declared oversize is rejected before a reader is created; a
 * streamed oversize cancels the reader immediately.
 */
async function readBoundedMediaBody(
  response: Response,
  maximumBytes: number,
  tooLargeMessage: string,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  const parsedLength = declaredLength === null ? undefined : Number.parseInt(declaredLength, 10);
  if (parsedLength !== undefined && Number.isSafeInteger(parsedLength) && parsedLength > maximumBytes) {
    throw new Error(tooLargeMessage);
  }
  if (!response.body) {
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > maximumBytes) throw new Error(tooLargeMessage);
    return body;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (size + value.byteLength > maximumBytes) {
        await reader.cancel(tooLargeMessage);
        throw new Error(tooLargeMessage);
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } catch (error) {
    try { await reader.cancel(error); } catch { /* transport may have closed the stream */ }
    throw error;
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

/** Download one HTTPS media source with bounded redirects, timeout, and bytes. */
export async function downloadMediaHttps(
  value: string,
  options: { maxBytes: number; timeoutMs?: number; maxRedirects?: number; fetchImpl?: typeof fetch },
): Promise<MediaDownloadResult> {
  return processWithLog({ operation: CHANNEL_OPERATIONS.MEDIA_DOWNLOAD, parameters: { maxBytes: options.maxBytes, timeoutMs: options.timeoutMs } }, async () => {
  let current = parseSafeHttpsUrl(value);
  if (!current) return { ok: false, error: "Media source must be a safe HTTPS URL", category: "telegram_rejected" };
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? MEDIA_DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? MEDIA_MAX_REDIRECTS;
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    try {
      const response = await fetchImpl(current.href, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
      if (response.status >= 300 && response.status < 400) {
        if (redirectCount === maxRedirects) return { ok: false, error: "Media source redirected too many times", category: "telegram_rejected" };
        const location = response.headers.get("location");
        if (!location) return { ok: false, error: "Media source redirect is missing a location", category: "telegram_rejected" };
        const next = parseSafeHttpsUrl(new URL(location, current).href);
        if (!next) return { ok: false, error: "Media source redirect is unsafe", category: "telegram_rejected" };
        current = next;
        continue;
      }
      if (!response.ok) return { ok: false, error: "Media source could not be downloaded", category: "network_error" };
      const contentType = normalizeContentType(response.headers.get("content-type") ?? "application/octet-stream");
      const bytes = await readBoundedMediaBody(response, options.maxBytes, "Media source exceeds the allowed size");
      return { ok: true, bytes, contentType, filename: safeFilenameFromUrl(current) };
    } catch (error) {
      if (error instanceof Error && error.message === "Media source exceeds the allowed size") return { ok: false, error: error.message, category: "telegram_rejected" };
      return { ok: false, error: "Media source download failed", category: "network_error" };
    }
  }
  return { ok: false, error: "Media source could not be downloaded", category: "network_error" };
  });
}

function validateBytes(mediaType: TelegramMediaType, bytes: Uint8Array, contentType: string, projectRoot?: string): MediaContentValidation {
  if (bytes.byteLength > mediaLimit(mediaType, projectRoot)) return { ok: false, error: "Media source exceeds the allowed size", category: "telegram_rejected" };
  const declared = normalizeContentType(contentType);
  const detected = detectMediaContentType(bytes);
  const detectedCheck = validateMediaContentType(mediaType, detected);
  if (!detectedCheck.ok) return detectedCheck;
  const declaredCheck = validateMediaContentType(mediaType, declared);
  if (!declaredCheck.ok) return declaredCheck;
  if (detected !== "application/octet-stream" && detected !== declared) return { ok: false, error: "Declared and detected media types do not match", category: "telegram_rejected" };
  return { ok: true };
}

/** Resolve and validate an allowed model-facing source into an uploadable source. */
export async function resolveMediaSource(input: TelegramMediaInput, mediaType: TelegramMediaType, filename?: string, scope?: MediaArtifactScope): Promise<MediaResolutionResult> {
  return processWithLog({ operation: CHANNEL_OPERATIONS.MEDIA_RESOLVE, parameters: { mediaType, kind: input.kind } }, async () => {
  if (input.kind === "file_id") {
    if (typeof input.file_id !== "string" || input.file_id.length === 0 || input.file_id.length > 256 || /[\r\n]/.test(input.file_id)) return { ok: false, error: "Telegram file id is invalid", category: "telegram_rejected" };
    return { ok: true, source: { kind: "file_id", fileId: input.file_id } };
  }
  if (input.kind === "artifact_id") {
    if (!scope) return { ok: false, error: "Media artifact is unavailable", category: "telegram_rejected" };
    const artifact = resolveMediaArtifact(input.artifact_id, scope);
    if (!artifact.ok) return artifact;
    const check = validateBytes(mediaType, artifact.source.bytes, artifact.source.contentType, scope.projectRoot);
    if (!check.ok) return check;
    return { ok: true, source: { kind: "bytes", bytes: artifact.source.bytes, contentType: artifact.source.contentType, filename: sanitizeMediaFilename(filename ?? artifact.source.filename) } };
  }
  if (input.kind !== "https") return { ok: false, error: "Unsupported media source", category: "telegram_rejected" };
  // The resolver intentionally nests the download boundary so one resolution
  // can be traced as MEDIA_RESOLVE -> MEDIA_DOWNLOAD without logging the URL.
  const settings = scope ? resolveChannelSettings(scope.projectRoot) : undefined;
  const downloaded = await downloadMediaHttps(input.url, {
    maxBytes: settings ? (mediaType === "photo" ? settings.mediaPhotoMaxBytes : settings.mediaDocumentMaxBytes) : mediaLimit(mediaType),
    timeoutMs: settings?.mediaTimeoutMs,
  });
  if (!downloaded.ok) return downloaded;
  const detected = detectMediaContentType(downloaded.bytes);
  const check = validateBytes(mediaType, downloaded.bytes, downloaded.contentType === "application/octet-stream" ? detected : downloaded.contentType, scope?.projectRoot);
  if (!check.ok) return check;
  return { ok: true, source: { kind: "bytes", bytes: downloaded.bytes, contentType: detected === "application/octet-stream" ? downloaded.contentType : detected, filename: sanitizeMediaFilename(filename ?? downloaded.filename) } };
  });
}
