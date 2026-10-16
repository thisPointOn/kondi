import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { callApiProvider, adapterFor, isApiToolProvider } from '../../cli/api-tool-caller';

let wd: string;
beforeAll(() => { wd = fs.mkdtempSync(path.join(os.tmpdir(), 'kondi-api-')); fs.writeFileSync(path.join(wd, 'notes.md'), 'hello notes'); });
afterAll(() => fs.rmSync(wd, { recursive: true, force: true }));

const line = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
/** OpenAI-compatible fake: first turn calls read_file(notes.md) via the FIRST advertised tool, second turn answers. */
function fakeOpenAI() {
  const bodies: Array<Record<string, unknown>> = [];
  let n = 0;
  const fetchImpl: typeof fetch = async (_u, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    n++;
    const enc = new TextEncoder();
    const tools = (body.tools as Array<{ function: { name: string } }> | undefined) || [];
    const chunks = n === 1 && tools.length
      ? [line({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: tools[0].function.name, arguments: '{"path":"notes.md"}' } }] } }] }), line({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 5 } }), 'data: [DONE]\n\n']
      : [line({ choices: [{ delta: { content: 'The notes say hello.' } }] }), line({ choices: [], usage: { prompt_tokens: 80, completion_tokens: 6 } }), 'data: [DONE]\n\n'];
    return new Response(new ReadableStream<Uint8Array>({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } }), { status: 200 });
  };
  return { fetchImpl, bodies };
}

describe('cli/api-tool-caller', () => {
  it('knows which providers get the tool loop and builds the right adapter', () => {
    for (const p of ['anthropic-api', 'openai-api', 'deepseek', 'xai', 'zai', 'moonshot', 'nvidia-router', 'ollama']) expect(isApiToolProvider(p)).toBe(true);
    expect(isApiToolProvider('google')).toBe(false);
    expect(isApiToolProvider('anthropic-cli')).toBe(false);
    expect(adapterFor({ provider: 'deepseek', model: 'm', apiKey: 'k', systemPrompt: '', userMessage: '' }).provider).toBe('deepseek');
    expect(adapterFor({ provider: 'anthropic-api', model: 'm', apiKey: 'k', systemPrompt: '', userMessage: '' }).provider).toBe('anthropic-api');
    expect(() => adapterFor({ provider: 'google', model: 'm', apiKey: 'k', systemPrompt: '', userMessage: '' })).toThrow(/No API adapter/);
  });

  it('runs a real tool loop with Node local tools scoped by allowedTools, returns summed usage and concrete provider/model', async () => {
    const { fetchImpl, bodies } = fakeOpenAI();
    const r = await callApiProvider({ provider: 'nvidia-router', model: 'nvidia/x', apiKey: 'k', systemPrompt: 'S', userMessage: 'read notes', workingDir: wd, allowedTools: ['Read', 'Glob'], fetchImpl });
    expect(r.content).toBe('The notes say hello.');
    expect(r.inputTokens).toBe(130);
    expect(r.outputTokens).toBe(11);
    expect(r.tokensUsed).toBe(141);
    expect(r.provider).toBe('nvidia-router');
    expect(r.model).toBe('nvidia/x');
    // Only read_file + list_directory were advertised (Read/Glob), not write/run.
    const advertised = (bodies[0].tools as Array<{ function: { name: string } }>).map((t) => t.function.name).sort();
    expect(advertised).toEqual(['s0__list_directory', 's0__read_file']);
    // The second request carried the tool result read from disk.
    const msgs = bodies[1].messages as Array<{ role: string; content: string }>;
    expect(msgs.find((m) => m.role === 'tool')?.content).toBe('hello notes');
  });

  it('skipTools or no working dir → plain completion with no tools advertised', async () => {
    const a = fakeOpenAI();
    await callApiProvider({ provider: 'deepseek', model: 'm', apiKey: 'k', systemPrompt: 'S', userMessage: 'hi', workingDir: wd, skipTools: true, fetchImpl: a.fetchImpl });
    expect(a.bodies[0].tools).toBeUndefined();
    const b = fakeOpenAI();
    await callApiProvider({ provider: 'deepseek', model: 'm', apiKey: 'k', systemPrompt: 'S', userMessage: 'hi', fetchImpl: b.fetchImpl });
    expect(b.bodies[0].tools).toBeUndefined();
  });

  it('honours timeoutMs as a real cancellation', async () => {
    const fetchImpl: typeof fetch = (_u, init) => new Promise((_res, rej) => { init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))); });
    await expect(callApiProvider({ provider: 'deepseek', model: 'm', apiKey: 'k', systemPrompt: '', userMessage: 'x', timeoutMs: 30, fetchImpl })).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});
