# TUI Tool Rendering Migration Log

This document records the per-tool migration from raw tool payload rendering to concise, user-facing activity rendering. Collapsed rows expose only high-level activity and safe identifiers; Pi's built-in expanded state reveals explicitly approved prompts, answers, bodies, and MCP payloads after credential and unsafe-identifier sanitization. The model continues to receive the full tool arguments and result.

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
| `agent` | tools | `agent • <subagent type> • <job title>` | collapsed status/title; expanded full `Instructions: <prompt>` on success; errors omit prompt | Changed; verification pending |
| `agent_cancel` | tools | host default | `Agent <subagent type> • <job ID> cancelled`; errors remain simple | Changed; verification pending |
| `agent_status` | tools | host default | `Agent <subagent type> • <job ID> <status>` | Changed; verification pending |
| `agent_jobs` | tools | host default | collapsed count; expanded subagent type, job ID, status, and job title | Changed; verification pending |
| `agent_list` | tools | host default | collapsed count; expanded names and descriptions | Changed; verification pending |
| `question` | tools | host default | collapsed answered/cancelled; expanded answer; unsafe details remain sanitized | Changed; verification pending |
| `goal_create` | tools | host default | collapsed `Goal created`; expanded interval and exact prompt; errors omit prompt | Changed; verification pending |
| `goal_pause` | tools | host default | collapsed `Goal paused`; expanded reason; errors omit reason | Changed; verification pending |
| `goal_resume` | tools | host default | collapsed `Goal resumed`; expanded prompt; errors omit prompt | Changed; verification pending |
| `goal_status` | tools | host default | collapsed status; expanded prompt, interval, status, and pause reason | Changed; verification pending |
| `goal_clear` | tools | host default | collapsed cleared/retained; expanded prompt; errors omit prompt | Changed; verification pending |
| `web_search` | tools | `web_search • <query>` | collapsed result count; expanded full returned body; persistence metadata omitted | Changed; verification pending |
| `web_fetch` | tools | `web_fetch • <url>` | collapsed content type and line count; expanded full fetched body | Changed; verification pending |
| `knowledge_search` | tools | `knowledge_search • <query/mode>` | collapsed count; expanded excerpts/page body | Changed; verification pending |
| `telegram_chat` | tools | host default | collapsed action/sent; expanded approved message text and safe metadata; tokens, chat IDs, and media credentials remain hidden | Changed; verification pending |
| `mcp_*` dynamic tools | mcp | MCP tool and server | collapsed completed/failed; expanded sanitized response payload | Changed; verification pending |
| `mcp_resources_list` | mcp | MCP resource list and server | collapsed outcome; expanded sanitized resource payload | Changed; verification pending |
| `mcp_resources_read` | mcp | MCP resource read, server, URI | collapsed outcome; expanded sanitized resource body | Changed; verification pending |

## Verification record

### 2026-08-16 — first per-tool renderer pass

- `agent`: shows subagent type plus bounded description; result shows returned job ID when available. Verified with focused tool-render test.
- `agent_cancel` / `agent_status`: show the target job ID; status shows the current status. Verified with focused tool-render test.
- `agent_jobs` / `agent_list`: retain concise list activity and hide full lists from the tool row. Verified with focused tool-render test.
- `question`: uses the host default call renderer; result shows answered/cancelled state and expanded successful answer. Existing renderer tests updated and passed.
- `goal_create` / `goal_pause` / `goal_resume` / `goal_status`: show the specific lifecycle action while exact prompts, pause reasons, and full records are available only in expanded successful views. `goal_clear` distinguishes clearing a completed goal from evaluating an incomplete one. Verified with focused tool-render test.
- `web_search` / `web_fetch`: show bounded query/URL; collapsed bodies remain hidden and expanded successful views reveal sanitized bodies. Verified with focused tool-render test.
- `knowledge_search`: shows bounded query or discovery mode; collapsed excerpts remain hidden and expanded successful views reveal sanitized excerpts/page content. Verified with focused tool-render test.
- `telegram_chat`: uses the host default call renderer; collapsed results show action/outcome, while expanded successful text may show the message with credentials and unsafe identifiers sanitized. Verified with focused tool-render test.
- Dynamic MCP tools: show stable tool label and server name; payloads are available only in expanded results after sanitization. MCP focused tests passed.
- MCP resource tools: show server and resource URI at a bounded high level; expanded results may show sanitized bodies. MCP focused tests passed.
- Added focused renderer regression coverage for pi-c2 tools, MCP tools/resources, and updated the existing question renderer expectations.

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

- `pnpm test:all --tests-only` — passed before the expanded MCP renderer pass; rerun after final changes.
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
