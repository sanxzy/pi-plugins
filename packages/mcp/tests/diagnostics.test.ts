import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnosticCategory, redactDiagnostic } from "../src/index.ts";

test("diagnostics redact credential-bearing headers, URLs, query values, and JSON", () => {
  const value = redactDiagnostic(
    'Authorization: Bearer access-secret token=token-secret&access_token=url-token https://client:password@example.test/mcp {"client_secret":"client-secret","code_verifier":"pkce-secret","safe":"visible"}',
  );
  assert.equal(value.includes("access-secret"), false);
  assert.equal(value.includes("token-secret"), false);
  assert.equal(value.includes("url-token"), false);
  assert.equal(value.includes("client:password"), false);
  assert.equal(value.includes("client-secret"), false);
  assert.equal(value.includes("pkce-secret"), false);
  assert.match(value, /visible/);
  assert.ok(value.length <= 1_000);
});

test("diagnostic categories are stable and do not expose raw errors", () => {
  assert.equal(diagnosticCategory(new Error("request timed out")), "timeout");
  assert.equal(diagnosticCategory(new Error("401 unauthorized access_token=secret")), "authentication");
  assert.equal(diagnosticCategory(new Error("transport disconnected")), "transport");
});
