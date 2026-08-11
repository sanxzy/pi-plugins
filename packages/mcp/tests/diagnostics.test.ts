import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnosticCategory, redactDiagnostic } from "../src/index.ts";

test("diagnostics redact credential-bearing headers, URLs, query values, and JSON", () => {
  const value = redactDiagnostic(
    'Authorization: Bearer access-secret X-Api-Key: header-secret api_key=api-secret apiKey: camel-secret Basic YWJjOnNlY3JldA== token=token-secret&access_token=url-token https://client:password@example.test/mcp?api_key=query-secret&client_secret=query-client {"client_secret":"client-secret","code_verifier":"pkce-secret","token":"json-token","safe":"visible"}',
  );
  assert.equal(value.includes("access-secret"), false);
  assert.equal(value.includes("header-secret"), false);
  assert.equal(value.includes("api-secret"), false);
  assert.equal(value.includes("camel-secret"), false);
  assert.equal(value.includes("token-secret"), false);
  assert.equal(value.includes("url-token"), false);
  assert.equal(value.includes("query-secret"), false);
  assert.equal(value.includes("query-client"), false);
  assert.equal(value.includes("client:password"), false);
  assert.equal(value.includes("client-secret"), false);
  assert.equal(value.includes("pkce-secret"), false);
  assert.equal(value.includes("json-token"), false);
  assert.match(value, /visible/);
  assert.ok(value.length <= 1_000);
});

test("diagnostics redact every common authorization scheme and OAuth query credential", () => {
  const value = redactDiagnostic([
    "Authorization: Token token-secret",
    "Authorization: token lower-secret",
    "Authorization: Bearer bearer-secret",
    "Authorization: Basic YWJjOnNlY3JldA==",
    "https://example.test/callback?code=oauth-code&state=oauth-state&token=query-token",
  ].join(" | "));
  for (const secret of ["token-secret", "lower-secret", "bearer-secret", "YWJjOnNlY3JldA==", "oauth-code", "oauth-state", "query-token"]) {
    assert.equal(value.includes(secret), false, `leaked ${secret}`);
  }
});

test("diagnostic categories are stable and do not expose raw errors", () => {
  assert.equal(diagnosticCategory(new Error("request timed out")), "timeout");
  assert.equal(diagnosticCategory(new Error("401 unauthorized access_token=secret")), "authentication");
  assert.equal(diagnosticCategory(new Error("transport disconnected")), "transport");
});
