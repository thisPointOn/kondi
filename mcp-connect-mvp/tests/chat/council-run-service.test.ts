import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/council/chat-council-gen', () => ({
  generateCouncilSetup: vi.fn(async (request: string) => ({
    name: 'Escalated council',
    task: request.split('\n')[0],
    stepType: 'council',
    personas: [
      { name: 'Boss', role: 'manager', model: 'm', provider: 'deepseek', suppressPersona: true, traits: ['t'], saveOutput: false },
      { name: 'Dev', role: 'worker', model: 'm', provider: 'deepseek', suppressPersona: true, traits: ['t'], saveOutput: false },
    ],
    maxRounds: 0, maxRevisions: 0,
  })),
  isCouncilCreationRequest: () => false,
}));

import { escalate, registerRunner, buildThreadSummary, composeEscalationTask, renderCardMarkdown, activeEscalation } from '../../src/services/councilRunService';
import type { CouncilRunCard } from '../../src/services/councilRunService';
import { getToolTimeoutMs, CHAT_ONLY_TOOLS } from '../../src/services/localTools';
import { councilStore } from '../../src/council/store';
import { pipelineStore } from '../../src/pipeline/store';
import { createOutput } from '../../src/council/context-store';
import type { Message } from '../../src/types/mcp';

const msg = (role: Message['role'], content: string, extra: Partial<Message> = {}): Message => ({ id: crypto.randomUUID(), role, content, timestamp: new Date(), ...extra });

describe('thread summary + task composition', () => {
  it('strips attachments and tool bodies, drops oldest beyond the cap, and composes task/focus/context', () => {
    const thread = [
      msg('system', 'ignored'),
      msg('user', 'Fix the parser\n\n--- File: a.ts (ts) ---\nhuge file\n--- End of a.ts ---'),
      msg('assistant', 'Looking…', { toolCalls: [{ id: '1', serverId: 's', toolName: 'read_file', arguments: {}, status: 'completed' }] }),
      msg('user', 'x'.repeat(20000)),
    ];
    const s = buildThreadSummary(thread, 5000);
    expect(s).not.toMatch(/huge file/);
    expect(s.endsWith('x')).toBe(true);                        // the newest message wins; oldest dropped
    expect(s).not.toMatch(/Fix the parser/);
    expect(buildThreadSummary(thread.slice(0, 3), 5000)).toMatch(/Assistant: Looking… \[used 1 tool call\]/);
    expect(s.length).toBeLessThanOrEqual(5000);
    expect(buildThreadSummary([], 100)).toBe('');
    const t = composeEscalationTask({ task: 'Do X', focus: 'be careful', thread: [msg('user', 'hello')] });
    expect(t).toMatch(/^Do X\n\n## FOCUS\nbe careful\n\n## CONVERSATION CONTEXT[^\n]*\nUser: hello$/);
  });

  it('chat-only tools get a long timeout; everything else keeps 5 min', () => {
    expect(CHAT_ONLY_TOOLS.map((t) => t.name)).toEqual(['convene_council']);
    expect(getToolTimeoutMs('convene_council')).toBe(3_600_000);
    expect(getToolTimeoutMs('read_file')).toBe(300_000);
  });
});

describe('escalate', () => {
  it('generating → running → done: creates the council + its pipeline, runs through the registered runner, returns the output', async () => {
    const cards: CouncilRunCard[] = [];
    registerRunner(async (pipelineId, overrides) => {
      const pipe = pipelineStore.get(pipelineId)!;
      const councilId = (pipe.stages[0].steps[0].config as { boundCouncilId: string }).boundCouncilId;
      overrides.onAgentThinkingStart?.({ id: 'p1', name: 'Dev' } as never, Date.now());
      overrides.onAgentEvent?.({ id: 'p1', name: 'Dev' } as never, { kind: 'text', delta: 'working…' }, 'execution');
      councilStore.setDeliberationPhase(councilId, 'executing');
      const out = createOutput(councilId, 'The parser needs a lookahead; patch attached.', 'd1');
      councilStore.setCurrentOutput(councilId, out.id);
      overrides.onAgentThinkingEnd?.({ id: 'p1', name: 'Dev' } as never);
      councilStore.setDeliberationPhase(councilId, 'completed');
    });
    const result = await escalate({ chatId: 'chat-1', task: 'Fix the parser bug', avail: { deepseek: true }, thread: [msg('user', 'Fix the parser bug')], onCard: (c) => cards.push(c) });
    expect(result.status).toBe('done');
    expect(result.output).toMatch(/lookahead/);
    expect(result.metadata?.councilId).toBeTruthy();
    const statuses = [...new Set(cards.map((c) => c.status))];
    expect(statuses).toEqual(['generating', 'running', 'done']);
    const running = cards.find((c) => c.status === 'running' && c.thinking.includes('Dev'))!;
    expect(running).toBeDefined();
    expect(cards.some((c) => c.tail?.includes('working…'))).toBe(true);
    const done = cards[cards.length - 1];
    expect(done.councilName).toBe('Escalated council');
    expect(done.pipelineId).toBeTruthy();
    expect(pipelineStore.get(done.pipelineId!)).toBeTruthy();                   // every council lives in a pipeline (rule 21)
    expect(councilStore.get(done.councilId!)!.deliberation?.savedProblem).toMatch(/CONVERSATION CONTEXT/);
    expect(renderCardMarkdown(done)).toMatch(/done\.\n\nThe parser needs a lookahead/);
    expect(activeEscalation('chat-1')).toBeUndefined();
  });

  it('a runner rejection becomes a failed RESULT (never a throw); one active escalation per chat', async () => {
    let release: () => void = () => {};
    registerRunner(() => new Promise<void>((resolve) => { release = resolve; }));
    const first = escalate({ chatId: 'chat-2', task: 'slow one', avail: { deepseek: true } });
    await new Promise((r) => setTimeout(r, 20));
    expect(activeEscalation('chat-2')?.status).toBe('running');
    const second = await escalate({ chatId: 'chat-2', task: 'another', avail: { deepseek: true } });
    expect(second.status).toBe('failed');
    expect(second.output).toMatch(/already running/);
    release();
    const r1 = await first;
    expect(['done', 'failed', 'cancelled']).toContain(r1.status);

    registerRunner(async () => { throw new Error('executor exploded'); });
    const failed = await escalate({ chatId: 'chat-3', task: 'boom', avail: { deepseek: true } });
    expect(failed.status).toBe('failed');
    expect(failed.output).toMatch(/executor exploded/);
    expect(renderCardMarkdown({ status: 'failed', task: 'boom', thinking: [], startedAt: 0, error: 'executor exploded' })).toMatch(/failed: executor exploded/);

    registerRunner(null);
    const noRunner = await escalate({ chatId: 'chat-4', task: 'x', avail: {} });
    expect(noRunner.status).toBe('failed');
    expect(noRunner.output).toMatch(/No council runner/);
  });
});
