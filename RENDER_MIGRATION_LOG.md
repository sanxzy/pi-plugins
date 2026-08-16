# TUI Tool Rendering Migration Log

This document records the per-tool migration from raw tool payload rendering to concise, user-facing activity rendering. The model continues to receive the full tool arguments and result; the TUI exposes only the high-level action and safe identifiers needed to understand progress.

## Status legend

- **Reviewed** — current registration and user-visible data boundary inspected.
- **Changed** — renderer updated for the tool's own activity semantics.
- **Verified** — focused typecheck/test verification passed.

## Migration history

### 2026-08-16 — migration started

- Confirmed Pi's `ToolDefinition.renderCall` / `renderResult` contract and the fallback behavior that can expose JSON arguments and full text output when a tool has no renderer.
- Confirmed hidden custom messages (`display: false`) are appropriate for model-only injected context; ordinary user-visible messages remain visible by design.
- Added the shared renderer utility only for safe one-line truncation and common success/error markers. Tool-specific renderers remain responsible for selecting their own visible details.

### Tool inventory and per-tool decisions

| Tool | Scope | Visible call details | Visible result details | Status |
|---|---|---|---|---|
| `agent` | tools | subagent type and short delegation description; never prompt | completion marker and job ID when returned | Changed; verification pending |
| `agent_cancel` | tools | target job ID | cancellation outcome | Changed; verification pending |
| `agent_status` | tools | target job ID | current status | Changed; verification pending |
| `agent_jobs` | tools | listing action only | completion marker; job list stays model-only | Changed; verification pending |
| `agent_list` | tools | listing action only | completion marker; definitions stay model-only | Changed; verification pending |
| `question` | tools | asking action only; question/options are user-facing dialog content, not duplicated in tool row | completion marker; answer remains in dialog/result flow | Changed; verification pending |
| `goal_create` | tools | create action only; goal prompt stays model-only | completion marker | Changed; verification pending |
| `goal_pause` | tools | pause action only; pause reason stays model-only | completion marker | Changed; verification pending |
| `goal_resume` | tools | resume action | completion marker | Changed; verification pending |
| `goal_status` | tools | status action | completion marker; full goal record stays model-only | Changed; verification pending |
| `goal_clear` | tools | clear action | completion marker | Changed; verification pending |
| `web_search` | tools | search query | completion marker; web result body stays model-only | Changed; verification pending |
| `web_fetch` | tools | requested URL (bounded) | completion marker; fetched body stays model-only | Changed; verification pending |
| `knowledge_search` | tools | query or discovery mode (bounded) | completion marker; excerpts/reference bodies stay model-only | Changed; verification pending |
| `telegram_chat` | tools | action type only; message, target, media source, and reaction payload stay hidden | delivery outcome only | Changed; verification pending |
| `mcp_*` dynamic tools | mcp | stable registered tool label and server name | completion/failure marker | Changed; verification pending |
| `mcp_resources_list` | mcp | server name | list outcome | Changed; verification pending |
| `mcp_resources_read` | mcp | server and URI | read outcome | Changed; verification pending |

## Verification record

### 2026-08-16 — first per-tool renderer pass

- `agent`: shows subagent type plus bounded description; result shows returned job ID when available. Verified with focused tool-render test.
- `agent_cancel` / `agent_status`: show the target job ID; status shows the current status. Verified with focused tool-render test.
- `agent_jobs` / `agent_list`: retain concise list activity and hide full lists from the tool row. Verified with focused tool-render test.
- `question`: shows the question text because it is explicitly user-facing, while options and answer are not duplicated into the tool row. Existing renderer tests updated and passed.
- `goal_create` / `goal_pause` / `goal_resume` / `goal_status`: show the specific lifecycle action while exact prompts, pause reasons, and full records remain model-facing. `goal_clear` distinguishes clearing a completed goal from evaluating an incomplete one. Verified with focused tool-render test.
- `web_search` / `web_fetch`: show bounded query/URL; bodies remain hidden. Verified with focused tool-render test.
- `knowledge_search`: shows bounded query or discovery mode; excerpts and reference content remain hidden. Verified with focused tool-render test.
- `telegram_chat`: shows the action type only; target IDs, message text, media sources, and reaction payloads remain hidden. Verified with focused tool-render test.
- Dynamic MCP tools: show stable tool label and server name; MCP payloads/results remain hidden. MCP focused tests passed.
- MCP resource tools: show server and resource URI at a bounded high level. MCP focused tests passed.
- Added focused renderer regression coverage for pi-c2 tools and updated the existing question renderer expectations.

### 2026-08-16 — review remediation

The explore review identified gaps beyond ordinary tool rows. Addressed in this pass:

- Added safe renderers for inherited child-session MCP tools.
- Removed raw tool arguments and user/assistant transcript bodies from the focused child live view; tool names, running/failed state, and activity markers remain visible.
- Replaced raw assistant/user footer leaves with `assistant activity` / `user activity`; tool names remain visible.
- Added result-aware failure detection for `Error:` content, structured failures, `success: false`, `sent: false`, denied, unknown, and MCP failure details.
- Corrected agent outcome labels for queued, running, completed, and terminal statuses.
- Made goal outcomes distinguish status availability, retained goals, and clearing outcomes without exposing prompt text.
- Added control-character stripping to compact renderer text.
- Added child MCP renderer regression coverage and live-view/footer payload-hiding assertions.

### Verification

- `pnpm test:all --tests-only` — passed before the review remediation.
- `pnpm --filter @xzy-ai/runtime typecheck` — passed after child MCP renderer changes.
- `pnpm --filter @xzy-ai/tui typecheck` — passed after live/footer changes.
- `pnpm --filter @xzy-ai/tools typecheck` — passed after result-aware rendering changes.
- `pnpm --filter @xzy-ai/commands typecheck` — passed after hidden-delivery test updates.
- `pnpm --filter @xzy-ai/mcp typecheck` — passed after MCP sanitization changes.
- `pnpm --filter @xzy-ai/runtime test -- --test-name-pattern='inherited MCP|live feed|maps SDK'` — passed.
- `pnpm --filter @xzy-ai/tui test -- --test-name-pattern='transcript|activity|tool args|footer'` — passed.
- `pnpm --filter @xzy-ai/tools test -- --test-name-pattern='tool renderers'` — passed.
- `pnpm --filter @xzy-ai/mcp test -- --test-name-pattern='McpToolExposer|resource'` — passed.
- `pnpm --filter @xzy-ai/commands test -- --test-name-pattern='background result raced'` — passed.

Remaining explicit scope note: `display: false` hides model-only custom messages from the ordinary transcript renderer, but those messages remain model context and persisted session data. MCP prompt command output remains intentionally user-visible because it is a slash-command response, not a hidden internal tool result. The upstream Pi session-tree implementation is external to this plugin checkout and was not patched here.
