import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createSessionLogger,
  getPersistenceFailureCount,
  processWithLog,
  resetPersistenceFailureCount,
  runWithLogContext,
} from "@xzy-ai/observability";

const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function scope(prefix = "pi-code-observability-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const eventsPath = join(root, "events.jsonl");
  const errorsPath = join(root, "errors.jsonl");
  return { root, eventsPath, errorsPath };
}

function records(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("processWithLog emits correlated before/after records to events.jsonl", async () => {
  const paths = scope();
  const logger = createSessionLogger({
    projectId: "project-a",
    rootSessionId: "root-a",
    eventsPath: paths.eventsPath,
    errorsPath: paths.errorsPath,
  });

  const result = await runWithLogContext(logger, () => processWithLog(
    { operation: "agent.run", parameters: { prompt: "inspect" } },
    async ({ correlationId, parentCorrelationId }) => {
      assert.ok(correlationId);
      assert.equal(parentCorrelationId, undefined);
      return { answer: "done" };
    },
  ));

  assert.deepEqual(result, { answer: "done" });
  const output = records(paths.eventsPath);
  assert.equal(output.length, 2);
  assert.equal(output[0]?.phase, "before");
  assert.equal(output[1]?.phase, "after");
  assert.equal(output[0]?.correlationId, output[1]?.correlationId);
  assert.equal(output[1]?.durationMs !== undefined, true);
  assert.deepEqual(output[1]?.result, { answer: "done" });
  assert.equal(records(paths.errorsPath).length, 0);
});

test("nested processWithLog inherits the ambient parent correlation", async () => {
  const paths = scope();
  const logger = createSessionLogger({ projectId: "project-a", rootSessionId: "root-a", eventsPath: paths.eventsPath, errorsPath: paths.errorsPath });
  await runWithLogContext(logger, () => processWithLog({ operation: "session.start" }, async ({ correlationId }) => {
    await processWithLog({ operation: "agent.create" }, ({ parentCorrelationId }) => {
      assert.equal(parentCorrelationId, correlationId);
      return "child";
    });
  }));
  const output = records(paths.eventsPath);
  const parentAfter = output.find((record) => record.operation === "session.start" && record.phase === "after");
  const childBefore = output.find((record) => record.operation === "agent.create" && record.phase === "before");
  assert.equal(childBefore?.parentCorrelationId, parentAfter?.correlationId ?? output[0]?.correlationId);
});

test("failed operations write one error record to errors.jsonl and rethrow", async () => {
  const paths = scope();
  const logger = createSessionLogger({ projectId: "project-a", rootSessionId: "root-a", eventsPath: paths.eventsPath, errorsPath: paths.errorsPath });
  assert.throws(
    () => processWithLog({ operation: "telegram.send", parameters: { chatId: "123" } }, () => { throw new Error("send failed"); }),
    /send failed/,
  );
  assert.equal(records(paths.eventsPath).length, 1);
  assert.equal(records(paths.eventsPath)[0]?.phase, "before");
  const errors = records(paths.errorsPath);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.phase, "error");
  assert.equal(errors[0]?.durationMs !== undefined, true);
});

test("masking removes secrets, tokens, credentials, and raw Telegram updates", async () => {
  const paths = scope();
  const logger = createSessionLogger({ projectId: "project-a", rootSessionId: "root-a", eventsPath: paths.eventsPath, errorsPath: paths.errorsPath });
  await processWithLog({
    operation: "telegram.receive",
    parameters: {
      token: "123456789:super-secret-token-value",
      nested: { apiSecret: "api-secret-value", password: "password-value", safe: "ok" },
      update: { update_id: 42, message: { text: "private message" } },
    },
  }, () => ({ credential: "credential-value", safe: "visible" }));
  const raw = readFileSync(paths.eventsPath, "utf8");
  assert.equal(raw.includes("super-secret-token-value"), false);
  assert.equal(raw.includes("api-secret-value"), false);
  assert.equal(raw.includes("password-value"), false);
  assert.equal(raw.includes("credential-value"), false);
  assert.equal(raw.includes("private message"), false);
  assert.equal(raw.includes("\"safe\":\"ok\""), true);
});

test("session logger routes agent errors to its error file and enforces private modes", async () => {
  const paths = scope();
  const logger = createSessionLogger({ projectId: "project-a", rootSessionId: "root-a", agentId: "agent-a", eventsPath: paths.eventsPath, errorsPath: paths.errorsPath });
  await assert.rejects(() => processWithLog({ operation: "agent.run" }, () => Promise.reject(new Error("boom"))));
  assert.equal(mode(paths.root), PRIVATE_DIR);
  assert.equal(mode(paths.errorsPath), PRIVATE_FILE);
  assert.equal(records(paths.eventsPath).length, 1);
  assert.equal(records(paths.errorsPath)[0]?.agentId, "agent-a");
  assert.equal(logger.projectId, "project-a");
});

test("persistence failure does not fail business work and reports safe fallback metadata", () => {
  resetPersistenceFailureCount();
  const fallback: string[] = [];
  const paths = scope();
  const logger = createSessionLogger({
    projectId: "project-a",
    rootSessionId: "root-a",
    eventsPath: paths.eventsPath,
    errorsPath: paths.errorsPath,
    write: () => { throw new Error("disk token=do-not-leak"); },
    fallback: (line) => fallback.push(line),
  });
  const result = processWithLog({ operation: "safe.operation", parameters: { token: "raw-secret" } }, () => "business result");
  assert.equal(result, "business result");
  assert.equal(getPersistenceFailureCount() >= 1, true);
  assert.equal(fallback.length >= 1, true);
  assert.equal(fallback.join("\n").includes("raw-secret"), false);
  assert.equal(fallback.join("\n").includes("do-not-leak"), false);
});
