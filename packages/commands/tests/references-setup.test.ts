import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { registerReferencesSetup } from "../src/registrations/references-setup-command.ts";
import { createReferencesSetupController } from "../src/registrations/references-setup.ts";

test("controller adds a validated local entry through the runtime catalog", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-code-reference-controller-"));
  const docs = join(root, "docs");
  mkdirSync(docs, { recursive: true });
  const saved: unknown[] = [];
  let document = { references: {} as Record<string, unknown> };
  const catalog = {
    filePath: join(root, "references.json"),
    readDocument: async () => document,
    preflight: async (candidate: unknown) => {
      saved.push(candidate);
      return { ok: true as const };
    },
    save: async (candidate: unknown) => {
      document = candidate as typeof document;
      return { ok: true as const };
    },
  };
  const controller = createReferencesSetupController({ catalog });
  assert.deepEqual(await controller.addLocal({ alias: "docs", path: docs, description: "Docs", hidden: true }), { ok: true, message: "Reference saved." });
  assert.deepEqual(document, { references: { docs: { path: docs, description: "Docs", hidden: true } } });
  assert.equal(saved.length, 1);
});

test("controller rejects invalid local candidates before preflight", async () => {
  let preflighted = false;
  const controller = createReferencesSetupController({
    catalog: {
      filePath: "/tmp/references.json",
      readDocument: async () => ({ references: {} }),
      preflight: async () => {
        preflighted = true;
        return { ok: true as const };
      },
      save: async () => ({ ok: true as const }),
    },
  });
  const result = await controller.addLocal({ alias: "docs", path: "relative/docs" });
  assert.equal(result.ok, false);
  assert.equal(preflighted, false);
});

test("updateLocal preserves shorthand form and omitted metadata losslessly", async () => {
  let document = {
    references: {
      notes: "~/notes" as string | Record<string, unknown>,
      docs: { path: "/tmp/docs", description: "Local docs", hidden: true } as Record<string, unknown>,
    },
  };
  const controller = createReferencesSetupController({
    catalog: {
      filePath: "/tmp/references.json",
      readDocument: async () => document,
      preflight: async () => ({ ok: true as const }),
      save: async (candidate: unknown) => {
        document = candidate as typeof document;
        return { ok: true as const };
      },
    },
  });
  await controller.updateLocal("notes", { path: "~/scratch" });
  assert.equal(document.references.notes, "~/scratch");
  await controller.updateLocal("notes", { path: "~/scratch", description: "Notes" });
  assert.deepEqual(document.references.notes, { path: "~/scratch", description: "Notes" });
  await controller.updateLocal("docs", { path: "/tmp/docs2" });
  assert.deepEqual(document.references.docs, { path: "/tmp/docs2", description: "Local docs", hidden: true });
});

test("controller adds a validated Git entry through the runtime catalog", async () => {
  const saved: unknown[] = [];
  let document = { references: {} as Record<string, unknown> };
  const controller = createReferencesSetupController({
    catalog: {
      filePath: "/tmp/references.json",
      readDocument: async () => document,
      preflight: async (candidate: unknown) => {
        saved.push(candidate);
        return { ok: true as const };
      },
      save: async (candidate: unknown) => {
        document = candidate as typeof document;
        return { ok: true as const };
      },
    },
  });
  const result = await controller.addGit({ alias: "react", repository: "facebook/react", branch: "main", description: "React", hidden: true });
  assert.deepEqual(result, { ok: true, message: "Reference saved." });
  assert.deepEqual(document, { references: { react: { repository: "facebook/react", branch: "main", description: "React", hidden: true } } });
  assert.equal(saved.length, 1);
});

test("controller rejects unsafe Git values before preflight", async () => {
  let preflighted = false;
  const controller = createReferencesSetupController({
    catalog: {
      filePath: "/tmp/references.json",
      readDocument: async () => ({ references: {} }),
      preflight: async () => {
        preflighted = true;
        return { ok: true as const };
      },
      save: async () => ({ ok: true as const }),
    },
  });
  assert.equal((await controller.addGit({ alias: "x", repository: "evil; rm -rf" })).ok, false);
  assert.equal((await controller.addGit({ alias: "x", repository: "a/b", branch: "-bad" })).ok, false);
  assert.equal(preflighted, false);
});

test("controller preserves Git raw metadata when editing branch only", async () => {
  let document = {
    references: {
      react: { repository: "facebook/react", description: "React", hidden: true } as Record<string, unknown>,
      scp: "user@host:repo" as string | Record<string, unknown>,
    },
  };
  const controller = createReferencesSetupController({
    catalog: {
      filePath: "/tmp/references.json",
      readDocument: async () => document,
      preflight: async () => ({ ok: true as const }),
      save: async (candidate: unknown) => {
        document = candidate as typeof document;
        return { ok: true as const };
      },
    },
  });
  await controller.updateGit("react", { repository: "facebook/react", branch: "dev" });
  assert.deepEqual(document.references.react, { repository: "facebook/react", branch: "dev", description: "React", hidden: true });
  await controller.updateGit("scp", { repository: "user@host:repo", branch: "dev" });
  assert.deepEqual(document.references.scp, { repository: "user@host:repo", branch: "dev" });
});

test("Git shorthand entries are not classified as editable local references", async () => {
  const controller = createReferencesSetupController({
    catalog: {
      filePath: "/tmp/references.json",
      readDocument: async () => ({ references: { remote: "owner/repo", local: "~/docs" } }),
      preflight: async () => ({ ok: true as const }),
      save: async () => ({ ok: true as const }),
    },
  });
  const items = (await controller.list()).items;
  assert.equal(items.find((item) => item.name === "remote")?.local, undefined);
  assert.deepEqual(items.find((item) => item.name === "local")?.local, { path: "~/docs" });
});

test("an aborted in-flight local save does not publish the candidate", async () => {
  const abort = new AbortController();
  let document: { references: Record<string, unknown> } = { references: {} };
  let releasePreflight!: () => void;
  const preflightPending = new Promise<void>((resolve) => { releasePreflight = resolve; });
  const controller = createReferencesSetupController({
    catalog: {
      filePath: "/tmp/references.json",
      readDocument: async () => document,
      preflight: async () => {
        await preflightPending;
        return { ok: true as const };
      },
      save: async (candidate: unknown) => {
        document = candidate as typeof document;
        return { ok: true as const };
      },
    },
  });
  const pending = controller.addLocal({ alias: "docs", path: "/tmp/docs", signal: abort.signal });
  abort.abort();
  releasePreflight();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.deepEqual(document, { references: {} });
});

test("controller removes an entry atomically and preserves the rest", async () => {
  let document = { references: { docs: { path: "/tmp/docs" } as Record<string, unknown>, keep: "~/keep" as string | Record<string, unknown> } };
  const controller = createReferencesSetupController({
    catalog: {
      filePath: "/tmp/references.json",
      readDocument: async () => document,
      preflight: async () => ({ ok: true as const }),
      save: async (candidate: unknown) => {
        document = candidate as typeof document;
        return { ok: true as const };
      },
    },
  });
  const result = await controller.remove("docs");
  assert.deepEqual(result, { ok: true, message: "Reference removed." });
  assert.deepEqual(document, { references: { keep: "~/keep" } });
});

test("/setup-references maps saved, error, and cancelled results to notifications", async () => {
  const handlers = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
  const notifications: Array<[string, string]> = [];
  const pi = {
    registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) {
      handlers.set(name, options.handler);
    },
  } as unknown as ExtensionAPI;
  registerReferencesSetup(pi);
  const ctxFor = (result: unknown): ExtensionCommandContext => ({
    mode: "tui",
    hasUI: true,
    signal: undefined,
    ui: {
      custom: async () => result,
      notify: (message: string, kind?: string) => notifications.push([message, kind ?? "info"] as [string, string]),
    },
  } as unknown as ExtensionCommandContext);
  await handlers.get("setup-references")!("", ctxFor({ status: "saved", message: "Done" }));
  await handlers.get("setup-references")!("", ctxFor({ status: "error", message: "Broken" }));
  await handlers.get("setup-references")!("", ctxFor({ status: "cancelled" }));
  assert.deepEqual(notifications, [
    ["Done", "info"],
    ["Broken", "error"],
    ["References setup cancelled", "info"],
  ]);
});

test("registers /setup-references and gates it to interactive TUI", async () => {
  const handlers = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
  const notifications: string[] = [];
  const pi = {
    registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) {
      handlers.set(name, options.handler);
    },
  } as unknown as ExtensionAPI;
  registerReferencesSetup(pi);
  assert.equal(handlers.has("setup-references"), true);
  await handlers.get("setup-references")!("", {
    mode: "rpc",
    hasUI: true,
    ui: { notify: (message: string) => notifications.push(message) },
  } as unknown as ExtensionCommandContext);
  assert.match(notifications[0]!, /requires an interactive TUI/);
});
