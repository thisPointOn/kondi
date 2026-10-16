import { describe, it, expect } from 'vitest';
import { openaiResponsesAdapter, toResponsesInput } from '../../src/agent-runtime/adapters/openai-responses';
import { fetchWithRetry } from '../../src/agent-runtime/http';
import { runToolLoop } from '../../src/agent-runtime/tool-loop';
import type { ToolExecutor } from '../../src/agent-runtime/types';

describe('openaiResponsesAdapter', () => {
  it('builds Responses input items, parses output_text + function_call items, replays native items, sums usage through the loop', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let n = 0;
    const adapter = openaiResponsesAdapter({
      model: 'gpt-5.5',
      transport: async (body) => {
        bodies.push(JSON.parse(body));
        n++;
        if (n === 1) return JSON.stringify({ output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reading…' }] },
          { type: 'function_call', call_id: 'c1', name: 's0__read_file', arguments: '{"path":"a.ts"}' },
        ], usage: { input_tokens: 100, output_tokens: 10 } });
        return JSON.stringify({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }], usage: { input_tokens: 150, output_tokens: 5 } });
      },
    });
    const executor: ToolExecutor = { list: () => [{ name: 's0__read_file', description: 'r', inputSchema: { type: 'object' } }], call: async () => 'file body' };
    const r = await runToolLoop({ adapter, executor, system: 'SYS', userMessage: 'read a.ts', history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }] });
    expect(r.content).toBe('Reading…\n\nDone.');
    expect(r.usage).toMatchObject({ inputTokens: 250, outputTokens: 15, apiTurns: 2, toolCalls: 1, reported: true });
    expect(bodies[0]).toMatchObject({ model: 'gpt-5.5', instructions: 'SYS', store: false });
    expect((bodies[0].input as unknown[]).length).toBe(3); // hi, hello, read a.ts
    expect((bodies[0].tools as Array<{ type: string; name: string }>)[0]).toMatchObject({ type: 'function', name: 's0__read_file' });
    // Turn 2 replays the model's own items verbatim, then the tool output
    const input2 = bodies[1].input as Array<Record<string, unknown>>;
    expect(input2.slice(-3)).toEqual([
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Reading…' }] },
      { type: 'function_call', call_id: 'c1', name: 's0__read_file', arguments: '{"path":"a.ts"}' },
      { type: 'function_call_output', call_id: 'c1', output: 'file body' },
    ]);
  });

  it('toResponsesInput folds plain history and tool results', () => {
    expect(toResponsesInput([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a', toolCalls: [{ id: 'x', name: 't', args: { k: 1 } }] },
      { role: 'tool', toolCallId: 'x', name: 't', content: 'out' },
    ])).toEqual([
      { type: 'message', role: 'user', content: 'q' },
      { type: 'message', role: 'assistant', content: 'a' },
      { type: 'function_call', call_id: 'x', name: 't', arguments: '{"k":1}' },
      { type: 'function_call_output', call_id: 'x', output: 'out' },
    ]);
  });
});

describe('fetchWithRetry', () => {
  it('retries 429/5xx with backoff (honouring Retry-After), returns other statuses as-is, never retries aborts', async () => {
    const statuses = [429, 503, 200];
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl = (async () => {
      const s = statuses[calls++];
      return new Response('x', { status: s, headers: s === 429 ? { 'retry-after': '1' } : {} });
    }) as unknown as typeof fetch;
    const r = await fetchWithRetry(fetchImpl, 'u', {}, { sleep: async (ms) => { sleeps.push(ms); }, baseDelayMs: 100 });
    expect(r.status).toBe(200);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1000, 200]);
    const bad = await fetchWithRetry((async () => new Response('nope', { status: 400 })) as unknown as typeof fetch, 'u', {}, { sleep: async () => {} });
    expect(bad.status).toBe(400);
    const ac = new AbortController(); ac.abort(new Error('stop'));
    await expect(fetchWithRetry(fetchImpl, 'u', { signal: ac.signal }, { sleep: async () => {} })).rejects.toThrow();
  });
});
