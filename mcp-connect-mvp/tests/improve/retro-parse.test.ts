import { describe, it, expect } from 'vitest';
import { pipelineStore } from '../../src/pipeline/store';
import type { CouncilStepConfig } from '../../src/pipeline/types';
import { parseProposalSet, buildRetroBundle, buildRetroTask, allowedKinds, lessonsAsProposals } from '../../src/improve/retrospective';
import { withSelfImproveDefaults } from '../../src/improve/types';
import type { RunScorecard } from '../../src/improve/types';

function mkPipeline() {
  const p = pipelineStore.create({ name: 'RetroParse', initialInput: 'seed' });
  const s = pipelineStore.addStage(p.id)!.stages[0];
  const cfg: CouncilStepConfig = {
    type: 'council',
    councilSetup: {
      name: 'c',
      personas: [
        { name: 'Boss', role: 'manager', model: 'm', provider: 'deepseek' },
        { name: 'Drafter', role: 'worker', model: 'm', provider: 'deepseek', systemPrompt: 'You are the drafter.' },
      ],
      maxRounds: 2, maxRevisions: 1, expectedOutput: 'A memo',
    },
    task: 'Write the memo.',
    inputTemplate: '{{input}}',
    outputType: 'string',
  };
  pipelineStore.addStep(p.id, s.id, cfg, 'Memo');
  const stepId = pipelineStore.get(p.id)!.stages[0].steps[0].id;
  return { pid: p.id, stepId };
}

const settings = withSelfImproveDefaults({ enabled: true, maxProposalsPerRun: 3 });

describe('improve/retrospective parsing', () => {
  it('parses fenced JSON wrapped in prose, resolves targets, drops unknowns, dedupes and caps', () => {
    const { pid, stepId } = mkPipeline();
    const pipeline = pipelineStore.get(pid)!;
    const raw = `Here is my analysis.\n\n\`\`\`json\n${JSON.stringify({
      proposals: [
        { kind: 'step_task', stepId, after: 'Write the memo in under 300 words.', rationale: 'too long', expectedEffect: 'fewer revisions', evidenceEntryIds: ['e1'] },
        { kind: 'step_task', stepId, after: 'Write the memo in under 300 words.', rationale: 'dup' },           // duplicate → dropped
        { kind: 'focus_area', stepId, personaIndex: 1, personaName: 'Drafter', after: 'brevity', rationale: 'r' },
        { kind: 'persona_prompt', stepId, personaIndex: 0, personaName: 'Nobody', after: 'xxxxxxxxxxxx', rationale: 'r' },  // unknown persona → dropped
        { kind: 'structure', stepId, after: 'add step', rationale: 'r' },                                       // not in scope → dropped
        { kind: 'expected_output', stepId, after: 'A memo', rationale: 'no change' },                          // unchanged → dropped
        { kind: 'step_task', stepId: 'nope', after: 'x', rationale: 'r' },                                     // unknown step → dropped
        { kind: 'council_setting', stepId, path: 'maxRevisions', after: 2, rationale: 'r' },
        { kind: 'council_setting', stepId, path: 'maxRounds', after: 1, rationale: 'r' },                      // over cap (3) → dropped
      ],
      lessons: [
        { text: 'Always state the word budget in the directive.', scope: 'manager', stepId },
        { text: 'Cite the source for every claim.', scope: 'bogus' },
        { text: '' },
      ],
    })}\n\`\`\`\n\n## COMPLETION SUMMARY\n**Status:** Complete`;

    const { proposals, lessons, dropped } = parseProposalSet(raw, pipeline, settings, 'run-1', 'retro-1');
    expect(proposals.map((p) => p.kind)).toEqual(['step_task', 'focus_area', 'council_setting']);
    expect(proposals[0].before).toBe('Write the memo.');
    expect(proposals[0].evidence.ledgerEntryIds).toEqual(['e1']);
    expect(proposals[1].target.persona).toEqual({ index: 1, name: 'Drafter', role: 'worker' });
    expect(proposals[1].before).toBeUndefined();
    expect(proposals[2].target.path).toBe('councilSetup.maxRevisions');
    expect(proposals[2].before).toBe(1);
    for (const p of proposals) {
      expect(p.configHash).toMatch(/^[0-9a-f]{8}$/);
      expect(p.status).toBe('proposed');
      expect(p.runId).toBe('run-1');
      expect(p.retroCouncilId).toBe('retro-1');
    }
    expect(dropped.some((d) => d.includes('Nobody'))).toBe(true);
    expect(dropped.some((d) => d.includes('structure'))).toBe(true);
    expect(dropped.some((d) => d.includes('nope'))).toBe(true);
    expect(dropped.some((d) => d.includes('changes nothing'))).toBe(true);

    expect(lessons).toHaveLength(2);
    expect(lessons[0].scope).toBe('manager');
    expect(lessons[0].stepId).toBe(stepId);
    expect(lessons[1].scope).toBe('all'); // bogus scope → all

    const asProps = lessonsAsProposals(lessons, pipeline, 'run-1', 'retro-1');
    expect(asProps[0].kind).toBe('lesson');
    expect(asProps[0].target.stepName).toBe('Memo');
    expect(asProps[1].target.stepName).toBe('all steps');
  });

  it('returns nothing (and says why) for non-JSON output', () => {
    const { pid } = mkPipeline();
    const r = parseProposalSet('I could not analyse this.', pipelineStore.get(pid)!, settings, 'r', 'c');
    expect(r.proposals).toEqual([]);
    expect(r.dropped[0]).toMatch(/not valid JSON/);
  });

  it('builds a bundle that names steps, personas, scorecard flags and allowed kinds, within the cap', () => {
    const { pid, stepId } = mkPipeline();
    const pipeline = pipelineStore.get(pid)!;
    const card: RunScorecard = {
      version: 1, runId: 'run-9', pipelineId: pid, pipelineName: 'RetroParse', startedAt: 't', completedAt: 't2', status: 'completed',
      totalTokens: 1234, totalCostUsd: 0.05, totalDurationMs: 9000, recipeHash: 'abc',
      steps: [{
        stepId, stepName: 'Memo', stepType: 'council', status: 'completed', tokens: 1234, costUsd: 0.05, entries: 9, rounds: 2, revisions: 2,
        reviewOutcomes: { accept: 1, revise: 2, re_deliberate: 0 }, firstTryAccept: false, errors: 0, outputChars: 100,
        completionSummaryPresent: true, seats: [], flags: ['revise_loop'],
      }],
    };
    const bundle = buildRetroBundle({ pipeline, scorecards: [card], state: null, settings });
    expect(bundle).toContain(`id=${stepId}`);
    expect(bundle).toContain('persona index=1 name="Drafter" role=worker');
    expect(bundle).toContain('FLAGS: revise_loop');
    expect(bundle).toContain('ALLOWED PROPOSAL KINDS');
    expect(bundle.length).toBeLessThan(24_500);
    expect(allowedKinds(settings)).toContain('step_task');
    expect(allowedKinds(settings)).not.toContain('structure');
    const task = buildRetroTask(settings);
    expect(task).toContain('ONLY a single JSON object');
    expect(task).toContain(`At most ${settings.maxProposalsPerRun}`);
  });
});
