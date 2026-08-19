import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, MessageEndEvent, SessionCompactEvent } from "@earendil-works/pi-coding-agent";
import { AGENT_OPERATIONS, createSessionLogger, runWithLogContext, SESSION_OPERATIONS } from "@xzy-ai/observability";
import { registerCompactionLogging } from "../src/registrations/compaction-logging.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;

function records(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function scope(prefix = "pi-c2-compaction-log-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const eventsPath = join(root, "events.jsonl");
  const errorsPath = join(root, "errors.jsonl");
  return { root, eventsPath, errorsPath };
}

/** Build a fake ExtensionAPI capturing handlers. */
function registrations() {
  const handlers = new Map<string, Handler>();
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  registerCompactionLogging(pi);
  return { handlers };
}

/** Fake context: provides getContextUsage + settings manager threshold surface. */
function context(
  cwd: string,
  logger: ReturnType<typeof createSessionLogger>,
  overrides: { contextWindow?: number; thresholdPercent?: number | null; tokens?: number | null } = {},
): ExtensionContext {
  const { contextWindow = 200000, thresholdPercent = 60, tokens = 150000 } = overrides;
  return {
    cwd,
    mode: "tui",
    hasUI: true,
    logger,
    model: { contextWindow },
    getContextUsage: () => ({ tokens, contextWindow, percent: tokens === null ? null : (tokens / contextWindow) * 100 }),
    getSettingsManager: () => ({
      getCompactionSettings: () => ({ enabled: true, reserveTokens: 0, keepRecentTokens: 0, thresholdPercent }),
    }),
  } as unknown as ExtensionContext;
}

/** Wrap a handler invocation in a session-logger context so writes land in eventsPath. */
async function runWith(eventsPath: string, errorsPath: string, fn: (logger: ReturnType<typeof createSessionLogger>) => Promise<unknown> | unknown): Promise<void> {
  const logger = createSessionLogger({ projectId: "project-a", rootSessionId: "root-a", eventsPath, errorsPath });
  await runWithLogContext(logger, () => fn(logger));
}

test("session_compact logs the compaction lifecycle for every reason with willRetry", async () => {
  const paths = scope();
  try {
    const { handlers } = registrations();
    const handler = handlers.get("session_compact")!;
    assert.ok(handler, "session_compact handler must be registered");
    const event = {
      type: "session_compact",
      reason: "threshold",
      fromExtension: false,
      willRetry: true,
      compactionEntry: { type: "compaction", summary: "sum", firstKeptEntryId: "e1", tokensBefore: 12345 },
    } as unknown as SessionCompactEvent;
    await runWith(paths.eventsPath, paths.errorsPath, (logger) => handler(event, context(process.cwd(), logger)));
    const output = records(paths.eventsPath);
    const compact = output.find((r) => r.operation === SESSION_OPERATIONS.COMPACT_LIFECYCLE && r.phase === "after");
    assert.ok(compact, "compaction lifecycle log missing");
    assert.equal((compact.parameters as { reason: string }).reason, "threshold", "reason logged");
    assert.equal((compact.result as { willRetry: boolean }).willRetry, true, "willRetry logged");
    assert.equal((compact.result as { fromExtension: boolean }).fromExtension, false, "fromExtension logged");
    assert.equal((compact.result as { contextEstimateBefore: number }).contextEstimateBefore, 12345, "tokensBefore logged");
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("message_end crossing the threshold logs the abort point", async () => {
  const paths = scope();
  try {
    const { handlers } = registrations();
    const handler = handlers.get("message_end")!;
    assert.ok(handler, "message_end handler must be registered");
    const event = {
      type: "message_end",
      message: {
        role: "assistant",
        content: [],
        usage: { input: 100000, output: 50000, cacheRead: 0, cacheWrite: 0 },
        timestamp: 1,
      },
    } as unknown as MessageEndEvent;
    await runWith(paths.eventsPath, paths.errorsPath, (logger) => handler(event, context(process.cwd(), logger)));
    const output = records(paths.eventsPath);
    const logged = output.find((r) => r.operation === SESSION_OPERATIONS.COMPACT_THRESHOLD_CHECK && r.phase === "after");
    assert.ok(logged, "threshold-check log missing");
    assert.equal((logged.parameters as { role: string }).role, "assistant");
    assert.equal((logged.result as { above: boolean }).above, true, "crossing above=true");
    assert.equal((logged.result as { contextEstimate: number }).contextEstimate, 150000, "usage estimate logged");
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("message_end below the threshold logs above=false", async () => {
  const paths = scope();
  try {
    const { handlers } = registrations();
    const handler = handlers.get("message_end")!;
    const event = {
      type: "message_end",
      message: { role: "user", content: [], timestamp: 1 },
    } as unknown as MessageEndEvent;
    await runWith(paths.eventsPath, paths.errorsPath, (logger) => handler(event, context(process.cwd(), logger, { tokens: 50000, thresholdPercent: 60 })));
    const output = records(paths.eventsPath);
    const logged = output.find((r) => r.operation === SESSION_OPERATIONS.COMPACT_THRESHOLD_CHECK && r.phase === "after");
    assert.ok(logged, "threshold-check log missing");
    assert.equal((logged.result as { above: boolean }).above, false, "below threshold above=false");
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("message_end with no threshold configured logs above=false with null threshold", async () => {
  const paths = scope();
  try {
    const { handlers } = registrations();
    const handler = handlers.get("message_end")!;
    const event = {
      type: "message_end",
      message: { role: "user", content: [], timestamp: 1 },
    } as unknown as MessageEndEvent;
    await runWith(paths.eventsPath, paths.errorsPath, (logger) => handler(event, context(process.cwd(), logger, { tokens: 150000, thresholdPercent: null })));
    const output = records(paths.eventsPath);
    const logged = output.find((r) => r.operation === SESSION_OPERATIONS.COMPACT_THRESHOLD_CHECK && r.phase === "after");
    assert.ok(logged, "threshold-check log missing");
    assert.equal((logged.result as { above: boolean }).above, false, "no threshold above=false");
    assert.equal((logged.result as { thresholdPercent: number | null }).thresholdPercent, null);
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("agent_start logs the auto-continue evidence", async () => {
  const paths = scope();
  try {
    const { handlers } = registrations();
    const handler = handlers.get("agent_start")!;
    assert.ok(handler, "agent_start handler must be registered");
    const event = { type: "agent_start" };
    await runWith(paths.eventsPath, paths.errorsPath, (logger) => handler(event, context(process.cwd(), logger)));
    const output = records(paths.eventsPath);
    const logged = output.find((r) => r.operation === AGENT_OPERATIONS.START && r.phase === "after");
    assert.ok(logged, "agent_start log missing");
  } finally {
    rmSync(paths.root, { recursive: true, force: true });
  }
});

test("registration wires all three compaction lifecycle events", () => {
  const { handlers } = registrations();
  assert.ok(handlers.has("session_compact"));
  assert.ok(handlers.has("message_end"));
  assert.ok(handlers.has("agent_start"));
});
