import { getActiveGroup, resolveActiveModel } from "./store.ts";
import { quarantineModel, isQuarantined, getQuarantineMap } from "./quarantine.ts";

export type AttemptResult = { ok: true; value: unknown } | { ok: false; status: number; error: string };
export type FallbackResult = { ok: true; value: unknown; usedRef: string } | { ok: false; error: string; nextRetryAt?: number; lastStatus?: number };

export function runWithModelGroupFallback(options: {
  attempt: (ref: string) => AttemptResult;
  now?: number;
}): FallbackResult {
  const group = getActiveGroup();
  if (!group) return { ok: false, error: "No active group" };
  const quarantineMinutes = group.quarantineMinutes;
  const tried = new Set<string>();
  let lastError = "";
  let lastStatus: number | undefined;
  function nextCandidate(): string | undefined {
    const ordered: string[] = group!.models.map((m) => m.ref);
    if (group!.mode === "round-robin") {
      if (tried.size === 0) {
        const first = resolveActiveModel();
        if (first && !tried.has(first.ref) && !isQuarantined(first.ref)) return first.ref;
      }
      for (const m of group!.models) {
        if (tried.has(m.ref)) continue;
        if (isQuarantined(m.ref)) continue;
        return m.ref;
      }
      return undefined;
    } else {
      for (const ref of ordered) {
        if (tried.has(ref)) continue;
        if (isQuarantined(ref)) continue;
        return ref;
      }
      return undefined;
    }
  }

  while (true) {
    const ref = nextCandidate();
    if (!ref) {
      let nextRetryAt: number | undefined;
      for (const m of group.models) {
        const exp = getQuarantineMap().get(m.ref);
        if (exp !== undefined && (nextRetryAt === undefined || exp < nextRetryAt)) nextRetryAt = exp;
      }
      return { ok: false, error: lastError || `All models in group '${group.name}' are quarantined`, nextRetryAt, lastStatus };
    }
    tried.add(ref);
    const result = options.attempt(ref);
    if (result.ok) {
      return { ok: true, value: result.value, usedRef: ref };
    }
    if (result.status >= 400 && result.status < 600) {
      quarantineModel(ref, quarantineMinutes);
      lastError = result.error;
      lastStatus = result.status;
      const remaining = group.models.some((m) => !isQuarantined(m.ref) && !tried.has(m.ref));
      if (!remaining) {
        let nextRetryAt: number | undefined;
        for (const m of group.models) {
          const exp = getQuarantineMap().get(m.ref);
          if (exp !== undefined && (nextRetryAt === undefined || exp < nextRetryAt)) nextRetryAt = exp;
        }
        return { ok: false, error: lastError, nextRetryAt, lastStatus };
      }
      continue;
    } else {
      return { ok: false, error: result.error, lastStatus: result.status };
    }
  }
}
