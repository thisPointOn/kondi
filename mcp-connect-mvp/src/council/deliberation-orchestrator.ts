/**
 * Council: Deliberation Orchestrator
 * Deterministic state machine for structured multi-agent deliberation
 *
 * The orchestrator is CODE, not an agent. It:
 * - Drives the state machine
 * - Invokes agents with correct context
 * - Manages artifacts and ledger
 * - Enforces invariants
 */

import type {
  Council,
  Persona,
  LedgerEntry,
  LedgerEntryType,
  DeliberationPhase,
  DeliberationRole,
  DeliberationRoleAssignment,
  ManagerEvaluation,
  ManagerReview,
  ContextArtifact,
  ContextPatch,
  ArtifactRef,
  SubagentSpec,
} from './types';

import {
  ledgerStore,
  getEntries,
  getAllEntries,
  getLatestOfType,
  getEntriesForRound,
  getManagerNotes,
  getLedgerTokenCount,
  formatEntriesForContext,
  buildMechanicalSummary,
} from './ledger-store';

import {
  getCurrentContext,
  getContextHistory,
  createInitialContext,
  createContextVersion,
  getPendingPatches,
  createPatch,
  acceptPatch,
  rejectPatch,
  createDecision,
  createPlan,
  createDirective,
  createOutput,
  createRevisionOutput,
  getDecision,
  getPlan,
  getDirective,
  getLatestOutput,
} from './context-store';

import {
  councilStore,
  getPersonaByRole,
  getRoleAssignment,
  isDeliberationMode,
} from './store';

import { bootstrapDirectoryContext } from './context-bootstrap';
import { buildContextInspection } from './context-inspection';
import type { ContextInspection } from './types';
import { isRoutedModel } from '../router/profile-options';
import { formatLessonsBlock } from '../improve/lessons';
import { buildWorkOrder, stripTaskPrefix, extractAcceptanceCriteria as extractAcceptanceCriteriaSection } from './work-order';
import type { WorkOrderInput, WorkOrderQA, ToolScope } from './work-order';
import { parseWorkerSignals, signalsForLedger } from './worker-signals';
import { detectTestCommand } from '../pipeline/test-detect';
import {
  resolveWorkerQuestion, buildWorkerQuestionAnswerPrompt,
  MAX_QUESTIONS_PER_PHASE, BUDGET_EXHAUSTED_ANSWER,
} from './ask-back';
import type { WorkerQuestionHandler } from './ask-back';
import { anySignal, timeoutSignal, raceSignal, throwIfAborted, isAbortError, isTimeoutError, AbortError } from '../agent-runtime/signals';
import type { AgentStreamEvent } from '../agent-runtime/types';
import { isBudgetExceededError } from '../pipeline/budget';
import { collectDiff } from '../pipeline/worktree';
import type { WorktreeInfo } from '../pipeline/worktree';

import {
  buildManagerFramingPrompt,
  buildManagerEvaluationPrompt,
  buildManagerDecisionPrompt,
  buildManagerForcedDecisionPrompt,
  buildManagerPlanPrompt,
  buildWorkDirectivePrompt,
  buildManagerReviewPrompt,
  buildManagerRoundSummaryPrompt,
  buildIndependentAnalysisPrompt,
  buildDeliberationResponsePrompt,
  buildConsultantFinalPositionPrompt,
  buildConsultantReviewPrompt,
  buildWorkerExecutionPrompt,
  buildWorkerRevisionPrompt,
  getMinimalWorkerSystemPrompt,
  type WorkerPermissions,
} from './prompts';

// ============================================================================
// Types
// ============================================================================

export interface AgentInvocation {
  personaId: string;
  systemPrompt: string;
  userMessage: string;
  /** When true, the invoker should NOT pass MCP tools (avoids slow MCP connections) */
  skipTools?: boolean;
  /** Restrict to specific tool names (e.g. ['Read', 'Write', 'Bash']) */
  allowedTools?: string[];
  /** MCP servers this invocation can access (undefined = all servers) */
  allowedServerIds?: string[];
  /** Working directory override for local tool calls (bypasses singleton) */
  workingDirectory?: string;
  /** Timeout in ms — set by invokeAgentSafe based on role/context defaults */
  timeoutMs?: number;
  /** Cancellation: run abort ∪ this call's timeout (set by invokeAgentSafe).
   *  Invokers pass it to the client; a TimeoutError reason means the timeout. */
  signal?: AbortSignal;
  /** Live stream events (text deltas, tool calls/results, turns) for display.
   *  Set by invokeAgentSafe from `OrchestratorConfig.onAgentEvent`. */
  onEvent?: (e: AgentStreamEvent) => void;
}

export interface AgentResponse {
  content: string;
  tokensUsed: number;
  latencyMs: number;
  structured?: Record<string, unknown>;
  /** Concrete model/provider actually used (invokers fill these when known). */
  model?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export type AgentInvoker = (invocation: AgentInvocation, persona: Persona) => Promise<AgentResponse>;

/** Per-run step facts the executor knows and the council record doesn't (work order Objective/Inputs). */
export interface StepBrief {
  /** The step's TASK alone (savedProblem is task + input for pipeline councils). */
  task?: string;
  stepName?: string;
  stepType?: string;
  runDir?: string;
  inputs?: Array<{ stepName?: string; outputType?: string; path?: string }>;
}

export type RunCommandFn = (cmd: string, cwd: string) => Promise<{ stdout: string; stderr: string; exit_code: number; success: boolean }>;

export interface OrchestratorConfig {
  invokeAgent: AgentInvoker;
  /** Work-order facts supplied per run by the pipeline executor. When set, the
   *  orchestrator does NOT overwrite `deliberation.savedProblem` (bound councils
   *  keep their original task instead of compounding input into it). */
  brief?: StepBrief;
  /** Per-seat track record (role → text) rendered into the work order. */
  seatBriefs?: Partial<Record<DeliberationRole, string>>;
  /** Platform hooks for verification/diffs (pipeline executor passes the platform's). */
  runCommand?: RunCommandFn;
  readFile?: (path: string) => Promise<string | null>;
  /** Worker-owned verification: the command the worker runs itself (and the
   *  orchestrator re-runs as the final check). Defaults: `deliberation.testCommand`,
   *  else auto-detected for file/directory outputs when readFile is available. */
  verify?: { command?: string; autoDetect?: boolean; maxWorkerTries?: number };
  /** Ask-back: a human hook for worker questions the manager escalates (or when
   *  there is no manager). Resolve null when nobody can answer → the worker is
   *  told to proceed on its best judgment. The pipeline executor parks the step
   *  in `waiting_approval` while this is pending. */
  onWorkerQuestion?: WorkerQuestionHandler;
  askBack?: { maxQuestionsPerPhase?: number };
  /** Run-level cancellation (the pipeline executor's AbortController). Checked
   *  at every phase boundary and composed into every agent call; an abort ends
   *  the council in the `cancelled` phase with a `cancellation` entry (no
   *  `error` entry, no `failed`). */
  signal?: AbortSignal;
  /** Live stream events per persona call (display only — never used to build
   *  the deliverable). The GUI shows the tail under the thinking indicator. */
  onAgentEvent?: (persona: Persona, event: AgentStreamEvent, context: string) => void;
  /** Run budget status line injected into EVERY persona's prompt (after the
   *  lessons). Supplied per run by the executor's BudgetMeter. */
  budgetLine?: () => string | undefined;
  /** Worktree mode (executor-prepared): workers operate in `worktreePath` on
   *  `branch`; the council record's workingDirectory is NEVER mutated. */
  codebase?: WorktreeInfo;
  /** Whether this runtime can actually EXECUTE tools for a persona's provider.
   *  Default true (app, where API clients run tool loops). The headless CLI
   *  runner returns true only for the claude/codex binaries so API-provider
   *  personas don't get advertised tools they can't use (→ hallucination). */
  canUseTools?: (persona: Persona) => boolean;
  onPhaseChange?: (from: DeliberationPhase, to: DeliberationPhase) => void;
  onEntryAdded?: (entry: LedgerEntry) => void;
  onError?: (error: Error, context: string) => void;
  /** Called when a persona starts thinking (startedAt = Date.now() timestamp, prompt = user message sent) */
  onAgentThinkingStart?: (persona: Persona, startedAt: number, prompt?: string) => void;
  /** Called when a persona finishes thinking */
  onAgentThinkingEnd?: (persona: Persona) => void;
  /** Called when an agent times out (before retry). Enables UI timeout warnings. */
  onAgentTimeout?: (persona: Persona, context: string, elapsedMs: number) => void;
  /** Self-improvement lessons (role → lines) appended to every persona's user
   *  message. Supplied per run by the pipeline executor; no council field needed
   *  (so bound councils are never mutated per run). */
  lessons?: Partial<Record<'all' | DeliberationRole, string[]>>;
}

// ============================================================================
// Phase Transition Table
// ============================================================================

const PHASE_TRANSITIONS: Record<DeliberationPhase, {
  validNext: DeliberationPhase[];
  terminal: boolean;
}> = {
  // 'cancelled' is reachable from EVERY non-terminal phase (user abort).
  created: { validNext: ['problem_framing', 'executing', 'failed', 'cancelled'], terminal: false },
  problem_framing: { validNext: ['round_independent', 'deciding', 'failed', 'cancelled'], terminal: false },
  round_independent: { validNext: ['round_waiting_for_manager', 'failed', 'cancelled'], terminal: false },
  round_interactive: { validNext: ['round_waiting_for_manager', 'failed', 'cancelled'], terminal: false },
  round_waiting_for_manager: { validNext: ['round_interactive', 'deciding', 'planning', 'failed', 'cancelled'], terminal: false },
  planning: { validNext: ['directing', 'failed', 'cancelled'], terminal: false },
  deciding: { validNext: ['planning', 'directing', 'completed', 'failed', 'cancelled'], terminal: false },
  directing: { validNext: ['executing', 'failed', 'cancelled'], terminal: false },
  executing: { validNext: ['reviewing', 'completed', 'failed', 'cancelled'], terminal: false },
  reviewing: { validNext: ['completed', 'revising', 'round_interactive', 'failed', 'cancelled'], terminal: false },
  revising: { validNext: ['reviewing', 'completed', 'failed', 'cancelled'], terminal: false },
  decomposing: { validNext: ['failed', 'cancelled'], terminal: false },
  implementing: { validNext: ['failed', 'cancelled'], terminal: false },
  code_reviewing: { validNext: ['failed', 'cancelled'], terminal: false },
  testing: { validNext: ['failed', 'cancelled'], terminal: false },
  debugging: { validNext: ['failed', 'cancelled'], terminal: false },
  paused: { validNext: ['created', 'problem_framing', 'round_independent', 'round_interactive', 'round_waiting_for_manager', 'planning', 'deciding', 'directing', 'executing', 'reviewing', 'revising', 'decomposing', 'implementing', 'code_reviewing', 'testing', 'debugging', 'failed', 'cancelled'], terminal: false },
  completed: { validNext: [], terminal: true },
  cancelled: { validNext: [], terminal: true },
  failed: { validNext: [], terminal: true },
};

// ============================================================================
// Deliverable sanitizer
// ============================================================================

/**
 * Clean a worker's text deliverable for any model. Weaker models (e.g. deepseek)
 * sometimes hallucinate tool calls and "I can't write the file" boilerplate even
 * when told they have no tools. This:
 *  - extracts the intended content from a hallucinated <write_file><content>…</content>
 *    block (that content IS the deliverable), then
 *  - strips stray tool-call tags and tool-apology / file-summary meta lines.
 * Returns the original text unchanged if nothing matches.
 */
export function sanitizeDeliverable(raw: string): string {
  if (!raw) return raw;
  let t = raw;

  // 1. If the worker "wrote a file", the file content IS the real deliverable —
  // extract it from however the model framed the (hallucinated) write call.
  const extractors: RegExp[] = [
    // XML-ish: <write_file>…<content>X</content>…</write_file>
    /<write_file>[\s\S]*?<content>\s*([\s\S]*?)\s*<\/content>[\s\S]*?<\/write_file>/i,
    // Named-arg call: write_file(path=…, content="""X""")  (any arg order)
    /\bcontent\s*=\s*(?:"""|''')([\s\S]*?)(?:"""|''')/i,
    /\bcontent\s*=\s*"((?:[^"\\]|\\.)*)"/i,
    /\bcontent\s*=\s*'((?:[^'\\]|\\.)*)'/i,
    // Positional call: write_file("path", """X""")  or  write_file('path', '''X''')
    /\bwrite_file\s*\([^,]*,\s*(?:"""|''')([\s\S]*?)(?:"""|''')\s*\)/i,
    // write_file("path", "X")  /  write_file('path', 'X')
    /\bwrite_file\s*\([^,]*,\s*"((?:[^"\\]|\\.)*)"\s*\)/i,
    /\bwrite_file\s*\([^,]*,\s*'((?:[^'\\]|\\.)*)'\s*\)/i,
  ];
  let extracted = '';
  for (const re of extractors) {
    const m = t.match(re);
    if (m && m[1].trim().length > extracted.trim().length) extracted = m[1];
  }
  if (extracted.trim().length > 40) {
    // Unescape common JS/Python string escapes when the content came from a quoted call.
    t = extracted.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\'/g, "'");
  } else {
    // Otherwise just drop stray pseudo-tool tags, keep surrounding prose.
    t = t.replace(/<\/?(write_file|read_file|run_command|list_directory|edit_file|bash|path|content|command)>/gi, '');
  }

  // 2. Drop a trailing "## COMPLETION SUMMARY" / file-bookkeeping block entirely —
  // it is process narration, not part of the deliverable.
  t = t.replace(/\n#+\s*COMPLETION SUMMARY[\s\S]*$/i, '\n');

  // 3. Drop tool-apology / file-bookkeeping / "I will now create" meta lines.
  t = t.split('\n').filter((line) => !new RegExp(
    '^\\s*(' +
    "I (cannot|can't|can not|don't have|do not have|am unable to) (call|use|access)|" +
    'No tools? (are|is)? ?available|Since I have no tools|Because I have no tools|' +
    'the file (already )?exists|If you (can )?confirm|Otherwise,? the file|' +
    "I'll (start by|first)|Let me (first|start)|I will now (create|write)|" +
    '\\*\\*(Status|Files? (created|modified)|What was (built|revised)|Known issues|Deliverable):\\*\\*|' +
    '- /[\\w./-]+ (—|-) ' +
    ')', 'i').test(line)).join('\n');

  return t.replace(/\n{3,}/g, '\n\n').trim() || raw.trim();
}

// ============================================================================
// Deliberation Orchestrator
// ============================================================================

export class DeliberationOrchestrator {
  private config: OrchestratorConfig;
  private activeCouncilId: string | null = null;
  /** councilId → the raw problem this run was started with (work order Source). */
  private rawProblems = new Map<string, string>();
  /** councilId → resolved verify command (null = none), resolved once per run. */
  private verifyCommands = new Map<string, string | null>();

  constructor(config: OrchestratorConfig) {
    this.config = config;
  }

  // ==========================================================================
  // Auto-Run: Full Deliberation Loop
  // ==========================================================================

  /**
   * Run the full deliberation automatically from start to completion.
   * Frames the problem then hands off to continueDeliberation.
   */
  async runFullDeliberation(council: Council, rawProblem: string): Promise<void> {
    const deliberationStart = Date.now();
    console.log('[Orchestrator] Starting full deliberation...');
    this.activeCouncilId = council.id;

    // Always read fresh from store to avoid stale React state
    council = councilStore.get(council.id) || council;

    // Keep the raw problem for the work order's Source section: the worker's
    // directive is a summary two hops removed from it (input → framing →
    // decision → directive). Pipeline runs (config.brief set) keep it on the
    // instance so a BOUND council's savedProblem stays its original TASK
    // (persisting task+input there made reruns compound input into the task);
    // legacy standalone callers still persist it for the UI.
    if (rawProblem?.trim()) {
      this.rawProblems.set(council.id, rawProblem);
      if (!this.config.brief && council.deliberation) {
        councilStore.setSavedProblem(council.id, rawProblem);
        council = councilStore.get(council.id) || council;
      }
    }

    // Pre-flight check: log role assignments and personas for debugging
    const roleAssignments = council.deliberation?.roleAssignments || [];
    const consultantAssignments = roleAssignments.filter(r => r.role === 'consultant');
    const managerAssignments = roleAssignments.filter(r => r.role === 'manager');
    const workerAssignments = roleAssignments.filter(r => r.role === 'worker');

    console.log('[Orchestrator] PRE-FLIGHT CHECK:', {
      totalPersonas: council.personas.length,
      personaNames: council.personas.map(p => `${p.name} (${p.id.slice(0, 8)})`),
      totalRoleAssignments: roleAssignments.length,
      roleBreakdown: {
        managers: managerAssignments.length,
        consultants: consultantAssignments.length,
        workers: workerAssignments.length,
      },
      consultantDetails: consultantAssignments.map(r => {
        const p = council.personas.find(p => p.id === r.personaId);
        return `${p?.name || 'MISSING'} (${r.personaId.slice(0, 8)})`;
      }),
      // Check for personas without role assignments
      unassignedPersonas: council.personas
        .filter(p => !roleAssignments.some(r => r.personaId === p.id))
        .map(p => `${p.name} (${p.id.slice(0, 8)})`),
      // Check for role assignments without matching personas
      orphanedAssignments: roleAssignments
        .filter(r => !council.personas.some(p => p.id === r.personaId))
        .map(r => `${r.role}:${r.personaId.slice(0, 8)}`),
    });

    if (consultantAssignments.length < 2 && consultantAssignments.length > 0) {
      console.warn(`[Orchestrator] WARNING: Only ${consultantAssignments.length} consultant(s) found. ` +
        `If you expected more, check role assignments in Setup.`);
    }

    // Auto-repair: ensure every persona has a role assignment
    const unassigned = council.personas.filter(
      p => !roleAssignments.some(r => r.personaId === p.id)
    );
    if (unassigned.length > 0) {
      console.warn(`[Orchestrator] REPAIRING: ${unassigned.length} persona(s) without role assignments:`,
        unassigned.map(p => p.name));
      const repairedAssignments = [
        ...roleAssignments,
        ...unassigned.map(p => ({
          personaId: p.id,
          role: (p.preferredDeliberationRole || 'consultant') as 'manager' | 'consultant' | 'worker',
        })),
      ];
      councilStore.setRoleAssignments(council.id, repairedAssignments);
      // Re-fetch council with repaired assignments
      council = councilStore.get(council.id)!;
    }

    // Special path: 0 managers → direct execution (worker-only council)
    if (managerAssignments.length === 0) {
      console.log('[Orchestrator] No manager — running direct execution path');
      try {
        await this.runDirectExecution(council, rawProblem);
      } catch (error) {
        if (this.isUserAbort(error)) this.markCancelled(council.id);
        else this.markFailed(council.id, error);
        throw error;
      }
      return;
    }

    // NOTE: there is intentionally NO workflow-skipping "lightweight" path here.
    // Every council type (including agent/analysis) runs the SAME deliberation
    // workflow — a "lightweight" council is just a SMALLER council (e.g. 2
    // consultants), not one that skips phases. The deliberation naturally stays
    // cheap when there's little to deliberate: with 0 consultants it skips the
    // discussion rounds and goes straight to deciding (see frameProblem), and
    // round/revision counts already cap the depth. (The only direct-execution
    // path remaining is the structural manager-less case handled above.)

    try {
      await this.runPhases(council, rawProblem, deliberationStart);
    } catch (error) {
      // A user abort ends the council HONESTLY as `cancelled` (not failed): a
      // `cancellation` entry, no `error` entry. Timeouts are not cancels.
      if (this.isUserAbort(error)) this.markCancelled(council.id);
      else this.markFailed(council.id, error);
      throw error;
    }
  }

  /** Error entry + `failed` phase for an error that escaped the phase loops
   *  (e.g. during problem framing); no-op when the council already ended. */
  private markFailed(councilId: string, error: unknown): void {
    const council = councilStore.get(councilId);
    const phase = council?.deliberationState?.currentPhase;
    if (!council || !phase || PHASE_TRANSITIONS[phase]?.terminal) return;
    try {
      const author = getPersonaByRole(council, 'manager')[0] || council.personas[0];
      if (author) {
        this.createEntry(councilId, author.preferredDeliberationRole || 'manager', author.id, 'error', phase,
          `Deliberation error during ${phase}: ${(error as Error)?.message || String(error)}`, 0, 0, undefined, undefined,
          isBudgetExceededError(error) ? { budget: { kind: error.state.exceeded?.kind, usd: error.state.usd, tokens: error.state.tokens } } : undefined);
      }
    } catch { /* best effort */ }
    this.transitionPhase(councilId, 'failed');
  }

  /** True for a run-level abort (not a per-call timeout). */
  private isUserAbort(error: unknown): boolean {
    if (isBudgetExceededError(error)) return false; // a budget breach is an honest FAILURE
    const signalReason = this.config.signal?.aborted ? this.config.signal.reason : undefined;
    const signalIsUserAbort = !!this.config.signal?.aborted && !isBudgetExceededError(signalReason);
    return (isAbortError(error) && !isTimeoutError(error)) || signalIsUserAbort;
  }

  /** Cancellation entry + `cancelled` phase (idempotent). */
  private markCancelled(councilId: string): void {
    const council = councilStore.get(councilId);
    const phase = council?.deliberationState?.currentPhase;
    if (!council || !phase || PHASE_TRANSITIONS[phase]?.terminal) return;
    const author = getPersonaByRole(council, 'manager')[0] || council.personas[0];
    if (author) {
      this.createEntry(councilId, author.preferredDeliberationRole || 'manager', author.id, 'cancellation', phase,
        'Deliberation cancelled by user', 0, 0);
    }
    this.transitionPhase(councilId, 'cancelled');
    councilStore.setStatus(councilId, 'resolved');
  }

  private async runPhases(council: Council, rawProblem: string, deliberationStart: number): Promise<void> {
    throwIfAborted(this.config.signal);
    // Phase 1: Frame the problem
    const t0 = Date.now();
    await this.frameProblem(council, rawProblem);
    console.log(`[Orchestrator:Timing] frameProblem took ${((Date.now() - t0) / 1000).toFixed(1)}s (elapsed: ${((Date.now() - deliberationStart) / 1000).toFixed(0)}s)`);

    // Continue through all remaining phases automatically
    await this.continueDeliberation(council.id, deliberationStart);
  }

  /**
   * Continue deliberation from whatever phase it's currently in.
   * Used after initial start (runFullDeliberation) and after resume from pause.
   * Runs fully automatically — no manual step-by-step buttons needed.
   */
  async continueDeliberation(councilId: string, startTime?: number): Promise<void> {
    this.activeCouncilId = councilId;
    const elapsed = () => startTime ? ` (elapsed: ${((Date.now() - startTime) / 1000).toFixed(0)}s)` : '';
    let council = councilStore.get(councilId)!;

    // Phase 2: Deliberation rounds
    const maxRounds = council.deliberation?.maxRounds || 4;

    // Run rounds until manager decides or max rounds reached
    let loopGuard = 0;
    const maxLoopIterations = maxRounds * 3 + 10; // Safety limit

    while (loopGuard++ < maxLoopIterations) {
      throwIfAborted(this.config.signal);
      council = councilStore.get(councilId)!;
      const phase = council.deliberationState?.currentPhase;

      // Stop on pause or terminal states
      if (phase === 'paused') {
        console.log('[Orchestrator] Deliberation paused — stopping auto-run');
        return;
      }
      if (phase === 'deciding' || phase === 'planning' || phase === 'directing' ||
          phase === 'executing' || phase === 'reviewing' || phase === 'revising' ||
          phase === 'completed' || phase === 'cancelled' || phase === 'failed') {
        break; // Move past deliberation rounds
      }

      try {
        const phaseStart = Date.now();
        if (phase === 'round_independent') {
          console.log(`[Orchestrator] Running independent round...`);
          await this.runIndependentRound(council);
          console.log(`[Orchestrator:Timing] round_independent took ${((Date.now() - phaseStart) / 1000).toFixed(1)}s${elapsed()}`);
          // Fallback: if phase didn't advance (isRoundComplete returned false), force it
          const afterPhase = councilStore.get(councilId)?.deliberationState?.currentPhase;
          if (afterPhase === 'round_independent') {
            console.warn('[Orchestrator] Round did not advance after independent round — forcing transition');
            this.transitionPhase(councilId, 'round_waiting_for_manager');
          }
        } else if (phase === 'round_waiting_for_manager') {
          console.log('[Orchestrator] Manager evaluating...');
          await this.managerEvaluate(council);
          console.log(`[Orchestrator:Timing] managerEvaluate took ${((Date.now() - phaseStart) / 1000).toFixed(1)}s${elapsed()}`);
        } else if (phase === 'round_interactive') {
          console.log('[Orchestrator] Running interactive round...');
          await this.runInteractiveRound(council);
          console.log(`[Orchestrator:Timing] round_interactive took ${((Date.now() - phaseStart) / 1000).toFixed(1)}s${elapsed()}`);
          // Fallback: if phase didn't advance, force it
          const afterPhase = councilStore.get(councilId)?.deliberationState?.currentPhase;
          if (afterPhase === 'round_interactive') {
            console.warn('[Orchestrator] Round did not advance after interactive round — forcing transition');
            this.transitionPhase(councilId, 'round_waiting_for_manager');
          }
        } else {
          console.log(`[Orchestrator] Unexpected phase during deliberation: ${phase}`);
          break;
        }
      } catch (error) {
        if (this.isUserAbort(error)) throw error;
        const errMsg = (error as Error).message || String(error);
        const isRateLimit = /\b(429|rate.limit|too many requests)\b/i.test(errMsg);

        if (isRateLimit) {
          // Rate limit during deliberation round — wait and retry this iteration
          const delayMs = 120_000; // 2 minutes
          console.warn(
            `[Orchestrator] Rate limit during ${phase}, waiting ${Math.round(delayMs / 1000)}s before retrying...`
          );
          this.createEntry(
            councilId, 'manager', this.getManager(council).id,
            'error', phase || 'failed',
            `Rate limited during ${phase} — waiting ${Math.round(delayMs / 1000)}s before retrying...`,
            0, 0, undefined, council.deliberationState?.currentRound
          );
          await new Promise(resolve => setTimeout(resolve, delayMs));
          loopGuard--; // don't count this as a loop iteration
          continue; // retry the same phase
        }

        console.error(`[Orchestrator] Error during phase ${phase}:`, errMsg);

        // Record the error as a ledger entry — attribute to the phase's active role
        const isConsultantPhase = phase === 'round_independent' || phase === 'round_interactive';
        const role = isConsultantPhase ? 'consultant' : 'manager';
        const fallbackPersona = isConsultantPhase
          ? (council.personas.find(p => p.preferredDeliberationRole === 'consultant') || this.getManager(council))
          : this.getManager(council);
        this.createEntry(
          councilId,
          role,
          fallbackPersona.id,
          'error',
          phase || 'failed',
          `Deliberation error during ${phase}: ${errMsg}`,
          0, 0, undefined,
          council.deliberationState?.currentRound
        );

        // Transition to failed state so UI reflects the problem
        this.transitionPhase(councilId, 'failed');
        throw error; // Re-throw so caller can handle
      }
    }

    // Phase 3: Decision + Plan + Directive + Execution
    // Wrapped with phase-level rate-limit retry: if a phase fails due to
    // rate limiting (after invokeAgentSafe's own 5 retries are exhausted),
    // we wait and retry from the current phase instead of failing the council.
    const PHASE_RETRY_MAX = 3;
    const PHASE_RETRY_BASE_MS = 120_000; // 2 minutes

    for (let phaseAttempt = 0; phaseAttempt <= PHASE_RETRY_MAX; phaseAttempt++) {
    try {
      council = councilStore.get(councilId)!;
      let phase = council.deliberationState?.currentPhase;

      // If still in round phases after max iterations, force to deciding
      if (phase === 'round_waiting_for_manager' || phase === 'round_interactive' || phase === 'round_independent') {
        console.log('[Orchestrator] Max rounds exhausted, forcing decision phase');
        this.transitionPhase(councilId, 'deciding');
        council = councilStore.get(councilId)!;
        phase = council.deliberationState?.currentPhase;
      }

      if (phase === 'paused' || phase === 'failed') return;

      if (phase === 'deciding') {
        const t = Date.now();
        console.log('[Orchestrator] Making decision...');
        await this.makeDecision(council);
        console.log(`[Orchestrator:Timing] makeDecision took ${((Date.now() - t) / 1000).toFixed(1)}s${elapsed()}`);
        council = councilStore.get(councilId)!;
        phase = council.deliberationState?.currentPhase;
      }

      if (phase === 'paused' || phase === 'failed') return;

      if (phase === 'planning') {
        const t = Date.now();
        console.log('[Orchestrator] Creating plan...');
        await this.createPlan(council);
        console.log(`[Orchestrator:Timing] createPlan took ${((Date.now() - t) / 1000).toFixed(1)}s${elapsed()}`);
        council = councilStore.get(councilId)!;
        phase = council.deliberationState?.currentPhase;
      }

      if (phase === 'paused' || phase === 'failed') return;

      if (phase === 'directing') {
        const t = Date.now();
        console.log('[Orchestrator] Issuing directive...');
        await this.issueDirective(council);
        console.log(`[Orchestrator:Timing] issueDirective took ${((Date.now() - t) / 1000).toFixed(1)}s${elapsed()}`);
        council = councilStore.get(councilId)!;
        phase = council.deliberationState?.currentPhase;
      }

      // Phase 4: Execution loop
      const maxRevisions = council.deliberation?.maxRevisions ?? 3;
      let revisionCount = council.deliberationState?.revisionCount || 0;

      while (revisionCount < maxRevisions + 1) {
        throwIfAborted(this.config.signal);
        council = councilStore.get(councilId)!;
        phase = council.deliberationState?.currentPhase;

        if (phase === 'paused' || phase === 'failed') {
          console.log('[Orchestrator] Deliberation paused/failed — stopping auto-run');
          return;
        }

        if (phase === 'executing') {
          const t = Date.now();
          console.log('[Orchestrator] Executing work...');
          await this.executeWork(council);
          console.log(`[Orchestrator:Timing] executeWork took ${((Date.now() - t) / 1000).toFixed(1)}s${elapsed()}`);
        } else if (phase === 'reviewing') {
          const t = Date.now();
          console.log('[Orchestrator] Reviewing work...');
          const { review } = await this.reviewWork(council);
          console.log(`[Orchestrator:Timing] reviewWork took ${((Date.now() - t) / 1000).toFixed(1)}s${elapsed()}`);

          if (review.verdict === 'accept') {
            console.log('[Orchestrator] Work approved!');
            break;
          } else if (review.verdict === 'revise') {
            revisionCount++;
            console.log(`[Orchestrator] Revision requested (${revisionCount}/${maxRevisions})`);
          } else if (review.verdict === 're_deliberate') {
            const reDelibCount = council.deliberationState?.reDeliberationCount || 0;
            if (reDelibCount >= 1) {
              console.log('[Orchestrator] Max re-deliberations reached — accepting with best effort');
              this.transitionPhase(councilId, 'completed');
              councilStore.setStatus(councilId, 'resolved');
              break;
            }
            console.log('[Orchestrator] Re-deliberation requested — looping back');
            councilStore.updateDeliberationState(councilId, {
              reDeliberationCount: reDelibCount + 1,
            });
            // Phase transitions back to round_interactive, re-enter deliberation loop
            await this.continueDeliberation(councilId);
            return;
          }
        } else if (phase === 'revising') {
          console.log('[Orchestrator] Revising work...');
          await this.requestRevision(council);
        } else if (phase === 'completed') {
          console.log('[Orchestrator] Deliberation completed!');
          break;
        } else {
          console.log(`[Orchestrator] Unexpected phase during execution: ${phase}`);
          break;
      }
    }

    // Success — break out of the phase-level retry loop
    break;

    } catch (error) {
      if (this.isUserAbort(error)) throw error; // handled by runFullDeliberation (cancelled, not failed)
      const errMsg = (error as Error).message || String(error);
      const isRateLimit = /\b(429|rate.limit|too many requests)\b/i.test(errMsg);

      council = councilStore.get(councilId)!;
      const errPhase = council.deliberationState?.currentPhase;

      if (isRateLimit && phaseAttempt < PHASE_RETRY_MAX) {
        const delayMs = PHASE_RETRY_BASE_MS * Math.pow(1.5, phaseAttempt);
        console.warn(
          `[Orchestrator] Rate limit during ${errPhase}, retrying phase in ${Math.round(delayMs / 1000)}s ` +
          `(phase attempt ${phaseAttempt + 1}/${PHASE_RETRY_MAX})`
        );
        this.createEntry(
          councilId, 'manager', this.getManager(council).id,
          'error', errPhase || 'failed',
          `Rate limited during ${errPhase} — waiting ${Math.round(delayMs / 1000)}s before retrying...`,
          0, 0, undefined, council.deliberationState?.currentRound
        );
        await new Promise(resolve => setTimeout(resolve, delayMs));
        continue; // retry from current phase
      }

      console.error(`[Orchestrator] Error during post-round phase:`, errMsg);

      // Record error in ledger — attribute to the phase's active role
      try {
        const isWorkerPhase = errPhase === 'executing' || errPhase === 'revising';
        const role = isWorkerPhase ? 'worker' : 'manager';
        const persona = isWorkerPhase
          ? (council.personas.find(p => p.preferredDeliberationRole === 'worker') || this.getManager(council))
          : this.getManager(council);
        this.createEntry(
          councilId,
          role,
          persona.id,
          'error',
          errPhase || 'failed',
          `Deliberation error during ${errPhase}: ${errMsg}`,
          0, 0, undefined,
          council.deliberationState?.currentRound,
          isBudgetExceededError(error) ? { budget: { kind: error.state.exceeded?.kind, usd: error.state.usd, tokens: error.state.tokens } } : undefined
        );
      } catch { /* best effort */ }

      this.transitionPhase(councilId, 'failed');
      throw error;
    }
    } // end phase-level retry loop

    console.log(`[Orchestrator] Auto-run finished${elapsed()}`);
  }

  // ==========================================================================
  // Phase 1: Problem Framing
  // ==========================================================================

  /**
   * Manager frames the problem, creating Context v1
   */
  async frameProblem(council: Council, rawProblem: string): Promise<LedgerEntry> {
    this.validatePhase(council, 'created');
    const manager = this.getManager(council);

    // Transition to problem_framing
    this.transitionPhase(council.id, 'problem_framing');

    // Show manager as thinking immediately (before bootstrap, which can be slow)
    this.config.onAgentThinkingStart?.(manager, Date.now(), rawProblem);

    // Bootstrap directory context if enabled
    let enrichedProblem = rawProblem;
    if (council.deliberation?.bootstrapContext && this.workDir(council)) {
      try {
        const dirContext = await bootstrapDirectoryContext(this.workDir(council)!);
        if (dirContext) {
          enrichedProblem = `${dirContext}\n\n---\n\n${rawProblem}`;
        }
      } catch (error) {
        console.warn('[Orchestrator] Directory context bootstrap failed:', error);
        // Clear thinking on bootstrap failure before continuing
      }
    }

    // Build prompts per Section 9.1
    const systemPrompt = manager.predisposition.systemPrompt;
    const userMessage = buildManagerFramingPrompt(enrichedProblem);

    // Note: onAgentThinkingStart was already called above (before bootstrap).
    // invokeAgentSafe will call it again (idempotent) and onAgentThinkingEnd when done.

    // Invoke manager
    const response = await this.invokeAgentSafe(
      { personaId: manager.id, systemPrompt, userMessage },
      manager,
      'problem_framing'
    );

    // Create Context v1
    const context = createInitialContext(council.id, response.content, manager.id);

    // Update deliberation state
    councilStore.setActiveContext(council.id, context.id, context.version);

    // Create ledger entry
    const entry = this.createEntry(
      council.id,
      'manager',
      manager.id,
      'problem_statement',
      'problem_framing',
      response.content,
      response.tokensUsed,
      response.latencyMs,
      [{ artifactType: 'context', artifactId: context.id, version: 1 }],
      undefined,
      response.structured
    );

    // Check if consultants exist — skip deliberation rounds if none
    const consultants = this.getConsultants(council);
    if (consultants.length === 0) {
      console.log('[Orchestrator] 0 consultants — skipping deliberation rounds, moving to deciding');
      this.transitionPhase(council.id, 'deciding');
    } else {
      // Transition to round_independent
      this.transitionPhase(council.id, 'round_independent');
      councilStore.advanceRound(council.id);
    }

    return entry;
  }

  // ==========================================================================
  // Phase 2: Deliberation Rounds
  // ==========================================================================

  /**
   * Generate independent analysis for all consultants (Round 1)
   */
  async runIndependentRound(council: Council): Promise<LedgerEntry[]> {
    this.validatePhase(council, 'round_independent');
    const consultants = this.getConsultants(council);
    const context = getCurrentContext(council.id);

    // Detailed logging to debug missing consultant participation
    const allRoleAssignments = council.deliberation?.roleAssignments || [];
    const consultantRoles = allRoleAssignments.filter(r => r.role === 'consultant');
    console.log(`[Orchestrator] Independent round: ${consultants.length} consultant(s) ` +
      `from ${consultantRoles.length} consultant role assignment(s)`,
      {
        consultantNames: consultants.map(c => `${c.name} (${c.id.slice(0, 8)})`),
        consultantRoleIds: consultantRoles.map(r => r.personaId.slice(0, 8)),
        allPersonaIds: council.personas.map(p => `${p.name}:${p.id.slice(0, 8)}`),
      });

    if (!context) {
      throw new Error('No context found - problem must be framed first');
    }

    if (consultants.length === 0) {
      console.warn('[Orchestrator] No consultants assigned - skipping independent round');
      this.transitionPhase(council.id, 'round_waiting_for_manager');
      return [];
    }

    const entries: LedgerEntry[] = [];

    const runOne = async (consultant: Persona): Promise<LedgerEntry> => {
      const assignment = getRoleAssignment(council, consultant.id);
      const focusArea = assignment?.focusArea || consultant.predisposition.domain || 'general';

      const systemPrompt = consultant.predisposition.systemPrompt;
      const userMessage = buildIndependentAnalysisPrompt(consultant, focusArea, context.content);

      const response = await this.invokeAgentSafe(
        { personaId: consultant.id, systemPrompt, userMessage },
        consultant,
        'independent_analysis'
      );

      const proposedPatch = this.extractContextProposal(response.content);

      // Independent analyses run concurrently and land in shared context out of
      // order — tag each with the focus/question it addressed (parallel mode).
      const isParallel = council.deliberation?.consultantExecution !== 'sequential';
      const briefedContent = isParallel
        ? `**Focus — ${focusArea}:** the question this analysis addresses.\n\n${response.content}`
        : response.content;

      const entry = this.createEntry(
        council.id,
        'consultant',
        consultant.id,
        'analysis',
        'round_independent',
        briefedContent,
        response.tokensUsed,
        response.latencyMs,
        undefined,
        council.deliberationState?.currentRound,
        response.structured
      );

      councilStore.recordSubmission(council.id, consultant.id);

      // Evolve context with consultant findings
      this.appendToContext(council.id, 'Consultant Analysis', consultant.name, briefedContent, 'consultant', consultant.id);

      if (proposedPatch) {
        const patch = createPatch(
          council.id,
          context.id,
          context.version,
          proposedPatch.diff,
          proposedPatch.rationale,
          consultant.id,
          council.deliberationState?.currentRound || 1
        );
        councilStore.addPendingPatch(council.id, patch.id);
      }

      return entry;
    };

    // Respect consultantExecution setting
    const isSequential = council.deliberation?.consultantExecution === 'sequential';

    if (isSequential) {
      // Sequential: run one at a time, each with retry
      for (const consultant of consultants) {
        const entry = await this.runConsultantWithRetry(council, consultant, () => runOne(consultant));
        if (entry) entries.push(entry);
      }
    } else {
      // Parallel: all at once, each with retry
      const results = await Promise.allSettled(
        consultants.map((consultant) =>
          this.runConsultantWithRetry(council, consultant, () => runOne(consultant))
        )
      );
      for (const r of results) if (r.status === 'rejected' && this.isUserAbort(r.reason)) throw r.reason;
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          entries.push(result.value);
        }
      }
    }

    // Check if round is complete (all consultants submitted or accounted for)
    if (councilStore.isRoundComplete(council.id)) {
      this.transitionPhase(council.id, 'round_waiting_for_manager');
    }

    return entries;
  }

  /**
   * Generate deliberation response for a consultant (Round 2+)
   */
  async generateDeliberationResponse(council: Council, consultantId: string): Promise<LedgerEntry> {
    this.validatePhase(council, 'round_interactive');
    const consultant = council.personas.find((p) => p.id === consultantId);

    if (!consultant) {
      throw new Error(`Consultant not found: ${consultantId}`);
    }

    const assignment = getRoleAssignment(council, consultant.id);
    const focusArea = assignment?.focusArea || consultant.predisposition.domain || 'general';

    // Build context per Section 9.3
    // In sequential mode, include current round entries so later consultants
    // can see and build on earlier consultants' responses from this round
    const isSequential = council.deliberation?.consultantExecution === 'sequential';
    const contextContent = this.buildRoundNContext(council, isSequential);

    // Build prompts
    const systemPrompt = consultant.predisposition.systemPrompt;
    const userMessage = buildDeliberationResponsePrompt(consultant, focusArea, contextContent);

    const response = await this.invokeAgentSafe(
      { personaId: consultant.id, systemPrompt, userMessage },
      consultant,
      'deliberation_response'
    );

    // Check for context change proposal
    const proposedPatch = this.extractContextProposal(response.content);
    const context = getCurrentContext(council.id);

    // Concurrent consultants write into shared context out of order, so tag
    // each output with the focus/question it addressed (parallel mode only).
    const briefedContent = isSequential
      ? response.content
      : `**Focus — ${focusArea}:** the question this response addresses.\n\n${response.content}`;

    // Create ledger entry
    const entryType: LedgerEntryType = proposedPatch ? 'proposal' : 'response';
    const entry = this.createEntry(
      council.id,
      'consultant',
      consultant.id,
      entryType,
      'round_interactive',
      briefedContent,
      response.tokensUsed,
      response.latencyMs,
      undefined,
      council.deliberationState?.currentRound,
      response.structured
    );

    // Record submission
    councilStore.recordSubmission(council.id, consultant.id);

    // Create patch if proposed
    if (proposedPatch && context) {
      const patch = createPatch(
        council.id,
        context.id,
        context.version,
        proposedPatch.diff,
        proposedPatch.rationale,
        consultant.id,
        council.deliberationState?.currentRound || 1
      );
      councilStore.addPendingPatch(council.id, patch.id);
    }

    return entry;
  }

  /**
   * Run a full interactive round for all consultants
   */
  async runInteractiveRound(council: Council): Promise<LedgerEntry[]> {
    this.validatePhase(council, 'round_interactive');
    const consultants = this.getConsultants(council);
    const entries: LedgerEntry[] = [];

    // Detailed logging to debug missing consultant participation
    const allRoleAssignments = council.deliberation?.roleAssignments || [];
    const consultantRoles = allRoleAssignments.filter(r => r.role === 'consultant');
    console.log(`[Orchestrator] Interactive round ${council.deliberationState?.currentRound}: ` +
      `${consultants.length} consultant(s) from ${consultantRoles.length} consultant role assignment(s)`,
      {
        consultantNames: consultants.map(c => `${c.name} (${c.id.slice(0, 8)})`),
        consultantRoleIds: consultantRoles.map(r => r.personaId.slice(0, 8)),
        allPersonaIds: council.personas.map(p => `${p.name}:${p.id.slice(0, 8)}`),
      });

    if (consultants.length === 0) {
      console.warn('[Orchestrator] No consultants assigned - skipping interactive round');
      this.transitionPhase(council.id, 'round_waiting_for_manager');
      return [];
    }

    // Respect consultantExecution setting
    const isSequential = council.deliberation?.consultantExecution === 'sequential';

    if (isSequential) {
      // Sequential: each consultant sees previous consultants' responses in this round
      for (const consultant of consultants) {
        const entry = await this.runConsultantWithRetry(
          council,
          consultant,
          () => this.generateDeliberationResponse(councilStore.get(council.id)!, consultant.id)
        );
        if (entry) entries.push(entry);
      }
    } else {
      // Parallel: all consultants respond simultaneously with same context
      const results = await Promise.allSettled(
        consultants.map((consultant) =>
          this.runConsultantWithRetry(
            council,
            consultant,
            () => this.generateDeliberationResponse(council, consultant.id)
          )
        )
      );
      for (const r of results) if (r.status === 'rejected' && this.isUserAbort(r.reason)) throw r.reason;
      for (const result of results) {
        if (result.status === 'fulfilled' && result.value) {
          entries.push(result.value);
        }
      }
    }

    // Check if round is complete (all consultants submitted or accounted for)
    const updatedCouncil = councilStore.get(council.id);
    if (updatedCouncil && councilStore.isRoundComplete(council.id)) {
      this.transitionPhase(council.id, 'round_waiting_for_manager');
    }

    return entries;
  }

  /**
   * Manager evaluates the round
   */
  async managerEvaluate(council: Council): Promise<ManagerEvaluation> {
    this.validatePhase(council, 'round_waiting_for_manager');
    const manager = this.getManager(council);

    // Build context per Section 9.4
    const evalContext = this.buildManagerEvalContext(council);
    const pendingPatches = getPendingPatches(council.id);
    const expectedOutput = council.deliberation?.expectedOutput;
    const originalTask = (council.deliberation?.savedProblem || council.topic || '').trim();

    // Build prompts
    const systemPrompt = manager.predisposition.systemPrompt;
    const userMessage = buildManagerEvaluationPrompt(evalContext, pendingPatches, expectedOutput, originalTask);

    const response = await this.invokeAgentSafe(
      { personaId: manager.id, systemPrompt, userMessage },
      manager,
      'manager_evaluation'
    );

    // Parse structured response
    const evaluation = this.parseManagerEvaluation(response.content);

    // Process patch decisions
    if (evaluation.patchDecisions) {
      for (const decision of evaluation.patchDecisions) {
        const patch = getPendingPatches(council.id).find((p) => p.id === decision.patchId);
        if (!patch) {
          console.warn(`[Deliberation] Patch not found: ${decision.patchId}`);
          continue;
        }

        if (decision.accepted) {
          const currentContext = getCurrentContext(council.id);

          // Check for staleness - patch was proposed against an older context version
          const isStale = currentContext ? patch.baseVersion < currentContext.version : false;

          if (isStale) {
            // For stale patches, we need to either:
            // 1. Reject and ask for rebase
            // 2. Apply with allowStale (if manager explicitly approves)
            // For now, we log a warning and allow with explicit flag
            console.warn(
              `[Deliberation] Accepting stale patch ${patch.id}: ` +
              `proposed against v${patch.baseVersion}, current is v${currentContext!.version}`
            );
          }

          // Intelligently integrate the patch into the current context
          // The patch.diff contains the proposed change/addition
          // Instead of naive append, use the manager's decision reason as context
          const integrationNote = isStale
            ? `[Context change from ${this.getPersonaDisplayName(council, patch.authorPersonaId)}, ` +
              `originally proposed against v${patch.baseVersion}, integrated at v${currentContext?.version || 1}]`
            : `[Context change from ${this.getPersonaDisplayName(council, patch.authorPersonaId)}]`;

          const newContent = currentContext
            ? `${currentContext.content}\n\n${integrationNote}:\n${patch.diff}`
            : patch.diff;

          const result = acceptPatch(
            council.id,
            decision.patchId,
            manager.id,
            decision.reason,
            newContent,
            {
              allowStale: true, // Manager made explicit decision to accept
              changeSummary: `${patch.rationale}${isStale ? ' (applied to newer context)' : ''}`,
            }
          );

          councilStore.removePendingPatch(council.id, decision.patchId);
          councilStore.setActiveContext(council.id, result.newContext.id, result.newContext.version);

          // Create acceptance ledger entry with staleness info
          this.createEntry(
            council.id,
            'manager',
            manager.id,
            'context_acceptance',
            'round_waiting_for_manager',
            `Accepted context change: ${decision.reason}${result.wasStale ? ' (applied to newer context version)' : ''}`,
            0, 0,
            [{ artifactType: 'context', artifactId: result.newContext.id, version: result.newContext.version }]
          );
        } else {
          rejectPatch(council.id, decision.patchId, manager.id, decision.reason);
          councilStore.removePendingPatch(council.id, decision.patchId);

          // Create rejection ledger entry
          this.createEntry(
            council.id,
            'manager',
            manager.id,
            'context_rejection',
            'round_waiting_for_manager',
            `Rejected context change: ${decision.reason}`,
            0, 0
          );
        }
      }
    }

    // Store evaluation
    councilStore.setManagerEvaluation(council.id, evaluation);

    // Handle action
    const currentRound = council.deliberationState?.currentRound || 1;
    const minRounds = council.deliberation?.minRounds || 1;
    const maxRounds = council.deliberation?.maxRounds || 4;

    // Enforce min rounds: if manager wants to decide but we haven't hit minRounds, continue instead
    const canDecide = currentRound >= minRounds;
    const mustDecide = currentRound >= maxRounds;

    if (mustDecide || (evaluation.action === 'decide' && canDecide)) {
      this.transitionPhase(council.id, 'deciding');
    } else if (!canDecide && evaluation.action === 'decide') {
      // Manager tried to decide too early — force another round
      console.log(`[Orchestrator] Manager wanted to decide at round ${currentRound}, but minRounds is ${minRounds}. Continuing.`);
      councilStore.advanceRound(council.id);
      this.transitionPhase(council.id, 'round_interactive');
    } else if (evaluation.action === 'continue' || evaluation.action === 'redirect') {
      // Create question/redirect entry if provided
      if (evaluation.question) {
        const entryType: LedgerEntryType = evaluation.action === 'redirect' ? 'manager_redirect' : 'manager_question';
        this.createEntry(
          council.id,
          'manager',
          manager.id,
          entryType,
          'round_waiting_for_manager',
          evaluation.question,
          response.tokensUsed,
          response.latencyMs,
          undefined,
          currentRound,
          response.structured
        );
      }

      // Generate summary if needed
      if (this.shouldSummarize(council)) {
        await this.generateRoundSummary(council);
      }

      // Advance to next round
      councilStore.advanceRound(council.id);
      this.transitionPhase(council.id, 'round_interactive');
    }

    return evaluation;
  }

  /**
   * Generate round summary
   */
  async generateRoundSummary(council: Council): Promise<LedgerEntry> {
    const manager = this.getManager(council);
    const currentRound = council.deliberationState?.currentRound || 1;
    const roundEntries = getEntriesForRound(council.id, currentRound);

    let summaryContent: string;
    let tokensUsed = 0;
    let latencyMs = 0;
    let summaryStructured: Record<string, unknown> | undefined;

    const summaryMode = council.deliberation?.summaryMode || 'manager';
    const summarizeAfterRound = council.deliberation?.summarizeAfterRound || 2;

    // Determine whether to use automatic or manager summary
    const useAutomatic = summaryMode === 'automatic' ||
      (summaryMode === 'hybrid' && currentRound <= summarizeAfterRound + 1);

    if (useAutomatic) {
      summaryContent = buildMechanicalSummary(roundEntries);
    } else {
      // Manager-generated summary
      const systemPrompt = manager.predisposition.systemPrompt;
      const userMessage = buildManagerRoundSummaryPrompt(roundEntries);

      const response = await this.invokeAgentSafe(
        { personaId: manager.id, systemPrompt, userMessage },
        manager,
        'round_summary'
      );

      summaryContent = response.content;
      tokensUsed = response.tokensUsed;
      latencyMs = response.latencyMs;
      summaryStructured = response.structured;
    }

    // Store summary
    councilStore.setRoundSummary(council.id, currentRound, summaryContent);

    // Create ledger entry
    return this.createEntry(
      council.id,
      'manager',
      manager.id,
      'round_summary',
      council.deliberationState?.currentPhase || 'round_waiting_for_manager',
      summaryContent,
      tokensUsed,
      latencyMs,
      undefined,
      currentRound,
      summaryStructured
    );
  }

  // ==========================================================================
  // Consultant Final Positions (before decision)
  // ==========================================================================

  private async collectConsultantFinalPositions(council: Council): Promise<string> {
    const consultants = this.getConsultants(council);
    if (consultants.length === 0) return '';

    const contextContent = this.buildRoundNContext(council, false);
    const positions: string[] = [];

    for (const consultant of consultants) {
      const assignment = getRoleAssignment(council, consultant.id);
      const focusArea = assignment?.focusArea || consultant.predisposition.domain || 'general';
      const systemPrompt = consultant.predisposition.systemPrompt;
      const userMessage = buildConsultantFinalPositionPrompt(consultant, focusArea, contextContent);

      this.config.onAgentThinkingStart?.(consultant, Date.now(), userMessage);
      const response = await this.invokeAgentSafe(
        { personaId: consultant.id, systemPrompt, userMessage },
        consultant,
        'deliberation_response'  // reuse existing tool phase (READ_ONLY_TOOLS)
      );
      this.config.onAgentThinkingEnd?.(consultant);

      positions.push(`[${consultant.name} - ${focusArea}]: ${response.content}`);

      this.createEntry(council.id, 'consultant', consultant.id, 'response', 'deciding',
        response.content, response.tokensUsed, response.latencyMs, undefined,
        council.deliberationState?.currentRound, response.structured);
    }

    return positions.join('\n\n');
  }

  // ==========================================================================
  // Phase 3: Decision
  // ==========================================================================

  /**
   * Manager makes final decision
   */
  async makeDecision(council: Council): Promise<LedgerEntry> {
    this.validatePhase(council, 'deciding');
    const manager = this.getManager(council);

    // Collect consultant final positions before manager decides
    const consultantPositions = await this.collectConsultantFinalPositions(council);

    // Build context per Section 9.5
    const decisionContext = this.buildDecisionContext(council);
    const fullContext = consultantPositions
      ? `CONSULTANT FINAL POSITIONS:\n${consultantPositions}\n\n---\n\n${decisionContext}`
      : decisionContext;
    const decisionCriteria = council.deliberation?.decisionCriteria;
    const expectedOutput = council.deliberation?.expectedOutput;

    // Manager subagent fan-out (provider-agnostic): the manager's subagents advise on
    // the decision context before it decides.
    const contextForDecision = await this.runSubagents(council, manager, fullContext);

    // Build prompts
    const systemPrompt = manager.predisposition.systemPrompt;
    const stepType = council.deliberation?.stepType;
    const userMessage = buildManagerDecisionPrompt(contextForDecision, decisionCriteria, expectedOutput, stepType, (council.deliberation?.savedProblem || council.topic || '').trim());

    const response = await this.invokeAgentSafe(
      { personaId: manager.id, systemPrompt, userMessage },
      manager,
      'decision'
    );

    // Create decision artifact
    const context = getCurrentContext(council.id);
    const acceptanceCriteria = this.extractAcceptanceCriteria(response.content);

    const decision = createDecision(
      council.id,
      response.content,
      context?.version || 1,
      acceptanceCriteria
    );

    // Update state
    councilStore.setFinalDecision(council.id, decision.id);

    // Create ledger entry
    const entry = this.createEntry(
      council.id,
      'manager',
      manager.id,
      'decision',
      'deciding',
      response.content,
      response.tokensUsed,
      response.latencyMs,
      [{ artifactType: 'decision', artifactId: decision.id }],
      undefined,
      response.structured
    );

    // Check if workers exist — if not, decision IS the output
    const workers = getPersonaByRole(council, 'worker');
    if (workers.length === 0) {
      console.log('[Orchestrator] 0 workers — decision is the final output');
      councilStore.updateDeliberationState(council.id, { completionSummary: response.content });
      this.transitionPhase(council.id, 'completed');
      councilStore.setStatus(council.id, 'resolved');
      return entry;
    }

    // Transition to planning or directing
    const requirePlan = council.deliberation?.requirePlan || false;
    this.transitionPhase(council.id, requirePlan ? 'planning' : 'directing');

    return entry;
  }

  /**
   * Manager creates execution plan (optional)
   */
  async createPlan(council: Council): Promise<LedgerEntry> {
    this.validatePhase(council, 'planning');
    const manager = this.getManager(council);
    const decision = getDecision(council.id);

    if (!decision) {
      throw new Error('No decision found - must make decision first');
    }

    // Build prompts
    const systemPrompt = manager.predisposition.systemPrompt;
    const userMessage = buildManagerPlanPrompt(decision.content);

    const response = await this.invokeAgentSafe(
      { personaId: manager.id, systemPrompt, userMessage },
      manager,
      'plan'
    );

    // Create plan artifact
    const plan = createPlan(council.id, response.content, decision.id);

    // Create ledger entry
    const entry = this.createEntry(
      council.id,
      'manager',
      manager.id,
      'plan',
      'planning',
      response.content,
      response.tokensUsed,
      response.latencyMs,
      [{ artifactType: 'plan', artifactId: plan.id }],
      undefined,
      response.structured
    );

    this.transitionPhase(council.id, 'directing');
    return entry;
  }

  // ==========================================================================
  // Phase 4: Work Directive
  // ==========================================================================

  /**
   * Manager issues work directive
   */
  async issueDirective(council: Council): Promise<LedgerEntry> {
    this.validatePhase(council, 'directing');
    const manager = this.getManager(council);
    const decision = getDecision(council.id);
    const plan = getPlan(council.id);

    if (!decision) {
      throw new Error('No decision found - must make decision first');
    }

    // Check if the worker has write permissions (informs the directive to emphasize implementation)
    const worker = this.getWorker(council);
    const workerAssignment = getRoleAssignment(council, worker.id);
    const hasWritePermissions = this.effectiveWrite(workerAssignment, council.deliberation?.outputType);
    const stepType = council.deliberation?.stepType;

    // Build prompts per Section 9.6
    const systemPrompt = manager.predisposition.systemPrompt;
    const userMessage = buildWorkDirectivePrompt(decision.content, plan?.content, hasWritePermissions, stepType);

    const response = await this.invokeAgentSafe(
      { personaId: manager.id, systemPrompt, userMessage },
      manager,
      'directive'
    );

    // Create directive artifact
    const directive = createDirective(
      council.id,
      response.content,
      decision.id,
      plan?.id
    );

    // Update state
    councilStore.setWorkDirective(council.id, directive.id);

    // Create ledger entry
    const entry = this.createEntry(
      council.id,
      'manager',
      manager.id,
      'work_directive',
      'directing',
      response.content,
      response.tokensUsed,
      response.latencyMs,
      [{ artifactType: 'directive', artifactId: directive.id }],
      undefined,
      response.structured
    );

    this.transitionPhase(council.id, 'executing');
    return entry;
  }

  // ==========================================================================
  // Phase 5: Execution
  // ==========================================================================

  /**
   * Worker executes directive
   */
  /**
   * Subagent fan-out (docs/SUBAGENTS.md). Runs a persona's configured subagents in
   * parallel — each on its OWN provider/model via the same router as personas — and
   * returns the directive augmented with their findings (or the directive unchanged
   * if there are none). Each subagent is recorded in the ledger; failures are
   * non-fatal. Provider-agnostic by construction: a synthetic persona carrying the
   * subagent's provider/model is passed to invokeAgent, so dispatch goes wherever
   * the subagent's model lives (Claude, GPT, Gemini, DeepSeek, a routed profile, …).
   */
  private async runSubagents(council: Council, persona: Persona, directive: string): Promise<string> {
    // Static (configured) subagents first, then dynamic (runtime-proposed) ones.
    let dir = await this.runSubagentSpecs(council, persona, directive, persona.subagents || []);
    if (persona.dynamicSubagents) {
      const proposed = await this.planDynamicSubagents(council, persona, directive);
      if (proposed.length) dir = await this.runSubagentSpecs(council, persona, dir, proposed);
    }
    return dir;
  }

  /** Dynamic spawning: ask the persona to PROPOSE up to 3 subagents for this directive.
   *  provider/model defaults to the persona's own when omitted or 'self'. Non-fatal. */
  private async planDynamicSubagents(council: Council, persona: Persona, directive: string): Promise<SubagentSpec[]> {
    void council;
    const systemPrompt = `You plan helper subagents. If splitting this work across a few focused helpers would clearly improve the result, propose up to 3; otherwise propose none. Be conservative.`;
    const userMessage =
      `DIRECTIVE:\n${directive}\n\n` +
      `Propose subagents, ONE PER LINE, EXACTLY as:  NAME | provider/model | task\n` +
      `Use 'self' for provider/model to reuse your own model. If none are needed, reply with exactly: NONE\n` +
      `Output only those lines (or NONE).`;
    let text = '';
    try {
      const resp = await this.invokeAgentSafe(
        { personaId: persona.id, systemPrompt, userMessage, skipTools: true },
        persona, 'subagent'
      );
      text = (resp.content || '').trim();
    } catch (err) {
      console.warn('[Orchestrator] Dynamic subagent planning failed:', (err as Error).message);
      return [];
    }
    if (/^none\b/i.test(text)) return [];
    const specs: SubagentSpec[] = [];
    for (const raw of text.split('\n')) {
      const line = raw.trim().replace(/^[-*\d.)]+\s*/, '');
      if (!line || /^none$/i.test(line)) continue;
      const parts = line.split('|').map((p) => p.trim());
      let name = '', pm = 'self', task = '';
      if (parts.length >= 3) { name = parts[0]; pm = parts[1]; task = parts.slice(2).join(' | '); }
      else if (parts.length === 2) { name = parts[0]; task = parts[1]; }
      else continue;
      if (!name || !task) continue;
      let provider = persona.provider, model = persona.model;
      const slash = pm.indexOf('/');
      if (pm && !/^self$/i.test(pm) && slash > 0) { provider = pm.slice(0, slash).trim(); model = pm.slice(slash + 1).trim(); }
      specs.push({ id: `dyn-${crypto.randomUUID().slice(0, 8)}`, name: name.slice(0, 60), provider, model, task, enabled: true });
      if (specs.length >= 3) break;
    }
    console.log(`[Orchestrator] Dynamic spawn: ${persona.name} proposed ${specs.length} subagent(s)`);
    return specs;
  }

  /** Core fan-out: run `specs` in parallel (each on its own provider/model), record each
   *  in the ledger, and fold the findings into the directive. */
  private async runSubagentSpecs(council: Council, persona: Persona, directive: string, specs: SubagentSpec[]): Promise<string> {
    const subs = specs.filter((s) => s.enabled !== false && s.task?.trim()).slice(0, 4);
    if (subs.length === 0) return directive;
    console.log(`[Orchestrator] Fan-out: ${subs.length} subagent(s) for ${persona.name}`);

    const results = await Promise.all(
      subs.map(async (sub) => {
        const task = sub.task.replace(/\{\{directive\}\}/g, directive);
        const subPersona: Persona = {
          ...persona,
          name: sub.name,
          provider: sub.provider,
          model: sub.model,
          preferredDeliberationRole: 'worker',
        };
        const systemPrompt = sub.systemPrompt
          || `You are ${sub.name}, a focused subagent assisting a worker. Do exactly what the task asks — concise, complete, no preamble or meta-commentary.`;
        try {
          const resp = await this.invokeAgentSafe(
            {
              personaId: persona.id,
              systemPrompt,
              userMessage: `TASK:\n${task}`,
              skipTools: true,
            },
            subPersona,
            'subagent'
          );
          const content = (resp.content || '').trim();
          this.createEntry(
            council.id, 'worker', persona.id, 'analysis', 'executing',
            `[Subagent: ${sub.name} · ${sub.provider}/${sub.model}]\n${content || '(no output)'}`,
            resp.tokensUsed || 0, resp.latencyMs || 0,
            undefined, undefined, resp.structured
          );
          return content ? `### ${sub.name} (${sub.provider}/${sub.model})\n${content}` : '';
        } catch (err) {
          const msg = (err as Error).message || String(err);
          console.warn(`[Orchestrator] Subagent ${sub.name} failed:`, msg);
          this.createEntry(
            council.id, 'worker', persona.id, 'error', 'executing',
            `Subagent ${sub.name} (${sub.provider}/${sub.model}) failed: ${msg}`, 0, 0
          );
          return '';
        }
      })
    );

    const findings = results.filter(Boolean).join('\n\n');
    return findings
      ? `${directive}\n\n---\nSUBAGENT FINDINGS (incorporate these; you synthesize the final deliverable yourself):\n${findings}`
      : directive;
  }

  /**
   * The manager's directive reaches the worker two lossy summarization hops
   * away from the step's actual input (input → framing → decision → directive).
   * When the directive drops details, a worker with nothing else to go on
   * invents them (observed: a market brief contradicting the upstream
   * positioning decision). Re-attach the original problem/input as
   * authoritative source material so the deliverable stays grounded in it.
   */
  /**
   * The verify command for this council: explicit config → `deliberation.testCommand`
   * → auto-detected (file/directory outputs, when a readFile hook exists). Cached.
   */
  /** Effective working dir: the executor's worktree (if any) else the council's. */
  private workDir(council: Council): string | undefined {
    return this.config.codebase?.worktreePath ?? council.deliberation?.workingDirectory;
  }

  private codebasePerm(): WorkerPermissions['codebase'] {
    const c = this.config.codebase;
    return c ? { mode: 'worktree', branch: c.branch, repoRoot: c.repoRoot } : undefined;
  }

  private async resolveVerifyCommand(council: Council): Promise<string | undefined> {
    if (this.verifyCommands.has(council.id)) return this.verifyCommands.get(council.id) || undefined;
    let cmd: string | null = this.config.verify?.command?.trim() || council.deliberation?.testCommand?.trim() || null;
    const outputType = council.deliberation?.outputType;
    const wd = this.workDir(council);
    const auto = this.config.verify?.autoDetect ?? (outputType === 'file' || outputType === 'directory');
    if (!cmd && auto && wd && this.config.readFile) {
      try {
        const detected = await detectTestCommand(wd, this.config.readFile);
        if (detected) cmd = detected.command;
      } catch { /* no detection */ }
    }
    this.verifyCommands.set(council.id, cmd);
    return cmd || undefined;
  }

  /** Attach the verify command to a FULL-tools worker's permissions (text workers can't run it). */
  private async withVerify(council: Council, perms: WorkerPermissions): Promise<WorkerPermissions> {
    perms = { ...perms, workingDirectory: this.workDir(council), codebase: this.codebasePerm() };
    if (!perms.writePermissions) return perms;
    const cmd = await this.resolveVerifyCommand(council);
    if (!cmd) return perms;
    return { ...perms, verifyCommand: cmd, verifyMaxTries: this.config.verify?.maxWorkerTries ?? 3 };
  }

  /**
   * Final check the orchestrator runs itself (the worker's own report is not
   * trusted): the verify command in the council's working dir. Records a
   * `test_result` entry. Returns undefined when nothing can be run.
   */
  private async runFinalVerification(council: Council, phase: DeliberationPhase): Promise<{ passed: boolean; exitCode: number; tail: string; command: string } | undefined> {
    const cmd = await this.resolveVerifyCommand(council);
    const wd = this.workDir(council);
    if (!cmd || !wd || !this.config.runCommand) return undefined;
    const manager = getPersonaByRole(council, 'manager')[0] || getPersonaByRole(council, 'worker')[0];
    let result: { stdout: string; stderr: string; exit_code: number };
    try {
      result = await this.config.runCommand(cmd, wd);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result = { stdout: '', stderr: msg, exit_code: -1 };
    }
    const output = `${result.stdout}\n${result.stderr}`.trim();
    const tail = output.length > 3000 ? `…${output.slice(-3000)}` : output;
    this.createEntry(
      council.id, 'manager', manager.id, 'test_result', phase,
      `Verification: ${cmd}\nExit code: ${result.exit_code}\n\n${tail}`,
      0, 0, undefined, undefined, { exitCode: result.exit_code, testCommand: cmd, verification: true }
    );
    return { passed: result.exit_code === 0, exitCode: result.exit_code, tail, command: cmd };
  }

  /** The raw problem this run started with (falls back to the persisted savedProblem). */
  private rawProblemFor(council: Council): string {
    return this.rawProblems.get(council.id) ?? council.deliberation?.savedProblem?.trim() ?? '';
  }

  /** What the worker may do with tools — mirrors the grant logic in invokeAgentSafe (rule 5). */
  private toolScopeFor(assignment: DeliberationRoleAssignment | undefined, writePermissions: boolean): ToolScope {
    if (assignment?.toolAccess === 'none') return 'none';
    if (writePermissions) return 'full';
    // The per-call runtime gate (canUseTools) may still turn these off; the
    // order text stays conservative and never names write tools (rule 5).
    if (assignment?.toolAccess === 'full' || (assignment?.allowedServerIds?.length ?? 0) > 0) return 'read_only';
    return 'none';
  }

  /**
   * Build the typed WORK ORDER the worker receives (replaces the old
   * "directive + ORIGINAL TASK & SOURCE MATERIAL" concatenation).
   */
  /**
   * Ask-back. While the worker's reply is a `## NEEDS INPUT` question (and not a
   * delivery), resolve it — manager → human (`onWorkerQuestion`) → auto — and
   * re-invoke the worker on the SAME attempt with the Q&A appended (`rebuild`
   * produces the new user message from the accumulated Q&A). Capped at
   * `askBack.maxQuestionsPerPhase` answered questions; the next question gets the
   * budget-exhausted auto answer and one last re-invoke, then the output stands.
   * Ledger (rule 1): question = `manager_question` authored by the worker;
   * answer = `response` with `structured.answeredBy` (manager | user | system).
   */
  private async handleWorkerSignals(
    council: Council,
    worker: Persona,
    systemPrompt: string,
    response: AgentResponse,
    rebuild: (qa: WorkOrderQA[]) => string,
    context: 'execution' | 'revision',
    phase: DeliberationPhase,
  ): Promise<{ response: AgentResponse; qa: WorkOrderQA[] }> {
    const qa: WorkOrderQA[] = [];
    const max = this.config.askBack?.maxQuestionsPerPhase ?? MAX_QUESTIONS_PER_PHASE;
    const manager = getPersonaByRole(council, 'manager')[0];
    for (let asked = 0; asked <= max; asked++) {
      const signals = parseWorkerSignals(response.content);
      if (signals.status !== 'question' || !signals.question) break;
      const question = signals.question;
      this.createEntry(council.id, 'worker', worker.id, 'manager_question', phase,
        `[Question from ${worker.name}] ${question}`, response.tokensUsed, response.latencyMs,
        undefined, undefined, { ...response.structured, signals: signalsForLedger(signals), askedBy: 'worker' });

      let answer: string;
      let answeredBy: WorkOrderQA['answeredBy'];
      const exhausted = asked >= max;
      if (exhausted) {
        answer = BUDGET_EXHAUSTED_ANSWER;
        answeredBy = 'system';
      } else {
        const directive = getDirective(council.id);
        const decision = getDecision(council.id);
        const resolved = await resolveWorkerQuestion({
          ctx: { councilId: council.id, personaId: worker.id, personaName: worker.name, question, phase: context },
          askManager: manager ? async () => {
            const r = await this.invokeAgentSafe({
              personaId: manager.id,
              systemPrompt: manager.predisposition.systemPrompt,
              userMessage: buildWorkerQuestionAnswerPrompt({
                question, workerName: worker.name,
                directive: directive?.content, decision: decision?.content,
                acceptanceCriteria: decision?.acceptanceCriteria, source: this.rawProblemFor(council),
              }),
            }, manager, 'worker_question');
            return r.content;
          } : undefined,
          onWorkerQuestion: this.config.onWorkerQuestion,
        });
        answer = resolved.answer;
        answeredBy = resolved.answeredBy;
      }
      console.log(`[Orchestrator:AskBack] ${worker.name} asked (${asked + 1}); answered by ${answeredBy}`);
      this.createEntry(council.id, manager ? 'manager' : 'worker', (manager ?? worker).id, 'response', phase,
        `[Answer to ${worker.name} — ${answeredBy}] ${answer}`, 0, 0, undefined, undefined,
        { answeredBy, question, automatic: answeredBy === 'system' });
      qa.push({ question, answer, answeredBy });

      response = await this.invokeAgentSafe(
        { personaId: worker.id, systemPrompt, userMessage: rebuild(qa) },
        worker,
        context,
      );
      if (exhausted) break;
    }
    return { response, qa };
  }

  private composeWorkOrder(
    council: Council,
    assignment: DeliberationRoleAssignment | undefined,
    perms: WorkerPermissions,
    directiveText: string,
    attempt: WorkOrderInput['attempt'],
    extras: { qa?: WorkOrderQA[]; lastTestTail?: string } = {},
  ): string {
    const d = council.deliberation;
    const decision = getDecision(council.id);
    const brief = this.config.brief;
    const task = brief?.task ?? undefined;
    const raw = this.rawProblemFor(council);
    return buildWorkOrder({
      objective: { task, stepName: brief?.stepName, stepType: brief?.stepType ?? d?.stepType },
      deliverable: { outputType: d?.outputType, expectedOutput: d?.expectedOutput },
      acceptance: { acceptanceCriteria: decision?.acceptanceCriteria, decisionCriteria: d?.decisionCriteria },
      directive: directiveText,
      constraints: {
        writePermissions: !!perms.writePermissions,
        toolScope: this.toolScopeFor(assignment, !!perms.writePermissions),
        workingDirectory: perms.workingDirectory,
        directoryConstrained: perms.directoryConstrained,
        maxWords: d?.maxWordsPerResponse || undefined,
        timeoutMinutes: 30,
        codebase: perms.codebase,
      },
      verification: perms.verifyCommand
        ? { command: perms.verifyCommand, maxTries: perms.verifyMaxTries ?? 3, lastOutputTail: extras.lastTestTail }
        : extras.lastTestTail ? { command: '', maxTries: 0, lastOutputTail: extras.lastTestTail } : undefined,
      attempt: { ...attempt, qa: extras.qa },
      inputs: brief?.inputs,
      // Task-only councils (no input) have nothing left after stripping the task.
      source: task ? stripTaskPrefix(raw, task) : raw,
      seatBrief: this.config.seatBriefs?.worker,
    });
  }

  async executeWork(council: Council): Promise<LedgerEntry> {
    this.validatePhase(council, 'executing');
    const worker = this.getWorker(council);
    const directive = getDirective(council.id);

    if (!directive) {
      throw new Error('No directive found - must issue directive first');
    }

    // Get role assignment for suppress check
    const assignment = getRoleAssignment(council, worker.id);
    const suppressPersona = assignment?.suppressPersona !== false; // Default true for worker

    // Build worker permissions from role assignment + deliberation config.
    // writePermissions is gated by ACTUAL tool capability so a non-tool worker
    // is driven as a text agent (not told to write files it can't write).
    const workerPermissions: WorkerPermissions = await this.withVerify(council, {
      writePermissions: this.effectiveWrite(assignment, council.deliberation?.outputType),
      workingDirectory: this.workDir(council),
      directoryConstrained: council.deliberation?.directoryConstrained,
    });

    // Build prompts per Section 9.7
    const stepType = council.deliberation?.stepType;
    const systemPrompt = suppressPersona
      ? getMinimalWorkerSystemPrompt(workerPermissions, stepType)
      : worker.predisposition.systemPrompt;

    // The typed WORK ORDER (objective, deliverable, acceptance, directive,
    // constraints, attempt, inputs, source) — then subagent fan-out
    // (provider-agnostic): if the worker has subagents, run them first and fold
    // their findings in before the worker synthesizes.
    const revisionCount = council.deliberationState?.revisionCount || 0;
    const maxRevisions = council.deliberation?.maxRevisions ?? 3;
    const order = this.composeWorkOrder(council, assignment, workerPermissions, directive.content,
      { number: revisionCount + 1, max: maxRevisions + 1, mode: 'execute' });
    const effectiveDirective = await this.runSubagents(council, worker, order);

    const userMessage = buildWorkerExecutionPrompt(effectiveDirective, workerPermissions, stepType);

    let response = await this.invokeAgentSafe(
      { personaId: worker.id, systemPrompt, userMessage },
      worker,
      'execution'
    );

    // Output guarantee: the worker MUST return a non-empty deliverable. If it
    // returns nothing (e.g. only a tool call, or blank), retry once with an
    // explicit demand, then fail loudly rather than writing an empty output.md.
    if (!response.content || response.content.trim().length < 20) {
      console.warn('[Orchestrator] Worker returned empty/short output — retrying once.');
      const retryMessage = `${userMessage}\n\n[RETRY — YOUR PREVIOUS RESPONSE WAS EMPTY] You returned no usable content. Output the COMPLETE deliverable now as plain text in your reply. Do not call tools, do not return an empty message, and do not just describe what you would do — produce the actual result.`;
      response = await this.invokeAgentSafe(
        { personaId: worker.id, systemPrompt, userMessage: retryMessage },
        worker,
        'execution'
      );
    }
    if (!response.content || !response.content.trim()) {
      throw new Error('Worker produced no output after a retry — the deliverable could not be generated.');
    }

    // Ask-back: a `## NEEDS INPUT` question is answered (manager → human → auto)
    // and the worker re-invoked on this same attempt with the Q&A in its order.
    const findingsSuffix = effectiveDirective.slice(order.length);
    ({ response } = await this.handleWorkerSignals(council, worker, systemPrompt, response, (qa) =>
      buildWorkerExecutionPrompt(
        this.composeWorkOrder(council, assignment, workerPermissions, directive.content,
          { number: revisionCount + 1, max: maxRevisions + 1, mode: 'answer' }, { qa }) + findingsSuffix,
        workerPermissions, stepType,
      ), 'execution', 'executing'));

    // Create output artifact
    const output = createOutput(council.id, workerPermissions.writePermissions ? response.content : sanitizeDeliverable(response.content), directive.id);

    // Update state
    councilStore.setCurrentOutput(council.id, output.id);

    // Create ledger entry (+ the worker's parsed signals: status/question/blocked/verification)
    const signals = parseWorkerSignals(response.content);
    const entry = this.createEntry(
      council.id,
      'worker',
      worker.id,
      'work_output',
      'executing',
      response.content,
      response.tokensUsed,
      response.latencyMs,
      [{ artifactType: 'output', artifactId: output.id, version: output.version }],
      undefined,
      { ...response.structured, signals: signalsForLedger(signals) }
    );

    // Evolve context with worker results
    this.appendToContext(council.id, 'Worker Execution', worker.name, response.content, 'worker', worker.id);

    this.transitionPhase(council.id, 'reviewing');
    return entry;
  }

  // ==========================================================================
  // Consultant Reviews (before manager verdict)
  // ==========================================================================

  private async collectConsultantReviews(council: Council): Promise<string> {
    const consultants = this.getConsultants(council);
    if (consultants.length === 0) return '';

    const output = getLatestOutput(council.id);
    const directive = getDirective(council.id);
    if (!output || !directive) return '';

    const expectedOutput = council.deliberation?.expectedOutput;

    // Run consultant reviews in parallel to reduce total time
    const reviewOne = async (consultant: Persona): Promise<string> => {
      const assignment = getRoleAssignment(council, consultant.id);
      const focusArea = assignment?.focusArea || consultant.predisposition.domain || 'general';
      const systemPrompt = consultant.predisposition.systemPrompt;
      const userMessage = buildConsultantReviewPrompt(
        consultant, focusArea, output.content, directive.content, expectedOutput
      );

      const response = await this.invokeAgentSafe(
        { personaId: consultant.id, systemPrompt, userMessage },
        consultant,
        'consultant_review'
      );

      this.createEntry(council.id, 'consultant', consultant.id, 'review', 'reviewing',
        response.content, response.tokensUsed, response.latencyMs, undefined,
        council.deliberationState?.currentRound, response.structured);

      return `[${consultant.name} - ${focusArea}]: ${response.content}`;
    };

    const results = await Promise.allSettled(consultants.map(c => reviewOne(c)));
    for (const r of results) if (r.status === 'rejected' && this.isUserAbort(r.reason)) throw r.reason;

    const reviews: string[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        reviews.push(result.value);
      } else {
        console.warn('[Orchestrator] Consultant review failed:', result.reason);
      }
    }

    return reviews.join('\n\n');
  }

  // ==========================================================================
  // Phase 6: Review
  // ==========================================================================

  /**
   * Manager reviews work output
   */
  async reviewWork(council: Council): Promise<{ entry: LedgerEntry; review: ManagerReview }> {
    this.validatePhase(council, 'reviewing');
    const manager = this.getManager(council);
    const directive = getDirective(council.id);
    const output = getLatestOutput(council.id);
    const decision = getDecision(council.id);

    if (!directive || !output) {
      throw new Error('Missing directive or output for review');
    }

    // Check if worker had write permissions (affects review criteria)
    const worker = this.getWorker(council);
    const workerAssignment = getRoleAssignment(council, worker.id);
    const hasWritePermissions = this.effectiveWrite(workerAssignment, council.deliberation?.outputType);
    const stepType = council.deliberation?.stepType;

    // FINAL VERIFICATION before any LLM review: the orchestrator runs the verify
    // command itself (the worker's own "**Verification:** exit 0" is not trusted).
    // A failure skips the manager call entirely — the verdict is a mechanical
    // `revise` whose feedback is the real test tail (honours maxRevisions).
    // WORKER-INITIATED RE-DELIBERATION: a worker that reports `**Status:** Blocked`
    // is not reviewed on quality — the manager re-plans (once) via the existing
    // re_deliberate branch; after that budget it must deliver its best effort,
    // and if the revision budget is spent too the council FAILS honestly.
    const latestWork = getLatestOfType(council.id, 'work_output');
    const workerSignals = (latestWork?.structured as { signals?: { status?: string; blockedReason?: string } } | undefined)?.signals;
    const blocked = workerSignals?.status === 'blocked';
    const blockedReason = workerSignals?.blockedReason || 'Worker reported being blocked';

    const verification = !blocked && hasWritePermissions ? await this.runFinalVerification(council, 'reviewing') : undefined;

    let review: ManagerReview;
    let entry: LedgerEntry;
    if (blocked) {
      const reDelibCount = council.deliberationState?.reDeliberationCount || 0;
      const revisionCount = council.deliberationState?.revisionCount || 0;
      const maxRevisions = council.deliberation?.maxRevisions ?? 3;
      if (reDelibCount < 1) {
        review = {
          verdict: 're_deliberate',
          reasoning: `Worker reported being BLOCKED: ${blockedReason}`,
          newInformation: `The worker could not carry out the directive. Blocked reason: ${blockedReason}\n\nRe-plan around this obstacle (a different approach, a narrower scope, or different tooling) and issue a directive the worker can actually execute.`,
        };
      } else if (revisionCount >= maxRevisions) {
        this.createEntry(council.id, 'manager', manager.id, 'error', 'reviewing',
          `Worker still BLOCKED after re-deliberation and ${revisionCount} revision(s): ${blockedReason}`, 0, 0,
          undefined, undefined, { blockedReason });
        councilStore.updateDeliberationState(council.id, { completionSummary: `Worker blocked: ${blockedReason}` });
        this.transitionPhase(council.id, 'failed');
        councilStore.setStatus(council.id, 'resolved');
        throw new Error(`Worker blocked after re-deliberation: ${blockedReason}`);
      } else {
        review = {
          verdict: 'revise',
          reasoning: `Worker blocked again after re-deliberation (${blockedReason}); re-deliberation budget exhausted.`,
          feedback: `You reported being blocked: ${blockedReason}. The re-deliberation budget is exhausted. Deliver your BEST EFFORT now: complete every part that IS possible, list precisely what remains blocked and why, and state what would unblock it.`,
        };
      }
      entry = this.createEntry(
        council.id, 'manager', manager.id, 'review', 'reviewing',
        `Verdict: ${review.verdict}\n\n${review.reasoning}`,
        0, 0, undefined, undefined, { automatic: true, blockedReason }, undefined, review.verdict
      );
    } else if (verification && !verification.passed) {
      review = {
        verdict: 'revise',
        reasoning: `Verification command \`${verification.command}\` failed with exit code ${verification.exitCode}.`,
        feedback: `The verification command \`${verification.command}\` FAILED (exit code ${verification.exitCode}). Fix the cause so it exits 0, then re-run it yourself and report the real result.\n\nOutput tail:\n${verification.tail || '(no output)'}`,
      };
      entry = this.createEntry(
        council.id, 'manager', manager.id, 'review', 'reviewing',
        `Verdict: revise\n\n${review.reasoning}\n\nFeedback: ${review.feedback}`,
        0, 0, undefined, undefined, { verification: { exitCode: verification.exitCode, command: verification.command }, automatic: true }, undefined, 'revise'
      );
    } else {
      // Collect consultant reviews first
      const consultantReviews = await this.collectConsultantReviews(council);

      // Build prompts per Section 9.8
      const systemPrompt = manager.predisposition.systemPrompt;
      const expectedOutput = council.deliberation?.expectedOutput;
      // Worktree mode: the manager reviews the real DIFF, not the worker's account.
      let diffText: string | undefined;
      if (this.config.codebase && this.config.runCommand && hasWritePermissions) {
        try {
          const d = await collectDiff(this.config.runCommand, this.config.codebase.worktreePath, this.config.codebase.baseSha);
          diffText = d.diff.trim() ? d.diff : '(no changes in the repository)';
        } catch (err) { console.warn('[Orchestrator] collectDiff failed:', err); }
      }
      const userMessage = buildManagerReviewPrompt(
        output.content,
        directive.content,
        decision?.acceptanceCriteria,
        expectedOutput,
        hasWritePermissions,
        stepType,
        consultantReviews,
        verification ? `PASSED — the orchestrator ran \`${verification.command}\` and it exited 0.` : undefined,
        diffText,
      );

      const response = await this.invokeAgentSafe(
        { personaId: manager.id, systemPrompt, userMessage },
        manager,
        'review'
      );

      // Parse review
      review = this.parseManagerReview(response.content);

      // Create ledger entry
      entry = this.createEntry(
        council.id,
        'manager',
        manager.id,
        'review',
        'reviewing',
        response.content,
        response.tokensUsed,
        response.latencyMs,
        undefined,
        undefined,
        response.structured,
        undefined,
        review.verdict
      );
    }

    // Handle verdict
    if (review.verdict === 'accept') {
      this.transitionPhase(council.id, 'completed');
      councilStore.setStatus(council.id, 'resolved');
    } else if (review.verdict === 'revise') {
      const revisionCount = council.deliberationState?.revisionCount || 0;
      const maxRevisions = council.deliberation?.maxRevisions ?? 3;

      if (revisionCount >= maxRevisions) {
        // Max revisions reached - complete with best effort
        this.transitionPhase(council.id, 'completed');
        councilStore.setStatus(council.id, 'resolved');
      } else {
        // Request revision
        if (review.feedback) {
          // A verification-driven send-back is tagged so requestRevision issues a
          // `fix` order (robust against same-millisecond timestamps).
          const fromVerification = !!(verification && !verification.passed);
          this.createEntry(
            council.id,
            'manager',
            manager.id,
            'revision_request',
            'reviewing',
            review.feedback,
            0, 0, undefined, undefined,
            fromVerification ? { fromVerification: true, verification: { exitCode: verification!.exitCode, command: verification!.command } } : undefined
          );
        }
        councilStore.incrementRevisionCount(council.id);
        this.transitionPhase(council.id, 'revising');
      }
    } else if (review.verdict === 're_deliberate') {
      // Start new deliberation round with new information
      let newContextVersion: number | undefined;

      if (review.newInformation) {
        // Add new information to context
        const currentContext = getCurrentContext(council.id);
        if (currentContext) {
          const updatedContext = createContextVersion(
            council.id,
            `${currentContext.content}\n\n[New Information from Review]:\n${review.newInformation}`,
            'New information emerged during review - re-deliberation required',
            'manager',
            manager.id
          );
          newContextVersion = updatedContext.version;

          // Update council's active context reference
          councilStore.setActiveContext(council.id, updatedContext.id, updatedContext.version);
        }
      }

      // Write ledger entry for re-deliberation decision
      this.createEntry(
        council.id,
        'manager',
        manager.id,
        're_deliberation',
        'reviewing',
        `Re-deliberation requested: ${review.reasoning || 'New information requires additional deliberation'}${
          review.newInformation ? `\n\nNew information:\n${review.newInformation}` : ''
        }${newContextVersion ? `\n\n[Context updated to version ${newContextVersion}]` : ''}`,
        0, 0
      );

      councilStore.advanceRound(council.id);
      this.transitionPhase(council.id, 'round_interactive');
    }

    return { entry, review };
  }

  /**
   * Worker revises output based on feedback
   */
  async requestRevision(council: Council): Promise<LedgerEntry> {
    this.validatePhase(council, 'revising');
    const worker = this.getWorker(council);
    const directive = getDirective(council.id);
    const previousOutput = getLatestOutput(council.id);

    // Get latest revision request
    const revisionRequest = getLatestOfType(council.id, 'revision_request');

    if (!directive || !previousOutput || !revisionRequest) {
      throw new Error('Missing directive, previous output, or revision feedback');
    }

    // Get role assignment for suppress check
    const assignment = getRoleAssignment(council, worker.id);
    const suppressPersona = assignment?.suppressPersona !== false;

    // Build worker permissions from role assignment + deliberation config
    const workerPermissions: WorkerPermissions = await this.withVerify(council, {
      writePermissions: this.effectiveWrite(assignment, council.deliberation?.outputType),
      workingDirectory: this.workDir(council),
      directoryConstrained: council.deliberation?.directoryConstrained,
    });

    // Build prompts per Section 9.7.1
    const stepType = council.deliberation?.stepType;
    const systemPrompt = suppressPersona
      ? getMinimalWorkerSystemPrompt(workerPermissions, stepType)
      : worker.predisposition.systemPrompt;

    // incrementRevisionCount already ran in reviewWork → this is attempt revisionCount+1.
    const revisionCount = council.deliberationState?.revisionCount || 0;
    const maxRevisions = council.deliberation?.maxRevisions ?? 3;
    const lastTest = getLatestOfType(council.id, 'test_result');
    const isFix = !!lastTest && (revisionRequest.structured as { fromVerification?: boolean } | undefined)?.fromVerification === true;
    const order = this.composeWorkOrder(council, assignment, workerPermissions, directive.content, {
      number: revisionCount + 1, max: maxRevisions + 1, mode: isFix ? 'fix' : 'revise',
      previousOutput: previousOutput.content, feedback: revisionRequest.content,
    }, { lastTestTail: isFix ? lastTest!.content : undefined });
    const userMessage = buildWorkerRevisionPrompt(
      order,
      previousOutput.content,
      revisionRequest.content,
      workerPermissions,
      stepType,
    );

    let response = await this.invokeAgentSafe(
      { personaId: worker.id, systemPrompt, userMessage },
      worker,
      'revision'
    );

    ({ response } = await this.handleWorkerSignals(council, worker, systemPrompt, response, (qa) =>
      buildWorkerRevisionPrompt(
        this.composeWorkOrder(council, assignment, workerPermissions, directive.content, {
          number: revisionCount + 1, max: maxRevisions + 1, mode: 'answer',
          previousOutput: previousOutput.content, feedback: revisionRequest.content,
        }, { qa, lastTestTail: isFix ? lastTest!.content : undefined }),
        previousOutput.content, revisionRequest.content, workerPermissions, stepType,
      ), 'revision', 'revising'));

    // Create revision output
    const output = createRevisionOutput(
      council.id,
      response.content,
      directive.id,
      previousOutput.id
    );

    // Update state
    councilStore.setCurrentOutput(council.id, output.id);

    // Create ledger entry
    const signals = parseWorkerSignals(response.content);
    const entry = this.createEntry(
      council.id,
      'worker',
      worker.id,
      'work_output',
      'revising',
      response.content,
      response.tokensUsed,
      response.latencyMs,
      [{ artifactType: 'output', artifactId: output.id, version: output.version }],
      undefined,
      { ...response.structured, signals: signalsForLedger(signals) }
    );

    // Evolve context with revision results
    this.appendToContext(council.id, 'Worker Revision', worker.name, response.content, 'worker', worker.id);

    this.transitionPhase(council.id, 'reviewing');
    return entry;
  }

  // ==========================================================================
  // Direct Execution (0 managers — worker-only council)
  // ==========================================================================

  /**
   * Run direct execution: worker executes the raw input directly.
   * No manager framing, no deliberation, no review.
   * Used when a council has only worker(s) and no manager.
   */
  async runDirectExecution(council: Council, rawProblem: string): Promise<void> {
    this.activeCouncilId = council.id;
    const workers = getPersonaByRole(council, 'worker');
    if (workers.length === 0) {
      throw new Error('No workers assigned for direct execution');
    }

    const worker = workers[0];
    const assignment = getRoleAssignment(council, worker.id);
    const suppressPersona = assignment?.suppressPersona !== false;

    // Bootstrap directory context if enabled
    let enrichedProblem = rawProblem;
    if (council.deliberation?.bootstrapContext && this.workDir(council)) {
      try {
        const dirContext = await bootstrapDirectoryContext(this.workDir(council)!);
        if (dirContext) {
          enrichedProblem = `${dirContext}\n\n---\n\n${rawProblem}`;
        }
      } catch (error) {
        console.warn('[Orchestrator] Directory context bootstrap failed:', error);
      }
    }

    // Create a synthetic directive from the raw input
    this.transitionPhase(council.id, 'executing');

    const directive = createDirective(council.id, enrichedProblem, 'direct-execution');
    councilStore.setWorkDirective(council.id, directive.id);

    this.createEntry(
      council.id,
      'worker',
      worker.id,
      'work_directive',
      'executing',
      enrichedProblem,
      0, 0,
      [{ artifactType: 'directive', artifactId: directive.id }]
    );

    // Build worker permissions
    const workerPermissions: WorkerPermissions = await this.withVerify(council, {
      writePermissions: this.effectiveWrite(assignment, council.deliberation?.outputType),
      workingDirectory: this.workDir(council),
      directoryConstrained: council.deliberation?.directoryConstrained,
    });

    const stepType = council.deliberation?.stepType;
    const systemPrompt = suppressPersona
      ? getMinimalWorkerSystemPrompt(workerPermissions, stepType)
      : worker.predisposition.systemPrompt;

    // The work order (the raw problem IS the directive here) + subagent fan-out
    // (static + dynamic) on the direct-execution path too. Source is omitted:
    // the directive already holds the whole problem.
    const mkOrder = (qa?: WorkOrderQA[]) => buildWorkOrder({
      objective: { task: this.config.brief?.task, stepName: this.config.brief?.stepName, stepType: this.config.brief?.stepType ?? stepType },
      deliverable: { outputType: council.deliberation?.outputType, expectedOutput: council.deliberation?.expectedOutput },
      acceptance: { decisionCriteria: council.deliberation?.decisionCriteria },
      directive: this.config.brief?.task ? stripTaskPrefix(enrichedProblem, this.config.brief.task) || enrichedProblem : enrichedProblem,
      constraints: {
        writePermissions: !!workerPermissions.writePermissions,
        toolScope: this.toolScopeFor(assignment, !!workerPermissions.writePermissions),
        workingDirectory: workerPermissions.workingDirectory,
        directoryConstrained: workerPermissions.directoryConstrained,
        maxWords: council.deliberation?.maxWordsPerResponse || undefined,
        timeoutMinutes: 30,
        codebase: workerPermissions.codebase,
      },
      verification: workerPermissions.verifyCommand ? { command: workerPermissions.verifyCommand, maxTries: workerPermissions.verifyMaxTries ?? 3 } : undefined,
      attempt: { number: 1, max: 1, mode: qa?.length ? 'answer' : 'execute', qa },
      inputs: this.config.brief?.inputs,
      seatBrief: this.config.seatBriefs?.worker,
    });
    const order = mkOrder();
    const effectiveProblem = await this.runSubagents(council, worker, order);
    const findingsSuffix = effectiveProblem.slice(order.length);
    const userMessage = buildWorkerExecutionPrompt(effectiveProblem, workerPermissions, stepType);

    let response = await this.invokeAgentSafe(
      { personaId: worker.id, systemPrompt, userMessage },
      worker,
      'execution'
    );

    // Ask-back (no manager here → human hook → auto answer).
    ({ response } = await this.handleWorkerSignals(council, worker, systemPrompt, response, (qa) =>
      buildWorkerExecutionPrompt(mkOrder(qa) + findingsSuffix, workerPermissions, stepType), 'execution', 'executing'));

    // Manager-less + blocked: nobody can re-plan, so fail HONESTLY (the executor
    // turns a failed council into a failed step) instead of completing with a
    // "I could not do this" deliverable.
    const directSignals = parseWorkerSignals(response.content);
    if (directSignals.status === 'blocked') {
      const reason = directSignals.blockedReason || 'Worker reported being blocked';
      this.createEntry(council.id, 'worker', worker.id, 'work_output', 'executing', response.content,
        response.tokensUsed, response.latencyMs, undefined, undefined, { ...response.structured, signals: signalsForLedger(directSignals) });
      this.createEntry(council.id, 'worker', worker.id, 'error', 'executing',
        `Worker BLOCKED (no manager to re-plan): ${reason}`, 0, 0, undefined, undefined, { blockedReason: reason });
      councilStore.updateDeliberationState(council.id, { completionSummary: `Worker blocked: ${reason}` });
      this.transitionPhase(council.id, 'failed');
      councilStore.setStatus(council.id, 'resolved');
      throw new Error(`Worker blocked: ${reason}`);
    }

    // Manager-less final verification: run the verify command ourselves; on
    // failure give the worker bounded fix attempts (maxRevisions) with the tail.
    if (workerPermissions.verifyCommand) {
      const maxFix = council.deliberation?.maxRevisions ?? 0;
      for (let fix = 0; ; fix++) {
        const v = await this.runFinalVerification(council, 'executing');
        if (!v || v.passed || fix >= maxFix) {
          if (v && !v.passed) console.warn(`[Orchestrator] Direct execution: verification still failing (exit ${v.exitCode}) after ${fix} fix attempt(s)`);
          break;
        }
        const fixOrder = buildWorkOrder({
          objective: { task: this.config.brief?.task, stepName: this.config.brief?.stepName, stepType: this.config.brief?.stepType ?? stepType },
          deliverable: { outputType: council.deliberation?.outputType, expectedOutput: council.deliberation?.expectedOutput },
          acceptance: {},
          directive: enrichedProblem,
          constraints: { writePermissions: true, toolScope: 'full', workingDirectory: workerPermissions.workingDirectory, directoryConstrained: workerPermissions.directoryConstrained, codebase: workerPermissions.codebase },
          verification: { command: v.command, maxTries: workerPermissions.verifyMaxTries ?? 3, lastOutputTail: v.tail },
          attempt: { number: fix + 2, max: maxFix + 1, mode: 'fix', previousOutput: response.content, feedback: `The verification command \`${v.command}\` failed with exit code ${v.exitCode}. Fix the cause and re-run it.` },
        });
        response = await this.invokeAgentSafe(
          { personaId: worker.id, systemPrompt, userMessage: buildWorkerExecutionPrompt(fixOrder, workerPermissions, stepType) },
          worker,
          'revision'
        );
      }
    }

    // Create output artifact
    const output = createOutput(council.id, workerPermissions.writePermissions ? response.content : sanitizeDeliverable(response.content), directive.id);
    councilStore.setCurrentOutput(council.id, output.id);

    const signals = parseWorkerSignals(response.content);
    this.createEntry(
      council.id,
      'worker',
      worker.id,
      'work_output',
      'executing',
      response.content,
      response.tokensUsed,
      response.latencyMs,
      [{ artifactType: 'output', artifactId: output.id, version: output.version }],
      undefined,
      { ...response.structured, signals: signalsForLedger(signals) }
    );

    // No review — first output is accepted
    councilStore.updateDeliberationState(council.id, { completionSummary: response.content });
    this.transitionPhase(council.id, 'completed');
    councilStore.setStatus(council.id, 'resolved');

    console.log('[Orchestrator] Direct execution completed');
  }

  // ==========================================================================
  // Control Operations
  // ==========================================================================

  /**
   * Pause deliberation
   */
  async pause(council: Council): Promise<void> {
    const currentPhase = council.deliberationState?.currentPhase;
    if (!currentPhase || PHASE_TRANSITIONS[currentPhase].terminal) {
      throw new Error('Cannot pause - deliberation is in terminal state');
    }

    councilStore.setDeliberationPhase(council.id, 'paused', currentPhase);
    councilStore.setStatus(council.id, 'paused');
  }

  /**
   * Resume deliberation
   */
  async resume(council: Council): Promise<void> {
    if (council.deliberationState?.currentPhase !== 'paused') {
      throw new Error('Council is not paused');
    }

    const previousPhase = council.deliberationState.previousPhase;
    if (!previousPhase) {
      throw new Error('No previous phase to resume from');
    }

    councilStore.setDeliberationPhase(council.id, previousPhase);
    councilStore.setStatus(council.id, 'active');
  }

  /**
   * Cancel and force decision
   */
  async cancelAndForceDecision(council: Council): Promise<LedgerEntry> {
    const manager = this.getManager(council);

    // Create cancellation entry
    this.createEntry(
      council.id,
      'manager',
      manager.id,
      'cancellation',
      council.deliberationState?.currentPhase || 'created',
      'Deliberation ended early by user - forcing decision',
      0, 0
    );

    // Build forced decision context per Section 9.9
    const contextContent = this.buildForcedDecisionContext(council);

    const systemPrompt = manager.predisposition.systemPrompt;
    const stepType = council.deliberation?.stepType;
    const userMessage = buildManagerForcedDecisionPrompt(contextContent, stepType);

    const response = await this.invokeAgentSafe(
      { personaId: manager.id, systemPrompt, userMessage },
      manager,
      'forced_decision'
    );

    // Create decision artifact
    const context = getCurrentContext(council.id);
    const decision = createDecision(
      council.id,
      response.content,
      context?.version || 1
    );

    councilStore.setFinalDecision(council.id, decision.id);

    const entry = this.createEntry(
      council.id,
      'manager',
      manager.id,
      'decision',
      'deciding',
      response.content,
      response.tokensUsed,
      response.latencyMs,
      [{ artifactType: 'decision', artifactId: decision.id }],
      undefined,
      response.structured
    );

    // Continue with normal flow
    this.transitionPhase(council.id, 'directing');

    return entry;
  }

  /**
   * Abort deliberation
   */
  async abort(council: Council): Promise<void> {
    const manager = this.getManager(council);

    this.createEntry(
      council.id,
      'manager',
      manager.id,
      'cancellation',
      council.deliberationState?.currentPhase || 'created',
      'Deliberation aborted by user',
      0, 0
    );

    this.transitionPhase(council.id, 'cancelled');
    councilStore.setStatus(council.id, 'resolved');
  }

  // ==========================================================================
  // Context Builders
  // ==========================================================================

  /**
   * Build context for Round 1 (independent analysis) - Section 9.2
   * ONLY context artifact, no other consultant output
   */
  buildRound1Context(council: Council): string {
    const context = getCurrentContext(council.id);
    if (!context) {
      throw new Error('No context found');
    }
    return `SHARED CONTEXT (v${context.version}):\n${context.content}`;
  }

  /**
   * Build context for Round 2+ (interactive deliberation) - Section 9.3
   * Context artifact + prior rounds (full or summarized) + manager notes
   * When includeCurrentRound is true (sequential mode), appends current round
   * entries so later consultants can see earlier consultants' contributions.
   */
  buildRoundNContext(council: Council, includeCurrentRound: boolean = false): string {
    const context = getCurrentContext(council.id);
    if (!context) {
      throw new Error('No context found');
    }

    let result = `SHARED CONTEXT (v${context.version}):\n${context.content}\n\n---\n`;

    const currentRound = council.deliberationState?.currentRound || 1;
    const useSummaries = this.shouldSummarize(council);
    const roundSummaries = council.deliberationState?.roundSummaries || {};

    if (useSummaries) {
      // OLD rounds: summaries only
      for (let r = 1; r < currentRound - 1; r++) {
        const summary = roundSummaries[r];
        if (summary) {
          result += `\nROUND ${r} SUMMARY:\n${summary}\n`;
        }
      }

      // MOST RECENT prior round: full entries
      if (currentRound > 1) {
        const recentEntries = getEntriesForRound(council.id, currentRound - 1);
        result += `\nROUND ${currentRound - 1}:\n`;
        result += formatEntriesForContext(recentEntries);
      }
    } else {
      // ALL prior rounds: full entries
      for (let r = 1; r < currentRound; r++) {
        const roundEntries = getEntriesForRound(council.id, r);
        result += `\nROUND ${r}:\n`;
        result += formatEntriesForContext(roundEntries);
      }
    }

    // Manager notes: ALWAYS full, NEVER summarized
    const managerNotes = getManagerNotes(council.id, currentRound);
    if (managerNotes.length > 0) {
      result += `\n---\nMANAGER NOTES:\n`;
      result += formatEntriesForContext(managerNotes);
    }

    // In sequential mode, include current round entries so later consultants
    // can see what earlier consultants said in this round
    if (includeCurrentRound) {
      const currentRoundEntries = getEntriesForRound(council.id, currentRound);
      // Only include consultant entries (not manager entries which are from previous evaluation)
      const consultantEntries = currentRoundEntries.filter(e => e.authorRole === 'consultant');
      if (consultantEntries.length > 0) {
        result += `\n---\nCURRENT ROUND (so far):\n`;
        result += formatEntriesForContext(consultantEntries);
      }
    }

    return result;
  }

  /**
   * Build context for Manager evaluation - Section 9.4
   * Uses summaries for older rounds to keep token usage manageable.
   * Manager sees: shared context + summarised old rounds + full current round.
   */
  buildManagerEvalContext(council: Council): string {
    const context = getCurrentContext(council.id);
    const currentRound = council.deliberationState?.currentRound || 1;
    const roundSummaries = council.deliberationState?.roundSummaries || {};

    let result = `SHARED CONTEXT (v${context?.version || 1}):\n${context?.content || ''}\n\n---\n`;

    // For rounds 1-2 send full history (not much to summarize yet)
    // For rounds 3+ use summaries for older rounds, full for recent 2 rounds
    if (currentRound <= 2) {
      for (let r = 1; r <= currentRound; r++) {
        const roundEntries = getEntriesForRound(council.id, r);
        if (roundEntries.length > 0) {
          result += `\nROUND ${r}:\n`;
          result += formatEntriesForContext(roundEntries);
        }
      }
    } else {
      // Old rounds: summaries (rounds 1 to currentRound-2)
      for (let r = 1; r <= currentRound - 2; r++) {
        const summary = roundSummaries[r];
        if (summary) {
          result += `\nROUND ${r} SUMMARY:\n${summary}\n`;
        } else {
          // No summary available yet — use full entries as fallback
          const roundEntries = getEntriesForRound(council.id, r);
          result += `\nROUND ${r}:\n`;
          result += formatEntriesForContext(roundEntries);
        }
      }

      // Recent 2 rounds: full entries (manager needs detail for evaluation)
      for (let r = Math.max(1, currentRound - 1); r <= currentRound; r++) {
        const roundEntries = getEntriesForRound(council.id, r);
        if (roundEntries.length > 0) {
          result += `\nROUND ${r}:\n`;
          result += formatEntriesForContext(roundEntries);
        }
      }
    }

    // Manager notes for current round only (old notes are captured in summaries)
    const managerNotes = getManagerNotes(council.id, currentRound);
    if (managerNotes.length > 0) {
      result += `\n---\nMANAGER NOTES:\n`;
      result += formatEntriesForContext(managerNotes);
    }

    return result;
  }

  /**
   * Build context for decision - Section 9.5
   * Same as manager eval context (uses summaries for older rounds).
   */
  buildDecisionContext(council: Council): string {
    return this.buildManagerEvalContext(council);
  }

  /**
   * Build context for directive - Section 9.6
   */
  buildDirectiveContext(council: Council): string {
    const decision = getDecision(council.id);
    const plan = getPlan(council.id);

    let result = `YOUR DECISION:\n${decision?.content || ''}\n`;

    if (plan) {
      result += `\nPLAN:\n${plan.content}\n`;
    }

    return result;
  }

  /**
   * Build context for Worker - Section 9.7
   * ONLY directive, no deliberation history
   */
  buildWorkerContext(council: Council): string {
    const directive = getDirective(council.id);
    return `DIRECTIVE:\n${directive?.content || ''}`;
  }

  /**
   * Build context for revision - Section 9.7.1
   */
  buildRevisionContext(council: Council): string {
    const directive = getDirective(council.id);
    const previousOutput = getLatestOutput(council.id);
    const revisionRequest = getLatestOfType(council.id, 'revision_request');

    return `DIRECTIVE:\n${directive?.content || ''}\n\nYOUR PREVIOUS OUTPUT:\n${previousOutput?.content || ''}\n\nREVISION FEEDBACK:\n${revisionRequest?.content || ''}`;
  }

  /**
   * Build context for review - Section 9.8
   */
  buildReviewContext(council: Council): string {
    const directive = getDirective(council.id);
    const output = getLatestOutput(council.id);
    const decision = getDecision(council.id);

    let result = `WORK DIRECTIVE:\n${directive?.content || ''}\n`;

    if (decision?.acceptanceCriteria) {
      result += `\nACCEPTANCE CRITERIA:\n${decision.acceptanceCriteria}\n`;
    }

    result += `\nWORKER OUTPUT:\n${output?.content || ''}`;

    return result;
  }

  /**
   * Build context for forced decision - Section 9.9
   */
  buildForcedDecisionContext(council: Council): string {
    const context = getCurrentContext(council.id);
    const entries = getAllEntries(council.id);

    let result = `SHARED CONTEXT (v${context?.version || 1}):\n${context?.content || ''}\n\n---\n`;
    result += `DELIBERATION SO FAR (incomplete):\n`;
    result += formatEntriesForContext(entries);

    return result;
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  /**
   * Determine if summarization should be used
   */
  shouldSummarize(council: Council): boolean {
    const config = council.deliberation;
    if (!config) return false;

    if (config.summaryMode === 'none') return false;

    const currentRound = council.deliberationState?.currentRound || 1;
    // Always summarize after round 1 completes (round 2+)
    if (currentRound <= 1) return false;

    // Token-based trigger: summarize when ledger exceeds 30% of budget
    const tokenCount = getLedgerTokenCount(council.id);
    if (tokenCount > config.contextTokenBudget * 0.3) return true;

    // Round-based trigger: always summarize from round 3+
    if (currentRound >= 3) return true;

    return false;
  }

  /**
   * Get the next valid phase based on current state and action
   */
  getNextPhase(
    council: Council,
    action?: 'continue' | 'decide' | 'redirect' | 'accept' | 'revise' | 're_deliberate'
  ): DeliberationPhase {
    const currentPhase = council.deliberationState?.currentPhase || 'created';
    const validNext = PHASE_TRANSITIONS[currentPhase].validNext;

    if (validNext.length === 0) {
      return currentPhase; // Terminal state
    }

    // Determine next based on action
    switch (currentPhase) {
      case 'round_waiting_for_manager':
        if (action === 'decide') return 'deciding';
        if (action === 'continue' || action === 'redirect') return 'round_interactive';
        return 'deciding';

      case 'deciding':
        return council.deliberation?.requirePlan ? 'planning' : 'directing';

      case 'reviewing':
        if (action === 'accept') return 'completed';
        if (action === 'revise') return 'revising';
        if (action === 're_deliberate') return 'round_interactive';
        return 'completed';

      default:
        return validNext[0];
    }
  }

  /**
   * Check if current phase is complete and can transition
   */
  isPhaseComplete(council: Council): boolean {
    const phase = council.deliberationState?.currentPhase;

    switch (phase) {
      case 'round_independent':
      case 'round_interactive':
        return councilStore.isRoundComplete(council.id);
      default:
        return true;
    }
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  private getManager(council: Council): Persona {
    const managers = getPersonaByRole(council, 'manager');
    if (managers.length === 0) {
      throw new Error('No manager assigned to council');
    }
    return managers[0];
  }

  private getConsultants(council: Council): Persona[] {
    return getPersonaByRole(council, 'consultant');
  }

  private getWorker(council: Council): Persona {
    const workers = getPersonaByRole(council, 'worker');
    if (workers.length === 0) {
      throw new Error('No worker assigned to council');
    }
    return workers[0];
  }

  /**
   * Whether the worker should be driven in FILE-WRITING mode vs as a text agent.
   * This is decided by the EXPECTED OUTPUT TYPE, not by provider capability — a
   * step whose output is a `string` or `json` produces a TEXT deliverable, so the
   * worker must NOT be told to "write files / explore the codebase / call
   * write_file" (that framing makes models narrate fake file creation instead of
   * producing the actual content — the "string not code" failure). Only `file`
   * and `directory` outputs are produced by writing to disk. When false, the
   * worker emits the deliverable as its reply and the output is sanitized.
   */
  private effectiveWrite(
    assignment?: { writePermissions?: boolean },
    outputType?: 'string' | 'file' | 'directory' | 'json',
  ): boolean {
    if (!assignment?.writePermissions) return false;
    // Text deliverables (string/json) and plain deliberations (no output type)
    // are never file-writing work, regardless of which model runs the worker.
    return outputType === 'file' || outputType === 'directory';
  }

  private getPersonaDisplayName(council: Council, personaId: string): string {
    const persona = council.personas.find((p) => p.id === personaId);
    return persona?.name || personaId;
  }

  private validatePhase(council: Council, expected: DeliberationPhase): void {
    // If deliberationState is undefined, treat as 'created'
    const current = council.deliberationState?.currentPhase ?? 'created';
    if (current !== expected) {
      throw new Error(`Invalid phase: expected ${expected}, got ${current}`);
    }
  }

  private transitionPhase(councilId: string, to: DeliberationPhase): void {
    const council = councilStore.get(councilId);
    const from = council?.deliberationState?.currentPhase || 'created';

    // Validate transition
    const validNext = PHASE_TRANSITIONS[from].validNext;
    if (!validNext.includes(to) && from !== 'paused') {
      console.warn(`[Orchestrator] Invalid phase transition: ${from} -> ${to}`);
    }

    councilStore.setDeliberationPhase(councilId, to, from);
    this.config.onPhaseChange?.(from, to);

    console.log(`[Orchestrator] Phase transition: ${from} -> ${to}`);
  }

  private async invokeAgentSafe(
    invocation: AgentInvocation,
    persona: Persona,
    context: string
  ): Promise<AgentResponse> {
    // Scope tool access by phase/role:
    //   Built-in tools (WebSearch, WebFetch) are always included for any tool-enabled phase.
    //   Workers (execution, revision, debug): full tools + search
    //   Planning workers: limited tools (Read, Write, Glob — save plan doc, no code editing)
    //   Consultants (independent_analysis, deliberation_response): read-only + search
    //   Reviewers (code_review): read-only + search
    //   Manager phases: no tools
    const BUILTIN_TOOLS = ['WebSearch', 'WebFetch'];
    const FULL_TOOLS = [...BUILTIN_TOOLS, 'Edit', 'Write', 'Read', 'Bash', 'Glob', 'Grep'];
    const PLAN_TOOLS = [...BUILTIN_TOOLS, 'Read', 'Write', 'Glob'];
    const READ_ONLY_TOOLS = [...BUILTIN_TOOLS, 'Read', 'Grep', 'Glob'];
    const MANAGER_TOOLS = [...BUILTIN_TOOLS, 'Read', 'Glob', 'Grep', 'Bash'];

    const council = this.activeCouncilId ? councilStore.get(this.activeCouncilId) : null;
    const stepType = council?.deliberation?.stepType;

    const workerToolPhases = ['execution', 'revision', 'debug'];
    const readOnlyToolPhases = ['independent_analysis', 'deliberation_response', 'code_review'];
    const managerToolPhases = ['problem_framing', 'directive', 'review', 'worker_question'];

    const roleAssignment = council?.deliberation?.roleAssignments
      ?.find(r => r.personaId === persona.id);

    // Effective MCP servers (intersection of step + persona), honoring role override.
    const stepServers = council?.deliberation?.allowedServerIds;
    const personaServers = roleAssignment?.allowedServerIds ?? persona.allowedServerIds;
    let effectiveServers: string[] | undefined;
    if (stepServers && personaServers) {
      effectiveServers = stepServers.filter(id => personaServers.includes(id));
    } else {
      effectiveServers = personaServers || stepServers;
    }

    // Tools are OPT-IN per role config (prevents managers/consultants from
    // "exploring"/"searching" and hallucinating tool results → off-task drift).
    // A role gets tools only when it explicitly opts in (toolAccess === 'full'),
    // a worker is granted write permissions, or it has MCP servers assigned.
    const writePermissions = !!roleAssignment?.writePermissions;
    const configGrantsTools =
      roleAssignment?.toolAccess === 'full' ||
      (workerToolPhases.includes(context) && writePermissions) ||
      (!!effectiveServers && effectiveServers.length > 0);
    // The runtime must also be able to EXECUTE tools for this provider (e.g. the
    // headless runner only runs tools via the claude/codex binaries).
    const runtimeCanExecute = this.config.canUseTools ? this.config.canUseTools(persona) : true;
    const toolsOn = roleAssignment?.toolAccess !== 'none' && configGrantsTools && runtimeCanExecute;

    console.log(`[Orchestrator:ToolAccess] persona=${persona.name} context=${context} toolAccess=${roleAssignment?.toolAccess} write=${writePermissions} grants=${configGrantsTools} runtimeOK=${runtimeCanExecute} → toolsOn=${toolsOn}`);

    if (toolsOn) {
      let allowedTools: string[];
      if (workerToolPhases.includes(context)) {
        // Rule 5: a string/json-output step is a TEXT deliverable — the worker
        // may still RESEARCH with tools, but advertising write_file for output
        // it must emit as text makes weaker models roleplay the write.
        const fileWriting = this.effectiveWrite(roleAssignment, council?.deliberation?.outputType);
        allowedTools = stepType === 'code_planning'
          ? PLAN_TOOLS
          : fileWriting ? FULL_TOOLS : READ_ONLY_TOOLS;
      } else if (readOnlyToolPhases.includes(context)) {
        allowedTools = READ_ONLY_TOOLS;
      } else if (managerToolPhases.includes(context)) {
        allowedTools = MANAGER_TOOLS;
      } else {
        allowedTools = BUILTIN_TOOLS;
      }
      const { skipTools: _drop, ...rest } = invocation;
      invocation = { ...rest, allowedTools, ...(effectiveServers ? { allowedServerIds: effectiveServers } : {}) } as AgentInvocation;
    } else {
      // No tools: drop tool advertising and hard-override any tool-encouraging
      // language in the already-built prompt so the model answers directly.
      invocation = {
        ...invocation,
        skipTools: true,
        allowedTools: undefined,
        systemPrompt: `${invocation.systemPrompt || ''}\n\n[TOOL POLICY] You have NO tools in this run. Do NOT call or simulate read_file, list_directory, run_command, web search, or any other tool, and do NOT invent their results. Work only from the information already provided and your own knowledge, and answer the task directly. Do not assume a codebase or files exist unless their contents are quoted above.`.trim(),
      };
    }

    // Inject brevity instruction if maxWordsPerResponse is configured
    const wordLimit = this.activeCouncilId
      ? councilStore.get(this.activeCouncilId)?.deliberation?.maxWordsPerResponse
      : undefined;
    if (wordLimit && wordLimit > 0) {
      invocation = {
        ...invocation,
        userMessage: invocation.userMessage +
          `\n\nIMPORTANT: Keep your response concise — aim for approximately ${wordLimit} words or fewer. Be direct and avoid unnecessary elaboration.`,
      };
    }

    // Self-improvement lessons: role-scoped notes distilled from earlier runs.
    const lessonsBlock = formatLessonsBlock(this.config.lessons, roleAssignment?.role || persona.preferredDeliberationRole);
    if (lessonsBlock) {
      invocation = { ...invocation, userMessage: invocation.userMessage + lessonsBlock };
    }
    const budgetLine = this.config.budgetLine?.();
    if (budgetLine) {
      invocation = { ...invocation, userMessage: `${invocation.userMessage}\n\n${budgetLine}` };
    }
    // Seat self-view for the MANAGER lands where it matters most — the directive
    // (the worker's brief is rendered inside the work order itself).
    if (context === 'directive' && this.config.seatBriefs?.manager) {
      invocation = { ...invocation, userMessage: `${invocation.userMessage}\n\n${this.config.seatBriefs.manager}` };
    }

    // Thread working directory from council so each invocation uses its own dir
    const councilDir = council ? this.workDir(council) : undefined;
    if (councilDir) {
      invocation = { ...invocation, workingDirectory: councilDir };
    }

    // Apply role-based default timeouts if not already set
    const DEFAULT_TIMEOUTS: Record<string, number> = {
      // Worker contexts — 30 min
      execution: 1_800_000,
      revision: 1_800_000,
      debug: 1_800_000,
      direct_execution: 1_800_000,
      // Manager contexts — 10 min
      problem_framing: 600_000,
      evaluation: 600_000,
      manager_evaluation: 600_000,
      decision: 600_000,
      forced_decision: 600_000,
      directive: 600_000,
      plan: 600_000,
      review: 600_000,
      worker_question: 600_000,
      round_summary: 600_000,
      // Consultant contexts — 10 min
      independent_analysis: 600_000,
      deliberation_response: 600_000,
      final_position: 600_000,
      consultant_review: 600_000,
    };
    invocation = { ...invocation, timeoutMs: invocation.timeoutMs ?? DEFAULT_TIMEOUTS[context] ?? 600_000 };

    // Build context inspection for this call
    const toolScope: ContextInspection['toolScope'] = invocation.skipTools ? 'none'
      : invocation.allowedTools === FULL_TOOLS ? 'full'
      : invocation.allowedTools === PLAN_TOOLS ? 'plan'
      : invocation.allowedTools === READ_ONLY_TOOLS ? 'read_only'
      : invocation.allowedTools === MANAGER_TOOLS ? 'manager'
      : invocation.allowedTools ? 'read_only' // custom list after override
      : 'none';

    const systemPromptSource = workerToolPhases.includes(context) ? 'minimal_worker'
      : readOnlyToolPhases.includes(context) && context === 'code_review' ? 'reviewer'
      : readOnlyToolPhases.includes(context) ? 'persona_predisposition'
      : 'persona_predisposition';

    const inspection = buildContextInspection({
      systemPrompt: invocation.systemPrompt,
      systemPromptSource,
      userMessage: invocation.userMessage,
      toolScope,
      toolNames: invocation.allowedTools,
      effectiveServerIds: invocation.allowedServerIds,
      wordLimitApplied: wordLimit && wordLimit > 0 ? wordLimit : undefined,
      contextTokenBudget: council?.deliberation?.contextTokenBudget,
      timeoutMs: invocation.timeoutMs,
    });

    // Retry transient errors (rate limits, overload) with exponential backoff.
    // This covers ALL roles (manager, consultant, worker) uniformly.
    // Timeout errors get 1 retry (no backoff — the timeout itself was the wait).
    const MAX_TRANSIENT_RETRIES = 5;
    const BASE_DELAY_MS = 15_000; // 15 seconds

    const sysPromptKB = (invocation.systemPrompt.length / 1024).toFixed(1);
    const userMsgKB = (invocation.userMessage.length / 1024).toFixed(1);
    const toolCount = invocation.allowedTools?.length || 0;
    console.log(
      `[Orchestrator:Call] ${persona.name} (${context}) — ` +
      `system: ${sysPromptKB}KB, user: ${userMsgKB}KB, tools: ${toolCount}, ` +
      `timeout: ${Math.round((invocation.timeoutMs || 0) / 1000)}s`
    );

    for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
      // Real cancellation: run abort ∪ this attempt's timeout, passed to the
      // invoker AND raced here (so a transport that ignores the signal still
      // returns control; no orphan retry runs concurrently with a live call).
      throwIfAborted(this.config.signal);
      const callSignal = anySignal([
        this.config.signal,
        invocation.timeoutMs ? timeoutSignal(invocation.timeoutMs, `${persona.name} (${context})`) : undefined,
      ]);
      try {
        const startedAt = Date.now();
        this.config.onAgentThinkingStart?.(persona, startedAt, invocation.userMessage);
        const onEvent = this.config.onAgentEvent ? (e: AgentStreamEvent) => this.config.onAgentEvent!(persona, e, context) : invocation.onEvent;
        const response = await raceSignal(this.config.invokeAgent({ ...invocation, signal: callSignal, onEvent }, persona), callSignal);
        this.config.onAgentThinkingEnd?.(persona);
        const callDuration = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(`[Orchestrator:Call] ${persona.name} (${context}) completed in ${callDuration}s — ${response.tokensUsed} tokens`);
        // Attach context inspection + per-call metadata (concrete model, token
        // split, attempts) to the response; createEntry lifts callMeta into the
        // ledger entry so the self-improvement loop can attribute cost/quality
        // to the model that ACTUALLY answered (routed personas resolve per call).
        const callMeta = {
          model: response.model || persona.model,
          provider: response.provider || persona.provider,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          attempts: attempt + 1,
          routed: isRoutedModel(persona.provider, persona.model),
        };
        response.structured = { ...response.structured, contextInspection: inspection, callMeta };
        return response;
      } catch (error) {
        this.config.onAgentThinkingEnd?.(persona);

        // Abort FIRST: a user cancel is never retried, whatever the message says
        // (an aborted fetch often surfaces as "terminated", which looks transient).
        if (this.isUserAbort(error)) {
          throw isAbortError(error) ? error : new AbortError(this.config.signal?.reason ?? 'Aborted');
        }

        const errMsg = error instanceof Error ? error.message : String(error);
        // Cause chains (Node fetch wraps the real network error in error.cause).
        const causeMsg = (error as any)?.cause?.message || (error as any)?.cause?.code || '';
        const full = `${errMsg} ${causeMsg}`;
        // Transient = worth retrying: rate limits, server 5xx, and network blips.
        // A single "fetch failed" must NOT kill the whole council (durability).
        const isTransient =
          /\b(429|500|502|503|504|529)\b/.test(full) ||
          /rate.?limit|overloaded|too many requests|fetch failed|networkerror|network error|socket hang up|connection (reset|refused|closed|error)|econnreset|etimedout|econnrefused|enotfound|eai_again|epipe|und_err|terminated/i.test(full);
        const isTimeout = isTimeoutError(error) || callSignal.aborted || /\btimed?\s*out\b/i.test(full);

        // Timeout: retry once, then fail
        if (isTimeout && attempt === 0) {
          const elapsedMs = invocation.timeoutMs || 0;
          console.warn(`[Orchestrator] ${persona.name} (${context}) timed out after ${Math.round(elapsedMs / 1000)}s, retrying once...`);
          this.config.onAgentTimeout?.(persona, context, elapsedMs);
          this.config.onError?.(new Error(`${persona.name} timed out — retrying`), context);
          continue; // retry once
        }

        if (isTransient && attempt < MAX_TRANSIENT_RETRIES) {
          const delayMs = BASE_DELAY_MS * Math.pow(2, attempt);
          console.warn(
            `[Orchestrator] Transient error for ${persona.name} (${context}), ` +
            `retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1}/${MAX_TRANSIENT_RETRIES}): ${errMsg}`
          );
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }

        this.config.onError?.(error as Error, context);
        throw error;
      }
    }

    // Should not reach here
    throw new Error('Unexpected: exhausted transient retry loop');
  }

  /**
   * Clean JSON artifacts from LLM responses for display.
   * LLMs sometimes respond with JSON when prompted for structured output.
   * This extracts readable text from those responses.
   */
  cleanLLMResponse(content: string): string {
    if (!content || typeof content !== 'string') return content;

    const trimmed = content.trim();

    // Try to extract JSON from various formats
    const jsonStr = this.extractJsonString(trimmed);
    if (jsonStr) {
      try {
        const parsed = JSON.parse(jsonStr);
        const formatted = this.formatParsedJson(parsed);
        if (formatted) return formatted;
      } catch {
        // Not valid JSON, fall through
      }
    }

    // Check if content is text followed by a raw JSON object at the end
    const trailingJsonMatch = trimmed.match(/^([\s\S]+?)\n\s*(\{[\s\S]*\})\s*$/);
    if (trailingJsonMatch) {
      const textPart = trailingJsonMatch[1].trim();
      try {
        JSON.parse(trailingJsonMatch[2]);
        if (textPart.length > 20) return textPart;
      } catch {
        // Not JSON, return as-is
      }
    }

    return content;
  }

  /**
   * Extract a JSON string from content that may be raw JSON, markdown-wrapped, etc.
   */
  private extractJsonString(trimmed: string): string | null {
    // Raw JSON object
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      return trimmed;
    }

    // Markdown code block: ```json\n{...}\n```
    const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?(\{[\s\S]*?\})\s*\n?```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1];
    }

    return null;
  }

  /**
   * Format a parsed JSON object into readable text.
   * Handles evaluation/review/decision structured responses.
   */
  private formatParsedJson(parsed: Record<string, unknown>): string | null {
    // Check for structured responses FIRST (action/verdict indicate eval/review)
    // These have multiple important fields that should all be shown
    if (parsed.action || parsed.verdict) {
      const parts: string[] = [];
      if (parsed.verdict && typeof parsed.verdict === 'string')
        parts.push(`Verdict: ${parsed.verdict}`);
      if (parsed.action && typeof parsed.action === 'string')
        parts.push(`Action: ${parsed.action}`);
      if (parsed.confidence != null)
        parts.push(`Confidence: ${Math.round((parsed.confidence as number) * 100)}%`);
      if (parsed.reasoning && typeof parsed.reasoning === 'string')
        parts.push(parsed.reasoning);
      if (parsed.feedback && typeof parsed.feedback === 'string')
        parts.push(`Feedback: ${parsed.feedback}`);
      if (parsed.question && typeof parsed.question === 'string')
        parts.push(`Question: ${parsed.question}`);
      if (parsed.newInformation && typeof parsed.newInformation === 'string')
        parts.push(`New information: ${parsed.newInformation}`);
      if (Array.isArray(parsed.missingInformation) && parsed.missingInformation.length)
        parts.push(`Missing: ${parsed.missingInformation.join(', ')}`);
      if (parts.length > 0) return parts.join('\n\n');
    }

    // For plain content responses, extract the main text field
    const textFields = ['reasoning', 'content', 'message', 'summary', 'analysis', 'feedback', 'explanation'];
    for (const field of textFields) {
      if (parsed[field] && typeof parsed[field] === 'string') {
        return parsed[field] as string;
      }
    }

    return null;
  }

  private createEntry(
    councilId: string,
    role: DeliberationRole,
    authorId: string,
    entryType: LedgerEntryType,
    phase: DeliberationPhase,
    content: string,
    tokensUsed: number,
    latencyMs: number,
    artifactRefs?: ArtifactRef[],
    roundNumber?: number,
    structured?: Record<string, unknown>,
    referencedEntries?: string[],
    reviewOutcome?: 'accept' | 'revise' | 're_deliberate'
  ): LedgerEntry {
    // Clean JSON artifacts from LLM responses before storing
    const cleanedContent = this.cleanLLMResponse(content);

    // Lift per-call metadata (attached by invokeAgentSafe) to top-level fields.
    const meta = (structured?.callMeta || {}) as {
      model?: string; provider?: string; inputTokens?: number; outputTokens?: number; attempts?: number; routed?: boolean;
    };

    const entry: LedgerEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      authorRole: role,
      authorPersonaId: authorId,
      entryType,
      phase,
      content: cleanedContent,
      tokensUsed,
      latencyMs,
      artifactRefs,
      roundNumber,
      referencedEntries,
      reviewOutcome,
      structured,
      ...(meta.model ? { model: meta.model } : {}),
      ...(meta.provider ? { provider: meta.provider } : {}),
      ...(meta.inputTokens != null ? { inputTokens: meta.inputTokens } : {}),
      ...(meta.outputTokens != null ? { outputTokens: meta.outputTokens } : {}),
      ...(meta.attempts != null ? { attempts: meta.attempts } : {}),
      ...(meta.routed != null ? { routed: meta.routed } : {}),
    };

    // Use ledgerStore.append to notify subscribers (enables real-time UI updates)
    ledgerStore.append(councilId, entry);
    this.config.onEntryAdded?.(entry);

    return entry;
  }

  private extractContextProposal(content: string): { diff: string; rationale: string } | null {
    const proposalMatch = content.match(/PROPOSED CONTEXT CHANGE:\s*\n*What:\s*(.+?)(?:\n+Why:\s*(.+))?$/is);

    if (proposalMatch) {
      return {
        diff: proposalMatch[1].trim(),
        rationale: proposalMatch[2]?.trim() || 'No rationale provided',
      };
    }
    return null;
  }

  /**
   * Append a summary to the shared context document when evolveContext is enabled.
   * Creates a new context version with the appended information.
   */
  private appendToContext(
    councilId: string,
    label: string,
    personaName: string,
    content: string,
    role: 'consultant' | 'worker' | 'manager',
    personaId?: string,
  ): void {
    const council = this.activeCouncilId ? councilStore.get(this.activeCouncilId) : null;
    if (!council?.deliberation?.evolveContext) return;

    const currentContext = getCurrentContext(councilId);
    if (!currentContext) return;

    // Extract a concise summary — first 2000 chars or up to COMPLETION SUMMARY
    const summaryMatch = content.match(/## COMPLETION SUMMARY[\s\S]*/i);
    const summary = summaryMatch
      ? summaryMatch[0].slice(0, 1500)
      : content.slice(0, 2000);

    const round = council.deliberationState?.currentRound || 1;
    const appendText = `\n\n---\n[Round ${round} — ${label} by ${personaName}]:\n${summary}`;

    const updated = createContextVersion(
      councilId,
      currentContext.content + appendText,
      `${label} by ${personaName} (round ${round})`,
      role,
      personaId,
      round,
    );

    councilStore.setActiveContext(councilId, updated.id, updated.version);
    console.log(`[Orchestrator] Context evolved to v${updated.version}: ${label} by ${personaName}`);
  }

  /** Heading-aware (the old regex stopped at the first blank line and lost every bullet after it). */
  private extractAcceptanceCriteria(content: string): string | undefined {
    return extractAcceptanceCriteriaSection(content);
  }

  private parseManagerEvaluation(content: string): ManagerEvaluation {
    try {
      // Try to extract JSON from the response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        // Filter patchDecisions to only include entries with valid UUID patchIds
        // (the LLM may hallucinate non-UUID strings)
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const patchDecisions = Array.isArray(parsed.patchDecisions)
          ? parsed.patchDecisions.filter(
              (d: any) => d && typeof d.patchId === 'string' && UUID_RE.test(d.patchId)
            )
          : undefined;

        return {
          action: parsed.action || 'decide',
          reasoning: parsed.reasoning || content,
          confidence: parsed.confidence ?? undefined,
          missingInformation: parsed.missingInformation ?? undefined,
          question: parsed.question ?? undefined,
          patchDecisions: patchDecisions && patchDecisions.length > 0 ? patchDecisions : undefined,
        };
      }
    } catch {
      // Fall back to text parsing
    }

    // Default interpretation from text
    const lowerContent = content.toLowerCase();
    let action: 'continue' | 'decide' | 'redirect' = 'decide';

    if (lowerContent.includes('continue') || lowerContent.includes('another round')) {
      action = 'continue';
    } else if (lowerContent.includes('redirect') || lowerContent.includes('refocus')) {
      action = 'redirect';
    }

    return {
      action,
      reasoning: content,
    };
  }

  private parseManagerReview(content: string): ManagerReview {
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          verdict: parsed.verdict || 'accept',
          reasoning: parsed.reasoning || content,
          feedback: parsed.feedback ?? undefined,
          newInformation: parsed.newInformation ?? undefined,
        };
      }
    } catch {
      // Fall back to text parsing
    }

    // Default interpretation
    const lowerContent = content.toLowerCase();
    let verdict: 'accept' | 'revise' | 're_deliberate' = 'accept';

    if (lowerContent.includes('revise') || lowerContent.includes('revision')) {
      verdict = 'revise';
    } else if (lowerContent.includes('re-deliberate') || lowerContent.includes('redeliberate')) {
      verdict = 're_deliberate';
    }

    return {
      verdict,
      reasoning: content,
    };
  }

  /**
   * Run a single consultant's contribution with retry logic.
   * Ensures every consultant gets a fair chance to contribute:
   * - 'retry' policy: retries up to maxRetries times with backoff
   * - 'skip' policy: records error and moves on
   * - 'fail' policy: fails the entire deliberation
   *
   * On final failure, records the submission anyway so the round can complete.
   */
  private async runConsultantWithRetry(
    council: Council,
    consultant: Persona,
    runFn: () => Promise<LedgerEntry>
  ): Promise<LedgerEntry | null> {
    const maxRetries = council.deliberation?.maxRetries || 2;
    const policy = council.deliberation?.consultantErrorPolicy || 'retry';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await runFn();
      } catch (error) {
        const isLastAttempt = attempt >= maxRetries || policy !== 'retry';

        console.error(
          `[Orchestrator] Consultant ${consultant.name} failed (attempt ${attempt + 1}/${maxRetries + 1}):`,
          (error as Error).message
        );

        councilStore.addError(
          council.id,
          `Consultant ${consultant.name}: ${(error as Error).message} (attempt ${attempt + 1})`
        );

        if (policy === 'fail') {
          this.transitionPhase(council.id, 'failed');
          throw error;
        }

        if (isLastAttempt) {
          // Record submission for failed consultant so the round can still complete
          councilStore.recordSubmission(council.id, consultant.id);

          // Create an error entry in the ledger so it's visible in the UI
          this.createEntry(
            council.id,
            'consultant',
            consultant.id,
            'error',
            council.deliberationState?.currentPhase || 'round_independent',
            `Failed to contribute after ${attempt + 1} attempt(s): ${(error as Error).message}`,
            0,
            0,
            undefined,
            council.deliberationState?.currentRound
          );

          return null;
        }

        // Delay before retry — longer backoff for rate limit errors
        const errMsg = (error as Error).message || '';
        const isRateLimit = /\b(429|529|rate.limit|overloaded|too many requests)\b/i.test(errMsg);
        const delayMs = isRateLimit
          ? 15_000 * Math.pow(2, attempt)  // 15s, 30s, 60s for rate limits
          : 2_000 * (attempt + 1);          // 2s, 4s, 6s for other errors
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }

    return null;
  }
}
