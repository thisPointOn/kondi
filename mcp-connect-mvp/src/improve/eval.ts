/**
 * Self-Improvement: evaluation (replay + judge + mechanical signals).
 *
 * A proposal is scored BEFORE anyone decides on it:
 *   1. replay  — re-run the affected step with the proposed change on the
 *                step's RECORDED input (StepInputRecord), via the factory +
 *                DeliberationOrchestrator directly (never a second
 *                PipelineExecutor: no library/run-dir/memory side effects).
 *   2. judge   — a worker-only "[Improve] Judge" council compares the original
 *                run's output (baseline) with the replay output, blind and
 *                position-swapped (A/B then B/A). Disagreement → neutral.
 *   3. mechanical — revisions, first-try acceptance, flags, cost, JSON validity
 *                of the replay vs the baseline step score.
 *   total = 0.7 · judge + 0.3 · mechanical  (0..1)
 *
 * 'judge-only' skips the replay and asks the judge to rate the proposal on the
 * evidence alone (cheap, weaker). Coding steps and bound councils are
 * judge-only in v1 (replaying them needs a worktree / shadow council).
 */

import { pipelineStore } from '../pipeline/store';
import type { PipelineStep, CouncilStepConfig, PipelinePersona } from '../pipeline/types';
import { isCouncilType } from '../pipeline/types';
import { createCouncilFromSetup } from '../council/factory';
import { DeliberationOrchestrator } from '../council/deliberation-orchestrator';
import { getDecision, getLatestOutput } from '../council/context-store';
import { stripCompletedCouncil } from '../council/storage-cleanup';
import { extractJsonBlock } from '../pipeline/input-template';
import { improveStore } from './store';
import { getStepInput } from './step-input';
import { applyToConfig } from './mutate';
import { scoreStep } from './run-metrics';
import { RETRO_COUNCIL_PREFIX } from './retrospective';
import type { RetroDeps } from './retrospective';
import type { Proposal, SelfImproveSettings, StepScore, EvalMode, StepInputRecord } from './types';

// ============================================================================
// Replayability
// ============================================================================

export function isReplayable(step: PipelineStep, record: StepInputRecord | null): boolean {
  if (!record) return false;
  if (!isCouncilType(step.config.type)) return false;
  const cfg = step.config as CouncilStepConfig;
  if (cfg.boundCouncilId) return false;              // v1: judge-only for bound councils
  if (step.config.type === 'coding') return false;    // v1: needs a worktree to replay safely
  const out = cfg.outputType || 'string';
  return out === 'string' || out === 'json';
}

const forceNoTools = (personas: PipelinePersona[]): PipelinePersona[] =>
  personas.map((p) => ({ ...p, toolAccess: 'none', saveOutput: false }));

// ============================================================================
// Replay
// ============================================================================

export interface ReplayResult {
  councilId: string;
  content: string;
  score: StepScore;
}

/**
 * Re-run a (mutated) step config on the recorded input. The replay council is
 * tool-less, has no working directory, is tagged with the pipeline id (so it
 * has a home per rule 21) and is stripped afterwards.
 */
export async function replayStep(
  pipelineId: string,
  step: PipelineStep,
  record: StepInputRecord,
  mutated: CouncilStepConfig,
  deps: RetroDeps,
): Promise<ReplayResult> {
  const original = step.config as CouncilStepConfig;
  // If the TASK changed, re-join the recorded parts around the new task;
  // otherwise replay the exact recorded problem.
  const rawProblem = mutated.task !== original.task
    ? [mutated.task, record.pipelineInput, record.inputContext].filter(Boolean).join('\n\n---\n\n')
    : record.rawProblem;

  const council = createCouncilFromSetup({
    ...mutated.councilSetup,
    name: `Replay · ${step.name}`,
    pipelinePrefix: RETRO_COUNCIL_PREFIX,
    pipelineId,
    personas: forceNoTools(mutated.councilSetup.personas || []),
    task: mutated.task,
    workingDirectory: undefined,
    directoryConstrained: true,
    bootstrapContext: false,
    saveDeliberation: false,
    stepType: mutated.type,
    outputType: mutated.outputType,
  });
  deps.onLog?.(`Replaying "${step.name}" with the proposed change (council ${council.id})`);

  const orchestrator = new DeliberationOrchestrator({
    invokeAgent: deps.invokeAgent,
    onAgentThinkingStart: deps.onAgentThinkingStart,
    onAgentThinkingEnd: deps.onAgentThinkingEnd,
    onError: (err, ctx) => deps.onLog?.(`Replay error in ${ctx}: ${err.message}`),
  });
  let content = '';
  try {
    await orchestrator.runFullDeliberation(council, rawProblem);
    content = (mutated.type === 'analysis' ? getDecision(council.id)?.content : undefined)
      || getLatestOutput(council.id)?.content || '';
    if (mutated.outputType === 'json') content = extractJsonBlock(content);
  } catch (err) {
    deps.onLog?.(`Replay failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const synthetic: PipelineStep = {
    ...step,
    status: content ? 'completed' : 'failed',
    config: mutated,
    artifact: { stepId: step.id, content, artifactType: 'output', createdAt: new Date().toISOString(), metadata: { councilId: council.id, outputType: mutated.outputType } },
  };
  const score = scoreStep(synthetic);
  try { stripCompletedCouncil(council.id); } catch { /* non-fatal */ }
  return { councilId: council.id, content, score };
}

// ============================================================================
// Judge
// ============================================================================

export interface JudgeVerdict {
  winner: 'A' | 'B' | 'tie';
  confidence: number;
  reasons: string;
  councilId: string;
}

const head = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…[truncated]` : s);

function buildJudgeTask(task: string, expectedOutput: string | undefined, input: string, a: string, b: string): string {
  return `You are a strict, impartial JUDGE comparing two candidate deliverables produced for the same task. Do not reward length, confidence or formatting; reward correctness, completeness against the task, adherence to the expected output, and absence of fabrication or narration of tools that were not used.

TASK GIVEN TO THE PRODUCER:
${head(task, 4000)}
${expectedOutput ? `\nEXPECTED OUTPUT:\n${head(expectedOutput, 1500)}\n` : ''}
INPUT MATERIAL THE PRODUCER HAD (excerpt):
${head(input, 6000)}

=== CANDIDATE A ===
${head(a, 9000)}

=== CANDIDATE B ===
${head(b, 9000)}

Respond with ONLY a JSON object: {"winner": "A" | "B" | "tie", "confidence": <0..1>, "reasons": "<2-4 sentences>"}`;
}

export async function judgePair(
  pipelineId: string,
  args: { task: string; expectedOutput?: string; input: string; a: string; b: string },
  judge: { provider: string; model: string },
  deps: RetroDeps,
): Promise<JudgeVerdict> {
  const task = buildJudgeTask(args.task, args.expectedOutput, args.input, args.a, args.b);
  const council = createCouncilFromSetup({
    name: 'Judge',
    pipelinePrefix: RETRO_COUNCIL_PREFIX,
    pipelineId,
    personas: [{ name: 'Judge', role: 'worker', model: judge.model, provider: judge.provider, toolAccess: 'none', suppressPersona: true, saveOutput: false, traits: ['impartial'] }],
    task,
    stepType: 'council', outputType: 'json', maxRounds: 0, maxRevisions: 0,
    saveDeliberation: false, bootstrapContext: false,
  });
  const orchestrator = new DeliberationOrchestrator({
    invokeAgent: deps.invokeAgent,
    onAgentThinkingStart: deps.onAgentThinkingStart,
    onAgentThinkingEnd: deps.onAgentThinkingEnd,
  });
  let verdict: JudgeVerdict = { winner: 'tie', confidence: 0, reasons: 'no verdict', councilId: council.id };
  try {
    // The orchestrator works from the raw problem (the factory `task` is metadata).
    await orchestrator.runFullDeliberation(council, task);
    const raw = getLatestOutput(council.id)?.content || '';
    const parsed = JSON.parse(extractJsonBlock(raw)) as { winner?: string; confidence?: number; reasons?: string };
    const w = String(parsed.winner || '').toUpperCase();
    verdict = {
      winner: w === 'A' ? 'A' : w === 'B' ? 'B' : 'tie',
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
      reasons: String(parsed.reasons || ''),
      councilId: council.id,
    };
  } catch (err) {
    deps.onLog?.(`Judge failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try { stripCompletedCouncil(council.id); } catch { /* non-fatal */ }
  return verdict;
}

/** Signed preference for the CANDIDATE from one verdict, given which slot it held. */
export function candidateScore(v: JudgeVerdict, candidateSlot: 'A' | 'B'): number {
  if (v.winner === 'tie') return 0;
  return v.winner === candidateSlot ? v.confidence : -v.confidence;
}

/** Combine the two position-swapped verdicts into 0..1 (0.5 = neutral / disagreement). */
export function combineJudge(ab: number, ba: number): number {
  const agree = Math.sign(ab) === Math.sign(ba) || ab === 0 || ba === 0;
  if (!agree) return 0.5;
  return Math.max(0, Math.min(1, (1 + (ab + ba) / 2) / 2));
}

// ============================================================================
// Mechanical signals
// ============================================================================

export function mechanicalSignals(baseline: StepScore | undefined, candidate: StepScore, outputType: string): { score: number; signals: Record<string, number> } {
  const s: Record<string, number> = {};
  let score = 0.5;
  if (!candidate.outputChars) { s.empty = -0.4; score -= 0.4; }
  if (outputType === 'json' && candidate.outputJsonValid === false) { s.json_invalid = -0.3; score -= 0.3; }
  if (candidate.flags.includes('tool_narration')) { s.tool_narration = -0.15; score -= 0.15; }
  if (baseline) {
    if (candidate.firstTryAccept && !baseline.firstTryAccept) { s.first_try = 0.2; score += 0.2; }
    else if (!candidate.firstTryAccept && baseline.firstTryAccept) { s.first_try = -0.2; score -= 0.2; }
    if (candidate.revisions < baseline.revisions) { s.revisions = 0.1; score += 0.1; }
    else if (candidate.revisions > baseline.revisions) { s.revisions = -0.1; score -= 0.1; }
    const bFlags = baseline.flags.length, cFlags = candidate.flags.length;
    if (cFlags < bFlags) { s.flags = 0.1; score += 0.1; } else if (cFlags > bFlags) { s.flags = -0.1; score -= 0.1; }
    if (baseline.costUsd > 0) {
      const ratio = candidate.costUsd / baseline.costUsd;
      if (ratio < 0.9) { s.cost = 0.05; score += 0.05; } else if (ratio > 1.25) { s.cost = -0.05; score -= 0.05; }
    }
  }
  return { score: Math.max(0, Math.min(1, score)), signals: s };
}

// ============================================================================
// Judge-only (no replay)
// ============================================================================

export async function judgeProposalOnly(pipelineId: string, p: Proposal, judge: { provider: string; model: string }, deps: RetroDeps): Promise<{ score: number; councilId: string }> {
  const task = `You are reviewing a PROPOSED change to a multi-model pipeline recipe. Rate how likely it is to improve the next run (fewer revisions, first-try acceptance, lower cost, no errors) WITHOUT making the output worse. Be skeptical of vague or cosmetic changes.

KIND: ${p.kind}
TARGET: ${p.target.stepName}${p.target.persona ? ` / ${p.target.persona.name} (${p.target.persona.role})` : ''}${p.target.path ? ` / ${p.target.path}` : ''}
RATIONALE: ${p.rationale}
EXPECTED EFFECT: ${p.expectedEffect || '(none given)'}
EVIDENCE CITED: ${p.evidence.ledgerEntryIds?.length || 0} ledger entries

BEFORE:
${head(typeof p.before === 'string' ? p.before : JSON.stringify(p.before ?? null, null, 1), 3000)}

AFTER:
${head(typeof p.after === 'string' ? p.after : JSON.stringify(p.after, null, 1), 3000)}

Respond with ONLY a JSON object: {"score": <0..1>, "reasons": "<2-3 sentences>"}`;
  const council = createCouncilFromSetup({
    name: 'Judge (proposal)', pipelinePrefix: RETRO_COUNCIL_PREFIX, pipelineId,
    personas: [{ name: 'Judge', role: 'worker', model: judge.model, provider: judge.provider, toolAccess: 'none', suppressPersona: true, saveOutput: false, traits: ['impartial'] }],
    task, stepType: 'council', outputType: 'json', maxRounds: 0, maxRevisions: 0, saveDeliberation: false, bootstrapContext: false,
  });
  const orchestrator = new DeliberationOrchestrator({ invokeAgent: deps.invokeAgent, onAgentThinkingStart: deps.onAgentThinkingStart, onAgentThinkingEnd: deps.onAgentThinkingEnd });
  let score = 0.5;
  try {
    await orchestrator.runFullDeliberation(council, task);
    const parsed = JSON.parse(extractJsonBlock(getLatestOutput(council.id)?.content || '')) as { score?: number };
    score = Math.max(0, Math.min(1, Number(parsed.score) || 0));
  } catch (err) {
    deps.onLog?.(`Judge-only failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  try { stripCompletedCouncil(council.id); } catch { /* non-fatal */ }
  return { score, councilId: council.id };
}

// ============================================================================
// Evaluate a proposal set
// ============================================================================

export async function evaluateProposals(
  pipelineId: string,
  proposals: Proposal[],
  settings: SelfImproveSettings,
  deps: RetroDeps,
): Promise<Proposal[]> {
  const pipeline = pipelineStore.get(pipelineId);
  if (!pipeline) return proposals;
  const judge = settings.judge || settings.retro;
  const latestCard = improveStore.latestScorecard(pipelineId);
  const out: Proposal[] = [];

  for (const p of proposals) {
    if (p.kind === 'lesson' || p.status !== 'proposed') { out.push(p); continue; }
    const step = pipeline.stages.flatMap((s) => s.steps).find((s) => s.id === p.target.stepId);
    if (!step) { out.push(p); continue; }
    improveStore.updateProposal(pipelineId, p.id, { status: 'evaluating' });
    const councilId = step.artifact?.metadata?.councilId;
    const record = councilId ? getStepInput(councilId) : null;
    const mode: EvalMode = settings.evalMode === 'replay' && isReplayable(step, record) ? 'replay' : 'judge-only';

    try {
      if (mode === 'judge-only') {
        const r = await judgeProposalOnly(pipelineId, p, judge, deps);
        improveStore.updateProposal(pipelineId, p.id, { status: 'proposed', score: { total: r.score, evalMode: 'judge-only', judgeCouncilIds: [r.councilId] } });
      } else {
        const cfg = step.config as CouncilStepConfig;
        const { config: mutated } = applyToConfig(cfg, p);
        const replay = await replayStep(pipelineId, step, record!, mutated, deps);
        const baselineOut = step.artifact?.content || '';
        const baselineScore = latestCard?.steps.find((s) => s.stepId === step.id);
        const task = mutated.task || cfg.task || '';
        const expected = mutated.councilSetup.expectedOutput;
        const input = record!.inputContext || record!.rawProblem;
        // Blind, position-swapped: baseline=A/candidate=B then candidate=A/baseline=B.
        const v1 = await judgePair(pipelineId, { task, expectedOutput: expected, input, a: baselineOut, b: replay.content }, judge, deps);
        const v2 = await judgePair(pipelineId, { task, expectedOutput: expected, input, a: replay.content, b: baselineOut }, judge, deps);
        const ab = candidateScore(v1, 'B');
        const ba = candidateScore(v2, 'A');
        const judgeScore = combineJudge(ab, ba);
        const mech = mechanicalSignals(baselineScore, replay.score, mutated.outputType || 'string');
        const total = Math.round((0.7 * judgeScore + 0.3 * mech.score) * 1000) / 1000;
        deps.onLog?.(`Scored ${p.kind} on "${step.name}": judge ${judgeScore.toFixed(2)} (${ab.toFixed(2)}/${ba.toFixed(2)}), mechanical ${mech.score.toFixed(2)} → ${total.toFixed(2)}`);
        improveStore.updateProposal(pipelineId, p.id, {
          status: 'proposed',
          score: { total, judge: { ab, ba }, mechanical: mech.signals, evalMode: 'replay', replayCouncilIds: [replay.councilId], judgeCouncilIds: [v1.councilId, v2.councilId] },
          reason: v1.reasons || v2.reasons ? `Judge: ${v1.reasons || v2.reasons}` : undefined,
        });
      }
    } catch (err) {
      deps.onLog?.(`Evaluation failed for ${p.id}: ${err instanceof Error ? err.message : String(err)}`);
      improveStore.updateProposal(pipelineId, p.id, { status: 'proposed' });
    }
    out.push(improveStore.getProposal(pipelineId, p.id) || p);
  }
  return out;
}
