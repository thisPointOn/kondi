import { describe, it, expect } from 'vitest';
import { looksLikeToolNarration, recoverToolCallsFromText } from '../../src/agent-runtime/tool-narration';
import { runToolLoop } from '../../src/agent-runtime/tool-loop';
import type { ToolLoopAdapter, ModelTurn, TurnRequest, ToolExecutor } from '../../src/agent-runtime/types';

const TOOLS = ['s0__read_file', 's0__run_command', 's1__search'];

describe('looksLikeToolNarration', () => {
  it('flags the common fake-call shapes and ignores ordinary prose about tools', () => {
    expect(looksLikeToolNarration('Action: list_directory\nPath: .')).toBe(true);
    expect(looksLikeToolNarration('I will now read the file.\n\nread_file("src/a.ts")')).toBe(true);
    expect(looksLikeToolNarration('run_command(command="npm test")')).toBe(true);
    expect(looksLikeToolNarration('```json\n{"name": "run_command", "args": {"command": "ls"}}\n```')).toBe(true);
    expect(looksLikeToolNarration('<tool_call>{"name":"read_file"}</tool_call>')).toBe(true);
    expect(looksLikeToolNarration("I'll call the read_file tool now to inspect the config.")).toBe(true);
    expect(looksLikeToolNarration('The worker should use read_file to inspect files before editing.')).toBe(false);
    expect(looksLikeToolNarration('We ran the tests; `npm test` exits 0. The parser now handles edge cases.')).toBe(false);
    expect(looksLikeToolNarration('Decision: refactor the parser into two modules.')).toBe(false);
    expect(looksLikeToolNarration('')).toBe(false);
  });
});

describe('recoverToolCallsFromText', () => {
  it('recovers JSON, XML and pseudo-call shapes for KNOWN tools (bare or prefixed names), dedupes, ignores unknown tools', () => {
    const text = [
      'Let me look.',
      '```json\n{"name": "read_file", "arguments": {"path": "src/a.ts"}}\n```',
      '{"tool": "s0__run_command", "params": "{\\"command\\": \\"npm test\\"}"}',
      '<invoke name="search"><parameter name="query">TODO</parameter></invoke>',
      'read_file(path="README.md")',
      'run_command("ls -la")',
      '{"name": "delete_everything", "args": {}}',
      '{"function": {"name": "read_file", "arguments": "{\\"path\\": \\"src/a.ts\\"}"}}', // duplicate of the first
    ].join('\n');
    const calls = recoverToolCallsFromText(text, TOOLS);
    expect(calls.map((c) => [c.name, c.args])).toEqual([
      ['s0__read_file', { path: 'src/a.ts' }],
      ['s0__run_command', { command: 'npm test' }],
      ['s1__search', { query: 'TODO' }],
      ['s0__read_file', { path: 'README.md' }],
      ['s0__run_command', { command: 'ls -la' }],
    ]);
    expect(calls.every((c) => c.id.startsWith('recovered_'))).toBe(true);
    expect(recoverToolCallsFromText('plain prose, no calls', TOOLS)).toEqual([]);
    expect(recoverToolCallsFromText('read_file()', TOOLS)).toEqual([]); // no args → ambiguous, not recovered
  });
});

describe('runToolLoop fake-call defenses', () => {
  const executor: ToolExecutor = {
    list: () => [{ name: 's0__read_file', description: 'r', inputSchema: { type: 'object' } }],
    call: async (name, args) => `[${name}] ${JSON.stringify(args)} → contents`,
  };

  it('recovers a call written as text, executes it for real, and the model continues with the result', async () => {
    const seen: TurnRequest[] = [];
    let n = 0;
    const adapter: ToolLoopAdapter = {
      provider: 'p', model: 'm',
      async turn(req): Promise<ModelTurn> {
        seen.push({ ...req, messages: [...req.messages] });
        n++;
        if (n === 1) return { text: 'I will read it:\nread_file(path="src/a.ts")', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
        return { text: 'Done: ' + (req.messages.at(-1) as { content: string }).content.slice(0, 30), toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const r = await runToolLoop({ adapter, executor, system: 's', userMessage: 'go' });
    expect(r.recoveredToolCalls).toBe(1);
    expect(r.narrationNudges).toBe(0);
    expect(r.usage.toolCalls).toBe(1);
    const tool = seen[1].messages.find((m) => m.role === 'tool') as { name: string; content: string };
    expect(tool.name).toBe('s0__read_file');
    expect(tool.content).toMatch(/src\/a\.ts/);
    expect(r.content).toMatch(/^I will read it[\s\S]*Done: \[s0__read_file\]/);
  });

  it('nudges ONCE on unparseable narration, then lets the model answer', async () => {
    let n = 0;
    const prompts: string[] = [];
    const adapter: ToolLoopAdapter = {
      provider: 'p', model: 'm',
      async turn(req): Promise<ModelTurn> {
        n++;
        prompts.push((req.messages.at(-1) as { content: string }).content);
        if (n === 1) return { text: "I'll call the read_file tool now and report back.", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
        return { text: 'Final answer without tools.', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const r = await runToolLoop({ adapter, executor, system: 's', userMessage: 'go' });
    expect(n).toBe(2);
    expect(prompts[1]).toMatch(/CORRECTION: Your previous reply DESCRIBED tool calls as text/);
    expect(r.narrationNudges).toBe(1);
    expect(r.recoveredToolCalls).toBe(0);
    expect(r.content).toMatch(/Final answer without tools\.$/);
  });

  it('does nothing special without tools (plain completion), even if the text mentions a tool', async () => {
    const adapter: ToolLoopAdapter = { provider: 'p', model: 'm', async turn(): Promise<ModelTurn> { return { text: 'Action: read_file', toolCalls: [] }; } };
    const r = await runToolLoop({ adapter, system: 's', userMessage: 'go' });
    expect(r.turns).toBe(1);
    expect(r.narrationNudges).toBe(0);
  });
});
