import { describe, it, expect } from 'vitest';
import { pipelineStore } from '../../src/pipeline/store';
import { councilStore } from '../../src/council/store';
import { createCouncilFromSetup } from '../../src/council/factory';
import type { CouncilStepConfig } from '../../src/pipeline/types';
import { improveStore } from '../../src/improve/store';
import { applyProposal, revertProposal, rejectProposal, approveProposal, proposalTargetHash, boundCouncilHash } from '../../src/improve/apply';
import { applyToConfig, MutationError } from '../../src/improve/mutate';
import type { Proposal, ProposalKind, ProposalTarget } from '../../src/improve/types';

function mkUnbound() {
  const p = pipelineStore.create({ name: 'ApplyUnbound', initialInput: 'seed' });
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
  const step = pipelineStore.get(p.id)!.stages[0].steps[0];
  return { pid: p.id, step };
}

let n = 0;
function mkProposal(pid: string, kind: ProposalKind, target: ProposalTarget, after: unknown, configHash: string, extra: Partial<Proposal> = {}): Proposal {
  const p: Proposal = {
    id: `prop-${++n}`, pipelineId: pid, runId: 'r', retroCouncilId: 'c', kind, target, before: undefined, after,
    rationale: 'because', expectedEffect: 'better', evidence: { stepIds: [target.stepId] }, configHash, status: 'proposed', createdAt: 't', ...extra,
  };
  improveStore.addProposals(pid, [p], 'r');
  return p;
}

const stepCfg = (pid: string) => pipelineStore.get(pid)!.stages[0].steps[0].config as CouncilStepConfig;

describe('improve/apply — unbound steps', () => {
  it('applies a task change, records before/after hashes and a changelog entry, then reverts', async () => {
    const { pid, step } = mkUnbound();
    const p = mkProposal(pid, 'step_task', { stepId: step.id, stepName: 'Memo' }, 'Write the memo in <300 words.', proposalTargetHash(step));
    const applied = await applyProposal(pid, p.id, 'user');
    expect(applied.status).toBe('applied');
    expect(applied.before).toBe('Write the memo.');
    expect(applied.appliedConfigHash).toMatch(/^[0-9a-f]{8}$/);
    expect(stepCfg(pid).task).toBe('Write the memo in <300 words.');
    expect(improveStore.get(pid).changelog.map((c) => c.action)).toEqual(['applied']);

    const reverted = await revertProposal(pid, p.id, 'user');
    expect(reverted.status).toBe('reverted');
    expect(stepCfg(pid).task).toBe('Write the memo.');
    expect(improveStore.get(pid).changelog.map((c) => c.action)).toEqual(['applied', 'reverted']);
  });

  it('refuses stale proposals (field changed since) and stale reverts (step changed after apply)', async () => {
    const { pid, step } = mkUnbound();
    // Hash mismatch AND the field it edits no longer holds the recorded `before` → stale.
    const stale = mkProposal(pid, 'step_task', { stepId: step.id, stepName: 'Memo' }, 'new task', 'deadbeef', { before: 'some older task' });
    expect((await applyProposal(pid, stale.id, 'user')).status).toBe('stale');
    expect(stepCfg(pid).task).toBe('Write the memo.');
    // Hash mismatch but the field is untouched → rebases and applies (sibling proposals).
    const rebased = mkProposal(pid, 'expected_output', { stepId: step.id, stepName: 'Memo' }, 'A tight memo', 'deadbeef', { before: 'A memo' });
    expect((await applyProposal(pid, rebased.id, 'user')).status).toBe('applied');
    expect(stepCfg(pid).councilSetup.expectedOutput).toBe('A tight memo');
    await revertProposal(pid, rebased.id, 'user');

    const ok = mkProposal(pid, 'expected_output', { stepId: step.id, stepName: 'Memo' }, 'A 1-page memo', proposalTargetHash(step));
    expect((await applyProposal(pid, ok.id, 'user')).status).toBe('applied');
    // Someone edits the step by hand afterwards…
    pipelineStore.updateStepConfig(pid, step.id, { ...stepCfg(pid), task: 'hand edited' });
    const r = await revertProposal(pid, ok.id, 'user');
    expect(r.status).toBe('applied'); // NOT reverted
    expect(r.reason).toMatch(/changed again/);
  });

  it('targets personas by index+name, falls back to a unique name, flags a renamed persona as stale', async () => {
    const { pid, step } = mkUnbound();
    const p1 = mkProposal(pid, 'focus_area', { stepId: step.id, stepName: 'Memo', persona: { index: 1, name: 'Drafter', role: 'worker' } }, 'brevity', proposalTargetHash(step));
    expect((await applyProposal(pid, p1.id, 'user')).status).toBe('applied');
    expect(stepCfg(pid).councilSetup.personas[1].focusArea).toBe('brevity');

    // Wrong index but unique name → still resolves.
    const live = pipelineStore.get(pid)!.stages[0].steps[0];
    const p2 = mkProposal(pid, 'persona_prompt', { stepId: step.id, stepName: 'Memo', persona: { index: 0, name: 'Drafter', role: 'worker' } }, 'You are a terse drafter.', proposalTargetHash(live));
    expect((await applyProposal(pid, p2.id, 'user')).status).toBe('applied');
    expect(stepCfg(pid).councilSetup.personas[1].systemPrompt).toBe('You are a terse drafter.');

    // Persona renamed → stale.
    const live2 = pipelineStore.get(pid)!.stages[0].steps[0];
    const p3 = mkProposal(pid, 'focus_area', { stepId: step.id, stepName: 'Memo', persona: { index: 1, name: 'Ghost', role: 'worker' } }, 'x', proposalTargetHash(live2));
    expect((await applyProposal(pid, p3.id, 'user')).status).toBe('stale');
  });

  it('worker_prompt requires the COMPLETION SUMMARY contract and flips suppressPersona atomically; revert restores both', async () => {
    const { pid, step } = mkUnbound();
    const bad = mkProposal(pid, 'worker_prompt', { stepId: step.id, stepName: 'Memo', persona: { index: 1, name: 'Drafter', role: 'worker' } }, 'Just write well, no summary.', proposalTargetHash(step));
    const r = await applyProposal(pid, bad.id, 'user');
    expect(r.status).toBe('invalid');
    expect(r.reason).toMatch(/COMPLETION SUMMARY/);

    const good = mkProposal(pid, 'worker_prompt', { stepId: step.id, stepName: 'Memo', persona: { index: 1, name: 'Drafter', role: 'worker' } },
      'You are a terse drafter.\n\nEnd with:\n## COMPLETION SUMMARY\n**Status:** ...', proposalTargetHash(step));
    const a = await applyProposal(pid, good.id, 'user');
    expect(a.status).toBe('applied');
    expect(stepCfg(pid).councilSetup.personas[1].suppressPersona).toBe(false);
    expect(a.before).toEqual({ systemPrompt: 'You are the drafter.', suppressPersona: undefined });
    await revertProposal(pid, good.id, 'user');
    expect(stepCfg(pid).councilSetup.personas[1].systemPrompt).toBe('You are the drafter.');
    expect(stepCfg(pid).councilSetup.personas[1].suppressPersona).toBeUndefined();
  });

  it('bounds council settings, rejects unknown settings, and blocks changes that break validation', async () => {
    const { pid, step } = mkUnbound();
    const tooBig = mkProposal(pid, 'council_setting', { stepId: step.id, stepName: 'Memo', path: 'councilSetup.maxRounds' }, 50, proposalTargetHash(step));
    expect((await applyProposal(pid, tooBig.id, 'user')).status).toBe('invalid');
    const unknown = mkProposal(pid, 'council_setting', { stepId: step.id, stepName: 'Memo', path: 'councilSetup.name' }, 'x', proposalTargetHash(step));
    expect((await applyProposal(pid, unknown.id, 'user')).status).toBe('rejected');
    // maxRounds 0 with a consultant-less council is fine; with consultants the builder flags it.
    pipelineStore.updateStepConfig(pid, step.id, {
      ...stepCfg(pid),
      councilSetup: { ...stepCfg(pid).councilSetup, personas: [...stepCfg(pid).councilSetup.personas, { name: 'Critic', role: 'consultant', model: 'm', provider: 'deepseek' }] },
    });
    const live = pipelineStore.get(pid)!.stages[0].steps[0];
    const zero = mkProposal(pid, 'council_setting', { stepId: step.id, stepName: 'Memo', path: 'councilSetup.maxRounds' }, 0, proposalTargetHash(live));
    const z = await applyProposal(pid, zero.id, 'user');
    expect(z.status).toBe('invalid');
    expect(z.reason).toMatch(/Would break the step/);
    expect(stepCfg(pid).councilSetup.maxRounds).toBe(2);
    const ok = mkProposal(pid, 'council_setting', { stepId: step.id, stepName: 'Memo', path: 'councilSetup.maxRevisions' }, 3, proposalTargetHash(live));
    expect((await applyProposal(pid, ok.id, 'user')).status).toBe('applied');
    expect(stepCfg(pid).councilSetup.maxRevisions).toBe(3);
  });

  it('approve / reject bookkeeping and lesson apply/revert', async () => {
    const { pid, step } = mkUnbound();
    const l = mkProposal(pid, 'lesson', { stepId: '', stepName: 'all steps' }, { text: 'State the word budget.', scope: 'manager' }, '');
    expect(approveProposal(pid, l.id)?.status).toBe('approved');
    const a = await applyProposal(pid, l.id, 'user');
    expect(a.status).toBe('applied');
    const lessons = improveStore.get(pid).lessons;
    expect(lessons).toHaveLength(1);
    expect(lessons[0].active).toBe(true);
    expect(lessons[0].source.proposalId).toBe(l.id);
    await revertProposal(pid, l.id, 'user');
    expect(improveStore.get(pid).lessons[0].active).toBe(false);

    const r = mkProposal(pid, 'step_task', { stepId: step.id, stepName: 'Memo' }, 'x', proposalTargetHash(step));
    expect(rejectProposal(pid, r.id, 'nah')?.status).toBe('rejected');
    expect(rejectProposal(pid, r.id)?.reason).toBe('nah');
    // Applying a rejected proposal is a no-op.
    expect((await applyProposal(pid, r.id, 'user')).status).toBe('rejected');
  });

  it('applyToConfig is pure and typed', () => {
    const { step } = mkUnbound();
    const cfg = step.config as CouncilStepConfig;
    const { config, before } = applyToConfig(cfg, { kind: 'decision_criteria', target: { stepId: step.id, stepName: 'Memo' }, after: ['clear', 'short'] } as Proposal);
    expect(before).toBeUndefined();
    expect(config.councilSetup.decisionCriteria).toEqual(['clear', 'short']);
    expect(cfg.councilSetup.decisionCriteria).toBeUndefined(); // input untouched
    expect(() => applyToConfig(cfg, { kind: 'decision_criteria', target: { stepId: step.id, stepName: 'Memo' }, after: 'nope' } as Proposal)).toThrow(MutationError);
    expect(() => applyToConfig(cfg, { kind: 'lesson', target: { stepId: step.id, stepName: 'Memo' }, after: 'x' } as Proposal)).toThrow(/not a step-config mutation/);
  });
});

describe('improve/apply — bound councils', () => {
  it('applies to the council record (Zod-validated) and reverts', async () => {
    const council = createCouncilFromSetup({
      name: 'BoundC', pipelineId: 'later',
      personas: [
        { name: 'Boss', role: 'manager', model: 'm', provider: 'deepseek' },
        { name: 'Drafter', role: 'worker', model: 'm', provider: 'deepseek', systemPrompt: 'You are the bound drafter.' },
      ],
      task: 'Bound task', maxRounds: 2, maxRevisions: 1,
    });
    const p = pipelineStore.create({ name: 'ApplyBound' });
    const s = pipelineStore.addStage(p.id)!.stages[0];
    pipelineStore.addStep(p.id, s.id, { type: 'council', boundCouncilId: council.id, councilSetup: { name: 'shell', personas: [] }, inputTemplate: '{{input}}' } as CouncilStepConfig, 'Bound');
    const step = pipelineStore.get(p.id)!.stages[0].steps[0];
    const drafter = council.personas[1];
    const hash = proposalTargetHash(step);
    expect(hash).toBe(boundCouncilHash(council));

    const prompt = mkProposal(p.id, 'persona_prompt', { stepId: step.id, stepName: 'Bound', bound: { councilId: council.id, personaId: drafter.id }, persona: { index: 1, name: 'Drafter', role: 'worker' } }, 'You are a terse bound drafter.', hash);
    const a = await applyProposal(p.id, prompt.id, 'user');
    expect(a.status).toBe('applied');
    expect(councilStore.get(council.id)!.personas[1].predisposition.systemPrompt).toBe('You are a terse bound drafter.');
    expect(a.before).toBe('You are the bound drafter.');

    // Zod: too-short prompt → rejected, council unchanged.
    const live = pipelineStore.get(p.id)!.stages[0].steps[0];
    const short = mkProposal(p.id, 'persona_prompt', { stepId: step.id, stepName: 'Bound', bound: { councilId: council.id, personaId: drafter.id }, persona: { index: 1, name: 'Drafter', role: 'worker' } }, 'short', proposalTargetHash(live));
    expect((await applyProposal(p.id, short.id, 'user')).status).toBe('invalid');
    expect(councilStore.get(council.id)!.personas[1].predisposition.systemPrompt).toBe('You are a terse bound drafter.');

    // Task + focus area + setting on the council record.
    const live2 = pipelineStore.get(p.id)!.stages[0].steps[0];
    const task = mkProposal(p.id, 'step_task', { stepId: step.id, stepName: 'Bound', bound: { councilId: council.id } }, 'Bound task v2', proposalTargetHash(live2));
    expect((await applyProposal(p.id, task.id, 'user')).status).toBe('applied');
    expect(councilStore.get(council.id)!.deliberation!.savedProblem).toBe('Bound task v2');
    const live3 = pipelineStore.get(p.id)!.stages[0].steps[0];
    const focus = mkProposal(p.id, 'focus_area', { stepId: step.id, stepName: 'Bound', bound: { councilId: council.id, personaId: drafter.id }, persona: { index: 1, name: 'Drafter', role: 'worker' } }, 'clarity', proposalTargetHash(live3));
    expect((await applyProposal(p.id, focus.id, 'user')).status).toBe('applied');
    expect(councilStore.get(council.id)!.deliberation!.roleAssignments.find((r) => r.personaId === drafter.id)!.focusArea).toBe('clarity');
    const live4 = pipelineStore.get(p.id)!.stages[0].steps[0];
    const rounds = mkProposal(p.id, 'council_setting', { stepId: step.id, stepName: 'Bound', bound: { councilId: council.id }, path: 'councilSetup.maxRounds' }, 1, proposalTargetHash(live4));
    expect((await applyProposal(p.id, rounds.id, 'user')).status).toBe('applied');
    expect(councilStore.get(council.id)!.deliberation!.maxRounds).toBe(1);

    // Revert the most recent first (hash chain), then the prompt.
    expect((await revertProposal(p.id, rounds.id, 'user')).status).toBe('reverted');
    expect(councilStore.get(council.id)!.deliberation!.maxRounds).toBe(2);
    const r = await revertProposal(p.id, prompt.id, 'user');
    expect(r.status).toBe('applied'); // council changed after this apply → refused
    expect(r.reason).toMatch(/changed again/);
  });
});
