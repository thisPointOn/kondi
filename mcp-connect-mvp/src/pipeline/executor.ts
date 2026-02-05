/**
 * Pipeline Executor
 * Runs pipelines: sequential stages, parallel steps within stages.
 * Council steps create real councils via DeliberationOrchestrator.
 * Execution steps make direct LLM calls.
 * Gate steps pause for user approval.
 */

import type {
  Pipeline,
  PipelineStage,
  PipelineStep,
  StepArtifact,
  CouncilStepConfig,
  ExecutionStepConfig,
  GateStepConfig,
} from './types';

import { pipelineStore } from './store';
import { councilStore } from '../council/store';
import { DeliberationOrchestrator } from '../council/deliberation-orchestrator';
import { getDecision, getLatestOutput } from '../council/context-store';
import type { Persona, DeliberationRoleAssignment } from '../council/types';
import type { AgentInvocation, AgentResponse } from '../council/deliberation-orchestrator';

// ============================================================================
// Callback Types
// ============================================================================

export interface PipelineExecutorCallbacks {
  /** Same invokeAgent used by DeliberationOrchestrator */
  invokeAgent: (invocation: AgentInvocation, persona: Persona) => Promise<AgentResponse>;
  /** Direct LLM call for execution steps */
  llmComplete: (params: {
    model: string;
    provider: string;
    systemPrompt: string;
    userMessage: string;
  }) => Promise<{ content: string; tokensUsed: number }>;

  onStageStart?: (stageIndex: number) => void;
  onStageComplete?: (stageIndex: number) => void;
  onStepStart?: (stepId: string) => void;
  onStepComplete?: (stepId: string, artifact: StepArtifact) => void;
  onStepError?: (stepId: string, error: string) => void;
  onGateWaiting?: (stepId: string, prompt: string) => Promise<boolean>;
  onCouncilCreated?: (stepId: string, councilId: string) => void;
  onAgentThinkingStart?: (persona: Persona) => void;
  onAgentThinkingEnd?: (persona: Persona) => void;
}

// ============================================================================
// Input Template Rendering
// ============================================================================

function renderInputTemplate(
  template: string,
  previousArtifacts: StepArtifact[]
): string {
  if (!template || template === '{{input}}') {
    return previousArtifacts.map((a) => a.content).join('\n\n---\n\n');
  }

  let result = template;

  // Replace {{input}} with all artifacts joined
  result = result.replace(
    /\{\{input\}\}/g,
    previousArtifacts.map((a) => a.content).join('\n\n---\n\n')
  );

  // Replace {{input[N]}} with specific artifact
  result = result.replace(/\{\{input\[(\d+)\]\}\}/g, (_match, index) => {
    const i = parseInt(index, 10);
    return previousArtifacts[i]?.content || '';
  });

  return result;
}

// ============================================================================
// Pipeline Executor
// ============================================================================

export class PipelineExecutor {
  private callbacks: PipelineExecutorCallbacks;
  private aborted = false;

  constructor(callbacks: PipelineExecutorCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Run a pipeline from its current stage index.
   * Supports resume — skips completed stages.
   */
  async run(pipelineId: string): Promise<void> {
    const pipeline = pipelineStore.get(pipelineId);
    if (!pipeline) throw new Error(`Pipeline not found: ${pipelineId}`);

    if (pipeline.stages.length === 0) {
      throw new Error('Pipeline has no stages');
    }

    this.aborted = false;
    pipelineStore.setPipelineStatus(pipelineId, 'running');

    try {
      for (let i = pipeline.currentStageIndex; i < pipeline.stages.length; i++) {
        if (this.aborted) {
          pipelineStore.setPipelineStatus(pipelineId, 'paused');
          return;
        }

        // Refresh pipeline state
        const current = pipelineStore.get(pipelineId);
        if (!current) throw new Error('Pipeline disappeared');

        const stage = current.stages[i];

        // Skip completed stages (for resume)
        if (stage.steps.every((s) => s.status === 'completed' || s.status === 'skipped')) {
          continue;
        }

        // Collect previous stage artifacts (or initial input for stage 0)
        const previousArtifacts = this.collectPreviousArtifacts(current, i);

        this.callbacks.onStageStart?.(i);

        // Run all steps in this stage in parallel
        await this.runStage(pipelineId, stage, previousArtifacts, current.settings.failurePolicy);

        this.callbacks.onStageComplete?.(i);

        // Advance stage index
        pipelineStore.advanceStage(pipelineId);
      }

      pipelineStore.setPipelineStatus(pipelineId, 'completed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[PipelineExecutor] Pipeline failed:', message);
      pipelineStore.setPipelineStatus(pipelineId, 'failed');
      throw error;
    }
  }

  /**
   * Abort a running pipeline
   */
  abort(): void {
    this.aborted = true;
  }

  // --------------------------------------------------------------------------
  // Stage Execution
  // --------------------------------------------------------------------------

  private collectPreviousArtifacts(
    pipeline: Pipeline,
    currentStageIndex: number
  ): StepArtifact[] {
    if (currentStageIndex === 0) {
      // For stage 0, create a synthetic artifact from initialInput
      if (!pipeline.initialInput) return [];
      return [
        {
          stepId: '__initial__',
          content: pipeline.initialInput,
          artifactType: 'output',
          createdAt: new Date().toISOString(),
        },
      ];
    }

    const previousStage = pipeline.stages[currentStageIndex - 1];
    return previousStage.steps
      .filter((s) => s.artifact)
      .map((s) => s.artifact!);
  }

  private async runStage(
    pipelineId: string,
    stage: PipelineStage,
    previousArtifacts: StepArtifact[],
    failurePolicy: 'stop' | 'skip_step'
  ): Promise<void> {
    const results = await Promise.allSettled(
      stage.steps.map((step) =>
        this.runStep(pipelineId, step, previousArtifacts)
      )
    );

    // Check for failures
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        const error = result.reason instanceof Error
          ? result.reason.message
          : String(result.reason);

        if (failurePolicy === 'stop') {
          throw new Error(`Step "${stage.steps[i].name}" failed: ${error}`);
        }
        // skip_step: already marked as failed in runStep
      }
    }
  }

  // --------------------------------------------------------------------------
  // Step Dispatch
  // --------------------------------------------------------------------------

  private async runStep(
    pipelineId: string,
    step: PipelineStep,
    previousArtifacts: StepArtifact[]
  ): Promise<void> {
    // Skip already completed steps (for resume)
    if (step.status === 'completed' || step.status === 'skipped') return;

    pipelineStore.setStepStatus(pipelineId, step.id, 'running');
    this.callbacks.onStepStart?.(step.id);

    try {
      let artifact: StepArtifact;

      switch (step.config.type) {
        case 'council':
          artifact = await this.runCouncilStep(pipelineId, step, previousArtifacts);
          break;
        case 'execution':
          artifact = await this.runExecutionStep(step, previousArtifacts);
          break;
        case 'gate':
          artifact = await this.runGateStep(pipelineId, step);
          break;
        default:
          throw new Error(`Unknown step type: ${(step.config as { type: string }).type}`);
      }

      pipelineStore.setStepArtifact(pipelineId, step.id, artifact);
      pipelineStore.setStepStatus(pipelineId, step.id, 'completed');
      this.callbacks.onStepComplete?.(step.id, artifact);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      pipelineStore.setStepStatus(pipelineId, step.id, 'failed', message);
      this.callbacks.onStepError?.(step.id, message);
      throw error;
    }
  }

  // --------------------------------------------------------------------------
  // Council Step
  // --------------------------------------------------------------------------

  private async runCouncilStep(
    pipelineId: string,
    step: PipelineStep,
    previousArtifacts: StepArtifact[]
  ): Promise<StepArtifact> {
    const config = step.config as CouncilStepConfig;

    // Build the problem from input template
    const rawProblem = renderInputTemplate(config.inputTemplate, previousArtifacts);

    // Create personas for the council
    const personas: Persona[] = config.councilSetup.personas.map((p) => ({
      id: crypto.randomUUID(),
      name: p.name,
      provider: p.provider,
      model: p.model,
      color: p.role === 'manager' ? '#6366f1' : p.role === 'worker' ? '#f59e0b' : '#16a34a',
      predisposition: {
        systemPrompt: `You are ${p.name}, a ${p.role} in this deliberation.`,
        stance: 'neutral' as const,
        traits: [],
        interactionStyle: 'build' as const,
      },
      temperature: 0.7,
      verbosity: 'balanced' as const,
      preferredDeliberationRole: p.role,
    }));

    // Create role assignments
    const roleAssignments: DeliberationRoleAssignment[] = config.councilSetup.personas.map(
      (p, i) => ({
        personaId: personas[i].id,
        role: p.role,
        suppressPersona: p.role === 'manager' || p.role === 'worker',
      })
    );

    // Create a real council via councilStore
    const council = councilStore.create({
      name: `[Pipeline] ${config.councilSetup.name}`,
      topic: rawProblem.slice(0, 200),
      personas,
      orchestration: { mode: 'deliberation' },
      deliberation: {
        enabled: true,
        roleAssignments,
        maxRounds: config.councilSetup.maxRounds ?? 4,
        maxRevisions: config.councilSetup.maxRevisions ?? 3,
        expectedOutput: config.councilSetup.expectedOutput,
        decisionCriteria: config.councilSetup.decisionCriteria,
        workingDirectory: config.councilSetup.workingDirectory,
        summaryMode: 'hybrid',
        summarizeAfterRound: 2,
        contextTokenBudget: 80000,
        consultantErrorPolicy: 'retry',
        maxRetries: 2,
        requirePlan: false,
        consultantExecution: 'sequential',
      },
    });

    this.callbacks.onCouncilCreated?.(step.id, council.id);

    // Run full deliberation
    const deliberator = new DeliberationOrchestrator({
      invokeAgent: this.callbacks.invokeAgent,
      onPhaseChange: (from, to) =>
        console.log(`[Pipeline:Council] Phase: ${from} -> ${to}`),
      onError: (err, ctx) =>
        console.error(`[Pipeline:Council] Error in ${ctx}:`, err),
      onAgentThinkingStart: this.callbacks.onAgentThinkingStart,
      onAgentThinkingEnd: this.callbacks.onAgentThinkingEnd,
    });

    await deliberator.runFullDeliberation(council, rawProblem);

    // Extract artifact based on outputSelection
    const updatedCouncil = councilStore.get(council.id);
    let content = '';
    let artifactType: StepArtifact['artifactType'] = 'output';
    const metadata: StepArtifact['metadata'] = { councilId: council.id };

    switch (config.outputSelection) {
      case 'decision': {
        const decision = getDecision(council.id);
        content = decision?.content || 'No decision was made.';
        artifactType = 'decision';
        metadata.decisionId = decision?.id;
        break;
      }
      case 'output': {
        const output = getLatestOutput(council.id);
        content = output?.content || 'No output was produced.';
        artifactType = 'output';
        metadata.outputId = output?.id;
        break;
      }
      case 'summary': {
        content = updatedCouncil?.deliberationState?.completionSummary || 'No summary available.';
        artifactType = 'output';
        break;
      }
    }

    return {
      stepId: step.id,
      content,
      artifactType,
      metadata,
      createdAt: new Date().toISOString(),
    };
  }

  // --------------------------------------------------------------------------
  // Execution Step
  // --------------------------------------------------------------------------

  private async runExecutionStep(
    step: PipelineStep,
    previousArtifacts: StepArtifact[]
  ): Promise<StepArtifact> {
    const config = step.config as ExecutionStepConfig;

    const userMessage = renderInputTemplate(config.inputTemplate, previousArtifacts);

    const result = await this.callbacks.llmComplete({
      model: config.model,
      provider: config.provider,
      systemPrompt: config.systemPrompt,
      userMessage,
    });

    return {
      stepId: step.id,
      content: result.content,
      artifactType: 'llm_response',
      metadata: {
        model: config.model,
        tokensUsed: result.tokensUsed,
      },
      createdAt: new Date().toISOString(),
    };
  }

  // --------------------------------------------------------------------------
  // Gate Step
  // --------------------------------------------------------------------------

  private async runGateStep(
    pipelineId: string,
    step: PipelineStep
  ): Promise<StepArtifact> {
    const config = step.config as GateStepConfig;

    pipelineStore.setStepStatus(pipelineId, step.id, 'waiting_approval');

    if (!this.callbacks.onGateWaiting) {
      throw new Error('No gate approval handler configured');
    }

    const approved = await this.callbacks.onGateWaiting(step.id, config.approvalPrompt);

    if (!approved) {
      throw new Error('Gate step rejected by user');
    }

    return {
      stepId: step.id,
      content: 'Approved',
      artifactType: 'approval',
      createdAt: new Date().toISOString(),
    };
  }
}
