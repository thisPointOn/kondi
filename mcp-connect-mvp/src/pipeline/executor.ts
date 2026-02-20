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
  LlmStepConfig,
  GateStepConfig,
} from './types';
import { isCouncilType } from './types';

import { pipelineStore } from './store';
import { councilStore } from '../council/store';
import { DeliberationOrchestrator } from '../council/deliberation-orchestrator';
import { CodingOrchestrator } from '../council/coding-orchestrator';
import { getDecision, getLatestOutput } from '../council/context-store';
import { buildAbbreviatedSummary } from '../services/deliberationSummary';
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
    conversationId?: string;
    allowedServerIds?: string[];
    skipTools?: boolean;
    allowedTools?: string[];
  }) => Promise<{ content: string; tokensUsed: number; sessionId?: string }>;

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
// Platform Adapter (abstracts Tauri / Node.js)
// ============================================================================

export interface PlatformAdapter {
  writeFile(path: string, content: string): Promise<void>;
  readFile?(path: string): Promise<string | null>;
  runCommand?(cmd: string, cwd: string): Promise<{ stdout: string; stderr: string; exit_code: number; success: boolean }>;
  setWorkingDir(dir: string): void;
  getWorkingDir(): string;
  saveDeliberationOutput?(council: any, mode: 'full' | 'abbreviated'): Promise<string>;
}

// ============================================================================
// Input Template Rendering
// ============================================================================

/**
 * Prepend a provenance header so downstream steps know what produced the content.
 * Skip header for synthetic initial-input artifacts (stepId === '__initial__').
 */
function formatArtifactForInput(artifact: StepArtifact): string {
  if (artifact.stepId === '__initial__') {
    return artifact.content;
  }

  const lines: string[] = [];
  if (artifact.metadata?.stepName) {
    const typeLabel = artifact.metadata.stepType ? ` (${artifact.metadata.stepType})` : '';
    lines.push(`[Source: ${artifact.metadata.stepName}${typeLabel}]`);
  }
  if (artifact.metadata?.outputPath) {
    lines.push(`[Output file: ${artifact.metadata.outputPath}]`);
  }

  if (lines.length > 0) {
    return lines.join('\n') + '\n\n' + artifact.content;
  }
  return artifact.content;
}

function renderInputTemplate(
  template: string,
  previousArtifacts: StepArtifact[]
): string {
  if (!template || template === '{{input}}') {
    return previousArtifacts.map((a) => formatArtifactForInput(a)).join('\n\n---\n\n');
  }

  let result = template;

  // Replace {{input}} with all artifacts joined (with provenance headers)
  result = result.replace(
    /\{\{input\}\}/g,
    previousArtifacts.map((a) => formatArtifactForInput(a)).join('\n\n---\n\n')
  );

  // Replace {{input[N]}} with specific artifact (with provenance header)
  result = result.replace(/\{\{input\[(\d+)\]\}\}/g, (_match, index) => {
    const i = parseInt(index, 10);
    return previousArtifacts[i] ? formatArtifactForInput(previousArtifacts[i]) : '';
  });

  // Replace {{file}} with all output file paths (newline-joined, non-null only)
  result = result.replace(
    /\{\{file\}\}/g,
    previousArtifacts
      .map((a) => a.metadata?.outputPath)
      .filter(Boolean)
      .join('\n')
  );

  // Replace {{file[N]}} with specific artifact's file path
  result = result.replace(/\{\{file\[(\d+)\]\}\}/g, (_match, index) => {
    const i = parseInt(index, 10);
    return previousArtifacts[i]?.metadata?.outputPath || '';
  });

  return result;
}

// ============================================================================
// Pipeline Executor
// ============================================================================

export class PipelineExecutor {
  private callbacks: PipelineExecutorCallbacks;
  private platform: PlatformAdapter;
  private aborted = false;
  private runningPipelineId: string | null = null;

  constructor(callbacks: PipelineExecutorCallbacks, platform: PlatformAdapter) {
    this.callbacks = callbacks;
    this.platform = platform;
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
    this.runningPipelineId = pipelineId;
    pipelineStore.setPipelineStatus(pipelineId, 'running');

    try {
      for (let i = pipeline.currentStageIndex; i < pipeline.stages.length; i++) {
        if (this.aborted) {
          return; // status already set by abort()
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

        // Run all steps in this stage
        await this.runStage(pipelineId, stage, previousArtifacts, current.settings.failurePolicy, current.settings);

        // Check abort again after stage completes (don't advance if aborted)
        if (this.aborted) {
          return;
        }

        this.callbacks.onStageComplete?.(i);

        // Advance stage index
        pipelineStore.advanceStage(pipelineId);
      }

      if (!this.aborted) {
        pipelineStore.setPipelineStatus(pipelineId, 'completed');
      }
    } catch (error) {
      if (this.aborted) return; // don't overwrite 'paused' status on abort
      const message = error instanceof Error ? error.message : String(error);
      console.error('[PipelineExecutor] Pipeline failed:', message);
      pipelineStore.setPipelineStatus(pipelineId, 'failed');
      throw error;
    } finally {
      this.runningPipelineId = null;
    }
  }

  /**
   * Abort a running pipeline. Sets status to 'paused' immediately and marks
   * any currently-running steps as failed so the UI updates right away.
   */
  abort(): void {
    this.aborted = true;
    if (this.runningPipelineId) {
      const pipeline = pipelineStore.get(this.runningPipelineId);
      if (pipeline) {
        // Mark any running steps as failed
        for (const stage of pipeline.stages) {
          for (const step of stage.steps) {
            if (step.status === 'running') {
              pipelineStore.setStepStatus(this.runningPipelineId, step.id, 'failed', 'Aborted by user');
            }
          }
        }
        pipelineStore.setPipelineStatus(this.runningPipelineId, 'failed');
      }
    }
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
    failurePolicy: 'stop' | 'skip_step',
    pipelineSettings: Pipeline['settings']
  ): Promise<void> {
    const mode = stage.executionMode || 'sequential';

    if (mode === 'parallel') {
      // Run all steps concurrently
      const results = await Promise.allSettled(
        stage.steps.map((step) =>
          this.runStep(pipelineId, step, previousArtifacts, pipelineSettings)
        )
      );

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === 'rejected') {
          const error = result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);

          if (failurePolicy === 'stop') {
            throw new Error(`Step "${stage.steps[i].name}" failed: ${error}`);
          }
        }
      }
    } else {
      // Run steps one at a time, in order.
      // Accumulate artifacts so later steps can reference earlier steps' outputs.
      const accumulatedArtifacts = [...previousArtifacts];
      for (const step of stage.steps) {
        if (this.aborted) return;

        try {
          await this.runStep(pipelineId, step, accumulatedArtifacts, pipelineSettings);
          // Add completed step's artifact for subsequent steps
          const updated = pipelineStore.get(pipelineId);
          const updatedStep = updated?.stages.flatMap(s => s.steps).find(s => s.id === step.id);
          if (updatedStep?.artifact) {
            accumulatedArtifacts.push(updatedStep.artifact);
          }
        } catch (error) {
          if (failurePolicy === 'stop') {
            throw error;
          }
          // skip_step: already marked as failed in runStep
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // Step Dispatch
  // --------------------------------------------------------------------------

  private async runStep(
    pipelineId: string,
    step: PipelineStep,
    previousArtifacts: StepArtifact[],
    pipelineSettings: Pipeline['settings']
  ): Promise<void> {
    // Skip already completed steps (for resume)
    if (step.status === 'completed' || step.status === 'skipped') return;

    pipelineStore.setStepStatus(pipelineId, step.id, 'running');
    this.callbacks.onStepStart?.(step.id);

    // Track council ID so we can link to the deliberation even if the step fails
    let stepCouncilId: string | null = null;
    const origOnCouncilCreated = this.callbacks.onCouncilCreated;
    if (isCouncilType(step.config.type)) {
      this.callbacks.onCouncilCreated = (stepId, councilId) => {
        stepCouncilId = councilId;
        origOnCouncilCreated?.(stepId, councilId);
      };
    }

    try {
      let artifact: StepArtifact;

      switch (step.config.type) {
        case 'planning':
        case 'coding':
          artifact = await this.runCouncilStep(pipelineId, step, previousArtifacts, pipelineSettings);
          break;
        case 'decisioning':
        case 'execution':
          artifact = await this.runLlmStep(step, previousArtifacts, pipelineSettings);
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

      // For council steps that created a council before failing, write a partial
      // artifact so the UI can still link to the deliberation ledger
      if (stepCouncilId) {
        pipelineStore.setStepArtifact(pipelineId, step.id, {
          stepId: step.id,
          content: `Step failed: ${message}`,
          artifactType: 'output',
          metadata: { councilId: stepCouncilId, stepName: step.name, stepType: step.config.type },
          createdAt: new Date().toISOString(),
        });
      }

      pipelineStore.setStepStatus(pipelineId, step.id, 'failed', message);
      this.callbacks.onStepError?.(step.id, message);
      throw error;
    } finally {
      // Restore original callback
      if (isCouncilType(step.config.type)) {
        this.callbacks.onCouncilCreated = origOnCouncilCreated;
      }
    }
  }

  // --------------------------------------------------------------------------
  // Council Step
  // --------------------------------------------------------------------------

  private async runCouncilStep(
    pipelineId: string,
    step: PipelineStep,
    previousArtifacts: StepArtifact[],
    pipelineSettings: Pipeline['settings']
  ): Promise<StepArtifact> {
    const config = step.config as CouncilStepConfig;

    // Build the problem from input template
    const rawProblem = renderInputTemplate(config.inputTemplate, previousArtifacts);

    // Resolve effective working directory with inheritance (default: constrained)
    const isConstrained = pipelineSettings.directoryConstrained !== false;
    const effectiveDir = isConstrained
      ? pipelineSettings.workingDirectory
      : config.councilSetup.workingDirectory || pipelineSettings.workingDirectory;

    // Create personas for the council using full persona data
    const personas: Persona[] = config.councilSetup.personas.map((p) => ({
      id: crypto.randomUUID(),
      name: p.name,
      provider: p.provider,
      model: p.model,
      avatar: p.avatar,
      color: p.color || (p.role === 'manager' ? '#6366f1' : p.role === 'worker' ? '#f59e0b' : p.role === 'reviewer' ? '#0ea5e9' : '#16a34a'),
      predisposition: {
        systemPrompt: p.systemPrompt || `You are ${p.name}, a ${p.role} in this deliberation.`,
        stance: p.stance || 'neutral' as const,
        traits: p.traits && p.traits.length > 0
          ? p.traits
          : p.role === 'manager' ? ['analytical', 'decisive']
          : p.role === 'worker' ? ['thorough', 'detail-oriented']
          : p.role === 'reviewer' ? ['critical', 'quality-focused']
          : ['insightful', 'collaborative'],
        interactionStyle: p.interactionStyle || 'build' as const,
        domain: p.domain,
      },
      temperature: p.temperature ?? 0.7,
      verbosity: p.verbosity || 'balanced' as const,
      preferredDeliberationRole: p.role,
      allowedServerIds: p.allowedServerIds,
    }));

    // Create role assignments using full persona data
    const roleAssignments: DeliberationRoleAssignment[] = config.councilSetup.personas.map(
      (p, i) => ({
        personaId: personas[i].id,
        role: p.role,
        focusArea: p.focusArea,
        stance: p.startingStance,
        suppressPersona: p.suppressPersona ?? (p.role === 'manager' || p.role === 'worker' || p.role === 'reviewer'),
        writePermissions: p.role === 'worker' ? true : undefined,
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
        workingDirectory: effectiveDir,
        directoryConstrained: isConstrained,
        summaryMode: 'hybrid',
        summarizeAfterRound: 2,
        contextTokenBudget: 80000,
        consultantErrorPolicy: 'retry',
        maxRetries: 2,
        requirePlan: false,
        consultantExecution: 'sequential',
        saveDeliberation: true,
        saveDeliberationMode: 'full',
        stepType: config.type,
        // Coding orchestrator config
        testCommand: config.councilSetup.testCommand,
        maxDebugCycles: config.councilSetup.maxDebugCycles ?? 5,
        maxReviewCycles: config.councilSetup.maxReviewCycles ?? 2,
        // MCP tool filtering
        allowedServerIds: config.councilSetup.allowedServerIds,
      },
    });

    this.callbacks.onCouncilCreated?.(step.id, council.id);

    // Set working directory so Claude operates in the pipeline's directory
    const previousDir = this.platform.getWorkingDir();
    if (effectiveDir) {
      this.platform.setWorkingDir(effectiveDir);
    }

    // Branch: coding steps use CodingOrchestrator, planning uses DeliberationOrchestrator
    const orchestratorCallbacks = {
      invokeAgent: this.callbacks.invokeAgent,
      onPhaseChange: (from: any, to: any) =>
        console.log(`[Pipeline:Council] Phase: ${from} -> ${to}`),
      onError: (err: Error, ctx: string) =>
        console.error(`[Pipeline:Council] Error in ${ctx}:`, err),
      onAgentThinkingStart: this.callbacks.onAgentThinkingStart,
      onAgentThinkingEnd: this.callbacks.onAgentThinkingEnd,
    };

    try {
      if (config.type === 'coding') {
        const codingOrchestrator = new CodingOrchestrator({
          ...orchestratorCallbacks,
          runCommand: this.platform.runCommand,
          readFile: this.platform.readFile,
        });
        await codingOrchestrator.runCodingWorkflow(council, rawProblem);
      } else {
        const deliberator = new DeliberationOrchestrator(orchestratorCallbacks);
        await deliberator.runFullDeliberation(council, rawProblem);
      }
    } finally {
      // Restore previous working directory so other callers (chat UI) aren't affected
      this.platform.setWorkingDir(previousDir);
    }

    // Generate summary and save to disk (normally done by React useEffect, but
    // pipeline executor doesn't render DeliberationView)
    let workerOutputPath: string | undefined;
    const completedCouncil = councilStore.get(council.id);
    if (completedCouncil) {
      const summary = buildAbbreviatedSummary(completedCouncil);
      councilStore.updateDeliberationState(council.id, { completionSummary: summary });

      // Save deliberation output to working directory
      if (effectiveDir) {
        try {
          if (this.platform.saveDeliberationOutput) {
            const outputDir = await this.platform.saveDeliberationOutput(completedCouncil, 'full');
            console.log(`[Pipeline:Council] Saved deliberation output to: ${outputDir}`);
          }
        } catch (err) {
          console.error('[Pipeline:Council] Failed to save deliberation output:', err);
        }

        // Save worker output to working directory if saveOutput is enabled
        const workerPersona = config.councilSetup.personas.find((p) => p.role === 'worker');
        if (workerPersona && workerPersona.saveOutput !== false) {
          const workerOutput = getLatestOutput(council.id);
          if (workerOutput?.content) {
            try {
              const safeName = config.councilSetup.name
                .toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 50);
              const suffix = config.type === 'coding' ? '_code.md' : '_plan.md';
              workerOutputPath = `${effectiveDir.replace(/\/$/, '')}/${safeName}${suffix}`;
              await this.platform.writeFile(workerOutputPath, workerOutput.content);
              console.log(`[Pipeline:Council] Saved worker output to: ${workerOutputPath}`);
            } catch (err) {
              console.error('[Pipeline:Council] Failed to save worker output:', err);
            }
          }
        }
      }
    }

    // Extract artifact based on outputSelection
    const updatedCouncil = councilStore.get(council.id);
    let content = '';
    let artifactType: StepArtifact['artifactType'] = 'output';
    const metadata: StepArtifact['metadata'] = {
      councilId: council.id,
      outputPath: workerOutputPath,
      stepName: step.name,
      stepType: config.type,
    };

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
  // LLM Step (Decisioning / Execution)
  // --------------------------------------------------------------------------

  private async runLlmStep(
    step: PipelineStep,
    previousArtifacts: StepArtifact[],
    pipelineSettings: Pipeline['settings']
  ): Promise<StepArtifact> {
    const config = step.config as LlmStepConfig;

    // Resolve effective working directory with inheritance (default: constrained)
    const effectiveDir = pipelineSettings.directoryConstrained !== false
      ? pipelineSettings.workingDirectory
      : config.workingDirectory || pipelineSettings.workingDirectory;

    const userMessage = renderInputTemplate(config.inputTemplate, previousArtifacts);

    // Set working directory
    const previousDir = this.platform.getWorkingDir();
    if (effectiveDir) {
      this.platform.setWorkingDir(effectiveDir);
    }

    const isExecution = config.type === 'execution';

    let result: { content: string; tokensUsed: number };
    try {
      result = await this.callbacks.llmComplete({
        model: config.model,
        provider: config.provider,
        systemPrompt: config.systemPrompt,
        userMessage,
        allowedServerIds: config.allowedServerIds,
        skipTools: !isExecution,
      });
    } finally {
      // Restore previous working directory
      this.platform.setWorkingDir(previousDir);
    }

    return {
      stepId: step.id,
      content: result.content,
      artifactType: 'llm_response',
      metadata: {
        model: config.model,
        tokensUsed: result.tokensUsed,
        stepName: step.name,
        stepType: config.type,
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
