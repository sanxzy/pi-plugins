const SENSITIVE_KEY = /(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|client[_-]?id|authorization|(?:x[_-]?)?(?:api[_-]?key|apiKey|auth[_-]?token|access[_-]?token)|apikey|password|passwd|secret|code[_-]?(?:verifier|challenge)|state|token|key)/i;
const SENSITIVE_QUERY_KEY = /(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|client[_-]?id|authorization|api[_-]?key|apikey|password|passwd|secret|code[_-]?(?:verifier|challenge)|state|token|key)/i;

function redactValue(value: string): string {
  return /^\s*$/.test(value) ? value : "[REDACTED]";
}

/**
 * Keep diagnostics useful while preventing credential-bearing values from
 * reaching status messages, logs, or model-visible output.
 */
export function redactDiagnostic(value: unknown, maxLength = 1_000): string {
  let text = value instanceof Error ? value.message : String(value);
  text = text
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/(https?:\/\/)([^\s/@:]+)(?::[^\s/@]*)?@/gi, "$1[REDACTED]@")
    .replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]");
  // Redact key=value pairs in query strings and header-like contexts.
  text = text.replace(/([?&\s"'])([A-Za-z0-9_.-]+)(\s*[=:]\s*)([^&\s,;"'}]+)/gi, (match, lead: string, key: string, sep: string, val: string) => {
    if (SENSITIVE_QUERY_KEY.test(key)) return `${lead}${key}${sep}${redactValue(val)}`;
    return match;
  });
  // Redact JSON/object key: "value" pairs.
  text = text.replace(/(["']?)([A-Za-z0-9_.-]+)\1\s*:\s*(["'])([^"']*)\3/g, (match, quote: string, key: string, q: string, val: string) => {
    if (SENSITIVE_KEY.test(key)) return `${quote}${key}${quote}: ${q}[REDACTED]${q}`;
    return match;
  });
  // Fallback for bare key=token-like sequences.
  text = text.replace(/(Authorization|Bearer|token|secret|password|api[_-]?key|apiKey|access[_-]?token|refresh[_-]?token|client[_-]?secret|code[_-]?verifier)[\s:=]+([^\s,;]+)/gi, (match, key: string, _val: string) => `${key}=[REDACTED]`);
  return text.slice(0, maxLength);
}

/** Convert an internal failure to a stable, non-secret category message. */
export function diagnosticCategory(value: unknown): string {
  const text = redactDiagnostic(value).toLowerCase();
  if (text.includes("timed out") || text.includes("timeout")) return "timeout";
  if (text.includes("abort") || text.includes("cancel")) return "cancelled";
  if (text.includes("auth") || text.includes("unauthorized") || text.includes("forbidden")) return "authentication";
  if (text.includes("registration")) return "client_registration";
  if (text.includes("discover") || text.includes("list")) return "discovery";
  if (text.includes("connect") || text.includes("transport") || text.includes("session")) return "transport";
  return "startup";
}