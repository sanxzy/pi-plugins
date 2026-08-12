import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { TUI } from "@earendil-works/pi-tui";
import {
  ReferencesSetupWizard,
  type ReferencesSetupController,
  type ReferencesSetupResult,
} from "../src/references-setup-wizard.ts";

function tui(): TUI {
  return { terminal: { rows: 24 }, requestRender: () => {} } as unknown as TUI;
}

const theme = { fg: (_color: string, text: string) => text };

function controller(overrides: Partial<ReferencesSetupController> = {}): ReferencesSetupController {
  return {
    list: async () => ({ items: [] }),
    addLocal: async () => ({ ok: true, message: "Reference saved." }),
    updateLocal: async () => ({ ok: true, message: "Reference saved." }),
    remove: async () => ({ ok: true, message: "Reference removed." }),
    cancel: async () => {
      await undefined;
    },
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function lines(component: { render(width: number): string[] }): string[] {
  return stripVTControlCharacters(component.render(60).join("\n")).split("\n");
}

function resultPromise(): { promise: Promise<ReferencesSetupResult>; resolve: (result: ReferencesSetupResult) => void } {
  let resolve!: (result: ReferencesSetupResult) => void;
  const promise = new Promise<ReferencesSetupResult>((next) => { resolve = next; });
  return { promise, resolve };
}

test("renders the local reference action menu and add flow", async () => {
  const ctl = controller();
  const result = resultPromise();
  const wizard = new ReferencesSetupWizard({ tui: tui(), theme, controller: ctl, done: result.resolve });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(lines(wizard).some((line) => line.includes("References setup")));
  assert.ok(lines(wizard).some((line) => line.includes("Add local reference")));
  wizard.handleInput("\r");
  assert.ok(lines(wizard).some((line) => line.includes("Reference alias")));
  void result.promise;
});

test("invalid local save remains in the wizard and successful save returns to menu", async () => {
  const responses = [{ ok: false as const, message: "Local path is unavailable" }, { ok: true as const, message: "Saved" }];
  const ctl = controller({ addLocal: async () => responses.shift()! });
  const wizard = new ReferencesSetupWizard({ tui: tui(), theme, controller: ctl, done: () => {} });
  await new Promise<void>((resolve) => setImmediate(resolve));
  wizard.handleInput("\r");
  // Alias, path, description, hidden fields are submitted sequentially.
  for (const value of ["docs", "/tmp/docs", "Local docs", "n"]) {
    for (const char of value) wizard.handleInput(char);
    wizard.handleInput("\r");
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(lines(wizard).some((line) => line.includes("Local path is unavailable")));
  wizard.handleInput("\r"); // retry
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(lines(wizard).some((line) => line.includes("Reference alias")));
});

test("Escape cancels from every step and abort settles once", async () => {
  const result = resultPromise();
  const cancelled: string[] = [];
  const wizard = new ReferencesSetupWizard({
    tui: tui(),
    theme,
    controller: controller({ cancel: async () => {
      cancelled.push("cancel");
    } }),
    done: result.resolve,
  });
  wizard.handleInput("\x1b");
  assert.deepEqual(await result.promise, { status: "cancelled" });
  assert.deepEqual(cancelled, ["cancel"]);
});

test("abort during a busy save settles once and passes the signal to the controller", async () => {
  const abort = new AbortController();
  let release!: (result: { ok: boolean; message: string }) => void;
  const pending = new Promise<{ ok: boolean; message: string }>((resolve) => { release = resolve; });
  let receivedSignal: AbortSignal | undefined;
  let doneCount = 0;
  const ctl = controller({
    addLocal: async (input) => {
      receivedSignal = input.signal;
      return pending;
    },
  });
  const wizard = new ReferencesSetupWizard({ tui: tui(), theme, controller: ctl, done: () => { doneCount++; }, signal: abort.signal });
  await flush();
  wizard.handleInput("\r");
  for (const char of "docs") wizard.handleInput(char);
  wizard.handleInput("\r");
  for (const char of "/tmp/docs") wizard.handleInput(char);
  wizard.handleInput("\r");
  wizard.handleInput("\r");
  wizard.handleInput("\r");
  assert.equal(receivedSignal, abort.signal);
  abort.abort();
  await flush();
  release({ ok: true, message: "Reference saved." });
  await flush();
  assert.equal(doneCount, 1);
});

test("narrow render stays safe", () => {
  const wizard = new ReferencesSetupWizard({ tui: tui(), theme, controller: controller(), done: () => {} });
  assert.ok(wizard.render(8).length > 0);
});

test("edit flow prefills raw values and submits updateLocal", async () => {
  const calls: Array<{ alias: string; input: unknown }> = [];
  const ctl = controller({
    list: async () => ({ items: [
      { name: "notes", label: "~/notes", local: { path: "~/notes" } },
      { name: "docs", label: "/tmp/docs", local: { path: "/tmp/docs", description: "Local docs", hidden: true } },
      { name: "react", label: "facebook/react" },
    ] }),
    updateLocal: async (alias, input) => {
      calls.push({ alias, input });
      return { ok: true, message: "Updated" };
    },
  });
  const wizard = new ReferencesSetupWizard({ tui: tui(), theme, controller: ctl, done: () => {} });
  await flush();
  wizard.handleInput("\x1b[B"); // down to Add Git
  wizard.handleInput("\x1b[B"); // down to Edit
  wizard.handleInput("\r"); // open edit selector
  assert.ok(lines(wizard).some((line) => line.includes("References setup · edit")));
  assert.ok(lines(wizard).some((line) => line.includes("docs — /tmp/docs")));
  wizard.handleInput("\x1b[B"); // select docs
  wizard.handleInput("\r");
  assert.ok(lines(wizard).some((line) => line.includes("Edit local reference · path")));
  assert.ok(lines(wizard).some((line) => line.includes("/tmp/docs"))); // prefilled raw path
  wizard.handleInput("\r"); // keep path
  assert.ok(lines(wizard).some((line) => line.includes("Edit local reference · description")));
  assert.ok(lines(wizard).some((line) => line.includes("Local docs"))); // prefilled raw description
  wizard.handleInput("\r"); // keep description
  assert.ok(lines(wizard).some((line) => line.includes("Edit local reference · hidden")));
  assert.ok(lines(wizard).some((line) => line.includes("Hide from discovery"))); // prefilled raw hidden
  wizard.handleInput("\r"); // Continue -> keep hidden, submit
  await flush();
  assert.deepEqual(calls, [{ alias: "docs", input: { path: "/tmp/docs", description: "Local docs" } }]);
  assert.ok(lines(wizard).some((line) => line.includes("Updated")));
  wizard.handleInput("\r"); // back to menu
  assert.ok(lines(wizard).some((line) => line.includes("References setup")));
});

test("failed update stays in wizard and retry succeeds through the edit form", async () => {
  const responses = [{ ok: false as const, message: "Locked by another process" }, { ok: true as const, message: "Saved" }];
  const ctl = controller({
    list: async () => ({ items: [{ name: "notes", label: "~/notes", local: { path: "~/notes" } }] }),
    updateLocal: async () => responses.shift()!,
  });
  const wizard = new ReferencesSetupWizard({ tui: tui(), theme, controller: ctl, done: () => {} });
  await flush();
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\r");
  wizard.handleInput("\r"); // edit notes (path step, prefilled ~/notes)
  wizard.handleInput("\r"); // description (empty)
  wizard.handleInput("\r"); // description -> hidden
  wizard.handleInput("\r"); // hidden -> submit, fails
  await flush();
  assert.ok(lines(wizard).some((line) => line.includes("Locked by another process")));
  wizard.handleInput("\r"); // retry -> path step prefilled
  assert.ok(lines(wizard).some((line) => line.includes("Edit local reference · path")));
  wizard.handleInput("\r");
  wizard.handleInput("\r");
  wizard.handleInput("\r"); // description -> hidden
  wizard.handleInput("\r"); // Continue -> submit, succeeds
  await flush();
  assert.ok(lines(wizard).some((line) => line.includes("Saved")));
});

test("Git add flow collects alias, repository, branch, metadata and submits addGit", async () => {
  const calls: unknown[] = [];
  const ctl = controller({
    addGit: async (input) => {
      calls.push(input);
      return { ok: true as const, message: "Git reference saved." };
    },
  });
  const wizard = new ReferencesSetupWizard({ tui: tui(), theme, controller: ctl, done: () => {} });
  await flush();
  wizard.handleInput("\x1b[B"); // down to Add Git reference
  wizard.handleInput("\r");
  assert.ok(lines(wizard).some((line) => line.includes("Add Git reference · alias")));
  for (const char of "react") wizard.handleInput(char);
  wizard.handleInput("\r");
  assert.ok(lines(wizard).some((line) => line.includes("Add Git reference · repository")));
  for (const char of "facebook/react") wizard.handleInput(char);
  wizard.handleInput("\r");
  assert.ok(lines(wizard).some((line) => line.includes("Add Git reference · branch")));
  for (const char of "main") wizard.handleInput(char);
  wizard.handleInput("\r");
  for (const char of "React source") wizard.handleInput(char);
  wizard.handleInput("\r");
  wizard.handleInput("\x1b[B"); // Hide
  wizard.handleInput("\r");
  await flush();
  assert.equal(calls.length, 1);
  assert.equal((calls[0] as { alias: string }).alias, "react");
  assert.equal((calls[0] as { repository: string }).repository, "facebook/react");
  assert.equal((calls[0] as { branch: string }).branch, "main");
  assert.equal((calls[0] as { description: string }).description, "React source");
  assert.equal((calls[0] as { hidden: boolean }).hidden, true);
  assert.ok(lines(wizard).some((line) => line.includes("Git reference saved.")));
});

test("Git edit prefills raw values and submits updateGit preserving metadata", async () => {
  const calls: Array<{ alias: string; input: unknown }> = [];
  const ctl = controller({
    list: async () => ({ items: [
      { name: "react", label: "facebook/react", git: { repository: "facebook/react", description: "React", hidden: true } },
    ] }),
    updateGit: async (alias, input) => {
      calls.push({ alias, input });
      return { ok: true as const, message: "Updated" };
    },
  });
  const wizard = new ReferencesSetupWizard({ tui: tui(), theme, controller: ctl, done: () => {} });
  await flush();
  wizard.handleInput("\x1b[B"); // Add Git
  wizard.handleInput("\x1b[B"); // Edit
  wizard.handleInput("\r"); // select-edit
  wizard.handleInput("\r"); // select react -> operation chooser (git)
  assert.ok(lines(wizard).some((line) => line.includes("References setup · react")));
  wizard.handleInput("\r"); // Edit
  assert.ok(lines(wizard).some((line) => line.includes("Edit Git reference · repository")));
  assert.ok(lines(wizard).some((line) => line.includes("facebook/react"))); // prefilled
  wizard.handleInput("\r"); // keep repo
  assert.ok(lines(wizard).some((line) => line.includes("Edit Git reference · branch")));
  wizard.handleInput("\r"); // keep empty branch
  assert.ok(lines(wizard).some((line) => line.includes("Edit Git reference · description")));
  assert.ok(lines(wizard).some((line) => line.includes("React"))); // prefilled
  wizard.handleInput("\r"); // keep description
  wizard.handleInput("\r"); // Continue -> hidden stays true (untouched)
  await flush();
  assert.deepEqual(calls, [{ alias: "react", input: { repository: "facebook/react", branch: "", description: "React" } }]);
  assert.ok(lines(wizard).some((line) => line.includes("Updated")));
});

test("Git edit sends an empty branch marker when clearing a stored branch", async () => {
  let submitted: { repository: string; branch?: string } | undefined;
  const ctl = controller({
    list: async () => ({ items: [{ name: "react", label: "facebook/react", git: { repository: "facebook/react", branch: "main" } }] }),
    updateGit: async (_alias, input) => {
      submitted = input;
      return { ok: true as const, message: "Branch cleared" };
    },
  });
  const wizard = new ReferencesSetupWizard({ tui: tui(), theme, controller: ctl, done: () => {} });
  await flush();
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\r");
  wizard.handleInput("\r"); // select Git entry -> operation chooser
  wizard.handleInput("\r"); // Edit
  wizard.handleInput("\r"); // keep repository
  // Clear the prefilled branch value and submit it as an explicit empty marker.
  for (let i = 0; i < "main".length; i++) wizard.handleInput("\x7f");
  wizard.handleInput("\r");
  wizard.handleInput("\r"); // empty description
  wizard.handleInput("\r"); // open hidden choices
  wizard.handleInput("\r"); // Continue
  await flush();
  assert.deepEqual(submitted, { repository: "facebook/react", branch: "" });
  assert.ok(lines(wizard).some((line) => line.includes("Branch cleared")));
});

test("Remove requires explicit confirmation and leaves the catalog unchanged on decline", async () => {
  const removed: string[] = [];
  const ctl = controller({
    list: async () => ({ items: [{ name: "docs", label: "/tmp/docs", local: { path: "/tmp/docs" } }] }),
    remove: async (alias) => {
      removed.push(alias);
      return { ok: true as const, message: "Reference removed." };
    },
  });
  const wizard = new ReferencesSetupWizard({ tui: tui(), theme, controller: ctl, done: () => {} });
  await flush();
  // Decline first: cancel must not call remove.
  wizard.handleInput("\x1b[B"); // Add Git
  wizard.handleInput("\x1b[B"); // Edit
  wizard.handleInput("\x1b[B"); // Remove
  wizard.handleInput("\r");
  assert.ok(lines(wizard).some((line) => line.includes("References setup · remove")));
  wizard.handleInput("\r"); // select docs
  assert.ok(lines(wizard).some((line) => line.includes("docs — /tmp/docs")));
  assert.ok(lines(wizard).some((line) => line.includes("Remove")));
  wizard.handleInput("\x1b[B"); // Cancel
  wizard.handleInput("\r");
  assert.deepEqual(removed, []);
  assert.ok(lines(wizard).some((line) => line.includes("References setup · remove")));
  // Confirm now: remove must run and return to the menu.
  wizard.handleInput("\r"); // select docs
  wizard.handleInput("\r"); // Remove
  await flush();
  assert.deepEqual(removed, ["docs"]);
  assert.ok(lines(wizard).some((line) => line.includes("Reference removed.")));
  wizard.handleInput("\r");
  assert.ok(lines(wizard).some((line) => line.includes("References setup")));
});

test("Test and Refresh actions run from the action menu", async () => {
  const testCalls: string[] = [];
  const refreshCalls: string[] = [];
  const ctl = controller({
    list: async () => ({ items: [{ name: "react", label: "facebook/react", git: { repository: "facebook/react" } }] }),
    testGit: async (alias) => {
      testCalls.push(alias);
      return { ok: true as const, message: "Reference available." };
    },
    refreshGit: async (alias) => {
      refreshCalls.push(alias);
      return { ok: true as const, message: "Reference refreshed." };
    },
  });
  const wizard = new ReferencesSetupWizard({ tui: tui(), theme, controller: ctl, done: () => {} });
  await flush();
  // Test action: Add Git, Edit, Remove, Test.
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\r");
  assert.ok(lines(wizard).some((line) => line.includes("References setup · test")));
  wizard.handleInput("\r");
  await flush();
  assert.deepEqual(testCalls, ["react"]);
  wizard.handleInput("\r"); // result -> menu
  // Refresh action: Add Git, Edit, Remove, Test, Refresh.
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\r");
  assert.ok(lines(wizard).some((line) => line.includes("References setup · refresh")));
  wizard.handleInput("\r");
  await flush();
  assert.deepEqual(refreshCalls, ["react"]);
});

test("Test and Refresh run observationally from the operation chooser", async () => {
  const testCalls: string[] = [];
  const refreshCalls: string[] = [];
  const ctl = controller({
    list: async () => ({ items: [
      { name: "react", label: "facebook/react", git: { repository: "facebook/react", branch: "main" } },
    ] }),
    testGit: async (alias) => {
      testCalls.push(alias);
      return { ok: true as const, message: "Reference available.", materialization: "cached", branch: "main" };
    },
    refreshGit: async (alias) => {
      refreshCalls.push(alias);
      return { ok: true as const, message: "Reference refreshed (cloned).", materialization: "cloned" };
    },
  });
  const wizard = new ReferencesSetupWizard({ tui: tui(), theme, controller: ctl, done: () => {} });
  await flush();
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\r");
  wizard.handleInput("\r"); // react -> operation chooser
  wizard.handleInput("\x1b[B"); // Test
  wizard.handleInput("\r");
  await flush();
  assert.deepEqual(testCalls, ["react"]);
  assert.ok(lines(wizard).some((line) => line.includes("Reference available.")));
  wizard.handleInput("\r"); // to menu
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\x1b[B");
  wizard.handleInput("\r");
  wizard.handleInput("\r");
  wizard.handleInput("\x1b[B"); // Test
  wizard.handleInput("\x1b[B"); // Refresh
  wizard.handleInput("\r");
  await flush();
  assert.deepEqual(refreshCalls, ["react"]);
  assert.ok(lines(wizard).some((line) => line.includes("Reference refreshed (cloned).")));
});

test("busy state renders while the local save is in flight", async () => {
  let release!: (result: { ok: boolean; message: string }) => void;
  const pending = new Promise<{ ok: boolean; message: string }>((resolve) => { release = resolve; });
  const ctl = controller({
    addLocal: async () => pending,
    list: async () => ({ items: [] }),
  });
  const wizard = new ReferencesSetupWizard({ tui: tui(), theme, controller: ctl, done: () => {} });
  await flush();
  wizard.handleInput("\r"); // alias
  for (const char of "docs") wizard.handleInput(char);
  wizard.handleInput("\r");
  for (const char of "/tmp/docs") wizard.handleInput(char);
  wizard.handleInput("\r");
  wizard.handleInput("\r"); // empty description
  wizard.handleInput("\r"); // hidden -> submit (pending)
  assert.ok(lines(wizard).some((line) => line.includes("Saving reference…")));
  release({ ok: true, message: "Reference saved." });
  await flush();
  assert.ok(lines(wizard).some((line) => line.includes("Reference saved.")));
});

test("duplicate alias failure reopens the alias editor prefilled for correction", async () => {
  const ctl = controller({
    addLocal: async () => ({ ok: false as const, message: "A reference with this alias already exists" }),
    list: async () => ({ items: [{ name: "docs", label: "/tmp/docs", local: { path: "/tmp/docs" } }] }),
  });
  const wizard = new ReferencesSetupWizard({ tui: tui(), theme, controller: ctl, done: () => {} });
  await flush();
  wizard.handleInput("\r"); // alias
  for (const char of "docs") wizard.handleInput(char);
  wizard.handleInput("\r");
  for (const char of "/tmp/docs") wizard.handleInput(char);
  wizard.handleInput("\r");
  wizard.handleInput("\r"); // empty description
  wizard.handleInput("\r"); // hidden -> submit, fails
  await flush();
  assert.ok(lines(wizard).some((line) => line.includes("A reference with this alias already exists")));
  wizard.handleInput("\r"); // reopen alias editor
  assert.ok(lines(wizard).some((line) => line.includes("Reference alias")));
  assert.ok(lines(wizard).some((line) => line.includes("docs"))); // prefilled previous alias
});
