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
  return key === "up" ? "[A" : key === "down" ? "[B" : "[D";
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
  manager.handleInput(raw("down"));
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
  // Live view uses the same bordered chrome as the tree view.
  assert.match(output, /╭/, "top-left border");
  assert.match(output, /Child Session/, "child title label");
  assert.match(output, /Activity|Transcript/, "transcript section label");
  assert.match(output, /Type to steer|Enter to send/, "live input legend");
  assert.match(output, /╯/, "bottom-right border");
});

test("tool-call parameters are rendered under the tool name", () => {
  const manager = new AgentManager({
    tui: fakeTUI(),
    theme: textTheme,
    view: { scopeSessionId: "root", rows: ROWS },
    done: () => {},
    onEnter: (selected) =>
      manager.pushLiveView({
        sessionId: selected.sessionId,
        description: selected.description,
        live: {
          snapshot: {
            status: "running" as const,
            settled: false,
            transcript: [
              {
                id: "t1",
                kind: "tool" as const,
                toolCallId: "call-1",
                toolName: "bash" as const,
                args: { command: "ls -la", cwd: "/repo" },
                text: "",
                complete: false,
                isError: false,
              },
            ],
          },
          steer: async () => {},
          subscribe: () => () => {},
        },
      }),
  });
  manager.handleInput(raw("down"));
  manager.handleInput("\r");

  const output = render(manager).join("\n");
  assert.match(output, /⌘ bash/, "tool name header remains");
  assert.match(output, /command: ls -la/, "tool arg key/value line is rendered");
  assert.match(output, /cwd: \/repo/, "second tool arg line is rendered");
});

test("a long transcript is scrollable: tail by default, earlier lines reachable by scrolling", () => {
  const longTranscript = Array.from({ length: 30 }, (_, index) => ({
    id: `m${index}`,
    kind: "message" as const,
    role: "assistant" as const,
    text: `message line ${index}`,
    complete: true,
  }));
  const manager = new AgentManager({
    tui: fakeTUI(12),
    theme: textTheme,
    view: { scopeSessionId: "root", rows: ROWS },
    done: () => {},
    onEnter: (selected) =>
      manager.pushLiveView({
        sessionId: selected.sessionId,
        description: "child",
        live: {
          snapshot: { status: "running" as const, settled: false, transcript: longTranscript },
          steer: async () => {},
          subscribe: () => () => {},
        },
      }),
  });
  manager.handleInput(raw("down"));
  manager.handleInput("\r");

  // Tail is shown by default: the last message is visible, the first is not.
  let output = render(manager).join("\n");
  assert.match(output, /message line 29/, "tail message is visible by default");
  assert.doesNotMatch(output, /message line 0/, "oldest message is off-screen initially");

  // Scroll up to the top: the oldest message becomes visible.
  manager.handleInput("[6~"); // PageUp
  output = render(manager).join("\n");
  assert.match(output, /message line 0/, "scrolling up reveals the oldest message");
  assert.match(output, /↑ scroll/, "scroll indicator appears while scrolled");
  assert.doesNotMatch(output, /message line 29/, "tail is off-screen at the top");

  // Home returns to the tail.
  manager.handleInput("[H"); // Home
  output = render(manager).join("\n");
  assert.match(output, /message line 29/, "Home returns to the tail");
  assert.doesNotMatch(output, /↑ scroll/, "no scroll indicator at the tail");

  // End jumps to the top again.
  manager.handleInput("[F"); // End
  output = render(manager).join("\n");
  assert.match(output, /message line 0/, "End jumps to the oldest message");
});

test("scrolling keys do not type into the steer draft and steering still works after scrolling", () => {
  const steers: string[] = [];
  const longTranscript = Array.from({ length: 20 }, (_, index) => ({
    id: `m${index}`,
    kind: "message" as const,
    role: "assistant" as const,
    text: `message line ${index}`,
    complete: true,
  }));
  const manager = new AgentManager({
    tui: fakeTUI(10),
    theme: textTheme,
    view: { scopeSessionId: "root", rows: ROWS },
    done: () => {},
    onEnter: (selected) =>
      manager.pushLiveView({
        sessionId: selected.sessionId,
        description: "child",
        live: {
          snapshot: { status: "running" as const, settled: false, transcript: longTranscript },
          steer: async (prompt: string): Promise<void> => {
            steers.push(prompt);
          },
          subscribe: () => () => {},
        },
      }),
  });
  manager.handleInput(raw("down"));
  manager.handleInput("\r");

  manager.handleInput("[6~"); // PageUp — scroll, not draft text
  manager.handleInput("h");
  manager.handleInput("i");
  manager.handleInput("\r");
  manager.handleInput("[5~"); // PageDown after steering
  return new Promise<void>((resolve) => {
    setImmediate(() => {
      assert.deepEqual(steers, ["hi"], "PageUp/PageDown never enter the draft; typed text still steers");
      resolve();
    });
  });
});

test("a live child with no activity renders an intentional empty state and status legend", () => {
  const manager = new AgentManager({
    tui: fakeTUI(),
    theme: textTheme,
    view: { scopeSessionId: "root", rows: ROWS },
    done: () => {},
    onEnter: (selected) =>
      manager.pushLiveView({
        sessionId: selected.sessionId,
        description: selected.description,
        live: {
          snapshot: { status: "running" as const, settled: false, transcript: [] },
          steer: async () => {},
          subscribe: () => () => {},
        },
      }),
  });
  manager.handleInput(raw("down"));
  manager.handleInput("\r");

  const output = render(manager).join("\n");
  assert.match(output, /No activity yet\./, "empty transcript message");
  assert.match(output, /Child Session/, "child title remains visible");
  assert.match(output, /running/, "running status remains visible");
  assert.match(output, /Esc close/, "close hint remains visible");
});

test("a settled live child renders a terminal status and disabled-input legend", () => {
  const manager = new AgentManager({
    tui: fakeTUI(),
    theme: textTheme,
    view: { scopeSessionId: "root", rows: ROWS },
    done: () => {},
    onEnter: (selected) =>
      manager.pushLiveView({
        sessionId: selected.sessionId,
        description: selected.description,
        live: {
          snapshot: {
            status: "failed" as const,
            settled: true,
            transcript: [{ id: "m1", kind: "message" as const, role: "assistant" as const, text: "failed", complete: true }],
          },
          steer: async () => {},
          subscribe: () => () => {},
        },
      }),
  });
  manager.handleInput(raw("down"));
  manager.handleInput("\r");

  const output = render(manager).join("\n");
  assert.match(output, /Child Session/, "child title remains visible");
  assert.match(output, /✗ failed/, "terminal status icon and label");
  assert.match(output, /failed/, "final transcript remains visible");
  assert.match(output, /read-only/, "input is described as disabled");
  assert.match(output, /← back.*Esc close/, "back/close hints remain");
});

test("entering and leaving the child view never touches the parent session", () => {
  let parentInputs = 0;
  const live = {
    snapshot: { status: "running" as const, settled: false, transcript: [] },
    steer: async (_prompt: string): Promise<void> => {
      parentInputs++;
    },
    subscribe: (_listener: () => void) => () => {},
  };
  const manager = new AgentManager({
    tui: fakeTUI(),
    theme: textTheme,
    view: { scopeSessionId: "root", rows: ROWS },
    done: () => {},
    onEnter: (selected) =>
      manager.pushLiveView({
        sessionId: selected.sessionId,
        rowId: selected.rowId,
        description: selected.description,
        live,
      }),
  });
  // Enter the child, type a steering prompt, and leave: the only seam that
  // receives input is the child's steer relay, never a parent composer or
  // session API.
  manager.handleInput(raw("down"));
  manager.handleInput("\r");
  manager.handleInput("n");
  manager.handleInput("o");
  manager.handleInput("\r");
  manager.handleInput(raw("left"));
  assert.equal(parentInputs, 1, "the child's steer seam was the only input destination");
  assert.equal(manager.currentView().scopeSessionId, "root");
});

test("steering input reaches only the live child and settlement disables further input", async () => {
  const steers: string[] = [];
  let emit: (() => void) | undefined;
  const live = {
    snapshot: { status: "running" as const, settled: false, transcript: [] },
    steer: async (prompt: string): Promise<void> => {
      steers.push(prompt);
    },
    subscribe: (listener: () => void) => {
      emit = listener;
      return () => {};
    },
  };
  const manager = new AgentManager({
    tui: fakeTUI(),
    theme: textTheme,
    view: { scopeSessionId: "root", rows: ROWS },
    done: () => {},
    onEnter: (selected) => manager.pushLiveView({ sessionId: selected.sessionId, description: selected.description, live }),
  });
  manager.handleInput(raw("down"));
  manager.handleInput("\r");
  manager.handleInput("s");
  manager.handleInput("t");
  manager.handleInput("e");
  manager.handleInput("e");
  manager.handleInput("r");
  manager.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(steers, ["steer"]);

  (live.snapshot as unknown as { status: "failed"; settled: true }).status = "failed";
  (live.snapshot as unknown as { status: "failed"; settled: true }).settled = true;
  emit?.();
  manager.handleInput("x");
  manager.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(steers, ["steer"], "settled views accept no further steering");
});

test("plain Left returns to the exact prior tree selection after live view", () => {
  const live = {
    snapshot: { status: "running" as const, settled: false, transcript: [] },
    steer: async () => {},
    subscribe: (_listener: () => void) => () => {},
  };
  const manager = new AgentManager({
    tui: fakeTUI(),
    theme: textTheme,
    view: { scopeSessionId: "root", rows: ROWS },
    done: () => {},
    onEnter: (selected) => manager.pushLiveView({ sessionId: selected.sessionId, rowId: selected.rowId, description: selected.description, live }),
  });
  manager.handleInput(raw("down"));
  manager.handleInput("\r");
  manager.handleInput(raw("left"));
  assert.equal(manager.currentView().scopeSessionId, "root");
  assert.equal(manager.selectedRow()?.rowId, "running");
});

test("component disposal unsubscribes without aborting or closing the child", () => {
  let unsubscribed = 0;
  let aborted = 0;
  let closed = 0;
  const live = {
    snapshot: { status: "running" as const, settled: false, transcript: [] },
    steer: async () => {},
    abort: () => {
      aborted++;
    },
    subscribe: (_listener: () => void) => () => {
      unsubscribed++;
    },
  };
  const manager = new AgentManager({
    tui: fakeTUI(),
    theme: textTheme,
    view: { scopeSessionId: "root", rows: ROWS },
    done: () => {
      closed++;
    },
    onEnter: (selected) => manager.pushLiveView({ sessionId: selected.sessionId, rowId: selected.rowId, description: selected.description, live }),
  });
  manager.handleInput(raw("down"));
  manager.handleInput("\r");
  manager.dispose();
  manager.dispose();
  // The manager only exposes the steer seam; component disposal must never
  // invoke the child abort relay that the cancellation/steering seams use.
  assert.equal(aborted, 0, "dispose never aborts the child");
  assert.equal(unsubscribed, 1, "dispose is idempotent");
  assert.equal(closed, 0, "dispose does not invoke the modal done callback");
});

test("settled child becomes terminal and non-enterable when returning to the tree", () => {
  let emit: (() => void) | undefined;
  const live = {
    snapshot: { status: "running" as const, settled: false, transcript: [] },
    steer: async () => {},
    subscribe: (listener: () => void) => {
      emit = listener;
      return () => {};
    },
  };
  const manager = new AgentManager({
    tui: fakeTUI(),
    theme: textTheme,
    view: { scopeSessionId: "root", rows: ROWS },
    done: () => {},
    onEnter: (selected) => manager.pushLiveView({ sessionId: selected.sessionId, rowId: selected.rowId, description: selected.description, live }),
  });
  manager.handleInput(raw("down"));
  manager.handleInput("\r");
  (live.snapshot as unknown as { status: "completed"; settled: true }).status = "completed";
  (live.snapshot as unknown as { status: "completed"; settled: true }).settled = true;
  emit?.();
  manager.handleInput(raw("left"));
  const row = manager.selectedRow();
  assert.equal(row?.rowId, "running");
  assert.equal(row?.status, "completed");
  assert.equal(row?.enterable, false);
  manager.handleInput("\r");
  assert.match(render(manager).join("\n"), /not enterable/i);
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
  assert.ok(lines.length <= 4, `viewport never renders more lines than fit: ${lines.length}`);
  assert.equal(live.snapshot.transcript.length, 2, "the retained snapshot is never truncated");
});
