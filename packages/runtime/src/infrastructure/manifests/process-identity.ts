/** Process-identity metadata for liveness reconciliation. */
export interface ProcessIdentity {
  readonly pid: number;
  readonly processStartTime: string;
}

/** Process start time captured from the process start clock. */
const PROCESS_START_TIME = currentProcessStartIso();

function currentProcessStartIso(): string {
  try {
    const startNanos = (process as NodeJS.Process & { getStartTime?: () => number }).getStartTime?.();
    if (typeof startNanos === "number") return new Date(startNanos).toISOString();
  } catch {
    // fall through
  }
  return new Date(Date.now() - process.uptime() * 1000).toISOString();
}

/** Current process identity used in session manifests. */
export function currentProcessIdentity(): ProcessIdentity {
  return { pid: process.pid, processStartTime: PROCESS_START_TIME };
}

/** Stable process start time for this Node process. */
export function processStartTime(): string {
  return PROCESS_START_TIME;
}
