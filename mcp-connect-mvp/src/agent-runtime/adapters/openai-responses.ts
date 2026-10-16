/**
 * OpenAI Responses API adapter (ChatGPT/Codex backend via OAuth). The request
 * is sent through a caller-supplied `transport` (the webview uses the Rust
 * `codex_request` command — chatgpt.com sends no CORS headers and the endpoint
 * requires stream:true, which the Rust side injects and buffers), so this
 * adapter is buffered: no token deltas, one ModelTurn per call.
 *
 * Wire shapes:
 *   input items: {type:'message', role, content} | {type:'function_call', call_id, name, arguments}
 *                | {type:'function_call_output', call_id, output}
 *   output items: {type:'message', role:'assistant', content:[{type:'output_text', text}]}
 *                 | {type:'function_call', call_id|id, name, arguments}
 */
import type { ToolLoopAdapter, TurnRequest, ModelTurn, LoopMessage, LoopToolCall, TurnUsage } from '../types';
import { throwIfAborted } from '../signals';

export interface OpenAIResponsesAdapterOptions {
  /** Sends the JSON body, returns the JSON response text. */
  transport: (bodyJson: string, signal?: AbortSignal) => Promise<string>;
  model: string;
  provider?: string;             // default 'openai-cli'
  store?: boolean;               // default false
}

function parseArgs(raw: unknown): { args: Record<string, unknown>; rawArgs?: string } {
  if (raw && typeof raw === 'object') return { args: raw as Record<string, unknown> };
  if (typeof raw !== 'string' || !raw.trim()) return { args: {} };
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? { args: v } : { args: {}, rawArgs: raw }; }
  catch { return { args: {}, rawArgs: raw }; }
}

export function toResponsesInput(messages: LoopMessage[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ type: 'message', role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      if (Array.isArray(m.native)) { out.push(...(m.native as Array<Record<string, unknown>>)); continue; }
      if (m.content) out.push({ type: 'message', role: 'assistant', content: m.content });
      for (const c of m.toolCalls || []) out.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: c.rawArgs ?? JSON.stringify(c.args) });
    } else {
      out.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content });
    }
  }
  return out;
}

export function openaiResponsesAdapter(o: OpenAIResponsesAdapterOptions): ToolLoopAdapter {
  return {
    provider: o.provider || 'openai-cli',
    model: o.model,
    async turn(req: TurnRequest): Promise<ModelTurn> {
      const body: Record<string, unknown> = {
        model: o.model,
        instructions: req.system || undefined,
        input: toResponsesInput(req.messages),
        store: o.store ?? false,
      };
      if (req.tools.length) {
        body.tools = req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema }));
      }
      throwIfAborted(req.signal);
      const text = await o.transport(JSON.stringify(body), req.signal);
      throwIfAborted(req.signal);
      const data = JSON.parse(text) as { output?: Array<Record<string, unknown>>; usage?: { input_tokens?: number; output_tokens?: number } };
      const items = data.output || [];
      const texts: string[] = [];
      const toolCalls: LoopToolCall[] = [];
      for (const item of items) {
        if (item.type === 'message' && item.role === 'assistant') {
          const content = item.content;
          if (Array.isArray(content)) for (const p of content as Array<Record<string, unknown>>) { if (p.type === 'output_text' && typeof p.text === 'string') texts.push(p.text); else if (typeof p === 'string') texts.push(p); }
          else if (typeof content === 'string') texts.push(content);
        } else if (item.type === 'function_call') {
          const id = String(item.call_id || item.id || `call_${toolCalls.length + 1}`);
          toolCalls.push({ id, name: String(item.name || ''), ...parseArgs(item.arguments) });
        }
      }
      const out = texts.join('\n');
      if (out && req.onText) req.onText(out);
      const usage: TurnUsage | undefined = data.usage ? { inputTokens: data.usage.input_tokens || 0, outputTokens: data.usage.output_tokens || 0 } : undefined;
      // Replay the model's own items verbatim next turn (keeps call ids intact).
      const native = items.filter((it) => it.type === 'message' || it.type === 'function_call');
      return { text: out, toolCalls, usage, native: native.length ? native : undefined };
    },
  };
}
