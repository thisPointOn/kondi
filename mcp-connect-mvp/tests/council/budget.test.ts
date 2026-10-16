import { describe, it, expect } from 'vitest';
import { BudgetMeter, BudgetExceededError, formatBudgetLine, hasBudget } from '../../src/pipeline/budget';
import { PipelineExecutor } from '../../src/pipeline/executor';
import type { PlatformAdapter } from '../../src/pipeline/executor';
import { pipelineStore } from '../../src/pipeline/store';
import { councilStore } from '../../src/council/store';
import { ledgerStore } from '../../src/council/ledger-store';
import { improveStore } from '../../src/improve/store';
import type { PipelinePersona, CouncilStepConfig } from '../../src/pipeline/types';

const persona = (name: string, role: PipelinePersona['role']): PipelinePersona =>
  ({ name, role, model: 'm', provider: 'deepseek', suppressPersona: true, traits: ['t'], saveOutput: false });

describe('BudgetMeter', () => {
  it('tracks tokens/usd/minutes, breaches once, asserts before calls, and reports a budget line', () => {
    const ticks: string[] = [];
    const t0 = 1_000_000;
    const m = new BudgetMeter({ maxTokens: 250, maxMinutes: 10 }, { now: t0, onTick: (s) => ticks.push(s.exceeded?.kind || 'ok') });
    expect(hasBudget({ maxTokens: 250 })).toBe(true);
    expect(hasBudget({})).toBe(false);
    expect(hasBudget(undefined)).toBe(false);

    m.assert(t0);
    m.record('m', { tokensUsed: 100 }, t0 + 1000);
    expect(m.state.tokens).toBe(100);
    expect(m.exceeded).toBe(false);
    expect(m.estimatedCallsLeft()).toBe(1); // (250-100)/100
    const line = formatBudgetLine(m, t0 + 60_000);
    expect(line).toMatch(/RUN BUDGET: 100 of 250 tokens used; 1\.0 of 10 min elapsed \(~1 more calls/);
    expect(line).toMatch(/smaller CORRECT deliverable/);

    m.record('m', { tokensUsed: 200 }, t0 + 2000);
    expect(m.exceeded).toBe(true);
    expect(m.state.exceeded!.kind).toBe('tokens');
    expect(() => m.assert()).toThrow(BudgetExceededError);
    expect(m.signal.aborted).toBe(false); // finish_call: no in-flight cancel
    expect(ticks).toEqual(['ok', 'tokens', 'tokens']); // first record ok; breach fires check-tick + record-tick
  });

  it('minutes breach by wall clock; abort_now arms the signal with a BudgetExceededError reason', () => {
    const t0 = 5_000_000;
    const m = new BudgetMeter({ maxMinutes: 2, onExceeded: 'abort_now' }, { now: t0 });
    expect(m.check(t0 + 60_000)).toBeUndefined();
    expect(m.check(t0 + 121_000)?.kind).toBe('minutes');
    expect(m.signal.aborted).toBe(true);
    expect(m.signal.reason).toBeInstanceOf(BudgetExceededError);
  });

  it('wrap(): assert → call → record', async () => {
    const m = new BudgetMeter({ maxTokens: 150 });
    const invoke = m.wrap(async () => ({ content: 'x', tokensUsed: 100, latencyMs: 1 }));
    const p = { id: 'p', name: 'P', model: 'm', provider: 'deepseek' } as unknown as Parameters<typeof invoke>[1];
    await invoke({ personaId: 'p', systemPrompt: '', userMessage: '' }, p);
    await invoke({ personaId: 'p', systemPrompt: '', userMessage: '' }, p); // 200 ≥ 150 → exceeded after
    await expect(invoke({ personaId: 'p', systemPrompt: '', userMessage: '' }, p)).rejects.toThrow(/Budget exceeded/);
    expect(m.state.calls).toBe(2);
  });
});

describe('executor budget', () => {
  it('a run that exceeds its budget FAILS the step honestly (error entry with structured.budget, failed phase), never starts the next stage, and still writes a scorecard', async () => {
    const p = pipelineStore.create({ name: 'Budget run', initialInput: 'spec', settings: { workingDirectory: '/virt/budget' } });
    pipelineStore.update(p.id, { settings: { ...pipelineStore.get(p.id)!.settings, budget: { maxTokens: 150 } } });
    const s1 = pipelineStore.addStage(p.id)!.stages[0];
    pipelineStore.addStep(p.id, s1.id, {
      type: 'council', task: 'First.', inputTemplate: '{{input}}', outputType: 'string',
      councilSetup: { name: 'c1', personas: [persona('Boss', 'manager'), persona('Dev', 'worker')], maxRounds: 0, maxRevisions: 0 },
    } as CouncilStepConfig, 'First');
    const s2 = pipelineStore.addStage(p.id)!.stages[1];
    pipelineStore.addStep(p.id, s2.id, {
      type: 'agent', task: 'Second.', inputTemplate: '{{input}}', outputType: 'string',
      councilSetup: { name: 'c2', personas: [persona('Next', 'worker')], maxRounds: 0, maxRevisions: 0 },
    } as CouncilStepConfig, 'Second');

    const platform: PlatformAdapter = {
      writeFile: async () => {}, readFile: async () => null,
      runCommand: async () => ({ stdout: '', stderr: '', exit_code: 0, success: true }),
      setWorkingDir: () => {}, getWorkingDir: () => '/virt/budget',
    };
    let nextCalls = 0; let calls = 0;
    const ticks: number[] = [];
    const logs: string[] = [];
    const executor = new PipelineExecutor({
      invokeAgent: async (_inv, who) => {
        calls++;
        if (who.name === 'Next') nextCalls++;
        // Every call costs 100 tokens → the 2nd call breaches a 150-token budget.
        return { content: 'DECISION: go\n\n## COMPLETION SUMMARY\n**Status:** Complete', tokensUsed: 100, inputTokens: 80, outputTokens: 20, latencyMs: 1 };
      },
      onBudgetTick: (s) => ticks.push(s.tokens),
      onLog: (m) => logs.push(m),
    }, platform);
    const before = improveStore.listScorecards(p.id).length;
    await expect(executor.run(p.id)).rejects.toThrow(/Budget exceeded/);

    const pipe = pipelineStore.get(p.id)!;
    const first = pipe.stages[0].steps[0];
    expect(first.status).toBe('failed');
    expect(first.error).toMatch(/Budget exceeded/);
    expect(pipe.stages[1].steps[0].status).not.toBe('completed');
    expect(nextCalls).toBe(0);
    expect(calls).toBe(2); // framing (ok) + the first call after the breach was refused → only 2 real calls
    expect(pipe.status).toBe('failed');
    // Council: honest failure, tagged as budget (not a cancellation)
    const council = councilStore.getAll().find((c) => ledgerStore.getAll(c.id).some((e) => e.entryType === 'error' && /Budget exceeded/.test(e.content)));
    expect(council).toBeDefined();
    expect(council!.deliberationState?.currentPhase).toBe('failed');
    const err = ledgerStore.getAll(council!.id).find((e) => e.entryType === 'error')!;
    expect((err.structured as { budget: { kind: string } }).budget.kind).toBe('tokens');
    expect(ledgerStore.getAll(council!.id).some((e) => e.entryType === 'cancellation')).toBe(false);
    // Scorecard still written (the loop must see the overspend)
    expect(improveStore.listScorecards(p.id).length).toBe(before + 1);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBe(200);
  });
});
