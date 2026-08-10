import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { TUI } from "@earendil-works/pi-tui";
import {
  TelegramSetupWizard,
  type TelegramSetupWizardTheme,
  type TelegramSetupController,
  type TelegramSetupResult,
} from "../src/telegram-setup-wizard.ts";

function fakeTUI(rows = 24): TUI {
  return { terminal: { rows }, requestRender: () => {} } as unknown as TUI;
}

const theme: TelegramSetupWizardTheme = { fg: (_c, text) => text };

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

test("starts with the token availability question and numbered options", () => {
  const controller = makeController();
  const component = new TelegramSetupWizard({ tui: fakeTUI(), theme, controller, done: () => {} });
  const lines = dirty(component, 40);
  assert.ok(lines.some((l) => l.includes("Do you already have a bot token?")), "first question is shown");
  assert.ok(lines.some((l) => l.includes("1. Yes, I have one")), "option 1 is shown");
  assert.ok(lines.some((l) => l.includes("2. Not yet — how to create one?")), "option 2 is shown");
  assert.ok(lines.some((l) => l.includes("3. Cancel")), "option 3 is shown");
});

test("choosing 'Yes, I have one' opens the plain token entry step", () => {
  const controller = makeController({ token: "prefilled" });
  const component = new TelegramSetupWizard({ tui: fakeTUI(), theme, controller, done: () => {} });
  component.handleInput("\r");
  const lines = dirty(component, 40);
  assert.ok(lines.some((l) => l.includes("Bot token:")), "token prompt is shown");
  assert.ok(lines.some((l) => l.includes("prefilled")), "prefill from the controller is shown plainly (no masking)");
});

test("typed token is visible (no masking) and Enter submits it, settling as saved", async () => {
  const { promise, resolve } = collectResult();
  const controller = makeController();
  const component = new TelegramSetupWizard({ tui: fakeTUI(), theme, controller, done: resolve });
  component.handleInput("\r"); // Yes, I have one
  component.handleInput("s");
  component.handleInput("e");
  component.handleInput("c");
  component.handleInput("r");
  component.handleInput("e");
  component.handleInput("t");
  const lines = dirty(component, 40);
  assert.ok(lines.some((l) => l.includes("secret")), "token is visible while typing per design decision");
  component.handleInput("\r"); // submit
  await new Promise<void>((resolve2) => setImmediate(resolve2));
  component.handleInput("\x1b"); // Esc: finish setup (no pending pairing)
  const result = await promise;
  assert.deepEqual(result, { status: "saved", message: "ready" });
  assert.deepEqual(controller.submitted, ["secret"], "controller received the typed token");
});

test("'Not yet — how to create one?' shows BotFather instructions and returns to the start step", () => {
  const controller = makeController();
  const component = new TelegramSetupWizard({ tui: fakeTUI(), theme, controller, done: () => {} });
  component.handleInput("\x1b[B"); // down
  component.handleInput("\r"); // Not yet — how to create one?
  const lines = dirty(component, 40);
  assert.ok(lines.some((l) => l.includes("BotFather")), "BotFather instructions are shown");
  component.handleInput("\r"); // Back
  assert.ok(dirty(component, 40).some((l) => l.includes("Do you already have a bot token?")), "returns to the start step");
});

test("a failed submission shows the error with 'Try again' and 'Cancel' options", async () => {
  const { promise, resolve } = collectResult();
  const controller = makeController({ result: { ok: false, message: "bad token" } });
  const component = new TelegramSetupWizard({ tui: fakeTUI(), theme, controller, done: resolve });
  component.handleInput("\r"); // Yes, I have one
  component.handleInput("bad");
  component.handleInput("\r"); // submit
  await new Promise<void>((resolve2) => setImmediate(resolve2));
  const lines = dirty(component, 40);
  assert.ok(lines.some((l) => l.includes("bad token")), "error message is shown");
  assert.ok(lines.some((l) => l.includes("Try again")), "retry option is shown");
  assert.ok(lines.some((l) => l.includes("Cancel")), "cancel option is shown");
  void promise;
});

test("'Try again' reopens the token step with a clean editor", async () => {
  const controller = makeController({ result: { ok: false, message: "bad" } });
  const component = new TelegramSetupWizard({ tui: fakeTUI(), theme, controller, done: () => {} });
  component.handleInput("\r"); // Yes, I have one
  component.handleInput("bad");
  component.handleInput("\r"); // submit
  await new Promise<void>((resolve2) => setImmediate(resolve2));
  component.handleInput("\r"); // Try again
  assert.ok(dirty(component, 40).some((l) => l.includes("Bot token:")), "token step is reopened");
});

test("Escape at the start cancels and resolves as cancelled", async () => {
  const { promise, resolve } = collectResult();
  const controller = makeController();
  const component = new TelegramSetupWizard({ tui: fakeTUI(), theme, controller, done: resolve });
  component.handleInput("\x1b"); // escape
  const result = await promise;
  assert.deepEqual(result, { status: "cancelled" });
  assert.equal(controller.cancelled, 1, "controller cancel is invoked");
});

test("an aborted signal resolves as cancelled", async () => {
  const { promise, resolve } = collectResult();
  const controller = makeController();
  const controller2 = new AbortController();
  const component = new TelegramSetupWizard({
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

test("pending pairings open the approval step automatically after saving, and approving settles as saved", async () => {
  const approvals: number[] = [];
  const controller = makeController();
  controller.listPendingPairings = () => [
    { id: 1, userId: "111", code: "ABCD2345", createdAt: "t", expiresAt: "t" },
  ];
  controller.approvePairing = (id) => {
    approvals.push(id);
    controller.listPendingPairings = () => [];
    return { ok: true, message: "Approved." };
  };
  const { promise, resolve } = collectResult();
  const component = new TelegramSetupWizard({ tui: fakeTUI(), theme, controller, done: resolve });

  component.handleInput("\r"); // Yes, I have one
  component.handleInput("\r"); // submit empty token
  await new Promise<void>((resolve2) => setImmediate(resolve2));
  let lines = dirty(component, 40);
  assert.ok(lines.some((l) => l.includes("111")), "pending request is shown directly after saving (no extra step)");

  component.handleInput("\r"); // approve the selected request
  assert.deepEqual(approvals, [1], "the selected pairing is approved");
  component.handleInput("\r"); // Done
  const result = await promise;
  assert.deepEqual(result, { status: "saved", message: "Approved." }, "approval result settles the wizard as saved");
});

test("remains usable at a narrow width", () => {
  const controller = makeController();
  const component = new TelegramSetupWizard({ tui: fakeTUI(), theme, controller, done: () => {} });
  const lines = component.render(8); // very narrow
  for (const line of lines) {
    assert.ok(line.length >= 0, "lines are produced at narrow widths");
  }
  assert.ok(lines.length > 0, "a narrow render still produces content");
});
