import { describe, it, expect } from 'vitest';
import { createStreamJsonAccumulator, parseStreamJsonOutput } from '../../src/pipeline/output-parsers';
import type { StreamJsonEvent } from '../../src/pipeline/output-parsers';
import { appendStreamTail, formatStreamEvent } from '../../src/council/stream-tail';

// Real shape from `claude --print --verbose --output-format stream-json --include-partial-messages`
const LINES = [
  '{"type":"system","subtype":"init","cwd":"/tmp","session_id":"s1","tools":["Bash","Read"],"model":"claude-haiku-5-5"}',
  '{"type":"stream_event","event":{"type":"message_start","message":{"role":"assistant","content":[],"usage":{"input_tokens":2,"cache_read_input_tokens":10443}}},"session_id":"s1"}',
  '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}},"session_id":"s1"}',
  '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello "}},"session_id":"s1"}',
  '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}},"session_id":"s1"}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hello world"},{"type":"tool_use","id":"tu1","name":"Read","input":{"file_path":"/tmp/a.ts"}}],"usage":{"input_tokens":2,"cache_read_input_tokens":10443,"output_tokens":5}},"session_id":"s1"}',
  '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":"export const a = 1;\\n"}]},"session_id":"s1"}',
  '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" done"}},"session_id":"s1"}',
  '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":" done"}],"usage":{"input_tokens":40,"output_tokens":3}},"session_id":"s1"}',
  '{"type":"result","subtype":"success","is_error":false,"result":"hello world done","session_id":"s1","usage":{"input_tokens":42,"output_tokens":8}}',
];

describe('createStreamJsonAccumulator', () => {
  it('emits text deltas ONCE (never from the full `assistant` text), tool calls/results, and per-turn usage', () => {
    const events: StreamJsonEvent[] = [];
    const acc = createStreamJsonAccumulator((e) => events.push(e));
    for (const l of LINES) acc.feed(l);
    const text = events.filter((e) => e.kind === 'text').map((e) => (e as { delta: string }).delta).join('');
    expect(text).toBe('hello world done');
    const call = events.find((e) => e.kind === 'tool_call') as Extract<StreamJsonEvent, { kind: 'tool_call' }>;
    expect(call).toMatchObject({ id: 'tu1', name: 'Read', args: { file_path: '/tmp/a.ts' } });
    const res = events.find((e) => e.kind === 'tool_result') as Extract<StreamJsonEvent, { kind: 'tool_result' }>;
    expect(res).toMatchObject({ id: 'tu1', name: 'Read', ok: true, chars: 20 });
    expect(events.filter((e) => e.kind === 'turn')).toHaveLength(2);
    expect(acc.usage.turns).toBe(2);
    expect(acc.usage.outputTokens).toBe(8);
    expect(acc.usage.inputTokens).toBe(2 + 10443 + 40); // billed incl. cache read
    // Order: text before the tool call, result after it
    const kinds = events.map((e) => e.kind);
    expect(kinds.indexOf('tool_call')).toBeGreaterThan(kinds.indexOf('text'));
    expect(kinds.indexOf('tool_result')).toBeGreaterThan(kinds.indexOf('tool_call'));
  });

  it('feedChunk handles partial lines split across chunks; flush drains the tail', () => {
    const events: StreamJsonEvent[] = [];
    const acc = createStreamJsonAccumulator((e) => events.push(e));
    const all = LINES.join('\n');
    const cut = all.indexOf('"text":"hello ') + 5; // split inside a JSON string
    acc.feedChunk(all.slice(0, cut));
    expect(events.filter((e) => e.kind === 'text')).toHaveLength(0);
    acc.feedChunk(all.slice(cut)); // no trailing newline → last line buffered
    acc.flush();
    const text = events.filter((e) => e.kind === 'text').map((e) => (e as { delta: string }).delta).join('');
    expect(text).toBe('hello world done');
  });

  it('a listener that throws never breaks the stream; non-JSON lines are ignored', () => {
    let n = 0;
    const acc = createStreamJsonAccumulator(() => { n++; throw new Error('boom'); });
    acc.feed('not json');
    acc.feed(LINES[3]);
    acc.feed(LINES[4]);
    expect(n).toBe(2);
  });

  it('the final parse is unchanged and does not double text when partial messages are present', () => {
    const parsed = parseStreamJsonOutput(LINES.join('\n'));
    expect(parsed.text).toBe('hello world done');
    expect(parsed.sessionId).toBe('s1');
    expect(parsed.outputTokens).toBe(8);
  });
});

describe('stream tail formatting', () => {
  it('renders tool calls and results compactly and caps the tail', () => {
    let tail = appendStreamTail('', { kind: 'text', delta: 'Thinking… ' });
    tail = appendStreamTail(tail, { kind: 'tool_call', id: '1', name: 'Read', args: { file_path: 'src/x.ts' } });
    tail = appendStreamTail(tail, { kind: 'tool_result', id: '1', name: 'Read', ok: true, chars: 120, durationMs: 1500 });
    tail = appendStreamTail(tail, { kind: 'turn', index: 1 });
    expect(tail).toBe('Thinking… \n→ Read({"file_path":"src/x.ts"})\n✓ Read (120 chars, 1.5s)\n');
    expect(formatStreamEvent({ kind: 'tool_result', id: '1', name: 'Bash', ok: false, chars: 0, durationMs: 0 })).toBe('✗ Bash (0 chars)\n');
    const long = appendStreamTail('x'.repeat(2000), { kind: 'text', delta: 'yz' }, 2000);
    expect(long).toHaveLength(2000);
    expect(long.endsWith('yz')).toBe(true);
  });
});
