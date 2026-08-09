import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createChannelLogger, channelLogFile } from "../src/index.ts";

function projectRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-code-channels-log-"));
}

test("writes structured JSONL session logs with safe metadata and redacted secrets", () => {
  const root = projectRoot();
  const secret = "123456789:ABCDEFGHIJKLMNOPQRSTUVWX";
  const result = createChannelLogger({ projectRoot: root, sessionId: "root-session" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const log = result.value;
  assert.equal(log.filePath, channelLogFile(root, "root-session"));
  log.info("lifecycle_start", { project: "demo", token: secret, botToken: secret });
  log.child({ chatId: "12345" }).warn("transport_error", { apiSecret: secret, detail: "polling failed" });
  log.close();

  const lines = readFileSync(channelLogFile(root, "root-session"), "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]!) as Record<string, unknown>;
  const second = JSON.parse(lines[1]!) as Record<string, unknown>;
  assert.equal(first.event, "lifecycle_start");
  assert.equal(first.sessionId, "root-session");
  assert.equal(first.project, "demo");
  assert.equal(first.token, "[Redacted]");
  assert.equal(first.botToken, "[Redacted]");
  assert.equal(second.event, "transport_error");
  assert.equal(second.chatId, "12345");
  assert.equal(second.apiSecret, "[Redacted]");
  assert.equal(second.detail, "polling failed");
});

test("redacts arbitrary nested token values and omits Telegram update payloads", () => {
  const root = projectRoot();
  const secret = "987654321:ZYXWVUTSRQPONMLKJIHGFEDC";
  const result = createChannelLogger({ projectRoot: root, sessionId: "root-session" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const log = result.value;
  log.error("inject_failed", {
    updateId: 42,
    arbitrary: { nestedValue: secret },
    update: { update_id: 42, message: { text: "private message" } },
  });
  log.close();
  const raw = readFileSync(channelLogFile(root, "root-session"), "utf8");
  const line = JSON.parse(raw.trim());
  assert.equal(line.updateId, 42);
  assert.equal(line.arbitrary.nestedValue, "[Redacted]");
  assert.equal(line.update, "[Omitted]");
  assert.equal(raw.includes(secret), false);
  assert.equal(raw.includes("private message"), false);
});

test("returns a safe result when session path validation fails", () => {
  const root = projectRoot();
  const result = createChannelLogger({ projectRoot: root, sessionId: "bad/session" });
  assert.deepEqual(result, { ok: false, code: "io", message: "Unable to create channel log" });
});

test("returns a safe result when the project root cannot be created", () => {
  const root = join(projectRoot(), "file-root");
  writeFileSync(root, "not a directory");
  const result = createChannelLogger({ projectRoot: root, sessionId: "root-session" });
  assert.deepEqual(result, { ok: false, code: "io", message: "Unable to create channel log" });
});