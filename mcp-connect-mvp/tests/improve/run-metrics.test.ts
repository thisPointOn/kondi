import { describe, it, expect } from 'vitest';
import { createCouncilFromSetup } from '../../src/council/factory';
import { councilStore, initializeDeliberationState } from '../../src/council/store';
import { ledgerStore } from '../../src/council/ledger-store';
import type { LedgerEntry } from '../../src/council/types';
import type { Pipeline, PipelineStep } from '../../src/pipeline/types';
import {
  buildRunScorecard, scoreStep, aggregateAcrossRuns, summarizeCouncilUsage, costForCall, stepConfigHash,
} from '../../src/improve/run-metrics';

let seq = 0;
const entry = (over: Partial<LedgerEntry> & Pick<LedgerEntry, 'authorRole' | 'authorPersonaId' | 'entryType' | 'phase'>): LedgerEntry => ({
  id: `e-${++seq}`,
  timestamp: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
  content: over.content ?? 'x',
  tokensUsed: 0,
  latencyMs: 0,
  ...over,
});

function seedCouncil() {
  const council = createCouncilFromSetup({
    name: 'Seeded',
    personas: [
      { name: 'Boss', role: 'manager', model: 'route:balanced', provider: 'router' },
      { name: 'Critic', role: 'consultant', model: 'deepseek-v4-pro', provider: 'deepseek' },
      { name: 'Builder', role: 'worker', model: 'nvidia/nemotron-3-super-120b-a12b', provider: 'nvidia-router' },
    ],
    maxRounds: 1, maxRevisions: 2, stepType: 'council', outputType: 'json', pipelineId: 'pipe-1',
  });
  const [boss, critic, builder] = council.personas;
  // The orchestrator initialises this at run start; seed it the same way.
  initializeDeliberationState(council.id);

  // Manager framing — routed persona resolved to a concrete model per call.
  ledgerStore.append(council.id, entry({ authorRole: 'manager', authorPersonaId: boss.id, entryType: 'problem_statement', phase: 'problem_framing', tokensUsed: 500, latencyMs: 1200, model: 'claude-sonnet-4-5-20250929', provider: 'anthropic-api', inputTokens: 400, outputTokens: 100, attempts: 1, routed: true }));
  // Consultant analysis, retried once
  ledgerStore.append(council.id, entry({ authorRole: 'consultant', authorPersonaId: critic.id, entryType: 'analysis', phase: 'round_independent', roundNumber: 1, tokensUsed: 800, latencyMs: 3000, model: 'deepseek-v4-pro', provider: 'deepseek', attempts: 2 }));
  // Consultant error
  ledgerStore.append(council.id, entry({ authorRole: 'consultant', authorPersonaId: critic.id, entryType: 'error', phase: 'round_independent', content: 'boom' }));
  // Decision (routed → different concrete model this time)
  ledgerStore.append(council.id, entry({ authorRole: 'manager', authorPersonaId: boss.id, entryType: 'decision', phase: 'deciding', tokensUsed: 600, latencyMs: 2000, model: 'gpt-5.4', provider: 'openai-api', attempts: 1, routed: true }));
  // Worker output v1 → revise → v2 → accept
  ledgerStore.append(council.id, entry({ authorRole: 'worker', authorPersonaId: builder.id, entryType: 'work_output', phase: 'executing', tokensUsed: 2000, latencyMs: 9000, model: 'nvidia/nemotron-3-super-120b-a12b', provider: 'nvidia-router', attempts: 1 }));
  ledgerStore.append(council.id, entry({ authorRole: 'manager', authorPersonaId: boss.id, entryType: 'review', phase: 'reviewing', reviewOutcome: 'revise', tokensUsed: 300, latencyMs: 1000, model: 'gpt-5.4', provider: 'openai-api' }));
  ledgerStore.append(council.id, entry({ authorRole: 'manager', authorPersonaId: boss.id, entryType: 'revision_request', phase: 'reviewing', content: 'fix it' }));
  ledgerStore.append(council.id, entry({ authorRole: 'worker', authorPersonaId: builder.id, entryType: 'work_output', phase: 'revising', tokensUsed: 1500, latencyMs: 7000, model: 'nvidia/nemotron-3-super-120b-a12b', provider: 'nvidia-router' }));
  ledgerStore.append(council.id, entry({ authorRole: 'manager', authorPersonaId: boss.id, entryType: 'review', phase: 'reviewing', reviewOutcome: 'accept', tokensUsed: 300, latencyMs: 1000, model: 'gpt-5.4', provider: 'openai-api' }));

  councilStore.updateDeliberationState(council.id, { currentPhase: 'completed', currentRound: 1, revisionCount: 1 });
  return councilStore.get(council.id)!;
}

function stepFor(councilId: string, content: string, over: Partial<PipelineStep> = {}): PipelineStep {
  return {
    id: 'step-1', name: 'Draft', description: '', status: 'completed',
    startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:00:30.000Z',
    config: { type: 'council', councilSetup: { name: 'c', personas: [] }, inputTemplate: '{{input}}', outputType: 'json' },
    artifact: { stepId: 'step-1', content, artifactType: 'output', createdAt: 't', metadata: { councilId, outputType: 'json' } },
    ...over,
  } as PipelineStep;
}

function pipelineWith(step: PipelineStep): Pipeline {
  return {
    id: 'pipe-1', name: 'Pipe', initialInput: 'go', stages: [{ id: 'st-1', name: 'Stage 1', executionMode: 'sequential', steps: [step], status: 'completed' } as any],
    settings: { failurePolicy: 'stop' }, status: 'completed', currentStageIndex: 1, createdAt: 't', updatedAt: 't',
  };
}

describe('improve/run-metrics', () => {
  it('costForCall uses the in/out split when present, blended estimate otherwise', () => {
    const precise = costForCall('nvidia/nemotron-3-super-120b-a12b', 1000, 800, 200);
    expect(precise).toBe(0); // NIM models are 0-cost
    const blended = costForCall('totally-unknown-model', 1000);
    expect(blended).toBeCloseTo((1000 / 1000) * ((0.01 + 0.03) / 2), 6);
    const split = costForCall('totally-unknown-model', 1000, 1000, 0);
    expect(split).toBeCloseTo(0.01, 6);
  });

  it('scores a step from its ledger: seats, verdicts, revisions, routed attribution, flags', () => {
    const council = seedCouncil();
    const score = scoreStep(stepFor(council.id, '{"ok": true}'));

    expect(score.councilId).toBe(council.id);
    expect(score.entries).toBe(9);
    expect(score.tokens).toBe(500 + 800 + 600 + 2000 + 300 + 1500 + 300);
    expect(score.revisions).toBe(1);
    expect(score.reviewOutcomes).toEqual({ accept: 1, revise: 1, re_deliberate: 0 });
    expect(score.firstTryAccept).toBe(false);
    expect(score.errors).toBe(1);
    expect(score.outputJsonValid).toBe(true);
    expect(score.durationMs).toBe(30_000);
    expect(score.terminalPhase).toBe('completed');

    const boss = score.seats.find((s) => s.role === 'manager')!;
    expect(boss.configuredModel).toBe('route:balanced');
    expect(boss.calls).toBe(4);
    expect(boss.resolvedModels).toEqual({ 'claude-sonnet-4-5-20250929': 1, 'gpt-5.4': 3 });
    expect(boss.inputTokens).toBe(400);
    expect(boss.outputTokens).toBe(100);
    expect(boss.costUsd).toBeGreaterThan(0);

    const critic = score.seats.find((s) => s.role === 'consultant')!;
    expect(critic.calls).toBe(1);
    expect(critic.attemptsTotal).toBe(2);
    expect(critic.errors).toBe(1);
    expect(critic.p95LatencyMs).toBe(3000);

    const builder = score.seats.find((s) => s.role === 'worker')!;
    expect(builder.calls).toBe(2);
    expect(builder.costUsd).toBe(0); // NIM

    expect(score.flags).toContain('retries');
    expect(score.flags).toContain('consultant_errors');
    expect(score.flags).not.toContain('revise_loop');
    expect(score.flags).not.toContain('json_invalid');
  });

  it('flags invalid JSON, tool narration, empty output, honest failure and max-revisions', () => {
    const council = seedCouncil();
    councilStore.updateDeliberationState(council.id, { currentPhase: 'failed', revisionCount: 2 });
    // Make it "revise, revise, never accepted" → max_revisions_hit requires accept===0
    const entries = ledgerStore.getAll(council.id);
    const acceptEntry = entries.find((e) => e.reviewOutcome === 'accept')!;
    // Rewrite the ledger: drop the accept, add a second revise.
    ledgerStore.clear(council.id);
    for (const e of entries) {
      if (e.id === acceptEntry.id) ledgerStore.append(council.id, { ...e, reviewOutcome: 'revise' });
      else ledgerStore.append(council.id, e);
    }
    const score = scoreStep(stepFor(council.id, 'I ran write_file("out.md", ...) and it worked. not json'));
    expect(score.flags).toContain('json_invalid');
    expect(score.flags).toContain('tool_narration');
    expect(score.flags).toContain('honest_failure');
    expect(score.flags).toContain('revise_loop');
    expect(score.flags).toContain('max_revisions_hit');
    expect(score.outputJsonValid).toBe(false);

    const empty = scoreStep(stepFor(council.id, 'No output was produced.'));
    expect(empty.flags).toContain('empty_output');
  });

  it('scores non-council steps (condition loops, failed steps) without a ledger', () => {
    const cond = scoreStep({
      id: 'c1', name: 'Check', description: '', status: 'completed',
      config: { type: 'condition', inputTemplate: '{{input}}', mode: 'contains', expression: 'PASS', trueAction: 'continue', falseAction: 'loop_to_stage' },
      artifact: { stepId: 'c1', content: 'x', artifactType: 'output', createdAt: 't' },
    } as any, { loopCounts: new Map([['c1', 2]]) });
    expect(cond.loopIterations).toBe(2);
    expect(cond.seats).toEqual([]);

    const failed = scoreStep({ id: 'f', name: 'F', description: '', status: 'failed', config: { type: 'script', inputTemplate: '', command: 'false' } } as any);
    expect(failed.flags).toContain('step_failed');
  });

  it('builds a run scorecard and summarizes council usage for artifact metadata', () => {
    const council = seedCouncil();
    const pipeline = pipelineWith(stepFor(council.id, '{"a":1}'));
    const card = buildRunScorecard({ pipeline, runId: 'run-x', status: 'completed', startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:01:00.000Z', runNumber: 3 });
    expect(card.version).toBe(1);
    expect(card.runNumber).toBe(3);
    expect(card.totalTokens).toBe(6000);
    expect(card.totalDurationMs).toBe(60_000);
    expect(card.steps).toHaveLength(1);
    expect(card.recipeHash).toMatch(/^[0-9a-f]{8}$/);
    expect(stepConfigHash(pipeline.stages[0].steps[0])).toMatch(/^[0-9a-f]{8}$/);

    const usage = summarizeCouncilUsage(council.id);
    expect(usage.tokens).toBe(6000);
    expect(usage.models).toEqual(['claude-sonnet-4-5-20250929', 'deepseek-v4-pro', 'gpt-5.4', 'nvidia/nemotron-3-super-120b-a12b']);
    expect(usage.inputTokens).toBe(400);
  });

  it('aggregates across runs into per-step trends and a sparkline series', () => {
    const council = seedCouncil();
    const p = pipelineWith(stepFor(council.id, '{"a":1}'));
    const c1 = buildRunScorecard({ pipeline: p, runId: 'r1', status: 'completed', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:01:00Z' });
    const c2 = buildRunScorecard({ pipeline: pipelineWith(stepFor(council.id, '{"a":1}', { status: 'failed' })), runId: 'r2', status: 'failed', startedAt: '2026-01-02T00:00:00Z', completedAt: '2026-01-02T00:01:00Z' });
    const agg = aggregateAcrossRuns([c2, c1])!; // out of order on purpose
    expect(agg.runs).toBe(2);
    expect(agg.completedRuns).toBe(1);
    expect(agg.series.map((s) => s.runId)).toEqual(['r1', 'r2']);
    const t = agg.steps[0];
    expect(t.stepId).toBe('step-1');
    expect(t.runs).toBe(2);
    expect(t.failRate).toBe(0.5);
    expect(t.reviseRate).toBe(1);
    expect(t.firstTryAcceptRate).toBe(0);
    expect(t.costPerAccepted).toBeNull();
    expect(Object.keys(t.seats)).toContain('Boss (manager)');
    expect(aggregateAcrossRuns([])).toBeNull();
  });
});
