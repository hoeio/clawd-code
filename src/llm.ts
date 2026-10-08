// Provider adapters. Only brain.ts may use these, and only through the budget guard.
// Every adapter turns reasoning/thinking OFF and reports real token usage. See docs/llm-providers.md.
// Every adapter streams when the request has onText, so the voice can start before the reply is done.
import { estimateTokens } from './budget.ts';

export interface ChatTurn { role: 'user' | 'assistant'; content: string }
export interface LlmRequest {
  system: string;
  messages: ChatTurn[];
  maxOutputTokens: number;
  /** Streaming: called with each new piece of text. */
  onText?: (delta: string) => void;
}
export interface LlmResult {
  text: string;
  inputTokens: number;
  outputTokens: number; // billed output, thinking included
  thinkingTokens: number;
  truncated: boolean;
}
export interface Adapter { call(req: LlmRequest): Promise<LlmResult> }
export interface AdapterConfig { provider: string; model: string; apiKey: string; baseUrl?: string; reasoningEffort?: string }

export class LlmError extends Error {
  readonly permanent: boolean; // config problem: retrying won't help
  constructor(message: string, permanent = false) {
    super(message);
    this.permanent = permanent;
  }
}

const TIMEOUT_MS = 20_000;

export function createAdapter(c: AdapterConfig): Adapter {
  switch (c.provider) {
    case 'gemini': return new GeminiAdapter(c);
    case 'anthropic': return new AnthropicAdapter(c);
    case 'openai': return new OpenAiAdapter(c);
    case 'ollama': return new OllamaAdapter(c);
    default: throw new LlmError(`unknown provider "${c.provider}"`, true);
  }
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

// --- Gemini ---------------------------------------------------------------
// Thinking off: thinkingLevel "minimal" (3.x), else thinkingBudget 0 (2.5 / 3.1).
// Some models accept neither, or silently ignore budget 0 (3.8-flash): thoughtsTokenCount > 0
// is reported as thinkingTokens and the brain refuses the model from then on.
const GEMINI_THINKING_OFF = [{ thinkingLevel: 'minimal' }, { thinkingBudget: 0 }];

class GeminiAdapter implements Adapter {
  private c: AdapterConfig;
  private mode = 0; // index into GEMINI_THINKING_OFF that this model accepts
  constructor(c: AdapterConfig) { this.c = c; }

  async call(req: LlmRequest): Promise<LlmResult> {
    const base = this.c.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
    const stream = !!req.onText;
    for (; this.mode < GEMINI_THINKING_OFF.length; this.mode++) {
      const res = await fetch(`${base}/models/${encodeURIComponent(this.c.model)}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.c.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: req.system }] },
          contents: req.messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
          generationConfig: { maxOutputTokens: req.maxOutputTokens, thinkingConfig: GEMINI_THINKING_OFF[this.mode] },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 400) continue; // this thinking-off form isn't supported here: try the next one
      if (res.status !== 200) {
        const json: any = await res.json().catch(() => ({}));
        throw new LlmError(`gemini HTTP ${res.status}: ${json.error?.message ?? ''}`, res.status === 401 || res.status === 403 || res.status === 404);
      }
      // Streamed: one JSON chunk per `data:` line, each with new text; usage totals come on the last ones.
      const chunks: any[] = stream ? await readJsonLines(res, json => {
        const t = geminiText(json);
        if (t) req.onText!(t);
      }, true) : [await res.json()];
      const last = chunks.at(-1) ?? {};
      const u = chunks.findLast(c => c.usageMetadata)?.usageMetadata ?? {};
      const thinkingTokens = u.thoughtsTokenCount ?? 0;
      return {
        text: chunks.map(geminiText).join(''),
        inputTokens: u.promptTokenCount ?? 0,
        outputTokens: (u.candidatesTokenCount ?? 0) + thinkingTokens,
        thinkingTokens,
        truncated: chunks.some(c => c.candidates?.[0]?.finishReason === 'MAX_TOKENS') || last.candidates?.[0]?.finishReason === 'MAX_TOKENS',
      };
    }
    throw new LlmError(`${this.c.model} rejects every way of turning thinking off`, true);
  }
}

const geminiText = (json: any): string => (json.candidates?.[0]?.content?.parts ?? []).filter((p: any) => !p.thought).map((p: any) => p.text ?? '').join('');

/** Reads a streamed body of JSON lines (NDJSON, or SSE with sse=true: only `data:` lines; `[DONE]` is skipped). */
async function readJsonLines(res: Response, onJson: (json: any) => void, sse = false): Promise<any[]> {
  const out: any[] = [];
  const decoder = new TextDecoder();
  let buf = '';
  const take = (raw: string) => {
    let line = raw.trim();
    if (sse) { if (!line.startsWith('data:')) return; line = line.slice(5); }
    if (!line) return;
    try { const json = JSON.parse(line); out.push(json); onJson(json); } catch {}
  };
  for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(part, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) { take(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
  }
  take(buf);
  return out;
}

async function postStream(url: string, headers: Record<string, string>, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/** A server that streamed but never said what it used: bill the most it could have been. */
const worstCase = (req: LlmRequest) => ({
  inputTokens: estimateTokens(req.system + req.messages.map(m => m.content).join('\n')),
  outputTokens: req.maxOutputTokens,
});

// --- Anthropic (official SDK, loaded only when used) ------------------------
// Thinking off: never send `thinking`. Use a model that doesn't think by default (claude-haiku-4-5).
class AnthropicAdapter implements Adapter {
  private c: AdapterConfig;
  private client: any;
  constructor(c: AdapterConfig) { this.c = c; }

  async call(req: LlmRequest): Promise<LlmResult> {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    this.client ??= new Anthropic({ apiKey: this.c.apiKey, ...(this.c.baseUrl ? { baseURL: this.c.baseUrl } : {}), timeout: TIMEOUT_MS, maxRetries: 1 });
    try {
      const params = { model: this.c.model, max_tokens: req.maxOutputTokens, system: req.system, messages: req.messages };
      let r;
      if (req.onText) {
        const s = this.client.messages.stream(params);
        s.on('text', (d: string) => req.onText!(d));
        r = await s.finalMessage(); // usage and stop reason, as with create()
      } else r = await this.client.messages.create(params);
      const thinkingBlocks = r.content.filter((b: any) => b.type === 'thinking' || b.type === 'redacted_thinking').length;
      return {
        text: r.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(''),
        inputTokens: r.usage.input_tokens + (r.usage.cache_creation_input_tokens ?? 0) + (r.usage.cache_read_input_tokens ?? 0),
        outputTokens: r.usage.output_tokens,
        thinkingTokens: thinkingBlocks ? r.usage.output_tokens : 0, // tokens aren't split out; flag it
        truncated: r.stop_reason === 'max_tokens',
      };
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.NotFoundError || e instanceof Anthropic.BadRequestError) throw new LlmError(`anthropic: ${e.message}`, true);
      if (e instanceof Anthropic.APIError) throw new LlmError(`anthropic HTTP ${e.status}: ${e.message}`);
      throw e;
    }
  }
}

// --- OpenAI-compatible ------------------------------------------------------
// Thinking: completion tokens include reasoning tokens, and max_completion_tokens caps both.
// reasoning_effort varies by server, so it's sent only when configured.
// Streaming: usage comes in one extra final chunk (empty choices) only with stream_options.include_usage.
// Some compatible servers reject that option (retried without it) or never send usage (billed worst case).
class OpenAiAdapter implements Adapter {
  private c: AdapterConfig;
  private usageOption = true;
  constructor(c: AdapterConfig) { this.c = c; }

  async call(req: LlmRequest): Promise<LlmResult> {
    const base = (this.c.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    const body = {
      model: this.c.model,
      messages: [{ role: 'system', content: req.system }, ...req.messages],
      max_completion_tokens: req.maxOutputTokens,
      ...(this.c.reasoningEffort ? { reasoning_effort: this.c.reasoningEffort } : {}),
    };
    const headers = { Authorization: `Bearer ${this.c.apiKey}` };
    const fail = (status: number, json: any) => new LlmError(`openai HTTP ${status}: ${json.error?.message ?? ''}`, status === 400 || status === 401 || status === 404);
    if (!req.onText) {
      const { status, json } = await postJson(`${base}/chat/completions`, headers, body);
      if (status !== 200) throw fail(status, json);
      return openAiResult(json.choices?.[0]?.message?.content ?? '', json.choices?.[0]?.finish_reason, json.usage, req);
    }
    let res = await postStream(`${base}/chat/completions`, headers, { ...body, stream: true, ...(this.usageOption ? { stream_options: { include_usage: true } } : {}) });
    if (res.status === 400 && this.usageOption) { // an older compatible server that doesn't know stream_options
      this.usageOption = false;
      res = await postStream(`${base}/chat/completions`, headers, { ...body, stream: true });
    }
    if (res.status !== 200) throw fail(res.status, await res.json().catch(() => ({})));
    let text = '', finish: string | undefined, usage: any;
    await readJsonLines(res, j => {
      const d = j.choices?.[0]?.delta?.content;
      if (d) { text += d; req.onText!(d); }
      finish = j.choices?.[0]?.finish_reason ?? finish;
      usage = j.usage ?? usage;
    }, true);
    return openAiResult(text, finish, usage, req);
  }
}

function openAiResult(text: string, finish: string | undefined, u: any, req: LlmRequest): LlmResult {
  const known = u && typeof u.prompt_tokens === 'number';
  return {
    text,
    ...(known ? { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens ?? 0 } : worstCase(req)),
    thinkingTokens: u?.completion_tokens_details?.reasoning_tokens ?? 0,
    truncated: finish === 'length',
  };
}

// --- Ollama (local, free) ---------------------------------------------------
class OllamaAdapter implements Adapter {
  private c: AdapterConfig;
  constructor(c: AdapterConfig) { this.c = c; }

  async call(req: LlmRequest): Promise<LlmResult> {
    const base = (this.c.baseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
    // Streamed as one JSON object per line; the last one (done: true) carries the token counts.
    const res = await postStream(`${base}/api/chat`, {}, {
      model: this.c.model, stream: !!req.onText, think: false,
      messages: [{ role: 'system', content: req.system }, ...req.messages],
      options: { num_predict: req.maxOutputTokens },
    });
    if (res.status !== 200) {
      const json: any = await res.json().catch(() => ({}));
      throw new LlmError(`ollama HTTP ${res.status}: ${json.error ?? ''}`, res.status === 404);
    }
    let text = '', thinking = false, last: any = {};
    await readJsonLines(res, j => {
      const d = j.message?.content ?? '';
      if (d) { text += d; req.onText?.(d); }
      if (j.message?.thinking) thinking = true;
      last = j;
    });
    return {
      text,
      inputTokens: last.prompt_eval_count ?? 0, // local and free: real counts if given, else 0
      outputTokens: last.eval_count ?? 0,
      thinkingTokens: thinking ? 1 : 0,
      truncated: last.done_reason === 'length',
    };
  }
}
