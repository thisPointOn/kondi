import { describe, it, expect } from 'vitest';
import { pipelineStore } from '../../src/pipeline/store';
import { councilStore } from '../../src/council/store';
import type { CouncilStepConfig } from '../../src/pipeline/types';
import { improveStore } from '../../src/improve/store';
import { saveStepInput } from '../../src/improve/step-input';
import { proposalTargetHash } from '../../src/improve/apply';
import {
  isReplayable, replayStep, judgePair, candidateScore, combineJudge, mechanicalSignals, evaluateProposals, judgeProposalOnly,
} from '../../src/improve/eval';
import { RETRO_COUNCIL_PREFIX } from '../../src/improve/retrospective';
import { withSelfImproveDefaults } from '../../src/improve/types';
import type { Proposal, RunScorecard, StepScore } from '../../src/improve/types';
import type { AgentInvocation, AgentResponse } from '../../src/council/deliberation-orchestrator';
import type { Persona } from '../../src/council/types';

function mkPipeline() {
  const p = pipelineStore.create({ name: 'Eval', initialInput: 'seed' });
  const s = pipelineStore.addStage(p.id)!.stages[0];
  const cfg: CouncilStepConfig = {
    type: 'agent',
    councilSetup: { name: 'draft', personas: [{ name: 'Drafter', role: 'worker', model: 'm', provider: 'deepseek', toolAccess: 'none' }], maxRounds: 1, maxRevisions: 0, expectedOutput: 'A haiku' },
    task: 'Write a haiku.', inputTemplate: '{{input}}', outputType: 'string',
  };
  pipelineStore.addStep(p.id, s.id, cfg, 'Draft');
  const step = pipelineStore.get(p.id)!.stages[0].steps[0];
  // Pretend the step ran: artifact + recorded input + a scorecard.
  pipelineStore.setStepArtifact(p.id, step.id, { stepId: step.id, content: 'old haiku', artifactType: 'output', createdAt: 't', metadata: { councilId: 'orig-council', outputType: 'string' } });
  pipelineStore.setStepStatus(p.id, step.id, 'completed');
  saveStepInput({ pipelineId: p.id, stepId: step.id, councilId: 'orig-council', runId: 'run-1', kind: 'unbound', stepType: 'agent', outputType: 'string', task: 'Write a haiku.', inputTemplate: '{{input}}', inputContext: 'seed', rawProblem: 'Write a haiku.\n\n---\n\nseed', recordedAt: 't' });
  const baseline: StepScore = { stepId: step.id, stepName: 'Draft', stepType: 'agent', status: 'completed', tokens: 100, costUsd: 0.01, entries: 2, rounds: 0, revisions: 1,
    reviewOutcomes: { accept: 1, revise: 1, re_deliberate: 0 }, firstTryAccept: false, errors: 0, outputChars: 9, completionSummaryPresent: true, seats: [], flags: ['revise_loop'] };
  improveStore.saveScorecard(<RunScorecard>{ version: 1, runId: 'run-1', pipelineId: p.id, pipelineName: 'Eval', startedAt: 't', completedAt: 't2', status: 'completed', totalTokens: 100, totalCostUsd: 0.01, totalDurationMs: 1, recipeHash: 'x', steps: [baseline] });
  return { pid: p.id, step: pipelineStore.get(p.id)!.stages[0].steps[0], baseline };
}

/** Scripted invoker: replay worker emits a new haiku; judges prefer whichever slot holds it. */
function scripted(opts: { judgeBehaviour: 'prefer-new' | 'prefer-old' | 'inconsistent' | 'garbage'; replayContent?: string }) {
  let judgeCalls = 0;
  const seen: { name: string; user: string; system: string; wd?: string; skipTools?: boolean }[] = [];
  const invokeAgent = async (inv: AgentInvocation, persona: Persona): Promise<AgentResponse> => {
    seen.push({ name: persona.name, user: inv.userMessage, system: inv.systemPrompt, wd: inv.workingDirectory, skipTools: inv.skipTools });
    if (persona.name === 'Judge') {
      judgeCalls++;
      if (opts.judgeBehaviour === 'garbage') return { content: 'no json', tokensUsed: 1, latencyMs: 1 };
      if (inv.userMessage.includes('PROPOSED change')) return { content: '{"score": 0.8, "reasons": "plausible"}', tokensUsed: 1, latencyMs: 1 };
      const newInA = inv.userMessage.indexOf('new haiku') < inv.userMessage.indexOf('=== CANDIDATE B ===');
      let winner: string;
      if (opts.judgeBehaviour === 'prefer-new') winner = newInA ? 'A' : 'B';
      else if (opts.judgeBehaviour === 'prefer-old') winner = newInA ? 'B' : 'A';
      else winner = 'A'; // position bias → inconsistent across the swap
      return { content: `{"winner": "${winner}", "confidence": 0.8, "reasons": "because"}`, tokensUsed: 1, latencyMs: 1 };
    }
    return { content: opts.replayContent ?? 'new haiku\n\n## COMPLETION SUMMARY\n**Status:** Complete', tokensUsed: 50, latencyMs: 1 };
  };
  return { invokeAgent, seen, judgeCalls: () => judgeCalls };
}

const settings = (evalMode: 'replay' | 'judge-only') => withSelfImproveDefaults({ enabled: true, evalMode, retro: { provider: 'deepseek', model: 'm' } });

describe('improve/eval — pure scoring', () => {
  it('candidateScore / combineJudge handle agreement, disagreement and ties', () => {
    const v = (winner: 'A' | 'B' | 'tie', confidence = 0.8) => ({ winner, confidence, reasons: '', councilId: 'c' });
    expect(candidateScore(v('B'), 'B')).toBe(0.8);
    expect(candidateScore(v('A'), 'B')).toBe(-0.8);
    expect(candidateScore(v('tie'), 'B')).toBe(0);
    expect(combineJudge(0.8, 0.8)).toBeCloseTo(0.9);
    expect(combineJudge(-0.8, -0.8)).toBeCloseTo(0.1);
    expect(combineJudge(0.8, -0.8)).toBe(0.5);   // disagreement → neutral
    expect(combineJudge(0, 0.6)).toBeCloseTo(0.65);
  });

  it('mechanicalSignals rewards first-try acceptance / fewer revisions and punishes empty or invalid output', () => {
    const base: StepScore = { stepId: 's', stepName: 'S', stepType: 'agent', status: 'completed', tokens: 100, costUsd: 0.01, entries: 1, rounds: 0, revisions: 1,
      reviewOutcomes: { accept: 1, revise: 1, re_deliberate: 0 }, firstTryAccept: false, errors: 0, outputChars: 10, completionSummaryPresent: true, seats: [], flags: ['revise_loop'] };
    const better: StepScore = { ...base, revisions: 0, firstTryAccept: true, flags: [], costUsd: 0.005 };
    const worse: StepScore = { ...base, outputChars: 0, outputJsonValid: false, flags: ['empty_output', 'json_invalid', 'tool_narration'] };
    expect(mechanicalSignals(base, better, 'string').score).toBeCloseTo(0.95);
    expect(mechanicalSignals(base, worse, 'json').score).toBe(0);
    expect(mechanicalSignals(undefined, base, 'string').score).toBe(0.5);
  });
});

describe('improve/eval — replay + judge', () => {
  it('isReplayable gates on record, step type, binding and output type', () => {
    const { step } = mkPipeline();
    const rec = { pipelineId: 'p', stepId: step.id, councilId: 'c', runId: 'r', kind: 'unbound' as const, stepType: 'agent', outputType: 'string', inputTemplate: '', rawProblem: 'x', recordedAt: 't' };
    expect(isReplayable(step, rec)).toBe(true);
    expect(isReplayable(step, null)).toBe(false);
    expect(isReplayable({ ...step, config: { ...step.config, type: 'coding' } } as typeof step, rec)).toBe(false);
    expect(isReplayable({ ...step, config: { ...step.config, boundCouncilId: 'b' } } as typeof step, rec)).toBe(false);
    expect(isReplayable({ ...step, config: { ...step.config, outputType: 'directory' } } as typeof step, rec)).toBe(false);
  });

  it('replayStep runs a tool-less, wd-less council tagged with the pipeline id and returns content + score; no new pipelines', async () => {
    const { pid, step } = mkPipeline();
    const s = scripted({ judgeBehaviour: 'prefer-new' });
    const before = pipelineStore.getAll().length;
    const cfg = step.config as CouncilStepConfig;
    const mutated: CouncilStepConfig = { ...cfg, task: 'Write a BETTER haiku.' };
    const r = await replayStep(pid, step, { pipelineId: pid, stepId: step.id, councilId: 'orig-council', runId: 'run-1', kind: 'unbound', stepType: 'agent', outputType: 'string', task: 'Write a haiku.', inputTemplate: '{{input}}', inputContext: 'seed', rawProblem: 'ORIGINAL RAW', recordedAt: 't' }, mutated, { invokeAgent: s.invokeAgent });
    expect(r.content).toContain('new haiku');
    expect(r.score.status).toBe('completed');
    expect(r.score.tokens).toBe(50);
    const c = councilStore.get(r.councilId)!;
    expect(c.name.startsWith(RETRO_COUNCIL_PREFIX)).toBe(true);
    expect(c.pipelineId).toBe(pid);
    expect(c.deliberation?.workingDirectory).toBeUndefined();
    expect(s.seen[0].wd).toBeUndefined();
    expect(s.seen[0].skipTools).toBe(true);
    // The task changed → re-joined around the new task, not the recorded raw problem.
    expect(s.seen[0].user).toContain('Write a BETTER haiku.');
    expect(s.seen[0].user).toContain('seed');
    expect(s.seen[0].user).not.toContain('ORIGINAL RAW');
    expect(pipelineStore.getAll().length).toBe(before);
  });

  it('judgePair parses the verdict and tolerates garbage', async () => {
    const { pid } = mkPipeline();
    const good = scripted({ judgeBehaviour: 'prefer-new' });
    const v = await judgePair(pid, { task: 't', input: 'i', a: 'old haiku', b: 'new haiku' }, { provider: 'deepseek', model: 'm' }, { invokeAgent: good.invokeAgent });
    expect(v.winner).toBe('B');
    expect(v.confidence).toBe(0.8);
    const bad = scripted({ judgeBehaviour: 'garbage' });
    const g = await judgePair(pid, { task: 't', input: 'i', a: 'x', b: 'y' }, { provider: 'deepseek', model: 'm' }, { invokeAgent: bad.invokeAgent });
    expect(g.winner).toBe('tie');
    expect(g.confidence).toBe(0);
  });

  it('evaluateProposals (replay mode) scores high when the judge prefers the replay both ways, neutral when inconsistent, low when it prefers the original', async () => {
    const mk = (behaviour: 'prefer-new' | 'prefer-old' | 'inconsistent') => {
      const { pid, step } = mkPipeline();
      const p: Proposal = { id: `e-${behaviour}`, pipelineId: pid, runId: 'run-1', retroCouncilId: 'c', kind: 'step_task', target: { stepId: step.id, stepName: 'Draft' }, before: 'Write a haiku.', after: 'Write a vivid haiku.', rationale: 'r', expectedEffect: 'e', evidence: { stepIds: [step.id] }, configHash: proposalTargetHash(step), status: 'proposed', createdAt: 't' };
      improveStore.addProposals(pid, [p], 'run-1');
      const s = scripted({ judgeBehaviour: behaviour });
      return { pid, p, s };
    };
    const hi = mk('prefer-new');
    const [h] = await evaluateProposals(hi.pid, [hi.p], settings('replay'), { invokeAgent: hi.s.invokeAgent });
    expect(h.status).toBe('proposed');
    expect(h.score?.evalMode).toBe('replay');
    expect(h.score?.judge).toEqual({ ab: 0.8, ba: 0.8 });
    expect(h.score?.total).toBeGreaterThan(0.8);
    expect(h.score?.replayCouncilIds).toHaveLength(1);
    expect(h.score?.judgeCouncilIds).toHaveLength(2);
    expect(hi.s.judgeCalls()).toBe(2);

    const mid = mk('inconsistent');
    const [m] = await evaluateProposals(mid.pid, [mid.p], settings('replay'), { invokeAgent: mid.s.invokeAgent });
    expect(m.score?.judge).toEqual({ ab: -0.8, ba: 0.8 });
    expect(m.score?.total).toBeLessThan(0.7);
    expect(m.score?.total).toBeGreaterThan(0.4);

    const lo = mk('prefer-old');
    const [l] = await evaluateProposals(lo.pid, [lo.p], settings('replay'), { invokeAgent: lo.s.invokeAgent });
    expect(l.score?.total).toBeLessThan(0.4);
  });

  it('judge-only mode scores from the proposal text alone and skips lessons', async () => {
    const { pid, step } = mkPipeline();
    const p: Proposal = { id: 'jo', pipelineId: pid, runId: 'run-1', retroCouncilId: 'c', kind: 'focus_area', target: { stepId: step.id, stepName: 'Draft', persona: { index: 0, name: 'Drafter', role: 'worker' } }, before: undefined, after: 'imagery', rationale: 'r', expectedEffect: 'e', evidence: { stepIds: [step.id] }, configHash: proposalTargetHash(step), status: 'proposed', createdAt: 't' };
    const lesson: Proposal = { ...p, id: 'les', kind: 'lesson', after: { text: 'x', scope: 'all' } };
    improveStore.addProposals(pid, [p, lesson], 'run-1');
    const s = scripted({ judgeBehaviour: 'prefer-new' });
    const out = await evaluateProposals(pid, [p, lesson], settings('judge-only'), { invokeAgent: s.invokeAgent });
    expect(out[0].score?.evalMode).toBe('judge-only');
    expect(out[0].score?.total).toBe(0.8);
    expect(out[1].score).toBeUndefined();
    expect(s.judgeCalls()).toBe(1);
    const direct = await judgeProposalOnly(pid, p, { provider: 'deepseek', model: 'm' }, { invokeAgent: s.invokeAgent });
    expect(direct.score).toBe(0.8);
  });
});
