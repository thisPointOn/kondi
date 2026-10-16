import { describe, it, expect } from 'vitest';
import { runToolLoop } from '../../src/agent-runtime/tool-loop';
import type { ModelTurn, ToolLoopAdapter, ToolExecutor, AgentStreamEvent, LoopMessage } from '../../src/agent-runtime/types';
import { AbortError } from '../../src/agent-runtime/signals';

/** Scripted adapter: returns turns in order and records the messages it saw. */
function scripted(turns: ModelTurn[]) {
  const seen: LoopMessage[][] = [];
  let i = 0;
  const adapter: ToolLoopAdapter = {
    provider: 'fake', model: 'fake-1',
    async turn(req) {
      seen.push(JSON.parse(JSON.stringify(req.messages)));
      if (req.signal.aborted) throw new AbortError(req.signal.reason);
      const t = turns[Math.min(i, turns.length - 1)];
      i++;
      if (t.text && req.onText) req.onText(t.text);
      return t;
    },
  };
  return { adapter, seen, calls: () => i };
}

const echoExecutor = (log: string[] = []): ToolExecutor => ({
  list: () => [{ name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: {} } }, { name: 'slow', description: 's', inputSchema: {} }, { name: 'boom', description: 'b', inputSchema: {} }],
  async call(name, args, ctx) {
    log.push(name);
    if (!['echo', 'slow', 'boom'].includes(name)) throw new Error(`Unknown tool "${name}"`);
    if (name === 'boom') throw new Error('kaboom');
    if (name === 'slow') await new Promise<void>((res, rej) => { const t = setTimeout(res, 10_000); ctx.signal?.addEventListener('abort', () => { clearTimeout(t); rej(ctx.signal!.reason); }, { once: true }); });
    return `echo:${JSON.stringify(args)}`;
  },
});

const usage = (i: number, o: number) => ({ inputTokens: i, outputTokens: o });

describe('agent-runtime/tool-loop', () => {
  it('single turn with no tool calls returns content and reported usage', async () => {
    const s = scripted([{ text: 'hello', toolCalls: [], usage: usage(10, 5) }]);
    const r = await runToolLoop({ adapter: s.adapter, executor: echoExecutor(), system: 'sys', userMessage: 'hi' });
    expect(r.content).toBe('hello');
    expect(r.turns).toBe(1);
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5, apiTurns: 1, toolCalls: 0, reported: true });
    expect(r.hitMaxTurns).toBe(false);
  });

  it('runs tool calls, replays results as tool messages, sums usage across turns', async () => {
    const s = scripted([
      { text: '', toolCalls: [{ id: 'c1', name: 'echo', args: { a: 1 } }, { id: 'c2', name: 'echo', args: { b: 2 } }], usage: usage(100, 10) },
      { text: 'partial', toolCalls: [{ id: 'c3', name: 'echo', args: {} }], usage: usage(150, 20) },
      { text: 'done', toolCalls: [], usage: usage(200, 30) },
    ]);
    const log: string[] = [];
    const events: AgentStreamEvent[] = [];
    const r = await runToolLoop({ adapter: s.adapter, executor: echoExecutor(log), system: 's', userMessage: 'go', onEvent: (e) => events.push(e) });
    expect(log).toEqual(['echo', 'echo', 'echo']);
    expect(r.content).toBe('partial\n\ndone');
    expect(r.usage).toEqual({ inputTokens: 450, outputTokens: 60, apiTurns: 3, toolCalls: 3, reported: true });
    // Second turn saw assistant(tool calls) + two tool results.
    const second = s.seen[1];
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool']);
    expect((second[2] as { content: string }).content).toBe('echo:{"a":1}');
    // Event ordering: text, tool_call, tool_result, turn...
    const kinds = events.map((e) => e.kind);
    expect(kinds.slice(0, 5)).toEqual(['turn', 'tool_call', 'tool_result', 'tool_call', 'tool_result']);
    expect(kinds.filter((k) => k === 'text')).toHaveLength(2);
  });

  it('unknown tool, thrown tool error and malformed args become error results — the loop never throws', async () => {
    const s = scripted([
      { text: '', toolCalls: [{ id: '1', name: 'nope', args: {} }, { id: '2', name: 'boom', args: {} }, { id: '3', name: 'echo', args: {}, rawArgs: '{bad json' }] },
      { text: 'recovered', toolCalls: [] },
    ]);
    const r = await runToolLoop({ adapter: s.adapter, executor: echoExecutor(), system: 's', userMessage: 'go' });
    expect(r.content).toBe('recovered');
    const tools = s.seen[1].filter((m) => m.role === 'tool') as Array<{ content: string; isError?: boolean }>;
    expect(tools[0].content).toMatch(/Unknown tool "nope"/);
    expect(tools[1].content).toMatch(/kaboom/);
    expect(tools[2].content).toMatch(/not valid JSON/);
    expect(tools.every((t) => t.isError)).toBe(true);
    expect(r.usage.reported).toBe(false); // turns had no usage
  });

  it('caps this turn\'s results and compresses older results before the next turn', async () => {
    const big = 'x'.repeat(5000);
    const exec: ToolExecutor = { list: () => [{ name: 'big', description: '', inputSchema: {} }], call: async () => big };
    const s = scripted([
      { text: '', toolCalls: [{ id: '1', name: 'big', args: {} }] },
      { text: '', toolCalls: [{ id: '2', name: 'big', args: {} }] },
      { text: 'end', toolCalls: [] },
    ]);
    const events: AgentStreamEvent[] = [];
    await runToolLoop({ adapter: s.adapter, executor: exec, system: 's', userMessage: 'go', resultCapChars: 3000, oldResultCapChars: 500, onEvent: (e) => events.push(e) });
    // This turn's result is capped at 3000 when appended (visible via the event chars)...
    const results = events.filter((e) => e.kind === 'tool_result') as Array<{ chars: number }>;
    expect(results[0].chars).toBeLessThanOrEqual(3000);
    expect(results[0].chars).toBeGreaterThan(2500);
    // ...and compressed to 500 before the NEXT adapter turn.
    const turn2 = s.seen[1].filter((m) => m.role === 'tool') as Array<{ content: string }>;
    expect(turn2[0].content.length).toBeLessThanOrEqual(500);
    expect(turn2[0].content).toMatch(/older result compressed/);
    const turn3 = s.seen[2].filter((m) => m.role === 'tool') as Array<{ content: string }>;
    expect(turn3).toHaveLength(2);
    expect(turn3.every((t) => t.content.length <= 500)).toBe(true);
  });

  it('stops at maxTurns and reports it', async () => {
    const s = scripted([{ text: 'again', toolCalls: [{ id: '1', name: 'echo', args: {} }] }]);
    const r = await runToolLoop({ adapter: s.adapter, executor: echoExecutor(), system: 's', userMessage: 'go', maxTurns: 3 });
    expect(r.hitMaxTurns).toBe(true);
    expect(r.turns).toBe(3);
    expect(r.content).toBe('again\n\nagain\n\nagain');
  });

  it('abort mid-tool rejects with AbortError and runs no further turns', async () => {
    const ac = new AbortController();
    const s = scripted([{ text: '', toolCalls: [{ id: '1', name: 'slow', args: {} }] }, { text: 'never', toolCalls: [] }]);
    const p = runToolLoop({ adapter: s.adapter, executor: echoExecutor(), system: 's', userMessage: 'go', signal: ac.signal });
    setTimeout(() => ac.abort(new AbortError('user')), 20);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(s.calls()).toBe(1);
  });

  it('per-tool timeout becomes an error result and the loop continues', async () => {
    const s = scripted([{ text: '', toolCalls: [{ id: '1', name: 'slow', args: {} }] }, { text: 'ok', toolCalls: [] }]);
    const r = await runToolLoop({ adapter: s.adapter, executor: echoExecutor(), system: 's', userMessage: 'go', perToolTimeoutMs: 30 });
    expect(r.content).toBe('ok');
    const tool = s.seen[1].find((m) => m.role === 'tool') as { content: string };
    expect(tool.content).toMatch(/timed out/);
  });

  it('with no executor the model\'s tool calls are ignored (plain completion)', async () => {
    const s = scripted([{ text: 'plain', toolCalls: [{ id: '1', name: 'echo', args: {} }] }]);
    const r = await runToolLoop({ adapter: s.adapter, system: 's', userMessage: 'go' });
    expect(r.content).toBe('plain');
    expect(r.turns).toBe(1);
  });
});
