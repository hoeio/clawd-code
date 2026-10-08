# Hook events (Phase 0 findings)

Measured on Claude Code 2.1.288, macOS, Node 24, 2026-10-06.
Sources: https://code.claude.com/docs/en/hooks plus real payloads captured by `phase0/hook.sh` and `phase0/log-server.mjs` (`docs/sample-events.jsonl`).
Docs were only a starting point: the docs summary named a `tool_output` field, but the real payload uses `tool_response`. **Trust the captured payloads over the docs.**

## Common fields (every event)

| field | notes |
| --- | --- |
| `session_id` | UUID; equals the transcript file name |
| `transcript_path` | `~/.claude/projects/<cwd with / and _ → ->/<session_id>.jsonl` |
| `cwd` | project dir |
| `hook_event_name` | |
| `prompt_id` | on everything except SessionStart; groups one user turn |
| `permission_mode` | e.g. `default` (not on SessionStart/SessionEnd) |

## Events we use

| event | extra fields (observed) | maps to |
| --- | --- | --- |
| `SessionStart` | `source`: `startup\|resume\|clear\|compact` | `session_started`, starts daemon |
| `UserPromptSubmit` | `prompt` (full text) | `prompt_submitted` |
| `PostToolUse` | `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, `duration_ms` | `tool_finished{success:true}` |
| `PostToolUseFailure` | `tool_name`, `tool_input`, `tool_use_id`, `error` (string, e.g. `"Exit code 1\ncat: nope.txt: ..."`), `is_interrupt`, `duration_ms` | `tool_finished{success:false}` |
| `Notification` | `message`, `notification_type` (`permission_prompt`, `idle_prompt`, …) | `approval_needed` (**docs only, not yet captured**: needs an interactive session) |
| `Stop` | `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons` | `turn_finished` |
| `SessionEnd` | `reason` | optional: go `sleepy` |

`tool_response` shape depends on the tool: Write gives `{type, filePath, content, structuredPatch, originalFile}`; Bash gives `{stdout, stderr, interrupted, ...}`.

**A failed tool call does NOT fire `PostToolUse`.** It fires only `PostToolUseFailure`. We need both to count error streaks.

## Return formats (verified live)

- **UserPromptSubmit, add context:** print to stdout
  `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}`
  Verified: the model repeated the injected secret word.
- **Stop, make Claude continue:** print `{"decision":"block","reason":"..."}`.
  Claude gets the reason as a user message `"Stop hook feedback:\n<reason>"` and keeps going. The next Stop arrives with `stop_hook_active: true`; returning nothing then lets it stop. This is the built-in loop guard.
- **Async hooks (`"async": true`) can't return anything**, so the two handoff hooks must run synchronously. That only applies when handoff is enabled; everything else stays async.

## Non-blocking and overhead

Hook entry: `{"type":"command","command":"<path>/hook.sh <Event>","async":true}`.
`hook.sh` reads stdin, starts `curl -m 1` in a detached subshell, and exits 0.

| case | median | p95 |
| --- | --- | --- |
| bare `sh` spawn (baseline) | 2.65 ms | |
| hook.sh, daemon up | 4.30 ms | 5.62 ms |
| hook.sh, daemon down | 4.07 ms | 7.13 ms |

Our script adds about 1.5 ms on top of process spawn, and `async: true` keeps even that off Claude's critical path. No Node startup per call.

**Rejected: native `type: "http"` hooks.** When the daemon was down, Claude Code showed `hook error occurred · ctrl+o to see` and logged `ECONNREFUSED` in the transcript. That's visible degradation, so we use the shell + curl script.

## Transcript (`transcript_path`) format

JSONL, append-only, **one content block per line**. Entry `type`s seen: `user`, `assistant`, `attachment`, `system` (`subtype: stop_hook_summary`), `queue-operation`, `last-prompt`, `atis-latch`, `cost-state`.

- `assistant`: `message.content[0].type` is one of `text` (Claude's words), `tool_use` (`name`, `input`, `id`), or `thinking` (**text empty, signature only; unusable**).
- `user`: `message.content` is either a string (the prompt, or `"Stop hook feedback:..."` with `isMeta: true`) or `[{type:"tool_result", content, is_error, tool_use_id}]`.
- Common: `uuid`, `parentUuid`, `timestamp`, `sessionId`, `cwd`, `gitBranch`, `isSidechain` (true for subagent entries; skip those).

Consequence: the final explanation comes straight from `Stop.last_assistant_message`, no transcript read needed. The transcript is only needed for mid-turn "plan sentences" (`assistant` `text` blocks before a `tool_use`). All of that stays in one adapter, tailing from the last byte offset.

## Still open

- `Notification` / `permission_prompt` payload: capture it in the first real interactive session (Phase 1).
- LLM provider checks (reasoning off, usage fields, prices): deferred to Phase 4 so prices are current when we use them.
- Clawd usage terms: waiting for the link.
