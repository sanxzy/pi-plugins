import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createManageModelGroupsController,
} from "../src/registrations/manage-model-groups.ts";
import {
  clearModelGroupsCache,
  clearQuarantine,
  getModelGroups,
  quarantineModel,
} from "@xzy-ai/runtime";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "pi-c2-model-groups-cmd-"));
}
function withHome(home: string, run: () => void | Promise<void>): void {
  const previous = process.env.PI_C2_TEST_HOME;
  process.env.PI_C2_TEST_HOME = home;
  process.env.PI_C2_HOME = home;
  void Promise.resolve(run()).finally(() => {
    if (previous === undefined) {
      delete process.env.PI_C2_TEST_HOME;
      delete process.env.PI_C2_HOME;
    } else {
      process.env.PI_C2_TEST_HOME = previous;
      process.env.PI_C2_HOME = previous;
    }
  });
}

function registry(): { getAvailable(): Array<Record<string, unknown>> } {
  return {
    getAvailable: () => [
      { provider: "openai", id: "gpt-a", reasoning: true, thinkingLevelMap: { off: "none", high: "high" }, contextWindow: 128000 },
      { provider: "openai", id: "gpt-b", reasoning: false, contextWindow: 64000 },
      { provider: "anthropic", id: "claude", reasoning: true, thinkingLevelMap: { off: "off", xhigh: "xhigh" }, contextWindow: 200000 },
    ],
  };
}

test("controller create → list → activate → delete", async () => {
  const home = tempHome();
  try {
    await withHome(home, async () => {
      clearModelGroupsCache();
      clearQuarantine();
      const controller = createManageModelGroupsController({ modelRegistry: registry() as never });

      const created = await controller.createGroup({
        name: "  Work  ",
        mode: "fallback",
        quarantineMinutes: 7,
        models: [{ ref: "openai/gpt-a", thinking: "high" }, { ref: "openai/gpt-b" }],
      });
      assert.equal(created.ok, true);

      const listed = await controller.listGroups();
      assert.equal(listed.length, 1);
      const group = listed[0]!;
      assert.equal(group.name, "Work");
      assert.equal(group.mode, "fallback");
      assert.equal(group.quarantineMinutes, 7);
      assert.equal(group.active, false);
      assert.equal(group.models.length, 2);
      assert.equal(group.models[1]!.ref, "openai/gpt-b");
      assert.equal(group.contextWindow, 64000, "derived contextWindow is the min member window");

      // Duplicate name is rejected.
      const duplicate = await controller.createGroup({
        name: "work",
        mode: "round-robin",
        quarantineMinutes: 5,
        models: [{ ref: "openai/gpt-a" }],
      });
      assert.equal(duplicate.ok, false);

      // Activate.
      const activated = await controller.activateGroup(group.id);
      assert.equal(activated.ok, true);
      const afterActivate = await controller.listGroups();
      assert.equal(afterActivate[0]!.active, true);
      assert.equal(getModelGroups().activeGroupId, group.id);

      // Delete clears the active pointer.
      const deleted = await controller.deleteGroup(group.id);
      assert.equal(deleted.ok, true);
      assert.equal((await controller.listGroups()).length, 0);
      assert.equal(getModelGroups().activeGroupId, undefined);

      // Persisted groups survive the cache (re-read from disk).
      assert.equal((await controller.listGroups()).length, 0);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("controller rejects invalid inputs with clear messages", async () => {
  const home = tempHome();
  try {
    await withHome(home, async () => {
      clearModelGroupsCache();
      const controller = createManageModelGroupsController({ modelRegistry: registry() as never });

      const emptyName = await controller.createGroup({ name: "  ", mode: "fallback", quarantineMinutes: 5, models: [{ ref: "openai/gpt-a" }] });
      assert.equal(emptyName.ok, false);

      const badQuarantine = await controller.createGroup({ name: "A", mode: "fallback", quarantineMinutes: 0, models: [{ ref: "openai/gpt-a" }] });
      assert.equal(badQuarantine.ok, false);

      const badQuarantineHigh = await controller.createGroup({ name: "A", mode: "fallback", quarantineMinutes: 61, models: [{ ref: "openai/gpt-a" }] });
      assert.equal(badQuarantineHigh.ok, false);

      const noModels = await controller.createGroup({ name: "A", mode: "fallback", quarantineMinutes: 5, models: [] });
      assert.equal(noModels.ok, false);

      const badRef = await controller.createGroup({ name: "A", mode: "fallback", quarantineMinutes: 5, models: [{ ref: "noslash" }] });
      assert.equal(badRef.ok, false);

      const badMode = await controller.createGroup({ name: "A", mode: "rotating" as never, quarantineMinutes: 5, models: [{ ref: "openai/gpt-a" }] });
      assert.equal(badMode.ok, false);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("controller update changes mode/quarantine/models and preserves the id", async () => {
  const home = tempHome();
  try {
    await withHome(home, async () => {
      clearModelGroupsCache();
      const controller = createManageModelGroupsController({ modelRegistry: registry() as never });

      const created = await controller.createGroup({ name: "RR", mode: "fallback", quarantineMinutes: 5, models: [{ ref: "openai/gpt-a" }] });
      assert.equal(created.ok, true);
      const id = (await controller.listGroups())[0]!.id;

      const updated = await controller.updateGroup(id, {
        name: "RR",
        mode: "round-robin",
        quarantineMinutes: 15,
        models: [{ ref: "openai/gpt-a", thinking: "off" }, { ref: "openai/gpt-b" }],
      });
      assert.equal(updated.ok, true);
      const group = (await controller.listGroups())[0]!;
      assert.equal(group.id, id, "update keeps the group id");
      assert.equal(group.mode, "round-robin");
      assert.equal(group.quarantineMinutes, 15);
      assert.equal(group.models.length, 2);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("listThinkingLevels follows supportedThinkingLevels for reasoning models", async () => {
  const home = tempHome();
  try {
    await withHome(home, async () => {
      clearModelGroupsCache();
      const controller = createManageModelGroupsController({ modelRegistry: registry() as never });
      const levels = await controller.listThinkingLevels("openai/gpt-a");
      assert.ok(levels.some((level) => level.level === "off"));
      assert.ok(levels.some((level) => level.level === "high"));
      const nonReasoning = await controller.listThinkingLevels("openai/gpt-b");
      assert.deepEqual(nonReasoning, [{ level: "off", label: "off" }]);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("quarantined members show a remaining timer in the group list", async () => {
  const home = tempHome();
  try {
    await withHome(home, async () => {
      clearModelGroupsCache();
      clearQuarantine();
      const controller = createManageModelGroupsController({ modelRegistry: registry() as never });
      await controller.createGroup({ name: "Work", mode: "fallback", quarantineMinutes: 5, models: [{ ref: "openai/gpt-a" }, { ref: "openai/gpt-b" }] });
      quarantineModel("openai/gpt-a", 5);
      const listed = await controller.listGroups();
      const models = listed[0]!.models;
      assert.ok(models[0]!.quarantinedForMs !== undefined && models[0]!.quarantinedForMs > 0);
      assert.equal(models[1]!.quarantinedForMs, undefined);
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});