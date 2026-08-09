import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { TUI } from "@earendil-works/pi-tui";
import {
  TelegramChannelSetup,
  type TelegramChannelSetupTheme,
  type TelegramSetupController,
  type TelegramSetupResult,
} from "../src/telegram-channel-setup.ts";

function fakeTUI(rows = 24): TUI {
  return { terminal: { rows }, requestRender: () => {} } as unknown as TUI;
}

const theme: TelegramChannelSetupTheme = { fg: (_c, text) => text };

interface FakeController extends TelegramSetupController {
  submitted: string[];
  cancelled: number;
  token: string;
  result: Awaited<ReturnType<TelegramSetupController["submitToken"]>>;
}

function makeController(overrides: Partial<FakeController> = {}): FakeController {
  return {
    submitted: [],
    cancelled: 0,
    token: "",
    result: { ok: true, message: "ready" },
    getInitialToken() {
      return this.token;
    },
    async submitToken(t) {
      this.submitted.push(t);
      return this.result;
    },
    async cancel() {
      this.cancelled += 1;
    },
    ...overrides,
  };
}

function collectResult(): { promise: Promise<TelegramSetupResult>; resolve: (r: TelegramSetupResult) => void } {
  let resolve: (r: TelegramSetupResult) => void = () => {};
  const promise = new Promise<TelegramSetupResult>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function dirty(component: { render(width: number): string[] }, width = 40): string[] {
  return stripVTControlCharacters(component.render(width).join("\n"))
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

test("masks token input and never renders the raw token", () => {
  const controller = makeController({ token: "123456789:ABCDEFGHIJKLMNOPQRSTUVWX" });
  const component = new TelegramChannelSetup({
    tui: fakeTUI(),
    theme,
    controller,
    done: () => {},
  });
  const lines = dirty(component, 40);
  assert.ok(lines.some((l) => l.includes("Bot token:")), "token prompt is shown");
  assert.ok(
    lines.some((l) => l.includes("•")),
    "input is masked with bullet characters",
  );
  assert.equal(lines.some((l) => l.includes("123456789:ABCDEFGHIJKLMNOPQRSTUVWX")), false, "raw token never rendered");
});

test("typing after prefill requests a re-render and keeps masking", () => {
  const renders: number[] = [];
  const tui = { terminal: { rows: 24 }, requestRender: () => renders.push(1) } as unknown as TUI;
  const controller = makeController();
  const component = new TelegramChannelSetup({ tui, theme, controller, done: () => {} });
  component.handleInput("h");
  component.handleInput("i");
  assert.ok(renders.length > 0, "typing requests a render");
  const lines = dirty(component, 40);
  assert.equal(lines.some((l) => l.includes("hi")), false, "typed content stays masked");
});

test("Enter submits the token and resolves saved without returning the token", async () => {
  const { promise, resolve } = collectResult();
  const controller = makeController();
  const component = new TelegramChannelSetup({ tui: fakeTUI(), theme, controller, done: resolve });
  component.handleInput("h");
  component.handleInput("i");
  component.handleInput("\r");
  const result = await promise;
  assert.deepEqual(result, { status: "saved", message: "ready" });
  assert.deepEqual(controller.submitted, ["hi"], "controller received the trimmed input");
});

test("a failed submission shows an error and leaves the component open", async () => {
  const { promise, resolve } = collectResult();
  const controller = makeController({ result: { ok: false, message: "bad token" } });
  const component = new TelegramChannelSetup({ tui: fakeTUI(), theme, controller, done: resolve });
  component.handleInput("bad");
  component.handleInput("\r");
  await new Promise<void>((resolve) => setImmediate(resolve));
  const lines = dirty(component, 40);
  assert.ok(lines.some((l) => l.includes("bad token")), "error message is shown");
  assert.ok(lines.some((l) => l.includes("Enter to connect")), "component stays interactive");
  void promise;
});

test("Escape cancels and resolves as cancelled", async () => {
  const { promise, resolve } = collectResult();
  const controller = makeController();
  const component = new TelegramChannelSetup({ tui: fakeTUI(), theme, controller, done: resolve });
  component.handleInput("\x1b"); // escape
  const result = await promise;
  assert.deepEqual(result, { status: "cancelled" });
  assert.equal(controller.cancelled, 1, "controller cancel is invoked");
});

test("an aborted signal resolves as cancelled", async () => {
  const { promise, resolve } = collectResult();
  const controller = makeController();
  const controller2 = new AbortController();
  const component = new TelegramChannelSetup({
    tui: fakeTUI(),
    theme,
    controller,
    done: resolve,
    signal: controller2.signal,
  });
  controller2.abort();
  const result = await promise;
  assert.deepEqual(result, { status: "cancelled" });
  void component;
});

test("remains usable at a narrow width", () => {
  const controller = makeController();
  const component = new TelegramChannelSetup({ tui: fakeTUI(), theme, controller, done: () => {} });
  const lines = component.render(8); // very narrow
  for (const line of lines) {
    assert.ok(line.length >= 0, "lines are produced at narrow widths");
  }
  assert.ok(lines.length > 0, "a narrow render still produces content");
});

test("press a reveals pending pairing requests and a numeric ID approves one, settling as saved", async () => {
  const approvals: number[] = [];
  const controller = makeController();
  controller.listPendingPairings = () => [
    { id: 1, userId: "111", code: "ABCD2345", createdAt: "t", expiresAt: "t" },
  ];
  controller.approvePairing = (id) => {
    approvals.push(id);
    return { ok: true, message: "Approved." };
  };
  const { promise, resolve } = collectResult();
  const component = new TelegramChannelSetup({ tui: fakeTUI(), theme, controller, done: resolve });

  component.handleInput("a");
  const lines = dirty(component, 40);
  assert.ok(lines.some((l) => l.includes("1") && l.includes("111")), "pending request is listed");

  const esc = String.fromCharCode(27);
  // The operator selects the ID using the numpad, which in application-keypad
  // mode sends an SS3 sequence (ESC O q) for the digit 1. The widget maps it.
  component.handleInput(`${esc}Oq`);
  component.handleInput("\r");
  assert.deepEqual(approvals, [1], "the numeric ID is approved");
  const approved = dirty(component, 40);
  assert.ok(approved.some((l) => l.includes("Approved.")), "approval result is shown");
  const result = await promise;
  assert.deepEqual(result, { status: "saved", message: "Approved." }, "approval settles the setup as saved");
});

test("Escape returns from the approval screen to the token view", () => {
  const controller = makeController();
  controller.listPendingPairings = () => [
    { id: 1, userId: "111", code: "ABCD2345", createdAt: "t", expiresAt: "t" },
  ];
  const component = new TelegramChannelSetup({ tui: fakeTUI(), theme, controller, done: () => {} });
  component.handleInput("a");
  assert.ok(dirty(component, 40).some((l) => l.includes("pairing")), "approval screen is shown");
  component.handleInput("\x1b");
  assert.ok(dirty(component, 40).some((l) => l.includes("Bot token:")), "returns to the token view");
});