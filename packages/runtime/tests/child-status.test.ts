import assert from "node:assert/strict";
import { test } from "node:test";
import { observeChildStatus } from "@xzy-ai/runtime";

/**
 * Phase 3 status-derivation tests.
 *
 * Child status must be derived from the runtime streaming state plus the final
 * assistant `stopReason`/`errorMessage`, not from a bare streaming flag. These
 * tests exercise the pure `observeChildStatus` function; the live adapter wires
 * it to a real session in the `pi -e` verification.
 */

test("streaming dominates while a run is active", () => {
  assert.equal(observeChildStatus({ isStreaming: true }), "streaming");
  // Even with a terminal-looking stop reason, an active run is still streaming.
  assert.equal(
    observeChildStatus({ isStreaming: true, stopReason: "error", errorMessage: "boom" }),
    "streaming",
  );
});

test("idle before any assistant message", () => {
  assert.equal(observeChildStatus({ isStreaming: false }), "idle");
  assert.equal(observeChildStatus({ isStreaming: false, stopReason: undefined }), "idle");
});

test("completed after a normal stop", () => {
  assert.equal(observeChildStatus({ isStreaming: false, stopReason: "stop" }), "completed");
  assert.equal(observeChildStatus({ isStreaming: false, stopReason: "length" }), "completed");
  assert.equal(observeChildStatus({ isStreaming: false, stopReason: "toolUse" }), "completed");
});

test("failed for an error stop reason or error message", () => {
  assert.equal(observeChildStatus({ isStreaming: false, stopReason: "error", errorMessage: "cmd failed" }), "failed");
  assert.equal(observeChildStatus({ isStreaming: false, stopReason: "error" }), "failed");
  // A recorded error message marks the run failed even if the stop reason is absent.
  assert.equal(observeChildStatus({ isStreaming: false, errorMessage: "boom" }), "failed");
});

test("aborted for an aborted stop reason", () => {
  assert.equal(observeChildStatus({ isStreaming: false, stopReason: "aborted" }), "aborted");
  // Real aborts carry an error message alongside the aborted stop reason
  // (references/pi/packages/agent/src/agent.ts handleRunFailure); the stop
  // reason is the discriminator, so this must still classify as aborted.
  assert.equal(observeChildStatus({ isStreaming: false, stopReason: "aborted", errorMessage: "cancelled" }), "aborted");
});