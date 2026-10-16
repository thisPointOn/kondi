/**
 * Agent runtime — Anthropic Messages API adapter (API keys AND OAuth tokens).
 *
 * `x-api-key` for API keys, `Authorization: Bearer` for OAuth tokens (same rule
 * as the Rust `anthropic_request` command); callers pass the beta headers
 * (`getBetasForToken`). The system prompt is sent as a cache_control block.
 * Streams `message_start` (input + cache usage) / `content_block_*`
 * (text_delta, input_json_delta) / `message_delta` (cumulative output usage).
 * Tool results are replayed as `tool_result` user content blocks.
 */
import type { ToolLoopAdapter, TurnRequest, ModelTurn, LoopMessage, LoopToolCall, TurnUsage } from '../types';
import { parseSseJson } from '../sse';
import { anySignal, timeoutSignal, throwIfAborted } from '../signals';

export interface AnthropicAdapterOptions {
  fetchImpl?: typeof fetch;
  apiKey: string;
  model: string;
  baseUrl?: string;                // default https://api.anthropic.com
  betas?: string[];
  maxTokens?: number;              // default 16384
  temperature?: number;
  stream?: boolean;                // default true
  cacheSystem?: boolean;           // default true
  idleTimeoutMs?: number;          // default 90s
  provider?: string;               // default 'anthropic-api'
}

export function isAnthropicOAuthToken(token: string): boolean {
  return token.includes('sk-ant-oat') || token.startsWith('eyJ');
}

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export function toAnthropicMessages(messages: LoopMessage[]): Array<{ role: 'user' | 'assistant'; content: Block[] }> {
  const out: Array<{ role: 'user' | 'assistant'; content: Block[] }> = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: [{ type: 'text', text: m.content }] });
    } else if (m.role === 'assistant') {
      if (m.native) { out.push(m.native as { role: 'assistant'; content: Block[] }); continue; }
      const content: Block[] = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls || []) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
      out.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] });
    } else {
      // Consecutive tool results must be in ONE user message.
      const block: Block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content, ...(m.isError ? { is_error: true } : {}) };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && last.content.every((b) => b.type === 'tool_result')) last.content.push(block);
      else out.push({ role: 'user', content: [block] });
    }
  }
  return out;
}

interface AnthUsage { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }

export function anthropicAdapter(o: AnthropicAdapterOptions): ToolLoopAdapter {
  const fetchImpl = o.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const url = `${(o.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`;
  const stream = o.stream ?? true;

  return {
    provider: o.provider || 'anthropic-api',
    model: o.model,
    async turn(req: TurnRequest): Promise<ModelTurn> {
      const body: Record<string, unknown> = {
        model: o.model,
        max_tokens: o.maxTokens ?? 16384,
        messages: toAnthropicMessages(req.messages),
        stream,
      };
      if (req.system) {
        body.system = o.cacheSystem === false
          ? req.system
          : [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }];
      }
      if (o.temperature != null) body.temperature = o.temperature;
      if (req.tools.length) body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      };
      if (isAnthropicOAuthToken(o.apiKey)) headers.Authorization = `Bearer ${o.apiKey}`;
      else headers['x-api-key'] = o.apiKey;
      const betas = o.betas && o.betas.length ? o.betas : ['prompt-caching-2024-07-31'];
      headers['anthropic-beta'] = betas.join(',');

      throwIfAborted(req.signal);
      const resp = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: req.signal });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status} from anthropic: ${text.slice(0, 500)}`);
      }

      const finish = (blocks: Block[], usage: TurnUsage | undefined, stop?: string): ModelTurn => {
        const text = blocks.filter((b): b is Extract<Block, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('');
        const toolCalls: LoopToolCall[] = blocks
          .filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use')
          .map((b) => ({ id: b.id, name: b.name, args: b.input || {} }));
        return { text, toolCalls, usage, stopReason: stop, native: { role: 'assistant', content: blocks } };
      };
      const mkUsage = (u?: AnthUsage): TurnUsage | undefined => u ? {
        inputTokens: u.input_tokens || 0,
        outputTokens: u.output_tokens || 0,
        cacheReadTokens: u.cache_read_input_tokens || undefined,
        cacheWriteTokens: u.cache_creation_input_tokens || undefined,
      } : undefined;

      if (!stream) {
        const data = await resp.json() as { content?: Block[]; usage?: AnthUsage; stop_reason?: string };
        const blocks = data.content || [];
        const t = blocks.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
        if (t && req.onText) req.onText(t);
        return finish(blocks, mkUsage(data.usage), data.stop_reason);
      }

      let idle = timeoutSignal(o.idleTimeoutMs ?? 90_000, 'anthropic stream idle');
      const blocks: Block[] = [];
      const partialJson = new Map<number, string>();
      let inputUsage: AnthUsage | undefined;
      let outputTokens = 0;
      let stop: string | undefined;

      type Ev =
        | { type: 'message_start'; message: { usage?: AnthUsage } }
        | { type: 'content_block_start'; index: number; content_block: Block }
        | { type: 'content_block_delta'; index: number; delta: { type: 'text_delta'; text: string } | { type: 'input_json_delta'; partial_json: string } }
        | { type: 'content_block_stop'; index: number }
        | { type: 'message_delta'; delta?: { stop_reason?: string }; usage?: { output_tokens?: number } }
        | { type: 'message_stop' }
        | { type: 'error'; error?: { message?: string } }
        | { type: 'ping' };

      for await (const { json } of parseSseJson<Ev>(resp.body, req.signal)) {
        throwIfAborted(anySignal([req.signal, idle]));
        idle = timeoutSignal(o.idleTimeoutMs ?? 90_000, 'anthropic stream idle');
        switch (json.type) {
          case 'message_start': inputUsage = json.message?.usage; break;
          case 'content_block_start': {
            const b = json.content_block;
            blocks[json.index] = b.type === 'tool_use' ? { ...b, input: b.input || {} } : b.type === 'text' ? { type: 'text', text: b.text || '' } : b;
            if (b.type === 'tool_use') partialJson.set(json.index, '');
            break;
          }
          case 'content_block_delta': {
            const b = blocks[json.index];
            if (json.delta.type === 'text_delta') {
              if (b && b.type === 'text') b.text += json.delta.text;
              else blocks[json.index] = { type: 'text', text: json.delta.text };
              req.onText?.(json.delta.text);
            } else if (json.delta.type === 'input_json_delta') {
              partialJson.set(json.index, (partialJson.get(json.index) || '') + json.delta.partial_json);
            }
            break;
          }
          case 'content_block_stop': {
            const b = blocks[json.index];
            if (b && b.type === 'tool_use') {
              const raw = partialJson.get(json.index) || '';
              if (raw.trim()) { try { b.input = JSON.parse(raw); } catch { b.input = { __raw: raw }; } }
            }
            break;
          }
          case 'message_delta':
            if (json.usage?.output_tokens != null) outputTokens = json.usage.output_tokens; // cumulative
            if (json.delta?.stop_reason) stop = json.delta.stop_reason;
            break;
          case 'error':
            throw new Error(`anthropic stream error: ${json.error?.message || 'unknown'}`);
          default: break;
        }
      }
      const usage: TurnUsage | undefined = inputUsage || outputTokens
        ? { ...(mkUsage(inputUsage) || { inputTokens: 0, outputTokens: 0 }), outputTokens }
        : undefined;
      const compact = blocks.filter(Boolean);
      // Malformed tool input → surface as rawArgs so the loop reports it back.
      const turn = finish(compact, usage, stop);
      turn.toolCalls = turn.toolCalls.map((c) => ('__raw' in c.args ? { ...c, args: {}, rawArgs: String(c.args.__raw) } : c));
      return turn;
    },
  };
}
