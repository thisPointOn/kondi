/**
 * Self-Improvement: Run Metrics
 *
 * Turns a finished pipeline run into a RunScorecard by reading each council
 * step's ledger (verdicts, revisions, retries, tokens, concrete models) and
 * the step artifacts. Pure functions over the stores — no LLM calls — so the
 * scorecard is built for EVERY run (GUI and CLI), whether or not the
 * retrospective is enabled.
 */

import type { Pipeline, PipelineStep, CouncilStepConfig } from '../pipeline/types';
import { isCouncilType } from '../pipeline/types';
import type { Council, LedgerEntry, Persona } from '../council/types';
import { councilStore } from '../council/store';
import { ledgerStore } from '../council/ledger-store';
import { getModelCostRates } from '../config/models';
import { estimateCostUsd } from '../services/cost';
import { extractJsonBlock } from '../pipeline/input-template';
import { hashValue } from './hash';
import type {
  RunScorecard, StepScore, SeatMetrics, SeatRole, StepFlag, RunAggregate, StepTrend,
} from './types';

// ============================================================================
// Cost
// ============================================================================

/** Precise cost when the in/out split is known; blended estimate otherwise. */
export function costForCall(model: string | undefined, tokens: number, inputTokens?: number, outputTokens?: number): number {
  if (inputTokens != null && outputTokens != null && (inputTokens > 0 || outputTokens > 0)) {
    const { input, output } = getModelCostRates(model || '');
    return (inputTokens / 1000) * input + (outputTokens / 1000) * output;
  }
  return estimateCostUsd(model, tokens);
}

// ============================================================================
// Helpers
// ============================================================================

const TOOL_NARRATION_RE = /\b(write_file|run_command|read_file|list_directory)\s*\(/;

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function roleOf(council: Council, persona: Persona): SeatRole {
  const ra = council.deliberation?.roleAssignments?.find((r) => r.personaId === persona.id);
  const role = ra?.role || persona.preferredDeliberationRole;
  if (role === 'manager' || role === 'consultant' || role === 'worker' || role === 'reviewer') return role;
  return 'consultant';
}

function durationOf(step: PipelineStep): number | undefined {
  if (!step.startedAt || !step.completedAt) return undefined;
  const ms = new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime();
  return ms >= 0 ? ms : undefined;
}

/** Hash of every step's config plus any bound council's live definition. */
export function recipeHashOf(pipeline: Pipeline): string {
  const parts = pipeline.stages.flatMap((s) => s.steps.map((st) => {
    const cfg = st.config as CouncilStepConfig;
    const bound = cfg.boundCouncilId ? councilStore.get(cfg.boundCouncilId) : null;
    return {
      id: st.id,
      config: st.config,
      bound: bound ? {
        personas: bound.personas.map((p) => ({ name: p.name, model: p.model, provider: p.provider, systemPrompt: p.predisposition?.systemPrompt })),
        roles: bound.deliberation?.roleAssignments,
        task: bound.deliberation?.savedProblem,
        maxRounds: bound.deliberation?.maxRounds,
        maxRevisions: bound.deliberation?.maxRevisions,
        expectedOutput: bound.deliberation?.expectedOutput,
      } : undefined,
    };
  }));
  return hashValue(parts);
}

/** Hash of one step's config (proposal staleness check). */
export function stepConfigHash(step: PipelineStep): string {
  return hashValue(step.config);
}

// ============================================================================
// Seat metrics from a ledger
// ============================================================================

function buildSeats(council: Council, entries: LedgerEntry[]): SeatMetrics[] {
  const byPersona = new Map<string, { persona: Persona; latencies: number[]; seat: SeatMetrics }>();

  for (const persona of council.personas) {
    byPersona.set(persona.id, {
      persona,
      latencies: [],
      seat: {
        personaId: persona.id,
        personaName: persona.name,
        role: roleOf(council, persona),
        configuredModel: persona.model,
        configuredProvider: persona.provider,
        resolvedModels: {},
        calls: 0,
        tokens: 0,
        inputTokens: undefined,
        outputTokens: undefined,
        latencyMs: 0,
        p95LatencyMs: 0,
        attemptsTotal: 0,
        errors: 0,
        costUsd: 0,
      },
    });
  }

  for (const e of entries) {
    const slot = byPersona.get(e.authorPersonaId);
    if (!slot) continue;
    const { seat, latencies } = slot;
    if (e.entryType === 'error') { seat.errors++; continue; }
    // Only LLM-backed entries carry tokens/latency; bookkeeping entries are 0/0.
    const isCall = (e.tokensUsed || 0) > 0 || (e.latencyMs || 0) > 0 || !!e.model;
    if (!isCall) continue;
    seat.calls++;
    seat.tokens += e.tokensUsed || 0;
    if (e.inputTokens != null) seat.inputTokens = (seat.inputTokens || 0) + e.inputTokens;
    if (e.outputTokens != null) seat.outputTokens = (seat.outputTokens || 0) + e.outputTokens;
    seat.latencyMs += e.latencyMs || 0;
    latencies.push(e.latencyMs || 0);
    seat.attemptsTotal += e.attempts || 1;
    const concrete = e.model || slot.persona.model;
    seat.resolvedModels[concrete] = (seat.resolvedModels[concrete] || 0) + 1;
    seat.costUsd += costForCall(concrete, e.tokensUsed || 0, e.inputTokens, e.outputTokens);
  }

  return [...byPersona.values()].map(({ seat, latencies }) => ({
    ...seat,
    p95LatencyMs: percentile(latencies, 95),
    costUsd: Math.round(seat.costUsd * 1e6) / 1e6,
  }));
}

// ============================================================================
// Council usage summary (for StepArtifact.metadata)
// ============================================================================

export interface CouncilUsage {
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  /** Distinct concrete models that answered, in first-seen order. */
  models: string[];
  costUsd: number;
}

export function summarizeCouncilUsage(councilId: string): CouncilUsage {
  const council = councilStore.get(councilId);
  const entries = ledgerStore.getAll(councilId);
  const personaModel = new Map<string, string>();
  for (const p of council?.personas || []) personaModel.set(p.id, p.model);
  const models: string[] = [];
  let tokens = 0, inputTokens = 0, outputTokens = 0, costUsd = 0;
  for (const e of entries) {
    const isCall = (e.tokensUsed || 0) > 0 || (e.latencyMs || 0) > 0 || !!e.model;
    if (!isCall || e.entryType === 'error') continue;
    tokens += e.tokensUsed || 0;
    inputTokens += e.inputTokens || 0;
    outputTokens += e.outputTokens || 0;
    const m = e.model || personaModel.get(e.authorPersonaId);
    if (m && !models.includes(m)) models.push(m);
    costUsd += costForCall(m, e.tokensUsed || 0, e.inputTokens, e.outputTokens);
  }
  if (tokens === 0) tokens = ledgerStore.getTokenCount(councilId);
  return { tokens, inputTokens, outputTokens, models, costUsd: Math.round(costUsd * 1e6) / 1e6 };
}

// ============================================================================
// Step score
// ============================================================================

export interface StepScoreContext {
  /** condition step id → number of loop_to_stage iterations fired */
  loopCounts?: Map<string, number>;
}

export function scoreStep(step: PipelineStep, ctx: StepScoreContext = {}): StepScore {
  const cfg = step.config as CouncilStepConfig;
  const councilId = step.artifact?.metadata?.councilId;
  const outputType = (cfg as { outputType?: string }).outputType || step.artifact?.metadata?.outputType || 'string';
  const content = step.artifact?.content || '';
  const flags: StepFlag[] = [];

  const score: StepScore = {
    stepId: step.id,
    stepName: step.name,
    stepType: step.config.type,
    status: step.status,
    councilId,
    durationMs: durationOf(step),
    tokens: 0,
    costUsd: 0,
    entries: 0,
    rounds: 0,
    revisions: 0,
    reviewOutcomes: { accept: 0, revise: 0, re_deliberate: 0 },
    firstTryAccept: false,
    errors: 0,
    outputChars: content.length,
    completionSummaryPresent: /##\s*COMPLETION SUMMARY/i.test(content),
    seats: [],
    flags,
  };

  if (step.status === 'failed') flags.push('step_failed');
  if (step.config.type === 'condition' && ctx.loopCounts) {
    score.loopIterations = ctx.loopCounts.get(step.id) || 0;
  }

  if (isCouncilType(step.config.type) && councilId) {
    const council = councilStore.get(councilId);
    const entries = ledgerStore.getAll(councilId);
    score.entries = entries.length;

    if (council) {
      score.seats = buildSeats(council, entries);
      score.tokens = score.seats.reduce((s, x) => s + x.tokens, 0) || ledgerStore.getTokenCount(councilId);
      score.costUsd = Math.round(score.seats.reduce((s, x) => s + x.costUsd, 0) * 1e6) / 1e6;
      score.rounds = council.deliberationState?.currentRound || 0;
      score.revisions = council.deliberationState?.revisionCount || 0;
      score.terminalPhase = council.deliberationState?.currentPhase;
      if (score.terminalPhase === 'failed') flags.push('honest_failure');
      if ((council.deliberationState?.reDeliberationCount || 0) > 0) flags.push('re_deliberated');
    } else {
      score.tokens = ledgerStore.getTokenCount(councilId);
      score.costUsd = estimateCostUsd(undefined, score.tokens);
    }

    const feedback: string[] = [];
    const head = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 300);
    for (const e of entries) {
      if (e.entryType === 'review' && e.authorRole === 'manager' && e.reviewOutcome) {
        score.reviewOutcomes[e.reviewOutcome]++;
      }
      // Reviewer/verification objections (bound ledgers are wiped per run, so
      // this is the only durable record of WHY work was sent back).
      if (feedback.length < 12) {
        if (e.entryType === 'revision_request' || e.entryType === 're_deliberation') {
          feedback.push(head(e.content));
        } else if (e.entryType === 'code_review') {
          const issues = (e.structured as { issues?: Array<{ description?: string }> } | undefined)?.issues;
          if (Array.isArray(issues)) for (const i of issues.slice(0, 4)) if (i?.description && feedback.length < 12) feedback.push(head(i.description));
          else if (/fail|issue|revise/i.test(e.content)) feedback.push(head(e.content));
        } else if (e.entryType === 'test_result') {
          const exit = (e.structured as { exitCode?: number } | undefined)?.exitCode;
          if (exit != null && exit !== 0) feedback.push(head(`Verification failed (exit ${exit}): ${e.content.slice(-400)}`));
        }
      }
      if (e.entryType === 'error') score.errors++;
      if ((e.attempts || 1) > 1 && !flags.includes('retries')) flags.push('retries');
      if (e.entryType === 'test_result') {
        score.testResults = score.testResults || { runs: 0, passed: 0 };
        score.testResults.runs++;
        const exit = (e.structured as { exitCode?: number } | undefined)?.exitCode;
        const passed = exit != null ? exit === 0 : /Exit code:\s*0\b/.test(e.content);
        if (passed) score.testResults.passed++;
      }
    }

    const managerReviews = score.reviewOutcomes.accept + score.reviewOutcomes.revise + score.reviewOutcomes.re_deliberate;
    // First-try acceptance: the first manager verdict was 'accept'. Manager-less
    // direct execution has no review at all — treat a completed step as accepted.
    if (managerReviews > 0) {
      const first = entries.find((e) => e.entryType === 'review' && e.authorRole === 'manager' && e.reviewOutcome);
      score.firstTryAccept = first?.reviewOutcome === 'accept';
    } else {
      score.firstTryAccept = step.status === 'completed' && score.terminalPhase !== 'failed';
    }

    if (score.reviewOutcomes.revise >= 2) flags.push('revise_loop');
    const maxRev = council?.deliberation?.maxRevisions ?? 3;
    if (score.reviewOutcomes.revise > 0 && score.reviewOutcomes.accept === 0 && score.revisions >= maxRev && step.status === 'completed') {
      flags.push('max_revisions_hit');
    }
    if (score.seats.some((s) => s.role === 'consultant' && s.errors > 0)) flags.push('consultant_errors');
    if (score.testResults && score.testResults.passed < score.testResults.runs) flags.push('tests_failed');
    if (feedback.length) score.reviewFeedback = feedback;
  }

  if (step.status === 'completed' && content.trim().length === 0) flags.push('empty_output');
  if (/^No (decision or )?output was produced\.?$/.test(content.trim())) flags.push('empty_output');
  if (outputType === 'json') {
    try { JSON.parse(extractJsonBlock(content)); score.outputJsonValid = true; }
    catch { score.outputJsonValid = false; flags.push('json_invalid'); }
  }
  if ((outputType === 'string' || outputType === 'json') && TOOL_NARRATION_RE.test(content)) {
    flags.push('tool_narration');
  }

  return score;
}

// ============================================================================
// Run scorecard
// ============================================================================

export interface BuildScorecardArgs {
  pipeline: Pipeline;
  runId: string;
  status: 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  runNumber?: number;
  loopCounts?: Map<string, number>;
}

export function buildRunScorecard(args: BuildScorecardArgs): RunScorecard {
  const { pipeline, runId, status, startedAt } = args;
  const completedAt = args.completedAt || new Date().toISOString();
  const steps = pipeline.stages.flatMap((s) => s.steps).map((st) => scoreStep(st, { loopCounts: args.loopCounts }));
  const totalTokens = steps.reduce((s, x) => s + x.tokens, 0);
  const totalCostUsd = Math.round(steps.reduce((s, x) => s + x.costUsd, 0) * 1e6) / 1e6;
  const totalDurationMs = Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime());

  return {
    version: 1,
    runId,
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    runNumber: args.runNumber,
    startedAt,
    completedAt,
    status,
    totalTokens,
    totalCostUsd,
    totalDurationMs,
    steps,
    recipeHash: recipeHashOf(pipeline),
  };
}

// ============================================================================
// Cross-run aggregation
// ============================================================================

export function aggregateAcrossRuns(cards: RunScorecard[]): RunAggregate | null {
  if (cards.length === 0) return null;
  const sorted = [...cards].sort((a, b) => a.completedAt.localeCompare(b.completedAt));
  const pipelineId = sorted[0].pipelineId;

  const stepMap = new Map<string, { name: string; scores: StepScore[] }>();
  for (const card of sorted) {
    for (const s of card.steps) {
      const slot = stepMap.get(s.stepId) || { name: s.stepName, scores: [] };
      slot.name = s.stepName;
      slot.scores.push(s);
      stepMap.set(s.stepId, slot);
    }
  }

  const steps: StepTrend[] = [...stepMap.entries()].map(([stepId, { name, scores }]) => {
    const runs = scores.length;
    const mean = (f: (s: StepScore) => number) => scores.reduce((a, s) => a + f(s), 0) / runs;
    const seats: StepTrend['seats'] = {};
    for (const s of scores) {
      for (const seat of s.seats) {
        const key = `${seat.personaName} (${seat.role})`;
        const agg = seats[key] || { calls: 0, tokens: 0, costUsd: 0, attemptsTotal: 0, errors: 0, resolvedModels: {} };
        agg.calls += seat.calls; agg.tokens += seat.tokens; agg.costUsd += seat.costUsd;
        agg.attemptsTotal += seat.attemptsTotal; agg.errors += seat.errors;
        for (const [m, n] of Object.entries(seat.resolvedModels)) agg.resolvedModels[m] = (agg.resolvedModels[m] || 0) + n;
        seats[key] = agg;
      }
    }
    const accepted = scores.filter((s) => s.status === 'completed' && s.firstTryAccept);
    const totalCost = scores.reduce((a, s) => a + s.costUsd, 0);
    return {
      stepId,
      stepName: name,
      runs,
      meanTokens: Math.round(mean((s) => s.tokens)),
      meanCostUsd: Math.round(mean((s) => s.costUsd) * 1e6) / 1e6,
      meanDurationMs: Math.round(mean((s) => s.durationMs || 0)),
      reviseRate: mean((s) => s.reviewOutcomes.revise),
      firstTryAcceptRate: accepted.length / runs,
      errorRate: scores.filter((s) => s.errors > 0).length / runs,
      failRate: scores.filter((s) => s.status !== 'completed').length / runs,
      costPerAccepted: accepted.length > 0 ? Math.round((totalCost / accepted.length) * 1e6) / 1e6 : null,
      seats,
    };
  });

  return {
    pipelineId,
    runs: sorted.length,
    first: sorted[0].completedAt,
    last: sorted[sorted.length - 1].completedAt,
    totalTokens: sorted.reduce((a, c) => a + c.totalTokens, 0),
    totalCostUsd: Math.round(sorted.reduce((a, c) => a + c.totalCostUsd, 0) * 1e6) / 1e6,
    completedRuns: sorted.filter((c) => c.status === 'completed').length,
    steps,
    series: sorted.map((c) => ({
      runId: c.runId,
      completedAt: c.completedAt,
      tokens: c.totalTokens,
      costUsd: c.totalCostUsd,
      revisions: c.steps.reduce((a, s) => a + s.revisions, 0),
      status: c.status,
    })),
  };
}

/** One-line JSONL record for `<wd>/.kondi/memory/<pid>_scorecards.jsonl`. */
export function scorecardJsonlLine(card: RunScorecard): string {
  return JSON.stringify(card);
}
