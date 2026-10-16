import { describe, it, expect } from 'vitest';
import { createGuiToolExecutor } from '../../src/services/gui-tool-executor';
import { runToolLoop } from '../../src/agent-runtime/tool-loop';
import type { ToolLoopAdapter, TurnRequest, ModelTurn } from '../../src/agent-runtime/types';
import { LOCAL_SERVER_ID } from '../../src/services/localTools';

const tools = new Map([
  [LOCAL_SERVER_ID, { serverId: LOCAL_SERVER_ID, tools: [{ name: 'read_file', description: 'Read a file. '.repeat(40), inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'p' } }, required: ['path'], additionalProperties: false } }] }],
  ['gh', { serverId: 'gh', tools: [{ name: 'a_very_long_tool_name_that_goes_on_and_on_and_on_and_on_and_on_forever_yes', description: 'x', inputSchema: { type: 'object' } }] }],
]);

describe('createGuiToolExecutor', () => {
  it('lists s<i>__ wire names (≤64), minimized schemas, 300-char descriptions; routes local vs MCP; records ToolCalls', async () => {
    const calls: string[] = [];
    const ex = createGuiToolExecutor(tools, {
      callLocal: async (name, args) => { calls.push(`local:${name}:${args.path}`); return [{ type: 'text', text: 'file body' }]; },
      callMcp: async (serverId, name) => { calls.push(`mcp:${serverId}:${name}`); throw new Error('server down'); },
    });
    const defs = ex.list();
    expect(defs.map((d) => d.name)).toEqual(['s0__read_file', `s1__${'a_very_long_tool_name_that_goes_on_and_on_and_on_and_on_and_on_forever_yes'.slice(0, 64 - 4)}`]);
    expect(defs[1].name.length).toBeLessThanOrEqual(64);
    expect(defs[0].description.length).toBeLessThanOrEqual(300);
    expect(defs[0].inputSchema).not.toHaveProperty('additionalProperties');

    const out = await ex.call('s0__read_file', { path: 'a.ts' }, {});
    expect(out).toMatch(/file body/);
    await expect(ex.call(defs[1].name, {}, {})).rejects.toThrow(/server down/);
    await expect(ex.call('nope', {}, {})).rejects.toThrow(/Unknown tool/);
    expect(calls).toEqual(['local:read_file:a.ts', 'mcp:gh:a_very_long_tool_name_that_goes_on_and_on_and_on_and_on_and_on_forever_yes']);
    expect(ex.toolCalls.map((c) => [c.toolName, c.status, c.serverId])).toEqual([
      ['read_file', 'completed', LOCAL_SERVER_ID],
      ['a_very_long_tool_name_that_goes_on_and_on_and_on_and_on_and_on_forever_yes', 'failed', 'gh'],
    ]);
    expect(ex.toolCalls[1].error).toBe('server down');
  });
});

describe('runToolLoop history', () => {
  it('prepends earlier turns before the user message and still sums usage across turns', async () => {
    const seen: TurnRequest[] = [];
    let n = 0;
    const adapter: ToolLoopAdapter = {
      provider: 'p', model: 'm',
      async turn(req): Promise<ModelTurn> {
        seen.push({ ...req, messages: [...req.messages] }); // snapshot: the loop mutates its array
        n++;
        if (n === 1) return { text: '', toolCalls: [{ id: 't1', name: 's0__read_file', args: { path: 'a.ts' } }], usage: { inputTokens: 10, outputTokens: 2 } };
        return { text: 'done', toolCalls: [], usage: { inputTokens: 20, outputTokens: 3 } };
      },
    };
    const ex = createGuiToolExecutor(tools, { callLocal: async () => 'body' });
    const r = await runToolLoop({ adapter, executor: ex, system: 'sys', userMessage: 'now', history: [{ role: 'user', content: 'earlier q' }, { role: 'assistant', content: 'earlier a' }] });
    expect(seen[0].messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(seen[0].messages[2]).toEqual({ role: 'user', content: 'now' });
    expect(seen[1].messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'tool']);
    expect(r.content).toBe('done');
    expect(r.usage).toMatchObject({ inputTokens: 30, outputTokens: 5, apiTurns: 2, toolCalls: 1, reported: true });
    expect(ex.toolCalls).toHaveLength(1);
  });
});
