import { describe, it, expect } from 'vitest';
import { openaiCompatibleAdapter, toOpenAIMessages } from '../../src/agent-runtime/adapters/openai-compatible';
import { anthropicAdapter, toAnthropicMessages, isAnthropicOAuthToken } from '../../src/agent-runtime/adapters/anthropic';
import { parseSse, parseSseJson } from '../../src/agent-runtime/sse';
import type { LoopMessage } from '../../src/agent-runtime/types';

/** Build a fetch that returns the given SSE lines (as separate chunks) and records the request. */
function sseFetch(chunks: string[], status = 200) {
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    calls.push({ url: String(input), init: init || {}, body });
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); },
    });
    return new Response(status === 200 ? stream : 'bad request body', { status });
  };
  return { fetchImpl, calls };
}
const line = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

describe('agent-runtime/sse', () => {
  it('parses CRLF, multi-line data, comments, [DONE] and multibyte splits', async () => {
    const enc = new TextEncoder();
    const raw = ': keep-alive\r\ndata: {"a":\r\ndata: 1}\r\n\r\nevent: x\ndata: héllo\n\ndata: [DONE]\n\n';
    const bytes = enc.encode(raw);
    const mid = raw.indexOf('é') + 1; // split inside the 2-byte char
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes.slice(0, mid)); c.enqueue(bytes.slice(mid)); c.close(); } });
    const evs = [];
    for await (const ev of parseSse(stream)) evs.push(ev);
    expect(evs[0]).toEqual({ data: '{"a":\n1}', event: undefined, id: undefined });
    expect(evs[1]).toEqual({ data: 'héllo', event: 'x', id: undefined });
    expect(evs[2].data).toBe('[DONE]');
    const json = [];
    const stream2 = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode('data: {"ok":true}\n\ndata: [DONE]\n\ndata: {"after":1}\n\n')); c.close(); } });
    for await (const j of parseSseJson(stream2)) json.push(j.json);
    expect(json).toEqual([{ ok: true }]); // stops at [DONE]
  });
});

describe('agent-runtime/adapters/openai-compatible', () => {
  it('streams text, accumulates tool_calls by index, captures the trailing usage chunk, requests include_usage', async () => {
    const { fetchImpl, calls } = sseFetch([
      line({ choices: [{ delta: { content: 'Hel' } }] }),
      line({ choices: [{ delta: { content: 'lo' } }] }),
      line({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_', arguments: '{"pa' } }] } }] }),
      line({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: 'th":"a.ts"}' } }] }, finish_reason: 'tool_calls' }] }),
      line({ choices: [], usage: { prompt_tokens: 42, completion_tokens: 7 } }),
      'data: [DONE]\n\n',
    ]);
    const a = openaiCompatibleAdapter({ fetchImpl, baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', provider: 'deepseek' });
    const text: string[] = [];
    const t = await a.turn({ system: 'S', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 't', description: 'd', inputSchema: {} }], signal: new AbortController().signal, onText: (d) => text.push(d) });
    expect(t.text).toBe('Hello');
    expect(text).toEqual(['Hel', 'lo']);
    expect(t.toolCalls).toEqual([{ id: 'call_1', name: 'read_file', args: { path: 'a.ts' } }]);
    expect(t.usage).toEqual({ inputTokens: 42, outputTokens: 7, cacheReadTokens: undefined });
    expect(t.stopReason).toBe('tool_calls');
    expect(calls[0].url).toBe('https://x/v1/chat/completions');
    expect(calls[0].body.stream_options).toEqual({ include_usage: true });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer k');
    expect((calls[0].body.messages as unknown[])[0]).toEqual({ role: 'system', content: 'S' });
    expect(((calls[0].body.tools as unknown[])[0] as { function: { name: string } }).function.name).toBe('t');
  });

  it('replays native assistant tool_calls and tool results; malformed args surface as rawArgs; non-2xx throws', async () => {
    const msgs: LoopMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'echo', args: { a: 1 } }] },
      { role: 'tool', toolCallId: 'c1', name: 'echo', content: 'result' },
    ];
    const wire = toOpenAIMessages('S', msgs);
    expect(wire[2]).toEqual({ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'echo', arguments: '{"a":1}' } }] });
    expect(wire[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'result' });

    const { fetchImpl } = sseFetch([line({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', function: { name: 'f', arguments: '{nope' } }] } }] }), 'data: [DONE]\n\n']);
    const a = openaiCompatibleAdapter({ fetchImpl, baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', provider: 'p' });
    const t = await a.turn({ system: '', messages: msgs, tools: [], signal: new AbortController().signal });
    expect(t.toolCalls[0].rawArgs).toBe('{nope');

    const bad = sseFetch([], 400);
    const b = openaiCompatibleAdapter({ fetchImpl: bad.fetchImpl, baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', provider: 'p' });
    await expect(b.turn({ system: '', messages: msgs, tools: [], signal: new AbortController().signal })).rejects.toThrow(/HTTP 400/);
  });

  it('non-streaming mode reads choices[0].message and usage', async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'hi', tool_calls: [{ id: 'c', type: 'function', function: { name: 'f', arguments: '{}' } }] }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }), { status: 200 });
    const a = openaiCompatibleAdapter({ fetchImpl, baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', provider: 'p', stream: false });
    const t = await a.turn({ system: '', messages: [{ role: 'user', content: 'x' }], tools: [], signal: new AbortController().signal });
    expect(t.text).toBe('hi');
    expect(t.toolCalls).toEqual([{ id: 'c', name: 'f', args: {} }]);
    expect(t.usage).toEqual({ inputTokens: 3, outputTokens: 2, cacheReadTokens: undefined });
  });

  it('passes the abort signal to fetch', async () => {
    const ac = new AbortController(); ac.abort();
    const { fetchImpl } = sseFetch([]);
    const a = openaiCompatibleAdapter({ fetchImpl, baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', provider: 'p' });
    await expect(a.turn({ system: '', messages: [{ role: 'user', content: 'x' }], tools: [], signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('agent-runtime/adapters/anthropic', () => {
  it('streams message_start usage, text + input_json deltas, cumulative output tokens; headers by token type', async () => {
    const { fetchImpl, calls } = sseFetch([
      line({ type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 10 } } }),
      line({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      line({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi ' } }),
      line({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'there' } }),
      line({ type: 'content_block_stop', index: 0 }),
      line({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'read_file', input: {} } }),
      line({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } }),
      line({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"a.ts"}' } }),
      line({ type: 'content_block_stop', index: 1 }),
      line({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 12 } }),
      line({ type: 'message_delta', usage: { output_tokens: 25 } }),
      line({ type: 'message_stop' }),
    ]);
    const a = anthropicAdapter({ fetchImpl, apiKey: 'sk-ant-api03-xyz', model: 'claude', betas: ['b1', 'b2'] });
    const t = await a.turn({ system: 'SYS', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'read_file', description: 'd', inputSchema: { type: 'object' } }], signal: new AbortController().signal });
    expect(t.text).toBe('Hi there');
    expect(t.toolCalls).toEqual([{ id: 'tu_1', name: 'read_file', args: { path: 'a.ts' } }]);
    expect(t.usage).toEqual({ inputTokens: 100, outputTokens: 25, cacheReadTokens: 40, cacheWriteTokens: 10 });
    expect(t.stopReason).toBe('tool_use');
    const h = calls[0].init.headers as Record<string, string>;
    expect(h['x-api-key']).toBe('sk-ant-api03-xyz');
    expect(h.Authorization).toBeUndefined();
    expect(h['anthropic-beta']).toBe('b1,b2');
    expect(calls[0].body.system).toEqual([{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }]);
    expect(((calls[0].body.tools as unknown[])[0] as { input_schema: unknown }).input_schema).toEqual({ type: 'object' });

    const oauth = sseFetch([line({ type: 'message_stop' })]);
    const b = anthropicAdapter({ fetchImpl: oauth.fetchImpl, apiKey: 'sk-ant-oat01-token', model: 'claude' });
    await b.turn({ system: '', messages: [{ role: 'user', content: 'x' }], tools: [], signal: new AbortController().signal });
    const oh = oauth.calls[0].init.headers as Record<string, string>;
    expect(oh.Authorization).toBe('Bearer sk-ant-oat01-token');
    expect(oh['x-api-key']).toBeUndefined();
    expect(isAnthropicOAuthToken('eyJabc')).toBe(true);
  });

  it('replays tool results as tool_result blocks grouped in one user message, and native assistant blocks', () => {
    const msgs: LoopMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'calling', toolCalls: [{ id: 'tu_1', name: 'a', args: { x: 1 } }, { id: 'tu_2', name: 'b', args: {} }] },
      { role: 'tool', toolCallId: 'tu_1', name: 'a', content: 'r1' },
      { role: 'tool', toolCallId: 'tu_2', name: 'b', content: 'bad', isError: true },
    ];
    const wire = toAnthropicMessages(msgs);
    expect(wire).toHaveLength(3);
    expect(wire[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'calling' }, { type: 'tool_use', id: 'tu_1', name: 'a', input: { x: 1 } }, { type: 'tool_use', id: 'tu_2', name: 'b', input: {} }] });
    expect(wire[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'r1' }, { type: 'tool_result', tool_use_id: 'tu_2', content: 'bad', is_error: true }] });
    const native = toAnthropicMessages([{ role: 'assistant', content: 'x', native: { role: 'assistant', content: [{ type: 'text', text: 'native!' }] } }]);
    expect(native[0].content[0]).toEqual({ type: 'text', text: 'native!' });
  });

  it('malformed tool input surfaces as rawArgs; non-stream mode works', async () => {
    const { fetchImpl } = sseFetch([
      line({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu', name: 'f', input: {} } }),
      line({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{broken' } }),
      line({ type: 'content_block_stop', index: 0 }),
      line({ type: 'message_stop' }),
    ]);
    const a = anthropicAdapter({ fetchImpl, apiKey: 'k', model: 'm' });
    const t = await a.turn({ system: '', messages: [{ role: 'user', content: 'x' }], tools: [], signal: new AbortController().signal });
    expect(t.toolCalls[0].rawArgs).toBe('{broken');
    expect(t.toolCalls[0].args).toEqual({});

    const ns: typeof fetch = async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'plain' }], usage: { input_tokens: 5, output_tokens: 6 }, stop_reason: 'end_turn' }), { status: 200 });
    const b = anthropicAdapter({ fetchImpl: ns, apiKey: 'k', model: 'm', stream: false });
    const u = await b.turn({ system: '', messages: [{ role: 'user', content: 'x' }], tools: [], signal: new AbortController().signal });
    expect(u.text).toBe('plain');
    expect(u.usage).toEqual({ inputTokens: 5, outputTokens: 6, cacheReadTokens: undefined, cacheWriteTokens: undefined });
  });
});
