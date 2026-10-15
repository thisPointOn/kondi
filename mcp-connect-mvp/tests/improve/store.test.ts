import { describe, it, expect, beforeEach } from 'vitest';
import { improveStore, scorecardKey, MAX_SCORECARDS, KONDI_IMPROVE_EVENT } from '../../src/improve/store';
import { councilDataStore } from '../../src/council/storage-cleanup';
import type { RunScorecard, Proposal } from '../../src/improve/types';
import { saveStepInput, getStepInput, deleteStepInput, formatStepInputMarkdown } from '../../src/improve/step-input';

const card = (pid: string, runId: string, over: Partial<RunScorecard> = {}): RunScorecard => ({
  version: 1, runId, pipelineId: pid, pipelineName: 'P', startedAt: '2026-01-01T00:00:00Z',
  completedAt: `2026-01-01T00:00:${runId.slice(-2)}Z`, status: 'completed', totalTokens: 10, totalCostUsd: 0.001,
  totalDurationMs: 1000, steps: [], recipeHash: 'r', ...over,
});

describe('improve/store', () => {
  beforeEach(() => improveStore.deleteAll('p1'));

  it('returns an empty state for an unknown pipeline', () => {
    const s = improveStore.get('p1');
    expect(s.proposals).toEqual([]);
    expect(s.scorecardIds).toEqual([]);
  });

  it('saves scorecards newest-last, caps retention and notifies', () => {
    let notified = 0;
    const unsub = improveStore.subscribe(() => notified++);
    let events = 0;
    const onEvt = () => events++;
    window.addEventListener(KONDI_IMPROVE_EVENT, onEvt);

    for (let i = 0; i < MAX_SCORECARDS + 3; i++) {
      improveStore.saveScorecard(card('p1', `run-${String(i).padStart(2, '0')}`));
    }
    const list = improveStore.listScorecards('p1');
    expect(list.length).toBe(MAX_SCORECARDS);
    expect(list[list.length - 1].runId).toBe(`run-${MAX_SCORECARDS + 2}`);
    expect(improveStore.latestScorecard('p1')?.runId).toBe(`run-${MAX_SCORECARDS + 2}`);
    // The oldest were pruned from the data store too.
    expect(councilDataStore.getItem(scorecardKey('p1', 'run-00'))).toBeNull();
    expect(improveStore.listScorecards('p1', 2).map((c) => c.runId)).toEqual([`run-${MAX_SCORECARDS + 1}`, `run-${MAX_SCORECARDS + 2}`]);
    expect(notified).toBeGreaterThan(0);
    expect(events).toBeGreaterThan(0);
    unsub();
    window.removeEventListener(KONDI_IMPROVE_EVENT, onEvt);
  });

  it('adds and updates proposals, appends changelog, upserts lessons', () => {
    const p: Proposal = {
      id: 'prop-1', pipelineId: 'p1', runId: 'r', retroCouncilId: 'c', kind: 'step_task',
      target: { stepId: 's1', stepName: 'S' }, before: 'a', after: 'b', rationale: 'why', expectedEffect: 'better',
      evidence: { stepIds: ['s1'] }, configHash: 'h', status: 'proposed', createdAt: 'now',
    };
    improveStore.addProposals('p1', [p], 'r');
    expect(improveStore.getProposal('p1', 'prop-1')?.status).toBe('proposed');
    improveStore.updateProposal('p1', 'prop-1', { status: 'applied', appliedAt: 't' });
    expect(improveStore.getProposal('p1', 'prop-1')?.status).toBe('applied');
    improveStore.appendChangelog('p1', { id: 'cl', proposalId: 'prop-1', action: 'applied', at: 't', by: 'user' });
    expect(improveStore.get('p1').changelog).toHaveLength(1);

    const lesson = { id: 'l1', text: 'Always cite sources', scope: 'worker' as const, source: { runId: 'r' }, createdAt: 't', confirmations: 0, active: true };
    improveStore.upsertLesson('p1', lesson);
    improveStore.upsertLesson('p1', { ...lesson, id: 'l2' }); // same text → confirmation, not duplicate
    expect(improveStore.get('p1').lessons).toHaveLength(1);
    expect(improveStore.get('p1').lessons[0].confirmations).toBe(1);
    improveStore.setLessonActive('p1', 'l1', false);
    expect(improveStore.get('p1').lessons[0].active).toBe(false);
  });

  it('deleteAll removes state and scorecards', () => {
    improveStore.saveScorecard(card('p1', 'run-01'));
    improveStore.deleteAll('p1');
    expect(improveStore.listScorecards('p1')).toEqual([]);
    expect(councilDataStore.getItem(scorecardKey('p1', 'run-01'))).toBeNull();
  });
});

describe('improve/step-input', () => {
  it('round-trips a record and renders markdown', () => {
    saveStepInput({
      pipelineId: 'p', stepId: 's', councilId: 'c-1', runId: 'r', kind: 'unbound', stepType: 'agent',
      outputType: 'string', task: 'Do X', inputTemplate: '{{input}}', inputContext: 'ctx', previousArtifactStepIds: ['s0'],
      rawProblem: 'Do X\n\n---\n\nctx', recordedAt: 't',
    });
    const rec = getStepInput('c-1');
    expect(rec?.kind).toBe('unbound');
    expect(rec?.rawProblem).toContain('Do X');
    const md = formatStepInputMarkdown(rec!);
    expect(md).toContain('## Task');
    expect(md).toContain('## Raw problem');
    deleteStepInput('c-1');
    expect(getStepInput('c-1')).toBeNull();
  });
});
