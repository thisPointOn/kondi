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

import { detectTestCommand } from '../pipeline/test-detect';

// Re-use the same agent invocation types from deliberation-orchestrator
export interface AgentInvocation {
  personaId: string;
  systemPrompt: string;
  userMessage: string;
  skipTools?: boolean;
  /** Resume an existing CLI session (within a single step) */
  conversationId?: string;
  /** MCP servers this invocation can access (undefined = all servers) */
  allowedServerIds?: string[];
}

export interface AgentResponse {
  content: string;
  tokensUsed: number;
  latencyMs: number;
  structured?: Record<string, unknown>;
  /** Session ID returned by the CLI, for resuming within this step */
  sessionId?: string;
}

export type AgentInvoker = (invocation: AgentInvocation, persona: Persona) => Promise<AgentResponse>;

export interface CodingOrchestratorConfig {
  invokeAgent: AgentInvoker;
  runCommand?: (cmd: string, cwd: string) => Promise<{ stdout: string; stderr: string; exit_code: number; success: boolean }>;
  readFile?: (path: string) => Promise<string | null>;
  onPhaseChange?: (from: DeliberationPhase, to: DeliberationPhase) => void;
  onEntryAdded?: (entry: LedgerEntry) => void;
  onError?: (error: Error, context: string) => void;
  onAgentThinkingStart?: (persona: Persona) => void;
  onAgentThinkingEnd?: (persona: Persona) => void;
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
  implementing:   { validNext: ['code_reviewing', 'completed'], terminal: false },
  code_reviewing: { validNext: ['implementing', 'testing', 'completed'], terminal: false },
  testing:        { validNext: ['completed', 'debugging'], terminal: false },
  debugging:      { validNext: ['testing'], terminal: false },
  completed:      { validNext: [], terminal: true },
  failed:         { validNext: [], terminal: true },
  cancelled:      { validNext: [], terminal: true },
};

// ============================================================================
// Coding Orchestrator
// ============================================================================

export class CodingOrchestrator {
  private config: CodingOrchestratorConfig;
  /** Per-persona session IDs for conversation persistence within this step */
  private personaSessionIds: Map<string, string> = new Map();
  /** Active council ID for the current workflow */
  private activeCouncilId: string | null = null;

  constructor(config: CodingOrchestratorConfig) {
    this.config = config;
  }

  /**
   * Main entry point: run the full coding workflow.
   */
  async runCodingWorkflow(council: Council, spec: string): Promise<void> {
    console.log('[CodingOrchestrator] Starting coding workflow...');
    this.personaSessionIds.clear();
    this.activeCouncilId = council.id;

    // Always read fresh from store
    council = councilStore.get(council.id) || council;

    const maxReviewCycles = council.deliberation?.maxReviewCycles ?? 2;
    const maxDebugCycles = council.deliberation?.maxDebugCycles ?? 3;

    try {
      // Phase 1: Decompose
      this.transitionPhase(council.id, 'decomposing');
      await this.decomposeSpec(council, spec);

      // Phase 2+3: Implement → Review loop
      let reviewCycleCount = 0;
      while (true) {
        council = councilStore.get(council.id)!;

        this.transitionPhase(council.id, 'implementing');
        await this.implementModules(council, spec, reviewCycleCount > 0);
        council = councilStore.get(council.id)!;

        // Check if reviewer exists
        const reviewers = getPersonaByRole(council, 'reviewer');
        if (reviewers.length === 0) {
          console.log('[CodingOrchestrator] No reviewer configured — skipping code review');
          break;
        }

        this.transitionPhase(council.id, 'code_reviewing');
        const verdict = await this.reviewCode(council, spec);

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

        console.log(`[CodingOrchestrator] Review cycle ${reviewCycleCount}/${maxReviewCycles} — revising`);
        // Store review feedback for revision, then loop back to implementing
        council = councilStore.get(council.id)!;
      }

      // Phase 4: Test loop
      council = councilStore.get(council.id)!;
      const testCommand = council.deliberation?.testCommand || await this.autoDetectTestCommand(council);

      if (testCommand) {
        let debugCycleCount = 0;
        while (true) {
          this.transitionPhase(council.id, 'testing');
          const testResult = await this.runTests(council, testCommand);

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
          await this.debugFix(council, testResult.output, spec);
          council = councilStore.get(council.id)!;
        }
      } else {
        console.log('[CodingOrchestrator] No test command found — skipping test phase');
      }

      // Phase 5: Merge outputs and complete
      council = councilStore.get(council.id)!;
      await this.mergeAndComplete(council, spec);

    } catch (error) {
      const errMsg = (error as Error).message || String(error);
      console.error('[CodingOrchestrator] Workflow error:', errMsg);

      council = councilStore.get(council.id)!;
      const currentPhase = council.deliberationState?.currentPhase;

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
      { personaId: manager.id, systemPrompt, userMessage, skipTools: true },
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
      response.content, response.tokensUsed, response.latencyMs
    );

    console.log(`[CodingOrchestrator] Decomposed into ${decomposition.modules.length} module(s):`,
      decomposition.modules.map(m => m.name));
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
    if (isRevision) {
      // Find the most recent code_review entry
      const allEntries = ledgerStore.getAll(council.id);
      const lastReview = [...allEntries].reverse().find(e => e.entryType === 'code_review');
      reviewFeedback = lastReview?.content;
    }

    // Assign modules to workers round-robin
    const assignments: Array<{ module: typeof modules[0]; worker: Persona }> = [];
    for (let i = 0; i < modules.length; i++) {
      const worker = workers[i % workers.length];
      modules[i].assignedWorkerId = worker.id;
      assignments.push({ module: modules[i], worker });
    }

    console.log(`[CodingOrchestrator] Implementing ${modules.length} module(s) with ${workers.length} worker(s)`,
      isRevision ? '(revision)' : '');

    // Run all workers in parallel
    const results = await Promise.allSettled(
      assignments.map(async ({ module, worker }) => {
        const assignment = getRoleAssignment(council, worker.id);
        const suppressPersona = assignment?.suppressPersona !== false;

        const workerPermissions: WorkerPermissions = {
          writePermissions: assignment?.writePermissions,
          workingDirectory: council.deliberation?.workingDirectory,
          directoryConstrained: council.deliberation?.directoryConstrained,
        };

        const systemPrompt = suppressPersona
          ? getMinimalWorkerSystemPrompt(workerPermissions)
          : worker.predisposition.systemPrompt;

        let userMessage: string;

        if (isRevision && reviewFeedback) {
          // Revision: include review feedback + previous output
          const previousOutput = state?.moduleOutputs?.[module.name] || '';
          userMessage = buildRevisionFromReviewPrompt(
            reviewFeedback, previousOutput, module.directive, workerPermissions
          );
        } else {
          // First pass: build module directive
          const otherInterfaces = modules
            .filter(m => m.name !== module.name)
            .map(m => ({ name: m.name, interfaces: m.interfaces }));

          userMessage = buildModuleDirectivePrompt(
            module, otherInterfaces, decomposition.integrationNotes, workerPermissions
          );
        }

        this.config.onAgentThinkingStart?.(worker);

        const response = await this.invokeAgentSafe(
          { personaId: worker.id, systemPrompt, userMessage },
          worker,
          'module_implementation'
        );

        // Create ledger entry
        this.createEntry(
          council.id, 'worker', worker.id,
          isRevision ? 'module_output' : 'module_output',
          'implementing',
          `[Module: ${module.name}]\n\n${response.content}`,
          response.tokensUsed, response.latencyMs
        );

        return { moduleName: module.name, output: response.content };
      })
    );

    // Collect outputs
    const moduleOutputs: Record<string, string> = { ...(state?.moduleOutputs || {}) };
    for (const result of results) {
      if (result.status === 'fulfilled') {
        moduleOutputs[result.value.moduleName] = result.value.output;
      } else {
        console.error('[CodingOrchestrator] Worker failed:', result.reason);
      }
    }

    // Check if any workers failed
    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length === results.length) {
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

    // Create ledger entry
    this.createEntry(
      council.id, 'reviewer', reviewer.id, 'code_review', 'code_reviewing',
      response.content, response.tokensUsed, response.latencyMs
    );

    return verdict;
  }

  // ==========================================================================
  // Phase 4: Test Execution
  // ==========================================================================

  private async runTests(
    council: Council,
    testCommand: string
  ): Promise<{ passed: boolean; output: string }> {
    const workingDir = council.deliberation?.workingDirectory;
    if (!workingDir) {
      console.warn('[CodingOrchestrator] No working directory set — cannot run tests');
      return { passed: true, output: 'No working directory configured' };
    }

    console.log(`[CodingOrchestrator] Running tests: ${testCommand} in ${workingDir}`);

    try {
      if (!this.config.runCommand) {
        console.warn('[CodingOrchestrator] No runCommand callback — cannot run tests');
        return { passed: true, output: 'No runCommand configured' };
      }
      const result = await this.config.runCommand(testCommand, workingDir);

      const output = (result.stdout + '\n' + result.stderr).trim();

      // Create ledger entry
      const manager = this.getManager(council);
      this.createEntry(
        council.id, 'manager', manager.id, 'test_result', 'testing',
        `Test command: ${testCommand}\nExit code: ${result.exit_code}\n\n${output}`,
        0, 0
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
        0, 0
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

    const debugger_ = workers[0]; // Use first worker as debugger
    const state = council.deliberationState;
    const moduleOutputs = state?.moduleOutputs || {};

    // Collect all current code
    const allCode = Object.entries(moduleOutputs)
      .map(([name, output]) => `=== Module: ${name} ===\n${output}`)
      .join('\n\n');

    const assignment = getRoleAssignment(council, debugger_.id);
    const suppressPersona = assignment?.suppressPersona !== false;

    const workerPermissions: WorkerPermissions = {
      writePermissions: assignment?.writePermissions,
      workingDirectory: council.deliberation?.workingDirectory,
      directoryConstrained: council.deliberation?.directoryConstrained,
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

    // Create ledger entry
    this.createEntry(
      council.id, 'worker', debugger_.id, 'debug_fix', 'debugging',
      response.content, response.tokensUsed, response.latencyMs
    );
  }

  // ==========================================================================
  // Completion
  // ==========================================================================

  private async mergeAndComplete(council: Council, spec: string): Promise<void> {
    const state = council.deliberationState;
    const moduleOutputs = state?.moduleOutputs || {};

    // Merge all module outputs into a single output artifact
    const mergedContent = Object.entries(moduleOutputs)
      .map(([name, output]) => `## Module: ${name}\n\n${output}`)
      .join('\n\n---\n\n');

    // Create output artifact (uses a dummy directive ID since coding flow
    // doesn't have the traditional directive artifact)
    const output = createOutput(council.id, mergedContent, 'coding-workflow');

    councilStore.setCurrentOutput(council.id, output.id);

    // Generate completion summary
    const summary = `Coding workflow completed. ${Object.keys(moduleOutputs).length} module(s) implemented: ${Object.keys(moduleOutputs).join(', ')}`;
    councilStore.updateDeliberationState(council.id, { completionSummary: summary });

    this.transitionPhase(council.id, 'completed');
    councilStore.setStatus(council.id, 'resolved');

    console.log('[CodingOrchestrator] Workflow completed successfully');
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

  private transitionPhase(councilId: string, to: DeliberationPhase): void {
    const council = councilStore.get(councilId);
    const from = council?.deliberationState?.currentPhase || 'created';

    // Validate transition
    const rule = CODING_PHASE_TRANSITIONS[from];
    if (rule && !rule.validNext.includes(to) && to !== 'failed') {
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
    // Only pass MCP tools to worker phases where they're useful:
    // - module_implementation, debug_fix (workers writing/fixing code)
    // Skip tools for decomposition and code_review (already set skipTools: true inline).
    const toolPhases = ['module_implementation', 'debug_fix'];
    if (!toolPhases.includes(context) && !invocation.skipTools) {
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

    // Inject per-persona session ID for conversation persistence within this step
    const existingSessionId = this.personaSessionIds.get(persona.id);
    if (existingSessionId) {
      invocation = { ...invocation, conversationId: existingSessionId };
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

    try {
      this.config.onAgentThinkingStart?.(persona);
      const response = await this.config.invokeAgent(invocation, persona);
      this.config.onAgentThinkingEnd?.(persona);

      // Store session ID for subsequent calls from this persona
      if (response.sessionId) {
        this.personaSessionIds.set(persona.id, response.sessionId);
      }

      return response;
    } catch (error) {
      this.config.onAgentThinkingEnd?.(persona);
      this.config.onError?.(error as Error, context);
      throw error;
    }
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
  ): LedgerEntry {
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
    };

    ledgerStore.append(councilId, entry);
    this.config.onEntryAdded?.(entry);

    return entry;
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
    };
  }

  private parseReviewVerdict(content: string): ReviewVerdict {
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
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
      // Fall back to text parsing
    }

    // Default: if content mentions "needs_revision" or "fail", treat as needing revision
    const lower = content.toLowerCase();
    if (lower.includes('needs_revision') || lower.includes('needs revision')) {
      return { verdict: 'needs_revision', issues: [], summary: content };
    }

    return { verdict: 'pass', issues: [], summary: content };
  }
}
