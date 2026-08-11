const SENSITIVE_KEY = /(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|client[_-]?id|authorization|password|passwd|secret|code[_-]?verifier|code)/i;

/**
 * Keep diagnostics useful while preventing credential-bearing values from
 * reaching status messages, logs, or model-visible output.
 */
export function redactDiagnostic(value: unknown, maxLength = 1_000): string {
  let text = value instanceof Error ? value.message : String(value);
  text = text
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/(https?:\/\/)([^\s/@:]+)(?::[^\s/@]*)?@/gi, "$1[REDACTED]@");
  text = text.replace(/([?&\s"'](?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|client[_-]?id|authorization|password|secret|code[_-]?verifier|code)[\s]*[=:])[^&\s,;"'}]+/gi, "$1[REDACTED]");
  text = text.replace(/(Bearer|token|secret|password|authorization|code[_-]?verifier)[\s:=]+[^\s,;]+/gi, (match, key: string) => `${key}=[REDACTED]`);
  text = text.replace(/(["']?[^"'\s:=]+["']?\s*:\s*["'])[^"']*(["'])/g, (match, prefix: string, suffix: string) => {
    const key = prefix.replace(/["'\s:]+$/, "");
    return SENSITIVE_KEY.test(key) ? `${prefix}[REDACTED]${suffix}` : match;
  });
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
