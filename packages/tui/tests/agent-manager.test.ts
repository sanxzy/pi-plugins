import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { TUI } from "@earendil-works/pi-tui";
import { AgentManager, type ManagerRow, type ManagerView } from "../src/agent-manager.ts";
import { textTheme } from "./test-theme.ts";

function fakeTUI(rows = 24): TUI {
  return {
    terminal: { rows },
    requestRender: () => {},
  } as unknown as TUI;
}

function raw(key: "up" | "down" | "left"): string {
  const suffix = key === "up" ? "A" : key === "down" ? "B" : "D";
  return `[1;5${suffix}`;
}

const TOGGLE_SHORTCUT = "[97;6u"; // Ctrl+Shift+A (kitty keyboard protocol)

function row(
  rowId: string,
  status: ManagerRow["status"],
  depth: number,
  overrides: Partial<ManagerRow> = {},
): ManagerRow {
  return {
    rowId,
    sessionId: rowId,
    status,
    description: rowId,
    durationMs: 0,
    depth,
    enterable: false,
    ...overrides,
  };
}

const ROWS: ManagerRow[] = [
  row("current", "active", 0, { description: "Current session" }),
  row("running", "running", 1, { enterable: true, description: "Implement feature" }),
  row("queued", "queued", 2, { description: "Waiting for a slot" }),
  row("done", "completed", 1, { description: "Finished work", durationMs: 125000 }),
  row("failed", "failed", 1),
  row("cancelled", "cancelled", 1),
  row("interrupted", "interrupted", 1),
];

function render(manager: AgentManager, width = 100): string[] {
  return manager.render(width).map(stripVTControlCharacters);
}

test("renders the scoped tree with status legend, connectors, description, and duration", () => {
  const manager = new AgentManager({
    tui: fakeTUI(),
    theme: textTheme,
    view: { scopeSessionId: "root", rows: ROWS },
    done: () => {},
  });

  const lines = render(manager);
  const output = lines.join("\n");
  assert.match(output, /Current session/);
  assert.match(output, /├─|└─/, "tree branch connectors are rendered");
  assert.match(output, /Implement feature/);
  assert.match(output, /Finished work.*2m 5s/);
  assert.match(output, /◯/, "open-circle status is rendered");
  assert.match(output, /●/, "filled status indicators are rendered");
  assert.match(output, /Enter.*view|Escape.*close/, "manager help is rendered");
  for (const line of lines) {
    assert.ok(line.length <= 100, `line fits width: ${line}`);
  }
});

test("Ctrl+Up and Ctrl+Down move across the complete flattened tree", () => {
  const manager = new AgentManager({
    tui: fakeTUI(),
    theme: textTheme,
    view: { scopeSessionId: "root", rows: ROWS },
    done: () => {},
  });

  assert.equal(manager.selectedRow()?.rowId, "current");
  manager.handleInput(raw("down"));
  manager.handleInput(raw("down"));
  assert.equal(manager.selectedRow()?.rowId, "queued", "cursor enters a nested branch");
  manager.handleInput(raw("up"));
  assert.equal(manager.selectedRow()?.rowId, "running");
});

test("Enter requests entry only for enterable running children", () => {
  const entered: string[] = [];
  const manager = new AgentManager({
    tui: fakeTUI(),
    theme: textTheme,
    view: { scopeSessionId: "root", rows: ROWS },
    done: () => {},
    onEnter: (selected) => entered.push(selected.rowId),
  });

  manager.handleInput("\r");
  assert.deepEqual(entered, [], "active session cannot be entered");
  assert.match(render(manager).join("\n"), /not enterable/i);

  manager.handleInput(raw("down"));
  manager.handleInput("\r");
  assert.deepEqual(entered, ["running"]);

  manager.handleInput(raw("down"));
  manager.handleInput("\r");
  assert.deepEqual(entered, ["running"], "queued child is rejected");
  assert.match(render(manager).join("\n"), /not enterable/i);
});

test("Ctrl+Shift+A closes the manager overlay", () => {
  const reasons: string[] = [];
  const manager = new AgentManager({
    tui: fakeTUI(),
    theme: textTheme,
    view: { scopeSessionId: "root", rows: ROWS },
    done: (reason) => reasons.push(reason),
  });

  manager.handleInput(TOGGLE_SHORTCUT);
  manager.handleInput(TOGGLE_SHORTCUT);
  assert.deepEqual(reasons, ["shortcut"]);
});


test("child entry pushes a view onto the return stack", () => {
  const child: ManagerView = {
    scopeSessionId: "running",
    rows: [row("nested", "running", 0, { enterable: true })],
  };
  let entered: ManagerRow | undefined;
  const manager = new AgentManager({
    tui: fakeTUI(),
    theme: textTheme,
    view: { scopeSessionId: "root", rows: ROWS },
    done: () => {},
    onEnter: (selected) => {
      entered = selected;
      manager.pushView(child);
    },
  });

  manager.handleInput(raw("down"));
  manager.handleInput("\r");
  assert.equal(entered?.rowId, "running");
  assert.equal(manager.currentView().scopeSessionId, "running");
  assert.equal(manager.returnDepth(), 1);
});

test("Ctrl+Left unwinds nested views as a return stack, then closes at the top", () => {
  let closed = 0;
  const parent: ManagerView = { scopeSessionId: "root", rows: ROWS };
  const child: ManagerView = {
    scopeSessionId: "running",
    rows: [row("nested-view", "active", 0, { description: "Child view" })],
  };
  const grandchild: ManagerView = {
    scopeSessionId: "nested-view",
    rows: [row("leaf-view", "active", 0, { description: "Nested child view" })],
  };
  const manager = new AgentManager({
    tui: fakeTUI(),
    theme: textTheme,
    view: parent,
    done: () => {
      closed++;
    },
  });

  manager.pushView(child);
  manager.pushView(grandchild);
  assert.equal(manager.returnDepth(), 2);
  manager.handleInput(raw("left"));
  assert.equal(manager.currentView().scopeSessionId, "running");
  assert.equal(manager.returnDepth(), 1);
  manager.handleInput(raw("left"));
  assert.equal(manager.currentView().scopeSessionId, "root");
  assert.equal(manager.returnDepth(), 0);
  manager.handleInput(raw("left"));
  assert.equal(closed, 1, "top-level Ctrl+Left closes the manager");
});

test("Escape and the manager shortcut close exactly once", () => {
  let closed = 0;
  const manager = new AgentManager({
    tui: fakeTUI(),
    theme: textTheme,
    view: { scopeSessionId: "root", rows: ROWS },
    done: () => {
      closed++;
    },
  });

  manager.handleInput("");
  manager.handleInput("");
  assert.equal(closed, 1);
});

test("component exposes the active view and requests re-render after navigation", () => {
  let renders = 0;
  const manager = new AgentManager({
    tui: {
      terminal: { rows: 24 },
      requestRender: () => renders++,
    } as unknown as TUI,
    theme: textTheme,
    view: { scopeSessionId: "root", rows: ROWS },
    done: () => {},
  });
  manager.handleInput(raw("down"));
  assert.ok(renders > 0);
  assert.equal(manager.currentView().scopeSessionId, "root");
});
