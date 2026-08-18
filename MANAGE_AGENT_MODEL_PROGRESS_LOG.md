# Manage Agent Model Command — Progress Log

Historical, append-only progress log for the `/manage-agent-model` command.

## 2026-08-18 — Session: interactive agent model management

### Context

The pi-c2 `agent` tool already supports an optional `model` field in agent file
frontmatter (`packages/runtime/src/infrastructure/agents/discovery.ts:44`
parses it; `packages/runtime/src/infrastructure/pi-sdk/child-session.ts:250`
resolves it against the child `ModelRuntime` and falls back to the parent model).
There is currently no way to *manage* that field without hand-editing the agent
Markdown file.

Feature request: add a `/manage-agent-model` command so the user can:

1. Pick an action: **set/replace** the agent model or **remove** it.
2. Select which agent (from discovered agent files).
3. Select the target model from the same model list `/model` uses.
4. For **set/replace**: write `model: <provider>/<model-id>` into the agent
   file's frontmatter automatically (preserving the rest of the file).
5. For **remove**: delete the `model` line from the frontmatter.

### Design decisions (to confirm)

- Command lives in `packages/commands/src/registrations/` (pattern:
  `references-setup-command.ts`), registered from the pi-c2 composition root
  (`packages/pi-c2/index.ts`).
- Interactive TUI wizard follows the `ReferencesSetupWizard` pattern
  (`packages/tui/`).
- Model list source: the SDK `ModelRegistry` (`ctx.modelRegistry.getAvailable()`)
  — the same list `/model` offers. Values formatted as `provider/model-id`.
- Agent list source: the cached agent discovery seam
  (`createCachedAgentDiscovery(cwd)`), same as the `agent` tool.
- Frontmatter rewrite must be lossless: re-serialize only the changed key and
  preserve the original Markdown body byte-for-byte. TBD exact serializer.

### Scope clarification (2026-08-18)

- Do NOT replicate `/model` selector behavior (search box, fuzzy filter,
  sort-by-current-first, catalog refresh, provider hints).
- Only requirement: the value written to the `model:` frontmatter key must be
  the **exact model reference string** `/model` uses — `${provider}/${model.id}`
  (the form `resolveCliModel({ cliModel })` accepts, and the form
  `resolveChildModel` in child-session.ts resolves against).
- Model list = available models from the model registry, formatted as
  `provider/model-id`.

### Next steps

- [ ] Explore TUI wizard pattern (`ReferencesSetupWizard`) and command handlers
- [ ] Explore the exact model list `/model` shows (formatting, filtering)
- [ ] Explore agent discovery + how to rewrite frontmatter in the .md file
- [ ] Design the wizard state machine (action → agent → model)
- [ ] Implement command + wizard + frontmatter writer
- [ ] Tests: deterministic (temp dirs, fake models/agents, no live user data)
- [ ] Run `pnpm test:all` from `plugins/`

### Thinking-level selector (2026-08-18, added during implementation)

- After selecting a model, show a thinking-level selector **only when the
  selected model supports levels beyond `off`** — determined by
  `getSupportedThinkingLevels(model)` from `@earendil-works/pi-ai` (returns
  `["off"]` for non-reasoning models; the extended level set for reasoning
  models).
- The chosen level writes a `thinking:` frontmatter key alongside `model:`.
- This requires extending the whole pipeline (currently missing):
  - `discovery.ts` parses `thinking` frontmatter → `DiscoveredAgent` gains
    `thinking?: ThinkingLevel`.
  - `child-session.ts` passes the resolved thinking level to
    `createAgentSession({ thinkingLevel })` (the SDK clamps internally via
    `clampThinkingLevel` when the level is unsupported).
  - Controller gains a way to list supported thinking levels for a model;
    wizard gains a thinking step after model selection.

### Implementation status (2026-08-18)

- [x] Lossless frontmatter set/remove utility (`core/domain/agents/frontmatter.ts`)
- [x] Controller (`commands/registrations/manage-agent-model.ts`)
- [x] Command registration (`commands/registrations/manage-agent-model-command.ts`)
- [x] TUI wizard (`tui/src/manage-agent-model-wizard.ts`), action → agent → model → thinking
- [x] Wired into pi-c2 composition root
- [x] Tests: frontmatter (core), controller+command (commands), wizard (tui) — all green
- [x] Thinking-level selector + pipeline support (in progress → done)
- [x] Discovery/child-session `thinking` support (done)
- [x] Run `pnpm test:all` from `plugins/` (all 18 green)

### Thinking-level implementation notes (2026-08-18)

- `core/domain/agents/agent.ts`: `DiscoveredAgent` gains `thinking?: ThinkingLevel`
  (type from `@earendil-works/pi-agent-core`, added as a direct dep of core +
  runtime). New `THINKING_LEVELS` + `supportedThinkingLevels(model)` mirror the
  pi-ai `getSupportedThinkingLevels` semantics (non-reasoning → `["off"]`;
  reasoning → extended set filtered by `thinkingLevelMap`).
- `core/domain/agents/frontmatter.ts`: generalized to `setFrontmatterKey` /
  `removeFrontmatterKey` (lossless text edits); `setFrontmatterModel` /
  `removeFrontmatterModel` are now thin aliases.
- `runtime/infrastructure/agents/discovery.ts`: parses `thinking` frontmatter,
  validates against the known level set.
- `runtime/infrastructure/pi-sdk/child-session.ts`: passes `discovered.thinking`
  to `createAgentSession({ thinkingLevel })`; the SDK clamps unsupported levels
  via `clampThinkingLevel`.
- Wizard: after model selection, `listThinkingLevels(reference)` returns the
  supported levels; the thinking step only appears when levels extend beyond
  `off`. `setModel(name, reference, thinking?)` writes both keys; `removeModel`
  removes both.
- Controller types moved to the **tui** package to avoid a commands→tui→commands
  cycle; the commands controller structurally satisfies the tui interface.

### Path-traversal regression fix (2026-08-18)

- `packages/tools/src/registrations/write-markdown.ts` had a pre-existing
  uncommitted change (from the earlier require→import migration) that removed
  the `isWithinProject` project-containment check from
  `admitWriteMarkdownTarget`. The tools tests (`edit-markdown`, `markdown-matrix`)
  failed on `src/../../outside.md` being accepted.
- Restored the `isWithinProject` guard so `write_markdown` again rejects targets
  outside the active project. All 18 workspace checks pass.
