/**
 * Council: Coding Orchestrator
 * Structured multi-worker implementation flow for coding pipeline steps.
 *
 * Flow: spec → decompose → implement (parallel) → review → test → debug loop
 *
 * Reuses the same agent invocation, ledger, and store patterns as
 * DeliberationOrchestrator but skips consultant deliberation entirely.
 */

import type {
  Council,
  Persona,
  LedgerEntry,
  LedgerEntryType,
  DeliberationPhase,
  DeliberationRole,
  ArtifactRef,
  ReviewVerdict,
} from './types';

import {
  ledgerStore,
} from './ledger-store';

import {
  createOutput,
  getCurrentContext,
  createContextVersion,
} from './context-store';

import {
  councilStore,
  getPersonaByRole,
  getRoleAssignment,
} from './store';

import {
  buildDecompositionPrompt,
  buildModuleDirectivePrompt,
  buildCodeReviewPrompt,
  buildReviewerSystemPrompt,
  buildDebugFixPrompt,
  buildRevisionFromReviewPrompt,
  getMinimalWorkerSystemPrompt,
  type WorkerPermissions,
} from './prompts';

import { bootstrapDirectoryContext } from './context-bootstrap';
import { isRoutedModel } from '../router/profile-options';
import { formatLessonsBlock } from '../improve/lessons';
import { detectTestCommand } from '../pipeline/test-detect';
import { detectBuildCommand } from '../pipeline/build-detect';
import { detectInstallCommand } from '../pipeline/install-detect';

// ONE shared definition of the agent invocation contract (was a drifting
// private copy here that lacked allowedTools/workingDirectory/timeoutMs).
import type { AgentInvocation, AgentResponse, AgentInvoker, StepBrief } from './deliberation-orchestrator';
export type { AgentInvocation, AgentResponse, AgentInvoker } from './deliberation-orchestrator';
import { parseWorkerSignals, signalsForLedger } from './worker-signals';
import { resolveWorkerQuestion, buildWorkerQuestionAnswerPrompt, MAX_QUESTIONS_PER_PHASE, BUDGET_EXHAUSTED_ANSWER } from './ask-back';
import type { WorkerQuestionHandler } from './ask-back';
import type { WorkOrderQA } from './work-order';
import { anySignal, timeoutSignal, raceSignal, throwIfAborted, isAbortError, isTimeoutError, AbortError } from '../agent-runtime/signals';
import type { AgentStreamEvent } from '../agent-runtime/types';

export interface CodingOrchestratorConfig {
  invokeAgent: AgentInvoker;
  /** Whether this runtime can EXECUTE tools for a persona's provider (see
   *  OrchestratorConfig.canUseTools). Default true. */
  canUseTools?: (persona: Persona) => boolean;
  /** Per-run step facts from the executor (task, step name, inputs) — see OrchestratorConfig.brief. */
  brief?: StepBrief;
  /** Per-seat track record (role → text) appended to worker prompts. */
  seatBriefs?: Partial<Record<DeliberationRole, string>>;
  runCommand?: (cmd: string, cwd: string) => Promise<{ stdout: string; stderr: string; exit_code: number; success: boolean }>;
  readFile?: (path: string) => Promise<string | null>;
  /** Ask-back human hook (see OrchestratorConfig.onWorkerQuestion). */
  onWorkerQuestion?: WorkerQuestionHandler;
  askBack?: { maxQuestionsPerPhase?: number };
  /** Run-level cancellation (see OrchestratorConfig.signal). */
  signal?: AbortSignal;
  /** Live stream events per persona call (see OrchestratorConfig.onAgentEvent). */
  onAgentEvent?: (persona: Persona, event: AgentStreamEvent, context: string) => void;
  onPhaseChange?: (from: DeliberationPhase, to: DeliberationPhase) => void;
  onEntryAdded?: (entry: LedgerEntry) => void;
  onError?: (error: Error, context: string) => void;
  onAgentThinkingStart?: (persona: Persona, startedAt: number) => void;
  onAgentThinkingEnd?: (persona: Persona) => void;
  onAgentTimeout?: (persona: Persona, context: string, elapsedMs: number) => void;
  /** Self-improvement lessons (role → lines) appended to every persona's user message. */
  lessons?: Partial<Record<'all' | DeliberationRole, string[]>>;
}

// ============================================================================
// Phase Transition Table (coding-specific)
// ============================================================================

const CODING_PHASE_TRANSITIONS: Record<string, {
  validNext: DeliberationPhase[];
  terminal: boolean;
}> = {
  created:        { validNext: ['decomposing'], terminal: false },
  decomposing:    { validNext: ['implementing'], terminal: false },
  implementing:   { validNext: ['code_reviewing', 'completed', 'failed', 'cancelled'], terminal: false },
  code_reviewing: { validNext: ['implementing', 'testing', 'completed', 'failed', 'cancelled'], terminal: false },
  testing:        { validNext: ['completed', 'debugging', 'failed', 'cancelled'], terminal: false },
  debugging:      { validNext: ['testing', 'failed', 'cancelled'], terminal: false },
  completed:      { validNext: [], terminal: true },
  failed:         { validNext: [], terminal: true },
  cancelled:      { validNext: [], terminal: true },
};

// ============================================================================
// Coding Orchestrator
// ============================================================================

export class CodingOrchestrator {
  private config: CodingOrchestratorConfig;
  /** councilId → verify command (install && build && test) or null; resolved before implementation. */
  private verifyCommands = new Map<string, string | null>();
  /** Active council ID for the current workflow */
  private activeCouncilId: string | null = null;
  /** Phase-level rate limit retry count (reset per workflow start) */
  private phaseRetryCount = 0;

  constructor(config: CodingOrchestratorConfig) {
    this.config = config;
  }

  /**
   * Main entry point: run the full coding workflow.
   */
  async runCodingWorkflow(council: Council, spec: string): Promise<void> {
    console.log('[CodingOrchestrator] Starting coding workflow...');
    this.activeCouncilId = council.id;

    // Always read fresh from store
    council = councilStore.get(council.id) || council;

    const maxReviewCycles = council.deliberation?.maxReviewCycles ?? 2;
    const maxDebugCycles = council.deliberation?.maxDebugCycles ?? 5;

    let snapshotSha: string | null = null;
    this.phaseRetryCount = 0;

    const warnings: string[] = [];

    // Bootstrap directory context if enabled
    let enrichedSpec = spec;
    if (council.deliberation?.bootstrapContext && council.deliberation?.workingDirectory) {
      try {
        const dirContext = await bootstrapDirectoryContext(council.deliberation.workingDirectory);
        if (dirContext) {
          enrichedSpec = `${dirContext}\n\n---\n\n${spec}`;
        }
      } catch (error) {
        console.warn('[CodingOrchestrator] Directory context bootstrap failed:', error);
      }
    }

    try {
      // Git snapshot before any changes
      snapshotSha = await this.createGitSnapshot(council);

      // Pre-create the worker's output dir. A sandboxed CLI worker (e.g. Codex)
      // often can't mkdir it itself (the patch tool can't create missing parents,
      // and the shell may be blocked), so the write fails. We create it here via
      // the Tauri backend, which is NOT inside the CLI's sandbox.
      await this.ensureWorkspaceDir(council);

      // Phase 1: Decompose
      throwIfAborted(this.config.signal);
      this.transitionPhase(council.id, 'decomposing');
      try {
        await this.decomposeSpec(council, enrichedSpec);
      } catch (decomposeError) {
        const errMsg = (decomposeError as Error).message || String(decomposeError);
        console.error('[CodingOrchestrator] Decompose failed, using fallback single-module:', errMsg);
        warnings.push(`Decomposition failed (${errMsg}) — used raw spec as single module`);

        const manager = this.getManager(council);
        this.createEntry(
          council.id, 'manager', manager.id, 'error', 'decomposing',
          `Decomposition failed: ${errMsg}. Falling back to single-module plan.`,
          0, 0
        );

        // Fallback: single "main" module using the raw spec as the directive
        councilStore.updateDeliberationState(council.id, {
          moduleDecomposition: {
            modules: [{ name: 'main', files: [], interfaces: '', dependencies: [], directive: spec }],
            integrationNotes: '',
            testStrategy: '',
            buildCommand: '',
            installCommand: '',
          },
          moduleOutputs: {},
        });
      }

      // Phase 1.5: Consultant advisory — honour consultant role assignments even
      // in the coding flow. Assigned consultants review the decomposed plan and
      // advise; their guidance is recorded in the ledger and folded into the
      // implementation spec. No consultants → no-op.
      const guidance = await this.consultOnPlan(council, enrichedSpec);
      const implSpec = guidance
        ? `${spec}\n\n---\nCONSULTANT GUIDANCE (consider during implementation):\n${guidance}`
        : spec;

      // Resolve the verify command (install && build && test) BEFORE implementing
      // so module workers can run it themselves and iterate to green; the test
      // loop below reuses the same command as the orchestrator's final check.
      council = councilStore.get(council.id)!;
      {
        const decomposition = council.deliberationState?.moduleDecomposition;
        const installCommand = decomposition?.installCommand || await this.autoDetectInstallCommand(council);
        const buildCommand = decomposition?.buildCommand || await this.autoDetectBuildCommand(council);
        const testCommand = council.deliberation?.testCommand || await this.autoDetectTestCommand(council);
        const parts = [installCommand, buildCommand, testCommand].filter(Boolean);
        this.verifyCommands.set(council.id, parts.length > 0 ? parts.join(' && ') : null);
      }

      // Phase 2+3: Implement → Review loop
      let reviewCycleCount = 0;
      while (true) {
        throwIfAborted(this.config.signal);
        council = councilStore.get(council.id)!;

        this.transitionPhase(council.id, 'implementing');
        await this.implementModules(council, implSpec, reviewCycleCount > 0);
        council = councilStore.get(council.id)!;

        // Check if reviewer exists
        const reviewers = getPersonaByRole(council, 'reviewer');
        if (reviewers.length === 0) {
          console.log('[CodingOrchestrator] No reviewer configured — skipping code review');
          break;
        }

        this.transitionPhase(council.id, 'code_reviewing');
        let verdict: ReviewVerdict;
        try {
          verdict = await this.reviewCode(council, spec);
        } catch (reviewError) {
          if (this.isUserAbort(reviewError)) throw reviewError;
          const errMsg = (reviewError as Error).message || String(reviewError);
          console.error('[CodingOrchestrator] Review failed, skipping:', errMsg);
          warnings.push(`Code review skipped (${errMsg})`);

          const reviewers = getPersonaByRole(council, 'reviewer');
          const authorId = reviewers[0]?.id || this.getManager(council).id;
          this.createEntry(
            council.id, 'reviewer', authorId, 'error', 'code_reviewing',
            `Code review failed: ${errMsg}. Skipping review phase.`,
            0, 0
          );

          verdict = { verdict: 'pass', issues: [], summary: `Review skipped due to error: ${errMsg}` };
        }

        if (verdict.verdict === 'pass') {
          console.log('[CodingOrchestrator] Code review passed');
          break;
        }

        reviewCycleCount++;
        councilStore.updateDeliberationState(council.id, { reviewCycleCount });

        if (reviewCycleCount >= maxReviewCycles) {
          console.log(`[CodingOrchestrator] Max review cycles (${maxReviewCycles}) reached — proceeding`);
          break;
        }

        // Store formatted review issues so revision workers get clear, actionable feedback
        // instead of raw LLM output mixed with tool-use noise
        this.storeFormattedReviewFeedback(council, verdict);

        console.log(`[CodingOrchestrator] Review cycle ${reviewCycleCount}/${maxReviewCycles} — revising`);
        council = councilStore.get(council.id)!;
      }

      // Phase 4: Test loop (build + test verification) — same command the workers were told to run
      council = councilStore.get(council.id)!;
      const verifyCommand = this.verifyCommands.get(council.id) ?? null;

      if (verifyCommand) {
        let debugCycleCount = 0;
        while (true) {
          throwIfAborted(this.config.signal);
          this.transitionPhase(council.id, 'testing');
          const testResult = await this.runTests(council, verifyCommand);

          if (testResult.skipped) {
            console.warn('[CodingOrchestrator] Verification SKIPPED:', testResult.output);
            warnings.push(`Verification NOT run (${testResult.output}) — "${verifyCommand}" was never executed`);
            break;
          }
          if (testResult.passed) {
            console.log('[CodingOrchestrator] Tests passed!');
            break;
          }

          debugCycleCount++;
          councilStore.updateDeliberationState(council.id, { debugCycleCount });

          if (debugCycleCount >= maxDebugCycles) {
            console.log(`[CodingOrchestrator] Max debug cycles (${maxDebugCycles}) reached`);
            break;
          }

          console.log(`[CodingOrchestrator] Debug cycle ${debugCycleCount}/${maxDebugCycles}`);
          this.transitionPhase(council.id, 'debugging');
          try {
            await this.debugFix(council, testResult.output, spec);
          } catch (debugError) {
            if (this.isUserAbort(debugError)) throw debugError;
            const errMsg = (debugError as Error).message || String(debugError);
            console.error('[CodingOrchestrator] Debug fix failed, proceeding with current code:', errMsg);
            warnings.push(`Debug fix failed (${errMsg}) — proceeding with existing code`);

            const workers = getPersonaByRole(council, 'worker');
            const authorId = workers[0]?.id || this.getManager(council).id;
            this.createEntry(
              council.id, 'worker', authorId, 'error', 'debugging',
              `Debug fix failed: ${errMsg}. Proceeding with current code.`,
              0, 0
            );

            break;
          }
          council = councilStore.get(council.id)!;
        }
      } else {
        console.log('[CodingOrchestrator] No build or test command found — skipping verification phase');
      }

      // Phase 5: Merge outputs and complete
      council = councilStore.get(council.id)!;
      await this.mergeAndComplete(council, spec, warnings);

    } catch (error) {
      council = councilStore.get(council.id)!;
      const currentPhase = council.deliberationState?.currentPhase;

      // User abort → `cancelled` with a cancellation entry (no error, no failed).
      if (this.isUserAbort(error)) {
        if (currentPhase && !CODING_PHASE_TRANSITIONS[currentPhase]?.terminal) {
          try {
            this.createEntry(council.id, 'manager', this.getManager(council).id, 'cancellation', currentPhase, 'Coding workflow cancelled by user', 0, 0);
          } catch { /* best effort */ }
          this.transitionPhase(council.id, 'cancelled');
          councilStore.setStatus(council.id, 'resolved');
        }
        throw error;
      }

      const errMsg = (error as Error).message || String(error);
      const isRateLimit = /\b(429|rate.limit|too many requests)\b/i.test(errMsg);

      // Rate limit: wait and retry from the current phase instead of failing
      if (isRateLimit && this.phaseRetryCount < 3) {
        this.phaseRetryCount++;
        const delayMs = 120_000 * Math.pow(1.5, this.phaseRetryCount - 1);
        console.warn(
          `[CodingOrchestrator] Rate limit during ${currentPhase}, retrying in ${Math.round(delayMs / 1000)}s ` +
          `(attempt ${this.phaseRetryCount}/3)`
        );
        this.createEntry(
          council.id, 'manager', this.getManager(council).id, 'error',
          currentPhase || 'created',
          `Rate limited during ${currentPhase} — waiting ${Math.round(delayMs / 1000)}s before retrying...`,
          0, 0
        );
        await new Promise(resolve => setTimeout(resolve, delayMs));
        // Re-run from current phase — the workflow reads state from the store
        // so it will resume from where it left off
        return this.runCodingWorkflow(councilStore.get(council.id)!, spec);
      }

      console.error('[CodingOrchestrator] Workflow error:', errMsg);

      // Attribute error to the phase's active role
      try {
        const isWorkerPhase = currentPhase === 'implementing' || currentPhase === 'debugging';
        const isReviewerPhase = currentPhase === 'code_reviewing';
        const role: DeliberationRole = isWorkerPhase ? 'worker' : isReviewerPhase ? 'reviewer' : 'manager';

        let persona: Persona;
        if (isWorkerPhase) {
          const workers = getPersonaByRole(council, 'worker');
          persona = workers[0] || this.getManager(council);
        } else if (isReviewerPhase) {
          const reviewers = getPersonaByRole(council, 'reviewer');
          persona = reviewers[0] || this.getManager(council);
        } else {
          persona = this.getManager(council);
        }

        this.createEntry(
          council.id, role, persona.id, 'error',
          currentPhase || 'created',
          `Coding workflow error during ${currentPhase}: ${errMsg}`,
          0, 0
        );
      } catch { /* best effort */ }

      if (snapshotSha) {
        console.log(`[CodingOrchestrator] Pre-pipeline snapshot: ${snapshotSha}. Rollback: git reset --hard ${snapshotSha}`);
      }

      this.transitionPhase(council.id, 'failed');
      throw error;
    }
  }

  // ==========================================================================
  // Phase 1: Decompose Spec
  // ==========================================================================

  private async decomposeSpec(council: Council, spec: string): Promise<void> {
    const manager = this.getManager(council);
    const workers = getPersonaByRole(council, 'worker');
    const workerCount = Math.max(workers.length, 1);

    console.log(`[CodingOrchestrator] Decomposing spec for ${workerCount} worker(s)`);

    const systemPrompt = manager.predisposition.systemPrompt;
    const userMessage = buildDecompositionPrompt(spec, workerCount);

    const response = await this.invokeAgentSafe(
      { personaId: manager.id, systemPrompt, userMessage },
      manager,
      'decomposition'
    );

    // Parse decomposition JSON
    const decomposition = this.parseDecompositionJson(response.content);

    // Store in deliberation state
    councilStore.updateDeliberationState(council.id, {
      moduleDecomposition: decomposition,
      moduleOutputs: {},
    });

    // Create ledger entry
    this.createEntry(
      council.id, 'manager', manager.id, 'decomposition', 'decomposing',
      response.content, response.tokensUsed, response.latencyMs,
      undefined, undefined, response.structured
    );

    console.log(`[CodingOrchestrator] Decomposed into ${decomposition.modules.length} module(s):`,
      decomposition.modules.map(m => m.name));
  }

  /**
   * Consultant advisory pass — runs BEFORE implementation so a coding council
   * still honours its consultant role assignments (the worker isn't the only
   * non-manager voice). Each assigned consultant reviews the decomposed plan from
   * their perspective and returns concise guidance; their input is recorded in
   * the ledger (as a consultant 'analysis' entry under the decomposing phase) and
   * folded into the implementation spec. No-op when there are no consultants.
   */
  private async consultOnPlan(council: Council, spec: string): Promise<string> {
    const consultants = getPersonaByRole(council, 'consultant');
    if (consultants.length === 0) return '';
    console.log(`[CodingOrchestrator] Consultant advisory: ${consultants.length} consultant(s)`);

    const decomposition = councilStore.get(council.id)?.deliberationState?.moduleDecomposition;
    const planSummary = decomposition?.modules?.length
      ? `\n\nPLANNED MODULES:\n${decomposition.modules.map(m => `- ${m.name}: ${m.directive || ''}`).join('\n')}`
      : '';

    const advices: string[] = [];
    for (const consultant of consultants) {
      const systemPrompt = consultant.predisposition?.systemPrompt || '';
      const userMessage =
        `An implementation is about to begin. From your perspective, give concise, actionable guidance ` +
        `(risks, better approaches, edge cases, things to verify). Do NOT write code or call tools — advise only.\n\n` +
        `TASK:\n${spec}${planSummary}`;
      try {
        const response = await this.invokeAgentSafe(
          { personaId: consultant.id, systemPrompt, userMessage },
          consultant,
          'consultation'
        );
        this.createEntry(
          council.id, 'consultant', consultant.id, 'analysis', 'decomposing',
          response.content, response.tokensUsed, response.latencyMs,
          undefined, undefined, response.structured
        );
        if (response.content?.trim()) advices.push(`### ${consultant.name}\n${response.content.trim()}`);
      } catch (err) {
        console.warn(`[CodingOrchestrator] Consultant ${consultant.name} advisory failed:`, (err as Error).message);
      }
    }
    return advices.join('\n\n');
  }

  // ==========================================================================
  // Phase 2: Implement Modules (parallel)
  // ==========================================================================

  private async implementModules(council: Council, spec: string, isRevision: boolean): Promise<void> {
    const workers = getPersonaByRole(council, 'worker');
    if (workers.length === 0) {
      throw new Error('No workers assigned to council');
    }

    const state = council.deliberationState;
    const decomposition = state?.moduleDecomposition;
    if (!decomposition) {
      throw new Error('No module decomposition found — decompose first');
    }

    const modules = decomposition.modules;

    // Get latest review feedback if this is a revision cycle
    let reviewFeedback: string | undefined;
    let reviewIssues: ReviewVerdict['issues'] | undefined;
    if (isRevision) {
      // Find the most recent code_review entry (the formatted one carries the
      // structured issue list so each module can be sent ONLY its own issues).
      const allEntries = ledgerStore.getAll(council.id);
      const lastReview = [...allEntries].reverse().find(e => e.entryType === 'code_review');
      reviewFeedback = lastReview?.content;
      const issues = (lastReview?.structured as { issues?: ReviewVerdict['issues'] } | undefined)?.issues;
      if (Array.isArray(issues) && issues.length) reviewIssues = issues;
    }
    // Spec head + test strategy reach every module worker (the spec argument used
    // to be ignored here, so consultant guidance never reached the implementers).
    const specHead = spec.length > 6000 ? `${spec.slice(0, 6000)}\n…[spec truncated]` : spec;
    const feedbackForModule = (moduleName: string): string | undefined => {
      if (!reviewFeedback) return undefined;
      if (!reviewIssues) return reviewFeedback;
      const mine = reviewIssues.filter((i) => !i.module || i.module === 'all' || i.module.toLowerCase() === moduleName.toLowerCase());
      if (mine.length === 0) {
        return `${reviewFeedback.split('\n## Issues to Fix')[0].trim()}\n\nNo issues were filed against your module (${moduleName}); other modules are being fixed by their owners. Re-check your module's integration with theirs and only change what is needed.`;
      }
      return `## Issues to fix in YOUR module (${moduleName})\n${mine.map((i) => `- **[${i.severity.toUpperCase()}]** ${i.description}${i.suggestion ? `\n  → Fix: ${i.suggestion}` : ''}`).join('\n')}`;
    };

    // Assign modules to workers round-robin
    const assignments: Array<{ module: typeof modules[0]; worker: Persona }> = [];
    for (let i = 0; i < modules.length; i++) {
      const worker = workers[i % workers.length];
      modules[i].assignedWorkerId = worker.id;
      assignments.push({ module: modules[i], worker });
    }

    console.log(`[CodingOrchestrator] Implementing ${modules.length} module(s) with ${workers.length} worker(s) sequentially`,
      isRevision ? '(revision)' : '');

    // Run workers sequentially to avoid filesystem conflicts when multiple
    // workers have write permissions to the same working directory.
    const moduleOutputs: Record<string, string> = { ...(state?.moduleOutputs || {}) };
    let failureCount = 0;

    for (const { module, worker } of assignments) {
      try {
        const assignment = getRoleAssignment(council, worker.id);
        const suppressPersona = assignment?.suppressPersona !== false;

        const workerPermissions: WorkerPermissions = {
          writePermissions: assignment?.writePermissions,
          workingDirectory: council.deliberation?.workingDirectory,
          directoryConstrained: council.deliberation?.directoryConstrained,
          verifyCommand: assignment?.writePermissions ? (this.verifyCommands.get(council.id) || undefined) : undefined,
          verifyMaxTries: 3,
        };

        const systemPrompt = suppressPersona
          ? getMinimalWorkerSystemPrompt(workerPermissions)
          : worker.predisposition.systemPrompt;

        let userMessage: string;

        const moduleFeedback = isRevision ? feedbackForModule(module.name) : undefined;
        if (isRevision && moduleFeedback) {
          // Revision: include (per-module) review feedback + previous output
          const previousOutput = state?.moduleOutputs?.[module.name] || '';
          userMessage = buildRevisionFromReviewPrompt(
            moduleFeedback, previousOutput, module.directive, workerPermissions
          );
        } else {
          // First pass: build module directive
          const otherInterfaces = modules
            .filter(m => m.name !== module.name)
            .map(m => ({ name: m.name, interfaces: m.interfaces }));

          userMessage = buildModuleDirectivePrompt(
            module, otherInterfaces, decomposition.integrationNotes, workerPermissions,
            { specHead, testStrategy: decomposition.testStrategy, seatBrief: this.config.seatBriefs?.worker },
          );
        }

        this.config.onAgentThinkingStart?.(worker, Date.now());

        let response = await this.invokeAgentSafe(
          { personaId: worker.id, systemPrompt, userMessage },
          worker,
          'module_implementation'
        );
        response = await this.askBack(council, worker, systemPrompt, userMessage, response, 'module_implementation', 'implementing', module.directive);

        // Create ledger entry (+ parsed worker signals)
        const signals = parseWorkerSignals(response.content);
        this.createEntry(
          council.id, 'worker', worker.id,
          'module_output',
          'implementing',
          `[Module: ${module.name}]\n\n${response.content}`,
          response.tokensUsed, response.latencyMs,
          undefined, undefined, { ...response.structured, module: module.name, signals: signalsForLedger(signals) }
        );

        // Evolve context with module implementation
        this.appendToContext(council.id, `Module Implementation (${module.name})`, worker.name, response.content, 'worker', worker.id);

        moduleOutputs[module.name] = response.content;
      } catch (error) {
        if (this.isUserAbort(error)) throw error;
        failureCount++;
        console.error(`[CodingOrchestrator] Worker failed on module ${module.name}:`, error);
      }
    }

    if (failureCount === assignments.length) {
      throw new Error('All workers failed during implementation');
    }

    councilStore.updateDeliberationState(council.id, { moduleOutputs });
  }

  // ==========================================================================
  // Phase 3: Code Review
  // ==========================================================================

  private async reviewCode(council: Council, spec: string): Promise<ReviewVerdict> {
    const reviewers = getPersonaByRole(council, 'reviewer');
    if (reviewers.length === 0) {
      return { verdict: 'pass', issues: [], summary: 'No reviewer configured — auto-pass' };
    }

    const reviewer = reviewers[0];
    const state = council.deliberationState;
    const moduleOutputs = state?.moduleOutputs || {};

    const workerOutputs = Object.entries(moduleOutputs).map(
      ([moduleName, output]) => ({ moduleName, output })
    );

    if (workerOutputs.length === 0) {
      return { verdict: 'pass', issues: [], summary: 'No module outputs to review' };
    }

    const expectedOutput = council.deliberation?.expectedOutput;

    const assignment = getRoleAssignment(council, reviewer.id);
    const suppressPersona = assignment?.suppressPersona !== false;

    const systemPrompt = suppressPersona
      ? buildReviewerSystemPrompt()
      : reviewer.predisposition.systemPrompt;

    const userMessage = buildCodeReviewPrompt(spec, workerOutputs, expectedOutput);

    console.log(`[CodingOrchestrator] Reviewer ${reviewer.name} reviewing ${workerOutputs.length} module(s)`);

    const response = await this.invokeAgentSafe(
      { personaId: reviewer.id, systemPrompt, userMessage },
      reviewer,
      'code_review'
    );

    // Parse review verdict
    const verdict = this.parseReviewVerdict(response.content);

    // Create ledger entry — the parsed verdict (incl. issue severities) rides
    // `structured` so the self-improvement loop can read it without regexing prose.
    this.createEntry(
      council.id, 'reviewer', reviewer.id, 'code_review', 'code_reviewing',
      response.content, response.tokensUsed, response.latencyMs,
      undefined, undefined,
      {
        ...response.structured,
        verdict: verdict.verdict,
        issueCounts: verdict.issues.reduce<Record<string, number>>((acc, i) => {
          acc[i.severity] = (acc[i.severity] || 0) + 1; return acc;
        }, {}),
      }
    );

    // Evolve context with review findings
    this.appendToContext(council.id, 'Code Review', reviewer.name, response.content, 'consultant', reviewer.id);

    return verdict;
  }

  // ==========================================================================
  // Phase 4: Test Execution
  // ==========================================================================

  private async runTests(
    council: Council,
    testCommand: string
  ): Promise<{ passed: boolean; output: string; skipped?: boolean }> {
    const workingDir = council.deliberation?.workingDirectory;
    // No way to run the command → the verification is SKIPPED, not passed. The
    // caller records a warning so the completion summary says so honestly.
    if (!workingDir) {
      console.warn('[CodingOrchestrator] No working directory set — cannot run tests');
      return { passed: true, skipped: true, output: 'Verification skipped: no working directory configured' };
    }

    console.log(`[CodingOrchestrator] Running tests: ${testCommand} in ${workingDir}`);

    try {
      if (!this.config.runCommand) {
        console.warn('[CodingOrchestrator] No runCommand callback — cannot run tests');
        return { passed: true, skipped: true, output: 'Verification skipped: this runtime cannot run commands' };
      }
      const result = await this.config.runCommand(testCommand, workingDir);

      const output = (result.stdout + '\n' + result.stderr).trim();

      // Create ledger entry
      const manager = this.getManager(council);
      this.createEntry(
        council.id, 'manager', manager.id, 'test_result', 'testing',
        `Test command: ${testCommand}\nExit code: ${result.exit_code}\n\n${output}`,
        0, 0,
        undefined, undefined, { exitCode: result.exit_code, testCommand }
      );

      return {
        passed: result.exit_code === 0,
        output,
      };
    } catch (error) {
      const errMsg = (error as Error).message || String(error);
      console.error('[CodingOrchestrator] Test execution error:', errMsg);

      const manager = this.getManager(council);
      this.createEntry(
        council.id, 'manager', manager.id, 'test_result', 'testing',
        `Test command failed: ${testCommand}\nError: ${errMsg}`,
        0, 0,
        undefined, undefined, { exitCode: -1, testCommand, error: errMsg }
      );

      return { passed: false, output: errMsg };
    }
  }

  // ==========================================================================
  // Phase 5: Debug Fix
  // ==========================================================================

  private async debugFix(council: Council, testOutput: string, spec: string): Promise<void> {
    const workers = getPersonaByRole(council, 'worker');
    if (workers.length === 0) {
      throw new Error('No workers available for debugging');
    }

    const state = council.deliberationState;
    const decomposition = state?.moduleDecomposition;
    const moduleOutputs = { ...(state?.moduleOutputs || {}) };

    if (decomposition && decomposition.modules.length > 0) {
      // Route errors to each module's assigned worker sequentially
      for (const module of decomposition.modules) {
        const worker = workers.find(w => w.id === module.assignedWorkerId) || workers[0];
        const assignment = getRoleAssignment(council, worker.id);
        const suppressPersona = assignment?.suppressPersona !== false;

        const workerPermissions: WorkerPermissions = {
          writePermissions: assignment?.writePermissions,
          workingDirectory: council.deliberation?.workingDirectory,
          directoryConstrained: council.deliberation?.directoryConstrained,
          verifyCommand: assignment?.writePermissions ? (this.verifyCommands.get(council.id) || undefined) : undefined,
          verifyMaxTries: 3,
        };

        const systemPrompt = suppressPersona
          ? getMinimalWorkerSystemPrompt(workerPermissions)
          : worker.predisposition.systemPrompt;

        // The debugger gets the ACTUAL files on disk (not its previous prose).
        const fileContents = await this.readModuleFiles(council, module.files);
        const userMessage = buildDebugFixPrompt(
          testOutput, moduleOutputs[module.name] || '', spec,
          workerPermissions, module.name, module.files, fileContents
        );

        console.log(`[CodingOrchestrator] Worker ${worker.name} fixing module ${module.name}`);

        let response = await this.invokeAgentSafe(
          { personaId: worker.id, systemPrompt, userMessage },
          worker,
          'debug_fix'
        );
        response = await this.askBack(council, worker, systemPrompt, userMessage, response, 'debug_fix', 'debugging', `Fix the failing tests in module ${module.name}`);

        moduleOutputs[module.name] = response.content;

        const signals = parseWorkerSignals(response.content);
        this.createEntry(
          council.id, 'worker', worker.id, 'debug_fix', 'debugging',
          `[Module: ${module.name}]\n\n${response.content}`,
          response.tokensUsed, response.latencyMs,
          undefined, undefined, { ...response.structured, module: module.name, signals: signalsForLedger(signals) }
        );
      }

      councilStore.updateDeliberationState(council.id, { moduleOutputs });
    } else {
      // Fallback: single debugger (no decomposition available)
      const debugger_ = workers[0];
      const allCode = Object.entries(moduleOutputs)
        .map(([name, output]) => `=== Module: ${name} ===\n${output}`)
        .join('\n\n');

      const assignment = getRoleAssignment(council, debugger_.id);
      const suppressPersona = assignment?.suppressPersona !== false;

      const workerPermissions: WorkerPermissions = {
        writePermissions: assignment?.writePermissions,
        workingDirectory: council.deliberation?.workingDirectory,
        directoryConstrained: council.deliberation?.directoryConstrained,
        verifyCommand: assignment?.writePermissions ? (this.verifyCommands.get(council.id) || undefined) : undefined,
        verifyMaxTries: 3,
      };

      const systemPrompt = suppressPersona
        ? getMinimalWorkerSystemPrompt(workerPermissions)
        : debugger_.predisposition.systemPrompt;

      const userMessage = buildDebugFixPrompt(testOutput, allCode, spec, workerPermissions);

      console.log(`[CodingOrchestrator] Debugger ${debugger_.name} fixing test failures`);

      const response = await this.invokeAgentSafe(
        { personaId: debugger_.id, systemPrompt, userMessage },
        debugger_,
        'debug_fix'
      );

      this.createEntry(
        council.id, 'worker', debugger_.id, 'debug_fix', 'debugging',
        response.content, response.tokensUsed, response.latencyMs,
        undefined, undefined, response.structured
      );
    }
  }

  // ==========================================================================
  // Completion
  // ==========================================================================

  /**
   * Ask-back for coding workers (same ladder and ledger shape as the
   * deliberation orchestrator: manager → `onWorkerQuestion` → auto answer; the
   * question is a worker-authored `manager_question`, the answer a `response`).
   * The worker is re-invoked with the Q&A appended to its original message.
   */
  private async askBack(
    council: Council,
    worker: Persona,
    systemPrompt: string,
    baseMessage: string,
    response: AgentResponse,
    context: 'module_implementation' | 'debug_fix',
    phase: DeliberationPhase,
    directive: string,
  ): Promise<AgentResponse> {
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
        const spec = council.deliberation?.savedProblem;
        const resolved = await resolveWorkerQuestion({
          ctx: { councilId: council.id, personaId: worker.id, personaName: worker.name, question, phase: context },
          askManager: manager ? async () => {
            const r = await this.invokeAgentSafe({
              personaId: manager.id,
              systemPrompt: manager.predisposition.systemPrompt,
              userMessage: buildWorkerQuestionAnswerPrompt({ question, workerName: worker.name, directive, source: spec }),
            }, manager, 'worker_question');
            return r.content;
          } : undefined,
          onWorkerQuestion: this.config.onWorkerQuestion,
        });
        answer = resolved.answer;
        answeredBy = resolved.answeredBy;
      }
      console.log(`[CodingOrchestrator:AskBack] ${worker.name} asked (${asked + 1}); answered by ${answeredBy}`);
      this.createEntry(council.id, manager ? 'manager' : 'worker', (manager ?? worker).id, 'response', phase,
        `[Answer to ${worker.name} — ${answeredBy}] ${answer}`, 0, 0, undefined, undefined,
        { answeredBy, question, automatic: answeredBy === 'system' });
      qa.push({ question, answer, answeredBy });

      const userMessage = `${baseMessage}\n\n## ANSWERS TO YOUR QUESTIONS\n${qa.map((q) => `- Q: ${q.question}\n  A (${q.answeredBy}): ${q.answer}`).join('\n')}\n\nContinue the task now using these answers. Do not ask them again.`;
      response = await this.invokeAgentSafe({ personaId: worker.id, systemPrompt, userMessage }, worker, context);
      if (exhausted) break;
    }
    return response;
  }

  /** True for a run-level abort (not a per-call timeout). */
  private isUserAbort(error: unknown): boolean {
    return (isAbortError(error) && !isTimeoutError(error)) || !!this.config.signal?.aborted;
  }

  private async mergeAndComplete(council: Council, spec: string, warnings: string[] = []): Promise<void> {
    const state = council.deliberationState;
    const moduleOutputs = state?.moduleOutputs || {};

    // Merge all module outputs into a single output artifact
    const mergedContent = Object.entries(moduleOutputs)
      .map(([name, output]) => `## Module: ${name}\n\n${output}`)
      .join('\n\n---\n\n');

    // List the files the worker ACTUALLY produced (from git, not its prose) so the
    // final output names exactly what was made — no hunting around the folder.
    const changedFiles = await this.listChangedFiles(council);
    const filesSection = changedFiles.length
      ? `## Files produced (${changedFiles.length})\n${changedFiles.map(f => `- ${f}`).join('\n')}\n\n---\n\n`
      : '';

    // Always record whatever the worker produced as the output artifact so it's
    // inspectable either way (files-produced list first, then the merged output).
    const output = createOutput(council.id, `${filesSection}${mergedContent || '(no output)'}`, 'coding-workflow');
    councilStore.setCurrentOutput(council.id, output.id);

    // HONEST COMPLETION: don't report success when the worker produced nothing
    // usable (e.g. it was blocked by its sandbox/tooling/filesystem and narrated
    // the failure instead of delivering). Mark the council FAILED, not completed,
    // so it isn't mistaken for a successful run.
    if (Object.keys(moduleOutputs).length === 0 || this.looksLikeFailedDeliverable(mergedContent)) {
      const workers = getPersonaByRole(council, 'worker');
      const authorId = workers[0]?.id || this.getManager(council).id;
      this.createEntry(
        council.id, 'worker', authorId, 'error', 'implementing',
        `Implementation did not produce a usable deliverable — the worker reported it was blocked ` +
          `(sandbox / tooling / filesystem). Marking this council FAILED rather than completed.`,
        0, 0
      );
      let failSummary = `Coding workflow FAILED — the worker could not produce a deliverable ` +
        `(it reported being blocked by its environment/tools). Re-run with a different worker ` +
        `(e.g. an API model) or fix the environment.`;
      if (warnings.length > 0) {
        failSummary += `\n\nWarnings:\n${warnings.map(w => `- ${w}`).join('\n')}`;
      }
      councilStore.updateDeliberationState(council.id, { completionSummary: failSummary });
      this.transitionPhase(council.id, 'failed');
      councilStore.setStatus(council.id, 'resolved'); // terminal, but phase=failed signals the outcome
      console.warn('[CodingOrchestrator] Workflow marked FAILED — no usable deliverable');
      return;
    }

    // Generate completion summary, appending any warnings from recovered phases
    let summary = `Coding workflow completed. ${Object.keys(moduleOutputs).length} module(s) implemented: ${Object.keys(moduleOutputs).join(', ')}`;
    if (changedFiles.length) {
      summary += `\n\nFiles produced (${changedFiles.length}):\n${changedFiles.map(f => `- ${f}`).join('\n')}`;
    }
    if (warnings.length > 0) {
      summary += `\n\nWarnings:\n${warnings.map(w => `- ${w}`).join('\n')}`;
    }
    councilStore.updateDeliberationState(council.id, { completionSummary: summary });

    this.transitionPhase(council.id, 'completed');
    councilStore.setStatus(council.id, 'resolved');

    console.log('[CodingOrchestrator] Workflow completed successfully');
  }

  /**
   * Heuristic: did the worker self-report being BLOCKED (environment/tooling/
   * sandbox/filesystem) instead of delivering? Requires 2+ distinct strong
   * markers and a non-huge body, so a genuine deliverable that merely discusses
   * errors isn't misflagged.
   */
  private looksLikeFailedDeliverable(content: string): boolean {
    const c = (content || '').trim();
    if (c.length === 0) return true;
    const markers = [
      /\bI(?:'m| am) blocked\b/i,
      /consistently blocked/i,
      /(?:sandbox|bwrap)\b.*(?:fail|wrapper|setup|block)/i,
      /tool names? (?:are|is) not available/i,
      /patch (?:write |tool )?(?:failed|cannot|could not)/i,
      /environment-level (?:write )?setup/i,
      /cannot (?:independently )?(?:list|grep|run|create|write|mkdir)/i,
      /failed before (?:it can |)(?:run|startup|command|startup)/i,
      /could not (?:create|write|establish) (?:the |)(?:file|directory|output|path)/i,
    ];
    const hits = markers.filter((re) => re.test(c)).length;
    return hits >= 2 && c.length < 4000;
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private getManager(council: Council): Persona {
    const managers = getPersonaByRole(council, 'manager');
    if (managers.length === 0) {
      throw new Error('No manager assigned to council');
    }
    return managers[0];
  }

  private async autoDetectTestCommand(council: Council): Promise<string | null> {
    const workingDir = council.deliberation?.workingDirectory;
    if (!workingDir) return null;

    try {
      const detected = await detectTestCommand(workingDir, this.config.readFile);
      if (detected) {
        console.log(`[CodingOrchestrator] Auto-detected test command: ${detected.command} (${detected.framework})`);
        return detected.command;
      }
    } catch (error) {
      console.warn('[CodingOrchestrator] Test detection failed:', error);
    }
    return null;
  }

  private async autoDetectBuildCommand(council: Council): Promise<string | null> {
    const workingDir = council.deliberation?.workingDirectory;
    if (!workingDir) return null;

    try {
      const detected = await detectBuildCommand(workingDir, this.config.readFile);
      if (detected) {
        console.log(`[CodingOrchestrator] Auto-detected build command: ${detected.command} (${detected.framework})`);
        return detected.command;
      }
    } catch (error) {
      console.warn('[CodingOrchestrator] Build detection failed:', error);
    }
    return null;
  }

  private async autoDetectInstallCommand(council: Council): Promise<string | null> {
    const workingDir = council.deliberation?.workingDirectory;
    if (!workingDir) return null;

    try {
      const detected = await detectInstallCommand(workingDir, this.config.readFile);
      if (detected) {
        console.log(`[CodingOrchestrator] Auto-detected install command: ${detected.command} (${detected.framework})`);
        return detected.command;
      }
    } catch (error) {
      console.warn('[CodingOrchestrator] Install detection failed:', error);
    }
    return null;
  }

  /**
   * Create a git snapshot before implementation begins so the user can
   * roll back if workers destroy the codebase.
   * Returns the commit SHA, or null if not in a git repo / no runCommand.
   */
  /**
   * The files the worker actually created/modified, read from git (not the
   * worker's prose). The pre-work git snapshot means `git status --porcelain`
   * shows exactly the worker's changes (modified + added + untracked). Used to
   * name the deliverable in the final output so the user doesn't have to hunt.
   */
  private async listChangedFiles(council: Council): Promise<string[]> {
    const workingDir = council.deliberation?.workingDirectory;
    if (!workingDir || !this.config.runCommand) return [];
    try {
      const res = await this.config.runCommand('git status --porcelain', workingDir);
      const files = new Set<string>();
      for (const line of res.stdout.split('\n')) {
        const trimmed = line.replace(/\r$/, '');
        if (!trimmed.trim()) continue;
        // porcelain: "XY path" (untracked "?? path"); renames "R  old -> new".
        let path = trimmed.slice(3).trim();
        const arrow = path.indexOf(' -> ');
        if (arrow !== -1) path = path.slice(arrow + 4).trim();
        path = path.replace(/^"|"$/g, '');
        if (path) files.add(path);
      }
      return [...files].sort();
    } catch (err) {
      console.warn('[CodingOrchestrator] Could not list changed files:', (err as Error).message);
      return [];
    }
  }

  /** Ensure `<workingDir>/.kondi/workspace` exists before the worker runs. */
  private async ensureWorkspaceDir(council: Council): Promise<void> {
    const workingDir = council.deliberation?.workingDirectory;
    if (!workingDir || !this.config.runCommand) return;
    try {
      // POSIX mkdir -p; harmless no-op error on the rare Windows runner (caught).
      await this.config.runCommand('mkdir -p .kondi/workspace', workingDir);
    } catch (err) {
      console.warn('[CodingOrchestrator] Could not pre-create .kondi/workspace:', (err as Error).message);
    }
  }

  private async createGitSnapshot(council: Council): Promise<string | null> {
    const workingDir = council.deliberation?.workingDirectory;
    if (!workingDir || !this.config.runCommand) return null;

    try {
      // The working dir must be its OWN repo root, not merely inside one:
      // nearest-repo discovery otherwise adopts a PARENT project (e.g. a
      // workspace nested in the user's repo) and `git add -A` snapshots the
      // parent's ENTIRE tree into the parent's history. Same failure class as
      // the CLI path's nearest-repo escape (rule #15) — init here too.
      const top = await this.config.runCommand('git rev-parse --show-toplevel', workingDir);
      const normalize = (p: string) => p.trim().replace(/\/+$/, '');
      if (top.exit_code !== 0 || normalize(top.stdout) !== normalize(workingDir)) {
        console.log('[CodingOrchestrator] Working dir is not its own git repo — initializing for snapshot + file tracking');
        const init = await this.config.runCommand('git init -q', workingDir);
        if (init.exit_code !== 0) return null;
        // git needs an identity to commit; set a local one if missing (harmless).
        await this.config.runCommand('git config user.email kondi@local && git config user.name Kondi', workingDir);
      }

      // Stage everything and commit (allow-empty in case there are no changes)
      await this.config.runCommand('git add -A', workingDir);
      await this.config.runCommand(
        'git commit -m "kondi: pre-pipeline snapshot" --allow-empty',
        workingDir
      );

      // Capture SHA
      const shaResult = await this.config.runCommand('git rev-parse HEAD', workingDir);
      const sha = shaResult.stdout.trim();

      console.log(`[CodingOrchestrator] Git snapshot created: ${sha}`);

      // Create ledger entry
      const manager = this.getManager(council);
      this.createEntry(
        council.id, 'manager', manager.id, 'decomposition', 'decomposing',
        `Pre-pipeline git snapshot: ${sha}\nRollback: git reset --hard ${sha}`,
        0, 0
      );

      return sha;
    } catch (error) {
      console.warn('[CodingOrchestrator] Git snapshot failed:', error);
      return null;
    }
  }

  private transitionPhase(councilId: string, to: DeliberationPhase): void {
    const council = councilStore.get(councilId);
    const from = council?.deliberationState?.currentPhase || 'created';

    // Validate transition
    const rule = CODING_PHASE_TRANSITIONS[from];
    if (rule && !rule.validNext.includes(to) && to !== 'failed' && to !== 'cancelled') {
      console.warn(`[CodingOrchestrator] Unexpected phase transition: ${from} -> ${to}`);
    }

    councilStore.setDeliberationPhase(councilId, to, from);
    this.config.onPhaseChange?.(from, to);

    console.log(`[CodingOrchestrator] Phase: ${from} -> ${to}`);
  }

  private async invokeAgentSafe(
    invocation: AgentInvocation,
    persona: Persona,
    context: string
  ): Promise<AgentResponse> {
    // Scope tool access by phase:
    //   Workers (module_implementation, debug_fix): full tools
    //   Reviewers (code_review) & decomposition: read-only tools
    //   Other phases: no tools
    const BUILTIN_TOOLS = ['WebSearch', 'WebFetch'];
    const READ_ONLY_TOOLS = [...BUILTIN_TOOLS, 'Read', 'Grep', 'Glob'];

    const toolPhases = ['module_implementation', 'debug_fix'];
    const readOnlyToolPhases = ['code_review', 'decomposition'];

    // The runtime must be able to EXECUTE tools for this provider (the headless
    // CLI runner only runs tools via the claude/codex binaries) — otherwise the
    // persona would be told it has tools it can't use and narrate fake calls.
    const runtimeCanExecute = this.config.canUseTools ? this.config.canUseTools(persona) : true;

    if (!runtimeCanExecute) {
      invocation = { ...invocation, skipTools: true, allowedTools: undefined };
    } else if (toolPhases.includes(context)) {
      // Workers keep default full tool access (no change needed)
    } else if (readOnlyToolPhases.includes(context)) {
      invocation = { ...invocation, allowedTools: READ_ONLY_TOOLS, skipTools: undefined };
    } else if (!invocation.skipTools) {
      invocation = { ...invocation, skipTools: true };
    }
    console.log(`[CodingOrchestrator] invokeAgentSafe context=${context} skipTools=${invocation.skipTools} persona=${persona.name} provider=${persona.provider}`);

    // Compute effective allowed servers (intersection of step + persona)
    const council = this.activeCouncilId ? councilStore.get(this.activeCouncilId) : null;
    const stepServers = council?.deliberation?.allowedServerIds;
    const personaServers = persona.allowedServerIds;
    let effectiveServers: string[] | undefined;
    if (stepServers && personaServers) {
      effectiveServers = stepServers.filter(id => personaServers.includes(id));
    } else {
      effectiveServers = personaServers || stepServers;
    }
    if (effectiveServers) {
      invocation = { ...invocation, allowedServerIds: effectiveServers };
    }

    // Apply per-persona tool access overrides from role assignment
    const roleAssignment = council?.deliberation?.roleAssignments
      ?.find(r => r.personaId === persona.id);

    if (roleAssignment?.toolAccess === 'none') {
      invocation = { ...invocation, skipTools: true };
    } else if (roleAssignment?.toolAccess === 'full') {
      const { skipTools: _, ...rest } = invocation;
      invocation = rest as AgentInvocation;
    }

    // The runtime gate wins over any per-role "full" override: if this runtime
    // cannot execute tools for the provider, the persona gets none (final say).
    if (!runtimeCanExecute) {
      invocation = { ...invocation, skipTools: true, allowedTools: undefined };
    }

    if (roleAssignment?.allowedServerIds) {
      invocation = { ...invocation, allowedServerIds: roleAssignment.allowedServerIds };
    }

    // Inject brevity instruction if configured
    const wordLimit = (() => {
      try {
        const councils = councilStore.getAll();
        for (const c of councils) {
          if (c.personas.some(p => p.id === persona.id)) {
            return c.deliberation?.maxWordsPerResponse;
          }
        }
      } catch { /* ignore */ }
      return undefined;
    })();

    if (wordLimit && wordLimit > 0) {
      invocation = {
        ...invocation,
        userMessage: invocation.userMessage +
          `\n\nIMPORTANT: Keep your response concise — aim for approximately ${wordLimit} words or fewer.`,
      };
    }

    // Self-improvement lessons: role-scoped notes distilled from earlier runs.
    const lessonsBlock = formatLessonsBlock(this.config.lessons, roleAssignment?.role || persona.preferredDeliberationRole);
    if (lessonsBlock) {
      invocation = { ...invocation, userMessage: invocation.userMessage + lessonsBlock };
    }

    // Thread working directory from council so each invocation uses its own dir
    const councilDir = council?.deliberation?.workingDirectory;
    if (councilDir) {
      invocation = { ...invocation, workingDirectory: councilDir };
    }

    // Role-based default timeouts (the deliberation orchestrator has had these
    // for a while; the coding path previously set none, so GUI CLI workers were
    // cut off by the client's own 10-minute default mid-implementation).
    const DEFAULT_TIMEOUTS: Record<string, number> = {
      module_implementation: 1_800_000,
      debug_fix: 1_800_000,
      decomposition: 600_000,
      code_review: 600_000,
      consultation: 600_000,
    };
    invocation = { ...invocation, timeoutMs: invocation.timeoutMs ?? DEFAULT_TIMEOUTS[context] ?? 600_000 };

    // Retry transient errors (rate limits, overload) with exponential backoff.
    // This covers ALL roles (manager, worker, reviewer) uniformly.
    const MAX_TRANSIENT_RETRIES = 5;
    const BASE_DELAY_MS = 15_000; // 15 seconds

    for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
      throwIfAborted(this.config.signal);
      const callSignal = anySignal([
        this.config.signal,
        invocation.timeoutMs ? timeoutSignal(invocation.timeoutMs, `${persona.name} (${context})`) : undefined,
      ]);
      try {
        this.config.onAgentThinkingStart?.(persona, Date.now());
        const onEvent = this.config.onAgentEvent ? (e: AgentStreamEvent) => this.config.onAgentEvent!(persona, e, context) : invocation.onEvent;
        const response = await raceSignal(this.config.invokeAgent({ ...invocation, signal: callSignal, onEvent }, persona), callSignal);
        this.config.onAgentThinkingEnd?.(persona);
        // Per-call metadata for the ledger (self-improvement loop) — mirrors
        // DeliberationOrchestrator.invokeAgentSafe.
        response.structured = {
          ...response.structured,
          callMeta: {
            model: response.model || persona.model,
            provider: response.provider || persona.provider,
            inputTokens: response.inputTokens,
            outputTokens: response.outputTokens,
            attempts: attempt + 1,
            routed: isRoutedModel(persona.provider, persona.model),
          },
        };
        return response;
      } catch (error) {
        this.config.onAgentThinkingEnd?.(persona);

        // Abort FIRST — a user cancel is never retried.
        if (this.isUserAbort(error)) {
          throw isAbortError(error) ? error : new AbortError(this.config.signal?.reason ?? 'Aborted');
        }

        const errMsg = error instanceof Error ? error.message : String(error);
        const isTransient = /\b(429|529|rate.limit|overloaded|too many requests)\b/i.test(errMsg);
        const isTimeout = isTimeoutError(error) || callSignal.aborted || /\btimed?\s*out\b/i.test(errMsg);

        // Timeout: retry once (the timeout itself was the wait), then fail.
        if (isTimeout && attempt === 0) {
          console.warn(`[CodingOrchestrator] ${persona.name} (${context}) timed out after ${Math.round((invocation.timeoutMs || 0) / 1000)}s, retrying once...`);
          this.config.onAgentTimeout?.(persona, context, invocation.timeoutMs || 0);
          continue;
        }

        if (isTransient && attempt < MAX_TRANSIENT_RETRIES) {
          const delayMs = BASE_DELAY_MS * Math.pow(2, attempt);
          console.warn(
            `[CodingOrchestrator] Transient error for ${persona.name} (${context}), ` +
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
  ): LedgerEntry {
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
      content,
      tokensUsed,
      latencyMs,
      artifactRefs,
      roundNumber,
      structured,
      ...(meta.model ? { model: meta.model } : {}),
      ...(meta.provider ? { provider: meta.provider } : {}),
      ...(meta.inputTokens != null ? { inputTokens: meta.inputTokens } : {}),
      ...(meta.outputTokens != null ? { outputTokens: meta.outputTokens } : {}),
      ...(meta.attempts != null ? { attempts: meta.attempts } : {}),
      ...(meta.routed != null ? { routed: meta.routed } : {}),
    };

    ledgerStore.append(councilId, entry);
    this.config.onEntryAdded?.(entry);

    return entry;
  }

  /**
   * Append a summary to the shared context document when evolveContext is enabled.
   */
  private appendToContext(
    councilId: string,
    label: string,
    personaName: string,
    content: string,
    role: 'consultant' | 'worker' | 'manager',
    personaId?: string,
  ): void {
    const council = councilStore.get(councilId);
    if (!council?.deliberation?.evolveContext) return;

    const currentContext = getCurrentContext(councilId);
    if (!currentContext) return;

    const summaryMatch = content.match(/## COMPLETION SUMMARY[\s\S]*/i);
    const summary = summaryMatch
      ? summaryMatch[0].slice(0, 1500)
      : content.slice(0, 2000);

    const appendText = `\n\n---\n[${label} by ${personaName}]:\n${summary}`;

    const updated = createContextVersion(
      councilId,
      currentContext.content + appendText,
      `${label} by ${personaName}`,
      role,
      personaId,
    );

    councilStore.setActiveContext(councilId, updated.id, updated.version);
    console.log(`[CodingOrchestrator] Context evolved to v${updated.version}: ${label} by ${personaName}`);
  }

  private parseDecompositionJson(content: string): {
    modules: Array<{
      name: string;
      files: string[];
      interfaces: string;
      dependencies: string[];
      directive: string;
      assignedWorkerId?: string;
    }>;
    integrationNotes: string;
    testStrategy: string;
    buildCommand?: string;
    installCommand?: string;
  } {
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.modules && Array.isArray(parsed.modules)) {
          return {
            modules: parsed.modules.map((m: any) => ({
              name: m.name || 'unnamed',
              files: Array.isArray(m.files) ? m.files : [],
              interfaces: m.interfaces || '',
              dependencies: Array.isArray(m.dependencies) ? m.dependencies : [],
              directive: m.directive || '',
            })),
            integrationNotes: parsed.integrationNotes || '',
            testStrategy: parsed.testStrategy || '',
            buildCommand: parsed.buildCommand || '',
            installCommand: parsed.installCommand || '',
          };
        }
      }
    } catch (e) {
      console.warn('[CodingOrchestrator] Failed to parse decomposition JSON:', e);
    }

    // Fallback: single monolithic module
    return {
      modules: [{
        name: 'main',
        files: [],
        interfaces: '',
        dependencies: [],
        directive: content,
      }],
      integrationNotes: '',
      testStrategy: '',
      buildCommand: '',
      installCommand: '',
    };
  }

  /**
   * Write a clean, formatted ledger entry from the parsed review verdict
   * so revision workers see actionable feedback instead of raw LLM output.
   */
  private storeFormattedReviewFeedback(council: Council, verdict: ReviewVerdict): void {
    if (verdict.issues.length === 0 && !verdict.summary) return;

    const lines: string[] = [];
    lines.push(`## Code Review: ${verdict.verdict.toUpperCase()}`);
    lines.push('');
    if (verdict.summary) {
      lines.push(verdict.summary);
      lines.push('');
    }
    if (verdict.issues.length > 0) {
      lines.push('## Issues to Fix');
      for (const issue of verdict.issues) {
        lines.push(`- **[${issue.severity.toUpperCase()}] ${issue.module}**: ${issue.description}`);
        if (issue.suggestion) {
          lines.push(`  → Fix: ${issue.suggestion}`);
        }
      }
    }

    const reviewer = getPersonaByRole(council, 'reviewer')[0];
    const authorId = reviewer?.id || 'system';

    // This entry replaces the raw code_review entry as the revision worker's
    // feedback source (implementModules looks for the last code_review entry).
    // The structured issue list lets implementModules route each module ONLY
    // its own issues (the whole review used to go to every module).
    this.createEntry(
      council.id, 'reviewer', authorId, 'code_review', 'code_reviewing',
      lines.join('\n'), 0, 0,
      undefined, undefined, { verdict: verdict.verdict, issues: verdict.issues, summary: verdict.summary }
    );
  }

  /** Read a module's files from disk (capped) so the debugger sees real code, not prose. */
  private async readModuleFiles(council: Council, files: string[]): Promise<Record<string, string> | undefined> {
    const wd = council.deliberation?.workingDirectory;
    if (!this.config.readFile || !wd || files.length === 0) return undefined;
    const PER_FILE = 8_000, TOTAL = 40_000;
    const out: Record<string, string> = {};
    let used = 0;
    for (const f of files) {
      const abs = f.startsWith('/') ? f : `${wd.replace(/\/$/, '')}/${f}`;
      try {
        const content = await this.config.readFile(abs);
        if (content == null) continue;
        const cut = content.length > PER_FILE ? `${content.slice(0, PER_FILE)}\n…[truncated ${content.length - PER_FILE} chars]` : content;
        if (used + cut.length > TOTAL) break;
        out[f] = cut;
        used += cut.length;
      } catch { /* missing file — the debugger will see it is absent */ }
    }
    return Object.keys(out).length ? out : undefined;
  }

  private parseReviewVerdict(content: string): ReviewVerdict {
    // Try multiple JSON extraction strategies (tool-use output may wrap the JSON
    // in markdown fences or place it after tool-call text)
    const candidates: string[] = [];

    // Strategy 1: markdown code block ```json ... ```
    const fencedMatch = content.match(/```(?:json)?\s*\n?(\{[\s\S]*?\})\s*\n?```/);
    if (fencedMatch) candidates.push(fencedMatch[1]);

    // Strategy 2: last JSON object in the content (skip tool-use JSON earlier in the text)
    const allJsonMatches = [...content.matchAll(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g)];
    if (allJsonMatches.length > 0) {
      // Work backwards — the review JSON is typically at the end
      for (let i = allJsonMatches.length - 1; i >= 0; i--) {
        candidates.push(allJsonMatches[i][0]);
      }
    }

    // Strategy 3: greedy match (original fallback)
    const greedyMatch = content.match(/\{[\s\S]*\}/);
    if (greedyMatch) candidates.push(greedyMatch[0]);

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate);
        // Must look like a review verdict (has verdict field)
        if (parsed.verdict) {
          return {
            verdict: parsed.verdict === 'needs_revision' ? 'needs_revision' : 'pass',
            issues: Array.isArray(parsed.issues) ? parsed.issues.map((i: any) => ({
              module: i.module || 'unknown',
              severity: ['critical', 'major', 'minor'].includes(i.severity) ? i.severity : 'minor',
              description: i.description || '',
              suggestion: i.suggestion || '',
            })) : [],
            summary: parsed.summary || content,
          };
        }
      } catch {
        // Not valid JSON or wrong shape, try next candidate
      }
    }

    // Text fallback: if content mentions "needs_revision", use the full content as summary
    // so the worker at least sees the reviewer's prose
    const lower = content.toLowerCase();
    if (lower.includes('needs_revision') || lower.includes('needs revision')) {
      return { verdict: 'needs_revision', issues: [], summary: content };
    }

    return { verdict: 'pass', issues: [], summary: content };
  }
}
