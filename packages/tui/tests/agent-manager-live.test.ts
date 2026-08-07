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
  return key === "up" ? "[1;5A" : key === "down" ? "[1;5B" : "[1;5D";
}

const TOGGLE_SHORTCUT = "[97;6u";

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
];

function runningLive() {
  return {
    snapshot: {
      status: "running" as const,
      settled: false,
      transcript: [
        { id: "m1", kind: "message" as const, role: "assistant" as const, text: "thinking...", complete: false },
        { id: "t1", kind: "tool" as const, toolCallId: "call-1", toolName: "bash" as const, text: "", complete: false, isError: false },
      ],
    },
    steer: async () => {},
    subscribe: (listener: () => void) => {
      listener();
      return () => {};
    },
  };
}

function render(manager: AgentManager, width = 100): string[] {
  return manager.render(width).map(stripVTControlCharacters);
}

test("Entering a running child mounts the live transcript view and subscriptions are cleared on close", () => {
  let unsubscribed = 0;
  const live = {
    snapshot: { status: "running" as const, settled: false, transcript: [] },
    steer: async () => {},
    subscribe: (_listener: () => void) => () => {
      unsubscribed++;
    },
  };
  const manager = new AgentManager({
    tui: fakeTUI(),
    theme: textTheme,
    view: { scopeSessionId: "root", rows: ROWS },
    done: () => {},
    onEnter: (selected) => {
      manager.pushLiveView({
        sessionId: selected.sessionId,
        description: selected.description,
        live,
      });
    },
  });

  // Enter the running child, then close: the live subscription is released.
  manager.handleInput("[B");
  manager.handleInput("\r");
  manager.handleInput("");
  assert.ok(unsubscribed >= 1, "closing the manager unsubscribes from the live child feed");

  // Repeated close remains idempotent.
  manager.handleInput("");
  assert.equal(unsubscribed, 1);
});

test("the live child view renders transcript and status from the retained snapshot", () => {
  const manager = new AgentManager({
    tui: fakeTUI(),
    theme: textTheme,
    view: { scopeSessionId: "root", rows: ROWS },
    done: () => {},
    onEnter: (selected) =>
      manager.pushLiveView({
        sessionId: selected.sessionId,
        description: selected.description,
        live: runningLive(),
      }),
  });
  manager.handleInput(raw("down"));
  manager.handleInput("\r");

  const output = render(manager).join("\n");
  assert.match(output, /thinking\.\.\./, "assistant transcript text is rendered");
  assert.match(output, /bash/, "tool name is rendered");
  assert.match(output, /running/, "child status is rendered");
  assert.match(output, /Implement feature/, "session description is rendered");
});

test("viewport overflow: the whole transcript is retained even when only the tail is rendered", () => {
  const live = {
    snapshot: {
      status: "running" as const,
      settled: false,
      transcript: [
        { id: "m1", kind: "message" as const, role: "assistant" as const, text: "line one", complete: false },
        { id: "m2", kind: "message" as const, role: "assistant" as const, text: "line two", complete: false },
      ],
    },
    steer: async () => {},
    subscribe: (_listener: () => void) => () => {},
  };
  const manager = new AgentManager({
    tui: fakeTUI(4),
    theme: textTheme,
    view: { scopeSessionId: "root", rows: ROWS },
    done: () => {},
    onEnter: (selected) =>
      manager.pushLiveView({
        sessionId: selected.sessionId,
        description: "child",
        live,
      }),
  });
  manager.handleInput(raw("down"));
  manager.handleInput("\r");
  const lines = render(manager, 100);
  assert.ok(lines.length <= 4, "viewport never renders more lines than fit");
  assert.equal(live.snapshot.transcript.length, 2, "the retained snapshot is never truncated");
});
