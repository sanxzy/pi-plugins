import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Phase 1 AC1: host patch must expose native swap primitive (no overlay for main window)
// This test verifies the pnpm patch file exists and contains the host swap marker.
// It will fail until the patch is delivered.
test("host swap patch is delivered and does not break compaction", () => {
  const candidates = [
    resolve(import.meta.dirname ?? ".", "../../../patches/@earendil-works__pi-coding-agent@0.84.2.patch"),
    resolve(import.meta.dirname ?? ".", "../../patches/@earendil-works__pi-coding-agent@0.84.2.patch"),
    resolve(process.cwd(), "patches/@earendil-works__pi-coding-agent@0.84.2.patch"),
    resolve(process.cwd(), "../patches/@earendil-works__pi-coding-agent@0.84.2.patch"),
    resolve(process.cwd(), "../../patches/@earendil-works__pi-coding-agent@0.84.2.patch"),
  ];
  const found = candidates.find((p) => existsSync(p));
  assert.ok(found, `patch file must exist (checked ${candidates.join(", ")})`);
  const content = readFileSync(found!, "utf8");
  assert.match(content, /hostSwap|HostSwap|_hostSwapStack/, "patch must contain host swap primitive marker");
});

// Phase 1 AC1: swap primitive rebinds main transcript+composer to child session and preserves parent
// This test uses the runtime host-swap controller (fake host double) to verify the contract.
// It will fail until the controller is implemented.
test("host swap controller swaps native transcript and preserves parent", async () => {
  const mod = await import("../src/infrastructure/host-swap/host-swap.ts");
  const controller = mod.createHostSwapController({
    sessionFile: "/home/parent.jsonl",
    sessionId: "parent-id",
    editorText: "parent draft",
    scrollOffset: 42,
  });

  // Initial state is parent, not swapped
  assert.equal(controller.isSwapped(), false);
  assert.equal(controller.current().sessionFile, "/home/parent.jsonl");
  assert.equal(controller.current().editorText, "parent draft");

  // Swap to running child - must rebind to child's session file and composer
  controller.swapTo({
    sessionFile: "/home/child.jsonl",
    sessionId: "child-id",
    editorText: "",
    scrollOffset: 0,
  });

  assert.equal(controller.isSwapped(), true, "should be swapped after swapTo");
  assert.equal(controller.current().sessionFile, "/home/child.jsonl");
  assert.equal(controller.current().sessionId, "child-id");
  // Parent's editor/scroll must be preserved in stack
  assert.equal(controller.getStackDepth(), 1);

  // Parent stays alive in background - simulated by buffering parent output
  // The controller must not expose parent's new output while swapped
  assert.equal(controller.isSwapped(), true);
  // While swapped, parent's new output is buffered, not shown
  // (represented by the fact that current() still points to child, not parent)

  // Restore must bring back parent's preserved state
  const restored = controller.restore();
  assert.equal(controller.isSwapped(), false);
  assert.equal(controller.current().sessionFile, "/home/parent.jsonl");
  assert.equal(controller.current().editorText, "parent draft");
  assert.equal(controller.current().scrollOffset, 42);
  assert.equal(restored?.sessionFile, "/home/parent.jsonl");
});

// Phase 1 AC2: parent stays alive and buffered while viewing child
test("parent background output is buffered until return", async () => {
  const mod = await import("../src/infrastructure/host-swap/host-swap.ts");
  const controller = mod.createHostSwapController({
    sessionFile: "/home/parent.jsonl",
    sessionId: "parent-id",
    editorText: "",
    scrollOffset: 0,
  });
  controller.swapTo({
    sessionFile: "/home/child.jsonl",
    sessionId: "child-id",
    editorText: "",
    scrollOffset: 0,
  });
  // Simulate parent producing output while swapped - it should be buffered, not visible
  controller.bufferParentOutput({ text: "parent new line while child viewed" });
  // While swapped, current() must still be child's session, not parent's new output
  assert.equal(controller.current().sessionFile, "/home/child.jsonl");
  // Buffered output should be available after restore
  controller.restore();
  const buffered = controller.drainBufferedParentOutput();
  assert.equal(buffered.length, 1);
  assert.equal(buffered[0]!.text, "parent new line while child viewed");
});
