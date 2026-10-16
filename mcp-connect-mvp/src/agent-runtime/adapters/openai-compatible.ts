/**
 * Agent runtime — OpenAI-compatible chat/completions adapter.
 * Serves openai-api, deepseek, xai, zai, moonshot, nvidia-router (NIM) and
 * ollama. Takes a `fetchImpl` so the webview can pass `relayFetch` (NIM sends
 * no CORS headers) and Node passes the global fetch.
 *
 * Streams SSE (`stream_options.include_usage` for the trailing usage chunk),
 * accumulates `tool_calls` deltas by index, and replays native assistant
 * `tool_calls` + `role:'tool'` messages verbatim on the next turn.
 */
import type { ToolLoopAdapter, TurnRequest, ModelTurn, LoopMessage, LoopToolCall, TurnUsage } from '../types';
import { parseSseJson } from '../sse';
import { anySignal, timeoutSignal, throwIfAborted } from '../signals';

export interface OpenAICompatibleAdapterOptions {
  fetchImpl?: typeof fetch;
  baseUrl: string;                 // e.g. https://api.deepseek.com/v1
  apiKey: string;
  model: string;
  provider: string;
  extraHeaders?: Record<string, string>;
  stream?: boolean;                // default true
  maxTokens?: number;              // default 16384
  temperature?: number;
  /** Abort a streaming response with no bytes for this long (default 90s). */
  idleTimeoutMs?: number;
  includeUsage?: boolean;          // default true (stream_options.include_usage)
}

interface OAIToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
interface OAIUsage { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }

function toUsage(u?: OAIUsage | null): TurnUsage | undefined {
  if (!u) return undefined;
  return {
    inputTokens: u.prompt_tokens || 0,
    outputTokens: u.completion_tokens || 0,
    cacheReadTokens: u.prompt_tokens_details?.cached_tokens || undefined,
  };
}

function parseArgs(raw: string): { args: Record<string, unknown>; rawArgs?: string } {
  if (!raw || !raw.trim()) return { args: {} };
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? { args: v as Record<string, unknown> } : { args: {}, rawArgs: raw };
  } catch {
    return { args: {}, rawArgs: raw };
  }
}

/** Convert loop messages to the OpenAI wire format (native assistant replay keeps tool_call ids). */
export function toOpenAIMessages(system: string, messages: LoopMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      if (m.native) { out.push(m.native as Record<string, unknown>); continue; }
      const msg: Record<string, unknown> = { role: 'assistant', content: m.content || null };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.rawArgs ?? JSON.stringify(c.args) } }));
      }
      out.push(msg);
    } else {
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    }
  }
  return out;
}

export function openaiCompatibleAdapter(o: OpenAICompatibleAdapterOptions): ToolLoopAdapter {
  const fetchImpl = o.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const stream = o.stream ?? true;
  const includeUsage = o.includeUsage ?? true;
  const url = `${o.baseUrl.replace(/\/$/, '')}/chat/completions`;

  return {
    provider: o.provider,
    model: o.model,
    async turn(req: TurnRequest): Promise<ModelTurn> {
      const body: Record<string, unknown> = {
        model: o.model,
        messages: toOpenAIMessages(req.system, req.messages),
        max_tokens: o.maxTokens ?? 16384,
        stream,
      };
      if (o.temperature != null) body.temperature = o.temperature;
      if (req.tools.length) {
        body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
        body.tool_choice = 'auto';
      }
      if (stream && includeUsage) body.stream_options = { include_usage: true };

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(o.apiKey ? { Authorization: `Bearer ${o.apiKey}` } : {}),
        ...(o.extraHeaders || {}),
      };

      throwIfAborted(req.signal);
      const resp = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: req.signal });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status} from ${o.provider}: ${text.slice(0, 500)}`);
      }

      if (!stream) {
        const data = await resp.json() as { choices?: Array<{ message?: { content?: string | null; tool_calls?: OAIToolCall[] }; finish_reason?: string }>; usage?: OAIUsage };
        const msg = data.choices?.[0]?.message || {};
        const text = msg.content || '';
        if (text && req.onText) req.onText(text);
        const toolCalls: LoopToolCall[] = (msg.tool_calls || []).map((tc) => ({ id: tc.id, name: tc.function.name, ...parseArgs(tc.function.arguments) }));
        return { text, toolCalls, usage: toUsage(data.usage), stopReason: data.choices?.[0]?.finish_reason, native: { role: 'assistant', content: text || null, ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) } };
      }

      // Streaming: reset the idle watchdog on every chunk.
      let idle = timeoutSignal(o.idleTimeoutMs ?? 90_000, `${o.provider} stream idle`);
      const readSignal = () => anySignal([req.signal, idle]);
      let text = '';
      const acc = new Map<number, { id: string; name: string; args: string }>();
      let usage: TurnUsage | undefined;
      let finish: string | undefined;

      type Chunk = { choices?: Array<{ delta?: { content?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string | null }>; usage?: OAIUsage | null };
      // We can't swap the signal on a running generator, so check idle manually per chunk.
      for await (const { json } of parseSseJson<Chunk>(resp.body, req.signal)) {
        throwIfAborted(readSignal());
        idle = timeoutSignal(o.idleTimeoutMs ?? 90_000, `${o.provider} stream idle`);
        // The usage chunk arrives with EMPTY choices — capture it before skipping.
        if (json.usage) usage = toUsage(json.usage);
        const choice = json.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finish = choice.finish_reason;
        const delta = choice.delta;
        if (!delta) continue;
        if (delta.content) { text += delta.content; req.onText?.(delta.content); }
        for (const tc of delta.tool_calls || []) {
          const slot = acc.get(tc.index) || { id: '', name: '', args: '' };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name += tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          acc.set(tc.index, slot);
        }
      }

      const nativeCalls: OAIToolCall[] = [...acc.entries()].sort((a, b) => a[0] - b[0]).map(([i, c]) => ({
        id: c.id || `call_${i}`, type: 'function', function: { name: c.name, arguments: c.args || '{}' },
      }));
      const toolCalls: LoopToolCall[] = nativeCalls.map((tc) => ({ id: tc.id, name: tc.function.name, ...parseArgs(tc.function.arguments) }));
      return {
        text,
        toolCalls,
        usage,
        stopReason: finish,
        native: { role: 'assistant', content: text || null, ...(nativeCalls.length ? { tool_calls: nativeCalls } : {}) },
      };
    },
  };
}
