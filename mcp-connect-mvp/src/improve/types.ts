/**
 * Self-Improvement Loop: Type Definitions
 *
 * The loop closes the gap between "a pipeline ran" and "the pipeline got
 * better": every run is measured into a RunScorecard (from the council
 * ledgers), a retrospective proposes concrete recipe edits (Proposal) with
 * evidence, proposals are scored by replay + judge, applied (manual approval
 * or auto mode, switchable live) with revert, and distilled Lessons are
 * carried into every persona's prompt on later runs.
 *
 * Nothing here introduces a new step type, ledger entry type, or phase.
 */

import type { LedgerEntry } from '../council/types';

// ============================================================================
// Settings (persisted on Pipeline.settings.selfImprove)
// ============================================================================

export type ImproveMode = 'manual' | 'auto';
export type EvalMode = 'none' | 'judge-only' | 'replay';

export interface SelfImproveScope {
  prompts: boolean;
  tasks: boolean;
  settings: boolean;
  models: boolean;
  router: boolean;
  structure: boolean;
}

export interface SelfImproveSettings {
  enabled: boolean;
  /** Read fresh at hook time AND before each apply, so a live toggle works. */
  mode: ImproveMode;
  scope: SelfImproveScope;
  /** 'none' until replay/judge eval ships; the cycle then just queues. */
  evalMode: EvalMode;
  retro: { provider: string; model: string; deep?: boolean };
  judge?: { provider: string; model: string };
  /** Auto mode applies only proposals whose score.total >= this. */
  autoApplyMinScore: number;
  maxProposalsPerRun: number;
  /** Retro/judge/replay councils kept for audit before pruning. */
  maxRetainedRetros: number;
  lessons: { enabled: boolean; maxChars: number };
}

export const DEFAULT_SELF_IMPROVE: SelfImproveSettings = {
  enabled: false,
  mode: 'manual',
  scope: { prompts: true, tasks: true, settings: true, models: false, router: false, structure: false },
  evalMode: 'none',
  retro: { provider: 'router', model: 'route:balanced' },
  autoApplyMinScore: 0.7,
  maxProposalsPerRun: 5,
  maxRetainedRetros: 20,
  lessons: { enabled: true, maxChars: 2000 },
};

/** Merge a possibly-partial persisted settings object over the defaults. */
export function withSelfImproveDefaults(s?: Partial<SelfImproveSettings> | null): SelfImproveSettings {
  return {
    ...DEFAULT_SELF_IMPROVE,
    ...(s || {}),
    scope: { ...DEFAULT_SELF_IMPROVE.scope, ...(s?.scope || {}) },
    retro: { ...DEFAULT_SELF_IMPROVE.retro, ...(s?.retro || {}) },
    lessons: { ...DEFAULT_SELF_IMPROVE.lessons, ...(s?.lessons || {}) },
  };
}

// ============================================================================
// Per-call metadata (ledger)
// ============================================================================

/**
 * Attached by the orchestrators to `response.structured.callMeta` and lifted
 * by `createEntry` into top-level LedgerEntry fields. `model`/`provider` are
 * the CONCRETE ones used (routed personas resolve to a real model per call).
 */
export interface CallMeta {
  model?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  /** 1 = succeeded first try; N = N-1 retries (transient errors / timeout). */
  attempts?: number;
  /** True when the persona was configured with a `route:<profile>` model. */
  routed?: boolean;
}

// ============================================================================
// Step input capture (so a step can be replayed in isolation)
// ============================================================================

/** councilDataStore key `step-input-<councilId>` */
export interface StepInputRecord {
  pipelineId: string;
  stepId: string;
  councilId: string;
  runId: string;
  kind: 'unbound' | 'bound';
  stepType: string;
  outputType: string;
  task?: string;
  inputTemplate: string;
  pipelineInput?: string;
  /** unbound: renderInputTemplate output */
  inputContext?: string;
  /** unbound: ids of the steps whose artifacts fed this one */
  previousArtifactStepIds?: string[];
  /** bound: the sibling workflow councils whose outputs composed the input */
  priorCouncilIds?: string[];
  /** Exactly what the orchestrator received. */
  rawProblem: string;
  recordedAt: string;
}

// ============================================================================
// Scorecard
// ============================================================================

export type SeatRole = 'manager' | 'consultant' | 'worker' | 'reviewer';

export interface SeatMetrics {
  personaId: string;
  personaName: string;
  role: SeatRole;
  configuredModel: string;
  configuredProvider: string;
  /** concrete model → call count (routed seats resolve per call) */
  resolvedModels: Record<string, number>;
  calls: number;
  tokens: number;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  p95LatencyMs: number;
  attemptsTotal: number;
  errors: number;
  costUsd: number;
}

export interface StepScore {
  stepId: string;
  stepName: string;
  stepType: string;
  status: string;
  councilId?: string;
  durationMs?: number;
  tokens: number;
  costUsd: number;
  entries: number;
  rounds: number;
  revisions: number;
  reviewOutcomes: Record<'accept' | 'revise' | 're_deliberate', number>;
  /** The worker's first output was accepted without a revision request. */
  firstTryAccept: boolean;
  errors: number;
  /** 'failed' marks an honest coding-council failure (rule 17). */
  terminalPhase?: string;
  testResults?: { runs: number; passed: number };
  outputChars: number;
  outputJsonValid?: boolean;
  completionSummaryPresent: boolean;
  /** condition steps: how many loop_to_stage iterations fired */
  loopIterations?: number;
  seats: SeatMetrics[];
  /** Mechanical flags the retrospective can key on. */
  flags: StepFlag[];
}

export type StepFlag =
  | 'revise_loop'            // 2+ revision requests
  | 'max_revisions_hit'      // accepted only because the budget ran out
  | 're_deliberated'
  | 'empty_output'
  | 'tool_narration'         // worker narrated fake tool calls in a text deliverable
  | 'json_invalid'           // outputType json but the artifact isn't valid JSON
  | 'consultant_errors'
  | 'retries'                // transient retries / timeouts occurred
  | 'honest_failure'         // terminalPhase === 'failed'
  | 'tests_failed'
  | 'step_failed';

export interface RunScorecard {
  version: 1;
  runId: string;
  pipelineId: string;
  pipelineName: string;
  runNumber?: number;
  startedAt: string;
  completedAt: string;
  status: 'completed' | 'failed';
  totalTokens: number;
  totalCostUsd: number;
  totalDurationMs: number;
  steps: StepScore[];
  /** Hash of all step configs (+ bound council definitions) — changes when the recipe changes. */
  recipeHash: string;
}

/** Cross-run aggregate for one step. */
export interface StepTrend {
  stepId: string;
  stepName: string;
  runs: number;
  meanTokens: number;
  meanCostUsd: number;
  meanDurationMs: number;
  reviseRate: number;        // revisions / runs
  firstTryAcceptRate: number;
  errorRate: number;         // runs with errors / runs
  failRate: number;          // runs where status !== completed / runs
  /** Cost per run that completed with first-try acceptance (∞ → null). */
  costPerAccepted: number | null;
  seats: Record<string, { calls: number; tokens: number; costUsd: number; attemptsTotal: number; errors: number; resolvedModels: Record<string, number> }>;
}

export interface RunAggregate {
  pipelineId: string;
  runs: number;
  first: string;
  last: string;
  totalTokens: number;
  totalCostUsd: number;
  completedRuns: number;
  steps: StepTrend[];
  /** Oldest → newest per-run series for sparklines. */
  series: Array<{ runId: string; completedAt: string; tokens: number; costUsd: number; revisions: number; status: string }>;
}

// ============================================================================
// Proposals, lessons, changelog
// ============================================================================

export type ProposalKind =
  | 'persona_prompt'
  | 'focus_area'
  | 'worker_prompt'
  | 'step_task'
  | 'expected_output'
  | 'decision_criteria'
  | 'council_setting'
  | 'lesson'
  | 'model_swap'
  | 'router_profile'
  | 'structure';

export interface ProposalTarget {
  stepId: string;
  stepName: string;
  bound?: { councilId: string; personaId?: string };
  /** Unbound personas have no stable id → index + name, both checked at apply time. */
  persona?: { index: number; name: string; role: string };
  /** e.g. 'councilSetup.maxRounds' for council_setting */
  path?: string;
}

export type ProposalStatus =
  | 'proposed' | 'evaluating' | 'approved' | 'rejected'
  | 'applied' | 'reverted' | 'stale' | 'invalid';

export interface ProposalScore {
  total: number;
  judge?: { ab: number; ba: number };
  mechanical?: Record<string, number>;
  evalMode: EvalMode;
  replayCouncilIds?: string[];
  judgeCouncilIds?: string[];
}

export interface Proposal {
  id: string;
  pipelineId: string;
  runId: string;
  retroCouncilId: string;
  kind: ProposalKind;
  target: ProposalTarget;
  before: unknown;
  after: unknown;
  rationale: string;
  expectedEffect: string;
  evidence: {
    stepIds: string[];
    ledgerEntryIds?: string[];
    metrics?: Partial<StepScore>;
    quotes?: string[];
  };
  /** Target hash at proposal time (step config, or bound council recipe); apply refuses on mismatch. */
  configHash: string;
  /** Target hash right after apply; revert refuses if the target changed since. */
  appliedConfigHash?: string;
  score?: ProposalScore;
  status: ProposalStatus;
  reason?: string;
  createdAt: string;
  decidedAt?: string;
  appliedAt?: string;
  revertedAt?: string;
}

export interface Lesson {
  id: string;
  text: string;
  scope: 'all' | SeatRole;
  stepId?: string;
  source: { runId: string; proposalId?: string };
  createdAt: string;
  confirmations: number;
  active: boolean;
}

/** What orchestrators receive: role → lesson lines. */
export type LessonBundle = Partial<Record<Lesson['scope'], string[]>>;

export interface ChangelogEntry {
  id: string;
  proposalId: string;
  action: 'applied' | 'reverted';
  at: string;
  by: 'user' | 'auto' | 'cli';
}

/** councilDataStore key `improve-<pipelineId>` */
export interface ImproveState {
  version: 1;
  pipelineId: string;
  proposals: Proposal[];
  lessons: Lesson[];
  changelog: ChangelogEntry[];
  /** keys `scorecard-<pid>-<runId>`, oldest first, capped. */
  scorecardIds: string[];
}

export type ImproveEvent =
  | { type: 'scorecard'; pipelineId: string; runId: string }
  | { type: 'proposals'; pipelineId: string; runId: string; count: number }
  | { type: 'applied' | 'reverted' | 'rejected'; pipelineId: string; proposalId: string }
  | { type: 'error'; pipelineId: string; message: string };

// Re-export so consumers of this module don't need the council types path.
export type { LedgerEntry };
