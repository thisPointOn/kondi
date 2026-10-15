import { describe, it, expect } from 'vitest';
import { pipelineStore } from '../../src/pipeline/store';
import { councilStore } from '../../src/council/store';
import type { CouncilStepConfig } from '../../src/pipeline/types';
import { improveStore } from '../../src/improve/store';
import { runImprovementCycle } from '../../src/improve/cycle';
import { RETRO_COUNCIL_PREFIX } from '../../src/improve/retrospective';
import type { RunScorecard, SelfImproveSettings } from '../../src/improve/types';
import type { AgentInvocation } from '../../src/council/deliberation-orchestrator';

function mkPipeline(selfImprove: Partial<SelfImproveSettings>) {
  const p = pipelineStore.create({ name: 'Cycle', initialInput: 'seed', settings: { workingDirectory: '/virt/wd' } });
  pipelineStore.update(p.id, { settings: { ...pipelineStore.get(p.id)!.settings, selfImprove: selfImprove as SelfImproveSettings } });
  const s = pipelineStore.addStage(p.id)!.stages[0];
  const cfg: CouncilStepConfig = {
    type: 'agent',
    councilSetup: { name: 'draft', personas: [{ name: 'Drafter', role: 'worker', model: 'm', provider: 'deepseek', toolAccess: 'none' }], maxRounds: 1, maxRevisions: 0 },
    task: 'Write the thing.', inputTemplate: '{{input}}', outputType: 'string',
  };
  pipelineStore.addStep(p.id, s.id, cfg, 'Draft');
  const stepId = pipelineStore.get(p.id)!.stages[0].steps[0].id;
  improveStore.saveScorecard(<RunScorecard>{
    version: 1, runId: 'run-1', pipelineId: p.id, pipelineName: 'Cycle', startedAt: 't', completedAt: 't2', status: 'completed',
    totalTokens: 100, totalCostUsd: 0.01, totalDurationMs: 1000, recipeHash: 'x',
    steps: [{ stepId, stepName: 'Draft', stepType: 'agent', status: 'completed', tokens: 100, costUsd: 0.01, entries: 2, rounds: 0, revisions: 0,
      reviewOutcomes: { accept: 0, revise: 0, re_deliberate: 0 }, firstTryAccept: true, errors: 0, outputChars: 50, completionSummaryPresent: true, seats: [], flags: ['tool_narration'] }],
  });
  return { pid: p.id, stepId };
}

/** A scripted retrospective: proposes a task edit, a focus area and a lesson. */
function scriptedRetro(stepId: string) {
  return async (_inv: AgentInvocation) => ({
    content: JSON.stringify({
      proposals: [
        { kind: 'step_task', stepId, after: 'Write the thing as plain text; never narrate tool calls.', rationale: 'tool_narration flag', expectedEffect: 'clean output', evidenceEntryIds: [] },
        { kind: 'focus_area', stepId, personaIndex: 0, personaName: 'Drafter', after: 'plain prose', rationale: 'r', expectedEffect: 'e' },
      ],
      lessons: [{ text: 'Never narrate tool calls in a text deliverable.', scope: 'worker' }],
    }),
    tokensUsed: 50, latencyMs: 3,
  });
}

const task = (pid: string) => (pipelineStore.get(pid)!.stages[0].steps[0].config as CouncilStepConfig).task;

describe('improve/cycle', () => {
  it('does nothing post-run when disabled', async () => {
    const { pid } = mkPipeline({ enabled: false });
    const r = await runImprovementCycle(pid, { trigger: 'post-run' }, { invokeAgent: async () => { throw new Error('should not be called'); } });
    expect(r.ran).toBe(false);
    expect(improveStore.get(pid).proposals).toEqual([]);
  });

  it('manual mode queues proposals (incl. lessons) without applying, creates an auditable retro council, no new pipelines', async () => {
    const { pid, stepId } = mkPipeline({ enabled: true, mode: 'manual' });
    const pipelinesBefore = pipelineStore.getAll().length;
    const logs: string[] = [];
    const r = await runImprovementCycle(pid, { trigger: 'post-run' }, { invokeAgent: scriptedRetro(stepId), onLog: (m) => logs.push(m) });
    expect(r.ran).toBe(true);
    expect(r.mode).toBe('manual');
    expect(r.proposals.map((p) => p.kind)).toEqual(['step_task', 'focus_area', 'lesson']);
    expect(r.applied).toEqual([]);
    expect(improveStore.get(pid).proposals.every((p) => p.status === 'proposed')).toBe(true);
    expect(task(pid)).toBe('Write the thing.');
    expect(improveStore.get(pid).lessons).toEqual([]);
    expect(pipelineStore.getAll().length).toBe(pipelinesBefore);
    const retro = councilStore.get(r.retroCouncilId!)!;
    expect(retro.name.startsWith(RETRO_COUNCIL_PREFIX)).toBe(true);
    expect(retro.pipelineId).toBe(pid);
    expect(retro.deliberation?.savedProblem).toContain('CURRENT RECIPE');
    expect(logs.some((l) => /queued for approval/.test(l))).toBe(true);
  });

  it('auto mode applies everything (evalMode none) and records the changelog', async () => {
    const { pid, stepId } = mkPipeline({ enabled: true, mode: 'auto', evalMode: 'none' });
    const r = await runImprovementCycle(pid, { trigger: 'post-run' }, { invokeAgent: scriptedRetro(stepId) });
    expect(r.applied.map((p) => p.kind)).toEqual(['step_task', 'focus_area', 'lesson']);
    expect(task(pid)).toBe('Write the thing as plain text; never narrate tool calls.');
    expect((pipelineStore.get(pid)!.stages[0].steps[0].config as CouncilStepConfig).councilSetup.personas[0].focusArea).toBe('plain prose');
    expect(improveStore.get(pid).lessons).toHaveLength(1);
    expect(improveStore.get(pid).changelog).toHaveLength(3);
    expect(improveStore.get(pid).proposals.every((p) => p.status === 'applied')).toBe(true);
  });

  it('a live toggle to manual mid-cycle stops further applies', async () => {
    const { pid, stepId } = mkPipeline({ enabled: true, mode: 'auto', evalMode: 'none' });
    // Flip the mode as soon as the FIRST proposal is applied (store notifies on apply).
    const unsub = improveStore.subscribe(() => {
      const s = improveStore.get(pid);
      if (s.proposals.some((p) => p.status === 'applied')) {
        const live = pipelineStore.get(pid)!;
        pipelineStore.update(pid, { settings: { ...live.settings, selfImprove: { ...live.settings.selfImprove!, mode: 'manual' } } });
      }
    });
    const logs: string[] = [];
    const r = await runImprovementCycle(pid, { trigger: 'post-run' }, { invokeAgent: scriptedRetro(stepId), onLog: (m) => logs.push(m) });
    unsub();
    expect(r.applied).toHaveLength(1);
    expect(r.applied[0].kind).toBe('step_task');
    const statuses = improveStore.get(pid).proposals.map((p) => p.status);
    expect(statuses).toEqual(['applied', 'proposed', 'proposed']);
    expect(logs.some((l) => /switched to manual/.test(l))).toBe(true);
  });

  it('respects autoApplyMinScore when proposals carry scores', async () => {
    const { pid, stepId } = mkPipeline({ enabled: true, mode: 'auto', evalMode: 'judge-only', autoApplyMinScore: 0.7 });
    const r = await runImprovementCycle(pid, { trigger: 'post-run' }, {
      invokeAgent: scriptedRetro(stepId),
      evaluate: async (proposals) => {
        for (const p of proposals) {
          const total = p.kind === 'step_task' ? 0.9 : 0.2;
          improveStore.updateProposal(pid, p.id, { score: { total, evalMode: 'judge-only' } });
        }
        return proposals.map((p) => improveStore.getProposal(pid, p.id)!);
      },
    });
    expect(r.applied.map((p) => p.kind)).toEqual(['step_task']);
    expect(improveStore.getProposal(pid, r.proposals[1].id)!.status).toBe('proposed');
  });

  it('survives a retrospective that returns garbage', async () => {
    const { pid } = mkPipeline({ enabled: true, mode: 'auto' });
    const r = await runImprovementCycle(pid, { trigger: 'manual', runs: 3 }, { invokeAgent: async () => ({ content: 'no json here', tokensUsed: 1, latencyMs: 1 }) });
    expect(r.ran).toBe(true);
    expect(r.proposals).toEqual([]);
    expect(r.applied).toEqual([]);
  });
});
