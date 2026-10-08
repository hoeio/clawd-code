# LLM providers (Phase 4 findings)

Checked 2026-10-06. "Measured" = real API calls with the user's key; "docs" = official docs only.

## Gemini (measured)

Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`, header `x-goog-api-key`.
Body: `systemInstruction.parts[].text`, `contents[]`, `generationConfig.maxOutputTokens`, `generationConfig.thinkingConfig`.

**Model access.** `gemini-2.5-flash-lite` (the spec's default) returns
`404 "no longer available to new users. Please update your code to use models/gemini-3.5-flash-lite"`.

**Prices** (official pricing page, paid tier, $/1M tokens; output includes thinking tokens):

| model | input | output | thinking off? |
| --- | --- | --- | --- |
| gemini-3.1-flash-lite | 0.25 | 1.50 | yes: `thinkingLevel:"minimal"` or `thinkingBudget:0`; default already 0 thoughts |
| gemini-3.5-flash-lite | 0.30 | 2.50 | yes: `thinkingLevel:"minimal"` only (`thinkingBudget:0` → HTTP 400); default 0 thoughts |
| gemini-3.5-flash | 1.50 | 9.00 | `minimal` or `budget 0` → 0 thoughts; **default thinks (382 tokens)** |
| gemini-3.8-flash | 0.75 → 1.50 on 2027-01-01 | 3.75 → 7.50 | **cannot**: `minimal` → 400, `thinkingBudget:0` silently ignored (380 thoughts) |
| gemini-2.5-flash-lite | 0.10 | 0.40 | closed to new users |

Free tier: "Content used to improve our products: Yes".

**Thinking controls.** `generationConfig.thinkingConfig.thinkingLevel` / `.thinkingBudget` (camelCase). The snake_case `thinking_level` is rejected by `generateContent` (it belongs to the Interactions API).

**Usage.** `usageMetadata.promptTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount` (absent when 0), `cachedContentTokenCount`, `totalTokenCount`. Bill output as `candidates + thoughts`.

**`maxOutputTokens` caps thinking + answer combined.** On `gemini-3.5-flash` with no thinking control, 382 thought tokens hit a 400 cap (`finishReason: MAX_TOKENS`) with only 14 answer tokens. So the worst-case cost per call is bounded by the cap, but a thinking model can return an empty answer.

## Anthropic (docs: claude-api skill, cached 2026-09-25; no key to measure)

- Cheapest model: `claude-haiku-4-5`, $1 / $5. Without a `thinking` param, Haiku 4.5 does not think. Never send `thinking`.
- Newer models (Sonnet 5.5, Opus 5.5) can't fully disable thinking; that's another reason to stick to Haiku for chat.
- Usage: `usage.input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`.
- Use the official `@anthropic-ai/sdk` (skill rule for TS projects), loaded lazily only when this provider is selected.
- Streaming (2026-10-07): SDK 0.131 `client.messages.stream(params)`, `.on('text', delta)`, then `await stream.finalMessage()` gives the same message as `create()` (usage, stop_reason). No `thinking` param is sent, streamed or not.

## OpenAI-compatible (docs/secondary sources; no key to measure)

- `POST {baseUrl}/chat/completions`, `Authorization: Bearer`.
- Usage: `usage.prompt_tokens`, `completion_tokens`; reasoning models report `completion_tokens_details.reasoning_tokens`, which is included in `completion_tokens`.
- `reasoning_effort` values differ per server, so the adapter sends it only if configured. The cost bound still comes from the output-token cap.
- Streaming (2026-10-07): `stream: true, stream_options: {include_usage: true}`; text in `choices[0].delta.content`; usage only in one extra final chunk with `choices: []`; `data: [DONE]` ends it. Some compatible servers reject `stream_options` (adapter retries without it and remembers) or never send usage (adapter bills the worst case: estimated input + the full output cap). Measured against Ollama's `/v1` (qwen2.5:14b): usage is sent; first text after 124 ms.

## Ollama (measured, local, $0)

- `POST http://127.0.0.1:11434/api/chat`, `{model, messages (role system ok), stream:false, think:false, options:{num_predict}}`.
- `think:false` is accepted even by non-thinking models (llama3.2).
- Usage: `prompt_eval_count`, `eval_count`.
- Streaming (2026-10-07): `stream: true` gives one JSON object per line (`message.content` pieces); the last has `done: true`, `done_reason`, and the counts. Measured with qwen2.5:14b: 20 pieces, real counts on the last line.

## Monthly estimate (spec usage: 30 chats/day × 22 days, ~1,600 in / 80 out per call)

| model | per call | per month |
| --- | --- | --- |
| gemini-3.1-flash-lite | $0.00052 | **~$0.34** |
| gemini-3.5-flash-lite | $0.00068 | ~$0.45 |
| claude-haiku-4-5 | $0.0020 | ~$1.32 (over the $1 target) |

## Measured in the real chat path (2026-10-06)

`gemini-3.1-flash-lite` through the daemon (persona + state + snippet + memos): 4 free-form chats cost $0.00089 in total, about $0.00022 each, which implies roughly 500 input tokens per call (well under the spec's 1,600 estimate). At 660 chats/month that's **~$0.15/month**. With the hard cap set below current spend, chat answered with the budget line and made no LLM call.
