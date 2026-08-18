# Goal Persistence Fix — Progress Log

Historical, append-only progress log for the goal-persistence fix task.

## 2026-08-18 — Session: goal persistence on exit

### Context

Bug report: exiting a session while a goal is still active causes the goal to
disappear when the same session is reopened. Active goals should persist across
session exits and be restored when the same session is resumed. Exiting a
session should pause active goals (not delete them); a goal is only removed when
explicitly cleared via `goal_clear`.

### Root cause (traced)

- `plugins/packages/commands/src/registrations/session-events.ts` — `stopSession`
  ends with `goalPool.clearStore()`, which:
  1. clears all schedulers/timers,
  2. clears bindings,
  3. sets `deliverySuspended = true`,
  4. **deletes the persisted goals file** via `rmSync(store.filePath, { force: true })`.
- `createGoalStore` loads state from `goals.jsonl` (home-scoped, per project +
  root session). Deleting the file destroys the log — the goal is unrecoverable.
- On the next `session_start` for the same session id, `getGoalPool` returns the
  singleton pool (persisted in `globalThis.piC2GoalPools` keyed by
  projectRoot:rootSessionId), whose in-memory `index` still holds the goal —
  but the file is gone, so `fold()`/`foldGoalLog` return an empty map and any
  mutation rewrites state as if the goal never existed.
- Goal event model (`core/src/domain/goals/events.ts`) supports `goal_paused`
  and `goal_cleared`; pause preserves the record, clear removes it.

### Design decision

Replace the destructive `clearStore()` on root session shutdown with a
non-destructive pause:

- On root session shutdown: stop delivery timers and pause every **active**
  persisted goal for that session with a deterministic reason, so the record is
  preserved in the log and restored on resume. Paused goals do not deliver.
- `clearStore()` remains available for explicit store removal but is no longer
  invoked from the session shutdown path.
- Add `GoalPool.pauseAllActive(reason)` (name TBD) mirroring
  `clearActiveGoals()` shape for symmetric, testable behavior.

### Next steps

- [ ] Implement pool `pauseAllActive(reason)` (or similar) in goal-pool.ts
- [ ] Wire session shutdown to pause instead of clear
- [ ] Add/extend tests: shutdown pauses active goals; store file persists;
      resume restores goal in paused state
- [ ] Run `pnpm test:all` from `plugins/`

### Decision updates (2026-08-18, continuation)

- Progress log lives at `plugins/GOAL_PERSISTENCE_PROGRESS_LOG.md` (the
  pre-existing `plugins/RENDER_MIGRATION_LOG.md` is an unrelated log and must
  not be touched).
- Repo root for git is `plugins/` itself; the git working tree is clean.
- Design:
  - Add `GoalPool.pauseAllActive(reason: string): number` in `goal-pool.ts`,
    mirroring `clearActiveGoals()`: fold persisted state, pause every active
    goal with the given reason, clear schedulers, suspend delivery.
  - Add `GOAL_OPERATIONS.PAUSE_ALL = "goal.pauseAll"` in
    `observability/src/operations.ts`.
  - In `stopSession` (commands/src/registrations/session-events.ts), replace
    `goalPool.clearStore()` with `goalPool.pauseAllActive(reason)` so goals
    survive session exit and are restored (paused) on resume.
  - `clearStore()` stays available but is no longer invoked from the shutdown
    path. Goals are removed only via `goal_clear` (explicit clear).

### Implementation

- [x] Read all goal code paths (store, pool, tools, session events, tests)
- [x] Implement pool `pauseAllActive` + operation constant
- [x] Wire session shutdown to pauseAllActive
- [x] Add pool-level and session-level tests
- [ ] Run `pnpm test:all` from `plugins/`

### Code changes made

- `runtime/src/infrastructure/goals/goal-pool.ts`:
  - Added `pauseAllActive(reason: string): number` to the `GoalPool` interface
    and implementation: folds persisted state, pauses every active goal with
    the given reason, clears each cwd scheduler, suspends delivery, returns
    the number paused.
  - Removed the now-unused `clearStore()` method (and its `rmSync` import);
    goals are never deleted on shutdown anymore.
- `observability/src/operations.ts`: removed `CLEAR_STORE`, added
  `GOAL_OPERATIONS.PAUSE_ALL = "goal.pauseAll"`.
- `commands/src/registrations/session-events.ts` (`stopSession`): replaced
  `goalPool.clearStore()` with `goalPool.pauseAllActive("session exited (${event.reason})")`.
- Tests:
  - `runtime/tests/goal-scheduler.test.ts`: new test
    `pauseAllActive pauses persisted goals without removing them and stops delivery`
    (asserts paused status, reason preserved, fresh reader restores it, no delivery).
  - `commands/tests/goal-lifecycle.test.ts`: updated
    `session shutdown pauses the persisted goal while stopping delivery` and
    `quit shutdown clears goal timers and bindings idempotently` to assert
    paused status + reason instead of active.

### Pending verification

- Run `pnpm test:all` from `plugins/` (or at least the affected packages:
  runtime, commands, observability, tools).

## 2026-08-18 — New requirement: session-root goal scoping

User: "Goals should be scoped to the session root, not the current working
 directory (cwd). This allows each session to maintain its own independent
 goals, even when multiple sessions are running from the same cwd."

### Design

The store file is ALREADY per-root-session (`homeGoalFile(projectId,
 rootSessionId)`), but goal identity inside the log is keyed by `cwd`:
 `GoalEvent` carries `cwd`, `foldGoalEvents` keys by `cwd`, and every pool
 mutation takes a cwd. One session could hold goals for several cwds, and the
 model surfaces cwd as the goal's owner.

Change goal identity to the root session id:

- `GoalEvent` gains required `rootSessionId`; keeps `cwd` for delivery routing.
- `foldGoalEvents` keys by `rootSessionId` (≤1 goal per pool, matching the
  per-session store file).
- `Goal` record gains `rootSessionId`; `cwd` remains delivery context.
- `GoalStore` methods key by `rootSessionId`.
- `GoalPool` mutation methods drop the cwd parameter:
  `pause(reason)`, `resume()`, `get()`, `clear()`; `create({ cwd, prompt,
  interval, intervalMs })` keeps cwd as delivery target. `tick(cwd)` keeps
  its cwd for delivery routing. Scheduler/binding maps stay keyed by cwd
  (single goal ⇒ single scheduler).
- `tools/src/registrations/goals.ts` tool handlers call the new pool API;
  status output gains a root-session field; tool descriptions say
  "session-scoped" instead of "cwd-scoped".

### Impact on tests

- `core/tests/goal.test.ts`: event literals gain `rootSessionId`; fold keys.
- `runtime/tests/goal-store.test.ts`: pool calls drop cwd keys; the
  multi-cwd record test becomes single-goal-per-session.
- `runtime/tests/goal-scheduler.test.ts`: `pause/get/clear` drop cwd; the
  two-goal delivery-isolation test becomes two pools (two sessions).
- `runtime/tests/phase6-goals.test.ts`: `get/clear` drop cwd; all() keys.
- `commands/tests/goal-lifecycle.test.ts`: `get()` drops cwd.
- `tools/tests/goal-tools.test.ts`: unchanged (tool-level contract).

### Implementation (session-root scoping) — DONE

Changed the goal identity from `cwd` to `rootSessionId` across the whole
stack:

- `core/src/domain/goals/events.ts`: `GoalEvent` now requires `rootSessionId`
  on every event; `isValidGoalEvent` validates it; `foldGoalEvents` keys the
  result by `rootSessionId` (one goal per root session).
- `core/src/domain/goals/record.ts`: `Goal` and `GoalCreationInput` gain
  `rootSessionId`; `cwd` remains the delivery target.
- `runtime/src/infrastructure/goals/goal-store.ts`:
  `createGoalStore(filePath, rootSessionId)`; every method is session-keyed
  (`create({ cwd, prompt, intervalMs })`, `pause(reason)`, `resume()`,
  `get()`, `clear()`); append logs `rootSessionId`.
- `runtime/src/infrastructure/goals/goal-pool.ts`:
  - `createGoalPool` passes `rootSessionId` to the store.
  - `GoalPool.pause(reason)`, `resume()`, `get()`, `clear()` no longer take a
    cwd; `create({ cwd, ... })` keeps cwd as the delivery routing target.
  - `tick(cwd)` / `ensureScheduler(cwd)` / bindings keyed by delivery cwd;
    a pool holds at most one goal so at most one scheduler.
  - `beginSessionConfirmation`/`clearActiveGoals`/`pauseAllActive` operate on
    the session goal.
- `tools/src/registrations/goals.ts`: tool handlers call the new API; tool
  descriptions/prompt snippet say session-scoped; `goal_status` output shows
  `Root session: <id>`; errors say "for this session".
- `session-events.ts` unchanged (already calls `pauseAllActive`).

### Tests updated

- `core/tests/goal.test.ts`: literals + fold keys + parsing.
- `runtime/tests/goal-store.test.ts`: session-keyed assertions; multi-session
  isolation instead of multi-cwd records.
- `runtime/tests/goal-scheduler.test.ts`: two-goal isolation now uses two
  pools (two sessions) on the same root; `get()/pause()/clear()` no-arg.
- `runtime/tests/phase6-goals.test.ts`: session-keyed assertions.
- `commands/tests/goal-lifecycle.test.ts`: `get()` no-arg.
- `tools/tests/goal-tools.test.ts`: only the test-name string "cwd-scoped"
  still refers to the legacy wording; no API changes needed.

### Verification

- `pnpm test:all` from `plugins/`: ALL 18 checks passed (typecheck + test for
  channels, commands, core, mcp, observability, pi-c2, runtime, tools, tui),
  74s.
- Re-ran after the wording cleanups (goal_status description,
  "session-scoped" test name): ALL 18 checks passed again, 93s.

### Final state

- Active goals persist across session exit and are restored paused on resume
  (shutdown calls `pauseAllActive("session exited (<reason>)")`, never
  deletes the store).
- Goals are scoped to the root session, not the cwd: event/record identity is
  `rootSessionId`; `cwd` is only the delivery routing target. Multiple
  sessions on the same cwd keep independent goals.
- `goal_clear` is the only path that removes a goal.
- Dead `clearStore()` removed; `CLEAR_STORE` operation constant removed.

## 2026-08-18 — Simplify goal-trigger UI notification (drop custom-entry renderer)

User reported the goal interval/trigger notification was not visible in the
TUI, and asked to stop using `pi.registerEntryRenderer`/`appendEntry` and
instead call `ctx.ui.notify` directly.

### Change

- `commands/src/registrations/notify-entry.ts`: simplified to a single
  `notifyHost(pi, ctx, message, type)` that calls `ctx.ui.notify(message,
  type)` when available (no-op otherwise). Removed `NOTIFY_ENTRY_TYPE`,
  `NotifyEntryData`, `notifyEntryRenderer`, `appendNotifyEntry`, and
  `registerNotifyEntry`.
- `commands/src/index.ts`: exports only `notifyHost` now.
- `pi-c2/index.ts`: removed `registerNotifyEntry` import and registration call.
- `session-events.ts`: goal binding passes the notify `type` through;
  agent-result notify unchanged (info).
- Tests (`commands/tests/session-events.test.ts`): background-result
  notifications assert `ctx.ui.notify` delivery; new test asserts type
  pass-through (info default, warning preserved) and no-op without UI.

### Verification

- commands + pi-c2 typecheck pass; commands tests pass (126).
- Full `pnpm test:all`: all 18 checks pass (85s).

### Final state

- Goal trigger notify now flows: pool `tick` → binding `notify(message,
  type)` → `notifyHost` → `ctx.ui.notify(message, type)`. In the TUI this is
  the built-in status/warning/error channel, so the user sees the goal-trigger
  notification without depending on host custom-entry renderer support.

## 2026-08-18 — Restore custom-entry renderer with ui.notify fallback

User: notifications should be `※`-prefixed and yellow; `ctx.ui.notify`
(warning type) renders `Warning: <text>` which must not appear. They
approved patching the pi package if needed.

### Change

- `notify-entry.ts`: reinstated the custom-entry renderer as the primary
  path. `NOTIFY_ENTRY_TYPE = "pi-c2:notify"`, `notifyEntryRenderer` renders
  `theme.fg("warning", "※ <message>")` (bare yellow `※` line, no
  `Warning:`), `appendNotifyEntry` appends via `pi.appendEntry`, and
  `registerNotifyEntry` registers the renderer.
- Auto-fallback: `notifyHost` tracks whether the host accepted the renderer
  (module flag set by `registerNotifyEntry` when both
  `pi.registerEntryRenderer` and `pi.appendEntry` exist). With UI + renderer
  → yellow `※` entry; otherwise → `ctx.ui.notify(message, "info")` (no
  `Warning:` prefix, dim status) or no-op without any UI. This satisfies
  "if notification component not working correctly, auto fallback to host
  notify ui" with the same semantic notify type.
- `commands/src/index.ts`: re-exported `registerNotifyEntry`,
  `appendNotifyEntry`, `NOTIFY_ENTRY_TYPE`, `notifyEntryRenderer`,
  `NotifyEntryData`.
- `pi-c2/index.ts`: calls `registerNotifyEntry(pi)`.
- SDK path verified end-to-end: `appendEntry` → `entry_appended` event →
  TUI `addCustomEntryToChat` → `getEntryRenderer` (runner reads the
  extension's `entryRenderers` map) → `CustomEntryComponent`. Custom entries
  stay out of LLM context. No SDK patch needed.
- Tests: `session-events.test.ts` covers the fallback (plain message via
  `ui.notify`) and the primary path (renderer registered → `※` entry
  appended, `ui.notify` untouched), plus silent no-op without UI.

## 2026-08-18 — Upgrade Pi SDK to 0.84.2 and re-base the local patch

Diagnosis: the live host is the globally installed `@earendil-works/pi-coding-agent`
0.80.2, which predates `registerEntryRenderer` — that is why the yellow `※`
entry never rendered (fallback fired instead). Workspace deps pinned `^0.84.1`
with a local patch.

### Change

- All `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`
  dependencies across 8 packages: `^0.84.1` → `^0.84.2`.
- Re-based `patches/@earendil-works__pi-coding-agent@0.84.2.patch` from the
  0.84.1 patch via `pnpm patch` + `pnpm patch-commit`. 0.84.2 changes were
  small (`expandPromptTemplates` option in types.d.ts; `APP_NAME` in a
  session-manager.js import string); all original hunks re-applied cleanly
  with adjusted offsets.
- `pnpm-workspace.yaml` `patchedDependencies` now points at 0.84.2 with the
  new patch hash; lockfile updated.
- Removed orphaned 0.84.1 / stale 0.84.2 store directories.

### Verification

- `pnpm install` clean; all 9 package typechecks pass; `pnpm test:all` all 18
  checks pass (59s).

## 2026-08-18 — Render experiment: patched 0.84.2 host renders yellow ※ notify

Live diagnosis: `pi --version` is **0.80.2** (global install). It has
`appendEntry` but no `registerEntryRenderer`, no `getEntryRenderer`, and its
interactive mode has no `entry_appended` handler — so custom entries are
silently dropped and the fallback (`ui.notify`) is what the user saw as plain
text. The extension is loaded from `settings.json` packages pointing at
`plugins/packages/pi-c2/index.ts`.

### Experiment (isolated, no live-host change)

Wrote a throwaway harness (`packages/pi-c2/experiment-notify.ts`, removed
after) that loaded the REAL notify renderer and goal pool against the REAL
patched 0.84.2 SDK, mirroring the loader wiring (`extension.entryRenderers`
map + `ExtensionRunner.getEntryRenderer`). Results — all 7 checks pass:

- host discovers a registered renderer for `pi-c2:notify`
- renderer produces a `Text` component
- rendered text has the `※` prefix
- rendered text is yellow: `\x1b[38;2;255;255;0m` (RGB 255,255,0)
- no `Warning:` prefix
- `appendNotifyEntry` appends `pi-c2:notify` with the message
- a real goal pool tick produces the notify

### Conclusion / next step

The patched 0.84.2 host renders the yellow `※` goal notification exactly as
intended. Adoption requires upgrading the **global** `pi` install (0.80.2 →
patched 0.84.2) so the live host has `registerEntryRenderer` + the patch's
`createCommandContext` (stock 0.84.2 lacks the latter; the telegram lifecycle
code calls it). User has offered to run the global upgrade.

## 2026-08-18 — Postinstall host-patch automation for published pi-c2

User asked: when `@xzy-ai/pi-c2` is published, how should patching work?
Preferred: a `postinstall` that auto-applies the host patch, backed up and
reversible. I recommended (and the user accepted) a pure-JS unified-diff
applier (`diff` package's `applyPatches`) instead of `git apply` — no `.git`
dir left in the user's global SDK, no external tool, idempotent.

### Change

- `packages/pi-c2/scripts/postinstall.mjs`:
  - Locates the HOST `pi-coding-agent` via `npm root -g` (flat global layout
    fallback, then local workspace fallback).
  - Reads `package.json` version; skips with a clear message when < 0.84.2.
  - Idempotent: marker-greps (`createCommandContext` in loader.js,
    `ensurePrivateSessionDir` in session-manager.js) and no-ops when patched.
  - Backs up the host SDK to `pi-coding-agent.bak-<version>` (cpSync), applies
    the bundled patch via `diff.applyPatches` (strips `a/`/`b/` prefixes,
    fuzzFactor 0), verifies markers, and rolls back to the backup on any
    failure. Never throws — npm postinstall failures are confusing.
- `packages/pi-c2/scripts/pi-coding-agent@0.84.2.patch`: bundled copy of the
  workspace patch (the postinstall applies this exact file).
- `packages/pi-c2/package.json`: `postinstall` script; `files` field
  (`index.ts`, `scripts/`) so the patch ships; added `diff@^9.0.0` dep.
- `packages/pi-c2/tests/postinstall.test.ts`: 4 deterministic tests using a
  fake global root + stubbed `npm` on PATH. Pristine 0.84.2 fixture built by
  reverse-applying the bundled patch to the workspace's patched SDK (offline).
  Covers: patch+backup, idempotency, old-version skip, rollback-to-prestate.

### Verification

- `pnpm test:all`: all 18 checks pass (62s). `npm pack --dry-run`: ships
  index.ts + scripts/ (patch + postinstall). Live run against the workspace
  correctly reports the real global host (0.80.2) and leaves it untouched.

## 2026-08-18 — ※ + warning styling for goal and agent notifications

User: notifications (both agent completion and goal trigger) should be
prefixed with `※` and colored yellow/warning.

### Change

- `commands/src/registrations/notify-entry.ts`: `notifyHost` now always
  delivers `※ ${message}` through `ctx.ui.notify(message, "warning")`. The
  host maps `warning` to its yellow warning color (the same output the old
  custom-entry renderer produced: `theme.fg("warning", "※ <text>")`). The
  `type` parameter is dropped; both goal and agent notifications render
  identically as yellow `※` lines.
- `session-events.ts`: goal binding no longer passes a type through.
- Tests updated to assert the `※` prefix and `warning` type.
