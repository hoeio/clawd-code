import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Brain, type LlmConfig } from '../src/brain.ts';
import { BudgetGuard } from '../src/budget.ts';
import type { Snapshot } from '../src/heart.ts';
import { createAdapter, type LlmRequest, type LlmResult } from '../src/llm.ts';

const snap: Snapshot = {
  state: 'working', sessionId: 's', cwd: '/p', task: 'fix cart', files: ['/p/cart.ts'], errorStreak: 0, failing: false,
  lastPlan: "I'll check cart.ts.", lastMessage: '', lastError: '', sessionStartedAt: 0, notesPath: null,
};
const llm: LlmConfig = { enabled: true, provider: 'gemini', model: 'm', apiKeyEnv: 'K', maxOutputTokens: 100 };

function setup(result: Partial<LlmResult> = {}, opts: { hard?: number; cfg?: Partial<LlmConfig> } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clawd-br-')), 'usage.json');
  const guard = new BudgetGuard({ pricing: { m: { inputPerMTok: 0.25, outputPerMTok: 1.5 } }, softMonthlyUsd: 1, hardMonthlyUsd: opts.hard ?? 3, file, now: () => new Date(2026, 9, 15).getTime() });
  const calls: LlmRequest[] = [];
  const brain = new Brain({
    llm: { ...llm, ...opts.cfg }, guard, env: { K: 'key' },
    adapterFactory: () => ({ call: async req => { calls.push(req); return { text: '응, 커피는 세 잔째야.', inputTokens: 500, outputTokens: 20, thinkingTokens: 0, truncated: false, ...result }; } }),
  });
  return { brain, guard, calls };
}

test('replies and records actual usage', async () => {
  const { brain, guard } = setup();
  const out = await brain.reply('커피 더 마실까?', snap, []);
  assert.equal(out.kind, 'reply');
  assert.ok(Math.abs(guard.status().monthUsd - (500 * 0.25 + 20 * 1.5) / 1e6) < 1e-12);
});

test('no call without key, without price, or over budget', async () => {
  const noKey = setup({}, {});
  (noKey.brain as any).o.env = {};
  assert.deepEqual(await noKey.brain.reply('x', snap, []), { kind: 'refused', reason: 'no_key' });
  const noPrice = setup({}, { cfg: { model: 'unpriced' } });
  assert.deepEqual(await noPrice.brain.reply('x', snap, []), { kind: 'refused', reason: 'no_price' });
  const broke = setup({}, { hard: 0.00001 });
  assert.equal((await broke.brain.reply('x', snap, [])).kind, 'refused');
  assert.equal(noKey.calls.length + noPrice.calls.length + broke.calls.length, 0);
});

test('a model that thinks anyway gets refused afterwards', async () => {
  const { brain, calls } = setup({ thinkingTokens: 50, outputTokens: 70 });
  assert.equal((await brain.reply('x', snap, [])).kind, 'reply');
  assert.deepEqual(await brain.reply('y', snap, []), { kind: 'refused', reason: 'broken' });
  assert.equal(calls.length, 1);
});

test('prompt diet: persona first, only 3 verbatim turns, older ones as memos, secrets redacted', async () => {
  const { brain, calls } = setup();
  for (let i = 1; i <= 6; i++) brain.noteTurn(`question ${i}`, `answer ${i}`);
  await brain.reply('my key is sk-ant-api03-abcdefghijklmnopqrstuvwx, ok?', snap, []);
  const req = calls[0];
  assert.ok(req.system.startsWith('You are Clawd'));
  assert.ok(req.system.includes('- user: "question 1"') && req.system.includes('- user: "question 3"'));
  assert.deepEqual(req.messages.map(m => m.content).slice(0, 6), ['question 4', 'answer 4', 'question 5', 'answer 5', 'question 6', 'answer 6']);
  assert.ok(!JSON.stringify(req).includes('abcdefghijklmnop'));
  assert.ok(req.system.includes("my latest words in the terminal: \"I'll check cart.ts.\""));
  assert.equal(req.maxOutputTokens, 100);
});

test('moments: the brain may SKIP; spoken lines are remembered so they are not repeated', async () => {
  const quiet = setup({ text: 'SKIP.' });
  assert.deepEqual(await quiet.brain.react({ what: 'I just finished a turn.', mustSpeak: false }, snap, []), { kind: 'skip' });
  assert.match(quiet.calls[0].messages.at(-1)!.content, /Not from the user.*finished a turn.*SKIP/s);

  const { brain, calls, guard } = setup({ text: 'Done, and nothing is on fire.' });
  const out = await brain.react({ what: 'I am paused for approval.', mustSpeak: true }, snap, []);
  assert.equal(out.kind, 'reply');
  assert.ok(!calls[0].messages.at(-1)!.content.includes('SKIP')); // must speak: no way out
  assert.ok(guard.status().monthUsd > 0); // moments go through the budget guard too
  await brain.react({ what: 'x', mustSpeak: false }, snap, []);
  assert.ok(calls[1].system.includes('- "Done, and nothing is on fire."'));
});

test('truncated output is cut back to a full sentence', async () => {
  const { brain } = setup({ text: 'Two of three pass. The last one is a ty', truncated: true });
  assert.deepEqual((await brain.reply('x', snap, [])) as any, { kind: 'reply', text: 'Two of three pass.', usd: (500 * 0.25 + 20 * 1.5) / 1e6, model: 'm' });
});

test('streaming: phrases go out while the reply is still being written', async () => {
  const phrases: string[] = [];
  const brain = new Brain({
    llm, guard: setup().guard, env: { K: 'key' },
    adapterFactory: () => ({ call: async req => {
      for (const d of ['Two of three', ' pass, and the last', ' one is a type issue.']) { req.onText?.(d); await new Promise(r => setImmediate(r)); }
      return { text: 'Two of three pass, and the last one is a type issue.', inputTokens: 500, outputTokens: 20, thinkingTokens: 0, truncated: false };
    } }),
  });
  const out = await brain.reply('how is it?', snap, [], p => phrases.push(p));
  assert.equal(out.kind, 'reply');
  assert.deepEqual(phrases, ['Two of three pass,', 'and the last one is a type issue.']);
});

test('streaming: an adapter that does not stream still gets its reply said, once', async () => {
  const phrases: string[] = [];
  const { brain } = setup({ text: 'All quiet here.' });
  await brain.reply('x', snap, [], p => phrases.push(p));
  assert.deepEqual(phrases, ['All quiet here.']);
  const skip = setup({ text: 'SKIP' });
  await skip.brain.react({ what: 'x', mustSpeak: false }, snap, [], p => phrases.push(p));
  assert.deepEqual(phrases, ['All quiet here.']); // SKIP is never said
});

test('mood: the tag sets the mood, is never in the text, and stays in history', async () => {
  const phrases: [string, string | undefined][] = [];
  const { brain, calls } = setup({ text: '[soft] Hey, it is late. The bug will keep until morning.' });
  const out = await brain.reply('still stuck', snap, [], (p, m) => phrases.push([p, m]));
  assert.equal(out.kind, 'reply');
  assert.equal((out as any).text, 'Hey, it is late. The bug will keep until morning.');
  assert.equal((out as any).mood, 'soft');
  assert.deepEqual(phrases.map(p => p[1]), phrases.map(() => 'soft'));
  assert.ok(!phrases.some(p => p[0].includes('[')));
  assert.match(calls[0].system, /\[cheerful\] \[excited\] \[calm\] \[soft\] \[worried\] \[sleepy\]/);
  brain.noteTurn('still stuck', (out as any).text, (out as any).mood);
  await brain.reply('ok', snap, []);
  assert.equal(calls[1].messages.at(-2)!.content, '[soft] Hey, it is late. The bug will keep until morning.');
});

// --- Gemini adapter against a mocked fetch ---
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('gemini: streams text as it arrives and reads usage from the last chunk', async () => {
  let url = '';
  const sse = [
    { candidates: [{ content: { parts: [{ text: 'Two of three' }] } }] },
    { candidates: [{ content: { parts: [{ text: ' pass.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 0 } },
  ].map(j => `data: ${JSON.stringify(j)}\r\n\r\n`).join('');
  globalThis.fetch = (async (u: string) => { url = u; return new Response(sse, { status: 200 }); }) as any;
  const got: string[] = [];
  const r = await createAdapter({ provider: 'gemini', model: 'g', apiKey: 'k' })
    .call({ system: 's', messages: [{ role: 'user', content: 'q' }], maxOutputTokens: 60, onText: d => got.push(d) });
  assert.match(url, /:streamGenerateContent\?alt=sse$/);
  assert.deepEqual(got, ['Two of three', ' pass.']);
  assert.deepEqual(r, { text: 'Two of three pass.', inputTokens: 10, outputTokens: 4, thinkingTokens: 0, truncated: false });
});

test('gemini: tries thinkingLevel minimal, falls back to thinkingBudget 0, counts thoughts as output', async () => {
  const bodies: any[] = [];
  globalThis.fetch = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.generationConfig.thinkingConfig.thinkingLevel) return new Response('{"error":{"message":"bad"}}', { status: 400 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, thoughtsTokenCount: 5 } }), { status: 200 });
  }) as any;
  const a = createAdapter({ provider: 'gemini', model: 'g', apiKey: 'k' });
  const r = await a.call({ system: 's', messages: [{ role: 'user', content: 'q' }], maxOutputTokens: 100 });
  assert.deepEqual(bodies.map(b => b.generationConfig.thinkingConfig), [{ thinkingLevel: 'minimal' }, { thinkingBudget: 0 }]);
  assert.deepEqual(r, { text: 'hi', inputTokens: 10, outputTokens: 8, thinkingTokens: 5, truncated: false });
  await a.call({ system: 's', messages: [{ role: 'user', content: 'q' }], maxOutputTokens: 100 });
  assert.equal(bodies.length, 3); // remembered which form works
  assert.equal(bodies[0].systemInstruction.parts[0].text, 's');
});

// --- Streaming for the other providers (mocked servers) ---
const ask = { system: 's', messages: [{ role: 'user' as const, content: 'q' }], maxOutputTokens: 60 };
const sseBody = (events: unknown[]) => events.map(j => `data: ${typeof j === 'string' ? j : JSON.stringify(j)}\n\n`).join('');

test('openai: streams deltas; usage from the final empty-choices chunk', async () => {
  const bodies: any[] = [];
  globalThis.fetch = (async (_u: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    return new Response(sseBody([
      { choices: [{ delta: { role: 'assistant', content: '' } }] },
      { choices: [{ delta: { content: 'Two of three' } }] },
      { choices: [{ delta: { content: ' pass.' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 0 } } },
      '[DONE]',
    ]), { status: 200 });
  }) as any;
  const got: string[] = [];
  const r = await createAdapter({ provider: 'openai', model: 'o', apiKey: 'k' }).call({ ...ask, onText: d => got.push(d) });
  assert.deepEqual(got, ['Two of three', ' pass.']);
  assert.deepEqual(r, { text: 'Two of three pass.', inputTokens: 12, outputTokens: 4, thinkingTokens: 0, truncated: false });
  assert.equal(bodies[0].stream, true);
  assert.deepEqual(bodies[0].stream_options, { include_usage: true });
});

test('openai-compatible: no stream_options support -> retried without; no usage -> billed worst case', async () => {
  const bodies: any[] = [];
  globalThis.fetch = (async (_u: string, init: any) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.stream_options) return new Response('{"error":{"message":"unknown field stream_options"}}', { status: 400 });
    return new Response(sseBody([{ choices: [{ delta: { content: 'Hi.' }, finish_reason: 'length' }] }, '[DONE]']), { status: 200 });
  }) as any;
  const a = createAdapter({ provider: 'openai', model: 'o', apiKey: 'k', baseUrl: 'http://local/v1' });
  const r = await a.call({ ...ask, onText: () => {} });
  assert.equal(r.text, 'Hi.');
  assert.equal(r.truncated, true);
  assert.equal(r.outputTokens, 60); // never told: assume the maximum
  assert.ok(r.inputTokens > 0);
  await a.call({ ...ask, onText: () => {} });
  assert.equal(bodies.length, 3); // remembered: no stream_options from then on
});

test('ollama: streams one JSON object per line; counts from the done line', async () => {
  let body: any;
  globalThis.fetch = (async (_u: string, init: any) => {
    body = JSON.parse(init.body);
    const lines = [
      { message: { role: 'assistant', content: 'Two of three' }, done: false },
      { message: { role: 'assistant', content: ' pass.' }, done: false },
      { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 30, eval_count: 5 },
    ].map(l => JSON.stringify(l)).join('\n');
    return new Response(lines, { status: 200 });
  }) as any;
  const got: string[] = [];
  const r = await createAdapter({ provider: 'ollama', model: 'llama', apiKey: '' }).call({ ...ask, onText: d => got.push(d) });
  assert.equal(body.stream, true);
  assert.equal(body.think, false);
  assert.deepEqual(got, ['Two of three', ' pass.']);
  assert.deepEqual(r, { text: 'Two of three pass.', inputTokens: 30, outputTokens: 5, thinkingTokens: 0, truncated: false });
});

test('anthropic: streams text through the SDK; usage from the final message', async () => {
  let body: any;
  globalThis.fetch = (async (_u: any, init: any) => {
    body = JSON.parse(init.body);
    const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    const stream = [
      ev('message_start', { message: { id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, output_tokens: 1 } } }),
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Two of three' } }),
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: ' pass.' } }),
      ev('content_block_stop', { index: 0 }),
      ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 6 } }),
      ev('message_stop', {}),
    ].join('');
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as any;
  const got: string[] = [];
  const r = await createAdapter({ provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'k' }).call({ ...ask, onText: d => got.push(d) });
  assert.equal(body.stream, true);
  assert.equal(body.thinking, undefined); // thinking stays off
  assert.deepEqual(got, ['Two of three', ' pass.']);
  assert.deepEqual(r, { text: 'Two of three pass.', inputTokens: 40, outputTokens: 6, thinkingTokens: 0, truncated: false });
});
