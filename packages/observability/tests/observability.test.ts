import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  MCP_OPERATIONS,
  PERSISTENCE_OPERATIONS,
  createSessionLogger,
  getPersistenceFailureCount,
  mask,
  processWithLog,
  resetPersistenceFailureCount,
  runWithLogContext,
} from "@xzy-ai/observability";

const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function scope(prefix = "pi-c2-observability-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const eventsPath = join(root, "events.jsonl");
  const errorsPath = join(root, "errors.jsonl");
  return { root, eventsPath, errorsPath };
}

function records(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function makeThenable<T>(): PromiseLike<T> & { resolve(value: T): void; reject(error: unknown): void } {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    then: promise.then.bind(promise),
    resolve: resolvePromise,
    reject: rejectPromise,
  };
}

test("operation identifiers persist with their constant casing (H1)", async () => {
  const paths = scope();
  const logger = createSessionLogger({ projectId: "project-a", rootSessionId: "root-a", eventsPath: paths.eventsPath, errorsPath: paths.errorsPath });
  await runWithLogContext(logger, () => {
    processWithLog({ operation: MCP_OPERATIONS.MANAGER_START }, () => undefined);
    processWithLog({ operation: PERSISTENCE_OPERATIONS.MANIFEST_PROJECT_WRITE }, () => undefined);
  });
  const output = records(paths.eventsPath);
  assert.deepEqual(output.map((record) => record.operation), [MCP_OPERATIONS.MANAGER_START, MCP_OPERATIONS.MANAGER_START, PERSISTENCE_OPERATIONS.MANIFEST_PROJECT_WRITE, PERSISTENCE_OPERATIONS.MANIFEST_PROJECT_WRITE]);
});

test("oversized string fields are bounded before persistence (H6)", () => {
  const paths = scope();
  const logger = createSessionLogger({ projectId: "project-a", rootSessionId: "root-a", eventsPath: paths.eventsPath, errorsPath: paths.errorsPath });
  const big = "A".repeat(40000);
  const result = processWithLog({ operation: "bound.check", parameters: { payload: big, nested: { blob: big } } }, () => ({ echo: big }));
  assert.equal(result.echo, big, "business result must stay unbounded");
  const after = records(paths.eventsPath).find((record) => record.phase === "after");
  assert.ok(after, "missing after record");
  const params = after.parameters as { payload: unknown; nested: { blob: unknown } };
  assert.equal(params.payload, "[truncated:40000]");
  assert.equal(params.nested.blob, "[truncated:40000]");
  assert.equal((after.result as { echo: unknown }).echo, "[truncated:40000]");
  assert.ok(readFileSync(paths.eventsPath, "utf8").length < 20000, "persisted file must be bounded");
});

test("URL query secret values and userinfo are redacted before persistence (H7)", () => {
  const paths = scope();
  const logger = createSessionLogger({ projectId: "project-a", rootSessionId: "root-a", eventsPath: paths.eventsPath, errorsPath: paths.errorsPath });
  const tokenValue = "z-secret-query-value-9";
  processWithLog({ operation: "url.params", parameters: {
    target: `https://api.example.com/v1/data?name=alice&access_token=${tokenValue}&code=${tokenValue}&client_id=${tokenValue}`,
    mirror: `https://user:${tokenValue}@svc.example.net/`,
  } }, () => "ok");
  const raw = readFileSync(paths.eventsPath, "utf8");
  assert.equal(raw.includes(tokenValue), false, "query secret value leaked");
  assert.match(raw, /access_token=\[Redacted\]/);
  assert.match(raw, /code=\[Redacted\]/);
  assert.match(raw, /client_id=\[Redacted\]/);
  assert.match(raw, /name=alice/, "non-secret query values must survive");
  assert.match(raw, /https:\/\/\[Redacted\]:\[Redacted\]@svc\.example\.net\//);
});

test("thenable (non-Promise) results are correlated like promises (H9)", async () => {
  const paths = scope();
  const logger = createSessionLogger({ projectId: "project-a", rootSessionId: "root-a", eventsPath: paths.eventsPath, errorsPath: paths.errorsPath });
  const thenableSecret = "thenable-resolved-value-77";
  const thenable = makeThenable<string>();
  const outcome = runWithLogContext(logger, () => processWithLog({ operation: "thenable.check" }, () => thenable));
  assert.equal(typeof outcome.then, "function", "thenable must be returned untouched");
  thenable.resolve(thenableSecret);
  assert.equal(await outcome, thenableSecret);
  const after = records(paths.eventsPath).find((record) => record.phase === "after");
  assert.equal(after?.result, thenableSecret, "after record must carry the resolved value");

  const failing = makeThenable<void>();
  const failingOutcome = runWithLogContext(logger, () => processWithLog({ operation: "thenable.fail" }, () => failing));
  failing.reject(new Error("thenable boom"));
  await assert.rejects(async () => failingOutcome, /thenable boom/);
  const errorRecords = records(paths.errorsPath);
  assert.equal(errorRecords.length >= 1, true);
  assert.equal(errorRecords.at(-1)?.operation, "thenable.fail");
});

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

test("masking removes common API-key, bearer, authorization, private-key, and error-message secrets", async () => {
  const paths = scope();
  const logger = createSessionLogger({ projectId: "project-a", rootSessionId: "root-a", eventsPath: paths.eventsPath, errorsPath: paths.errorsPath });
  const rawValues = ["APIKEY_123", "BEARERTOK_456", "cred_abc", "RAW_PRIVATE_KEY", "BEARER_FREE", "AUTH_VALUE"];
  await assert.rejects(
    () => processWithLog({
      operation: "auth.check",
      parameters: {
        apiKey: rawValues[0],
        api_key: rawValues[0],
        bearer: rawValues[1],
        authorization: `Bearer ${rawValues[1]}`,
        bearerAssignment: `bearer=${rawValues[4]}`,
        authorizationAssignment: `authorization=Bearer ${rawValues[5]}`,
        nested: { privateKey: rawValues[3], credential: rawValues[2] },
      },
    }, () => Promise.reject(new Error(`Bearer ${rawValues[1]} apiKey=${rawValues[0]} credential=${rawValues[2]} bearer=${rawValues[4]} authorization=Bearer ${rawValues[5]}`))),
  );
  const raw = readFileSync(paths.errorsPath, "utf8") + readFileSync(paths.eventsPath, "utf8");
  for (const value of rawValues) assert.equal(raw.includes(value), false, `raw value leaked: ${value}`);
});

test("masking redacts generic secret assignments in nested params, results, and error messages", async () => {
  const paths = scope();
  const logger = createSessionLogger({ projectId: "project-a", rootSessionId: "root-a", eventsPath: paths.eventsPath, errorsPath: paths.errorsPath });
  const paramSecret = "p_secret_123";
  const resultSecret = "r_password_456";
  const errorSecret = "e_token_789";
  await processWithLog({
    operation: "nested.result",
    parameters: { nested: { secret: paramSecret, token: paramSecret, password: paramSecret, api_secret: paramSecret } },
  }, () => ({ nestedResult: { secret: resultSecret, token: resultSecret, password: resultSecret, api_secret: resultSecret } }));
  assert.throws(
    () => processWithLog({ operation: "nested.error" }, () => {
      throw new Error(`secret=${errorSecret} token=${errorSecret} password=${errorSecret} api_secret=${errorSecret}`);
    }),
  );
  const raw = readFileSync(paths.errorsPath, "utf8") + readFileSync(paths.eventsPath, "utf8");
  for (const value of [paramSecret, resultSecret, errorSecret]) {
    assert.equal(raw.includes(value), false, `raw value leaked: ${value}`);
  }
  assert.equal(raw.includes("secret="), false);
  assert.equal(raw.includes("token="), false);
  assert.equal(raw.includes("password="), false);
  assert.equal(raw.includes("api_secret="), false);
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

test("masking safely bounds cyclic values instead of recursing forever", () => {
  const cyclic: Record<string, unknown> = { name: "cycle" };
  cyclic.self = cyclic;
  assert.deepEqual(mask(cyclic), { name: "cycle", self: "[Circular]" });
});

test("no-context processWithLog fallback is silent and non-persistent (H2)", () => {
  const helper = fileURLToPath(new URL("./no-context-helper.ts", import.meta.url));
  const result = spawnSync(process.execPath, ["--import", "tsx", helper], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "COUNT=0\n");
  assert.equal(result.stderr, "", "no-context fallback must not emit persistence noise");
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
  assert.equal(fallback.join("\n").includes("token"), false);
});
