import { describe, it, expect } from 'vitest';
import { createCouncilFromSetup } from '../../src/council/factory';
import { ledgerStore } from '../../src/council/ledger-store';
import { scoreStep } from '../../src/improve/run-metrics';
import { buildSeatBriefs, normalizeObjection, SEAT_BRIEF_MAX_CHARS } from '../../src/improve/seat-brief';
import { improveStore } from '../../src/improve/store';
import { PipelineExecutor } from '../../src/pipeline/executor';
import type { PlatformAdapter } from '../../src/pipeline/executor';
import { pipelineStore } from '../../src/pipeline/store';
import type { RunScorecard, StepScore } from '../../src/improve/types';
import type { LedgerEntry } from '../../src/council/types';
import type { PipelineStep, PipelinePersona, CouncilStepConfig } from '../../src/pipeline/types';

const persona = (name: string, role: PipelinePersona['role']): PipelinePersona =>
  ({ name, role, model: 'm', provider: 'deepseek', suppressPersona: true, traits: ['t'], saveOutput: false });

const entry = (councilId: string, over: Partial<LedgerEntry> & Pick<LedgerEntry, 'entryType' | 'content'>): LedgerEntry => ({
  id: crypto.randomUUID(), timestamp: new Date().toISOString(), authorRole: 'manager', authorPersonaId: 'mgr',
  phase: 'reviewing', tokensUsed: 0, latencyMs: 0, ...over, councilId,
} as unknown as LedgerEntry);

function stepScore(stepId: string, over: Partial<StepScore> = {}): StepScore {
  return {
    stepId, stepName: 'Build', stepType: 'council', status: 'completed', tokens: 100, costUsd: 0.01, entries: 5,
    rounds: 1, revisions: 1, reviewOutcomes: { accept: 1, revise: 1, re_deliberate: 0 }, firstTryAccept: false,
    errors: 0, outputChars: 100, completionSummaryPresent: true, seats: [], flags: [], ...over,
  };
}
function card(pipelineId: string, runId: string, steps: StepScore[]): RunScorecard {
  return { version: 1, runId, pipelineId, pipelineName: 'P', startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), status: 'completed', totalTokens: 0, totalCostUsd: 0, totalDurationMs: 0, steps, recipeHash: 'h' };
}

describe('scoreStep captures reviewer/verification feedback', () => {
  it('collects revision requests, re-deliberation reasons, code-review issues and failing test tails (≤300 chars each, ≤12)', () => {
    const council = createCouncilFromSetup({ name: 'FB', personas: [persona('Boss', 'manager'), persona('Dev', 'worker')], maxRounds: 0, maxRevisions: 1, stepType: 'council', outputType: 'string' });
    ledgerStore.append(council.id, entry(council.id, { entryType: 'review', reviewOutcome: 'revise', content: 'Verdict: revise' }));
    ledgerStore.append(council.id, entry(council.id, { entryType: 'revision_request', content: 'Missing error handling in the parser. '.repeat(20) }));
    ledgerStore.append(council.id, entry(council.id, { entryType: 're_deliberation', content: 'Re-deliberation requested: the API needs a key' }));
    ledgerStore.append(council.id, entry(council.id, { entryType: 'test_result', content: 'FAIL expected 2 to be 3', structured: { exitCode: 1, verification: true } }));
    ledgerStore.append(council.id, entry(council.id, { entryType: 'code_review', authorRole: 'reviewer', content: 'issues', structured: { issues: [{ severity: 'high', description: 'No input validation' }, { severity: 'low', description: 'Rename foo' }] } }));
    for (let i = 0; i < 15; i++) ledgerStore.append(council.id, entry(council.id, { entryType: 'revision_request', content: `nit ${i}` }));
    const step = { id: 's1', name: 'Build', status: 'completed', config: { type: 'council', outputType: 'string' }, artifact: { stepId: 's1', content: 'ok', artifactType: 'output', createdAt: '', metadata: { councilId: council.id } } } as unknown as PipelineStep;
    const score = scoreStep(step);
    expect(score.reviewFeedback).toBeDefined();
    expect(score.reviewFeedback!.length).toBeLessThanOrEqual(12);
    expect(score.reviewFeedback![0]).toMatch(/^Missing error handling/);
    expect(score.reviewFeedback![0].length).toBeLessThanOrEqual(300);
    expect(score.reviewFeedback).toContain('Re-deliberation requested: the API needs a key');
    expect(score.reviewFeedback!.some((f) => /Verification failed \(exit 1\): FAIL expected 2 to be 3/.test(f))).toBe(true);
    expect(score.reviewFeedback).toContain('No input validation');
  });
});

describe('buildSeatBriefs', () => {
  it('needs ≥2 prior runs', () => {
    expect(buildSeatBriefs([card('p', 'r1', [stepScore('s')])], 's')).toBeUndefined();
    expect(buildSeatBriefs([], 's')).toBeUndefined();
    expect(buildSeatBriefs([card('p', 'r1', [stepScore('other')]), card('p', 'r2', [stepScore('other')])], 's')).toBeUndefined();
  });

  it('summarizes first-try acceptance, revisions and RECURRING objections (≥2 runs), capped at 600 chars; manager brief when reviews exist', () => {
    const cards = [
      card('p', 'r1', [stepScore('s', { firstTryAccept: false, revisions: 2, reviewFeedback: ['Missing error handling in the parser.', 'Add tests for the CLI.'] })]),
      card('p', 'r2', [stepScore('s', { firstTryAccept: true, revisions: 0, reviewOutcomes: { accept: 1, revise: 0, re_deliberate: 0 } })]),
      card('p', 'r3', [stepScore('s', { firstTryAccept: false, revisions: 1, reviewFeedback: ['**Missing** error-handling in the parser!', 'Docs are thin.'] })]),
    ];
    const briefs = buildSeatBriefs(cards, 's')!;
    expect(briefs.worker).toMatch(/last 3 runs/);
    expect(briefs.worker).toMatch(/accepted first try 1\/3/);
    expect(briefs.worker).toMatch(/avg 1\.0 revision/);
    expect(briefs.worker).toMatch(/Recurring reviewer objections/);
    expect(briefs.worker).toMatch(/\(2\/3 runs\) Missing error handling in the parser\./);
    expect(briefs.worker).not.toMatch(/Docs are thin/); // recurring wins over one-offs
    expect(briefs.worker!.length).toBeLessThanOrEqual(SEAT_BRIEF_MAX_CHARS);
    expect(briefs.manager).toMatch(/as manager of this step/);
    expect(briefs.manager).toMatch(/3 accept \/ 2 revise/);
    expect(briefs.manager).toMatch(/worker accepted first try 1\/3/);
    expect(normalizeObjection('**Missing** error-handling in the parser!')).toBe(normalizeObjection('Missing error handling in the parser.'));
  });

  it('falls back to the latest objections when nothing recurs', () => {
    const cards = [
      card('p', 'r1', [stepScore('s', { reviewFeedback: ['a1', 'a2'] })]),
      card('p', 'r2', [stepScore('s', { reviewFeedback: ['b1', 'b2'] })]),
    ];
    const b = buildSeatBriefs(cards, 's')!.worker!;
    expect(b).toMatch(/Latest reviewer objections/);
    expect(b).toMatch(/- a2\n- b1\n- b2/);
  });
});

describe('executor injects seat briefs', () => {
  it('the worker work order and the manager directive carry the seat track record after 2 prior runs', async () => {
    const p = pipelineStore.create({ name: 'Seat run', initialInput: 'spec', settings: { workingDirectory: '/virt/seat' } });
    const stage = pipelineStore.addStage(p.id)!.stages[0];
    pipelineStore.addStep(p.id, stage.id, {
      type: 'council', task: 'Do.', inputTemplate: '{{input}}', outputType: 'string',
      councilSetup: { name: 'c', personas: [persona('Boss', 'manager'), persona('Dev', 'worker')], maxRounds: 0, maxRevisions: 0 },
    } as CouncilStepConfig, 'Step');
    const stepId = pipelineStore.get(p.id)!.stages[0].steps[0].id;
    improveStore.saveScorecard(card(p.id, 'prev-1', [stepScore(stepId, { firstTryAccept: false, reviewFeedback: ['Cite the source for every claim.'] })]));
    improveStore.saveScorecard(card(p.id, 'prev-2', [stepScore(stepId, { firstTryAccept: false, reviewFeedback: ['Cite the source for every claim'] })]));

    const prompts: Record<string, string[]> = {};
    const platform: PlatformAdapter = {
      writeFile: async () => {}, readFile: async () => null,
      runCommand: async () => ({ stdout: '', stderr: '', exit_code: 0, success: true }),
      setWorkingDir: () => {}, getWorkingDir: () => '/virt/seat',
    };
    const executor = new PipelineExecutor({
      invokeAgent: async (inv, who) => {
        (prompts[who.name] ||= []).push(inv.userMessage);
        if (who.name === 'Dev') return { content: 'done\n\n## COMPLETION SUMMARY\n**Status:** Complete', tokensUsed: 1, latencyMs: 1 };
        if (/WORKER OUTPUT/.test(inv.userMessage)) return { content: '{"verdict":"accept"}', tokensUsed: 1, latencyMs: 1 };
        return { content: 'DECISION: go', tokensUsed: 1, latencyMs: 1 };
      },
    }, platform);
    await executor.run(p.id);
    const worker = prompts.Dev[0];
    expect(worker).toMatch(/## Your track record in this seat/);
    expect(worker).toMatch(/accepted first try 0\/2/);
    expect(worker).toMatch(/\(2\/2 runs\) Cite the source for every claim/);
    const directive = prompts.Boss.find((m) => /as manager of this step/.test(m));
    expect(directive).toBeDefined();
    // Framing/review prompts don't carry the manager brief (directive only)
    expect(prompts.Boss.filter((m) => /as manager of this step/.test(m))).toHaveLength(1);
  });
});
