/**
 * Pipeline Executor
 * Runs pipelines: sequential stages, parallel steps within stages.
 * All step types (planning, coding, decisioning, execution) create councils.
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
import { migrateLlmConfig } from './types';

import { pipelineStore } from './store';
import { councilStore } from '../council/store';
import { createCouncilFromSetup } from '../council/factory';
import { DeliberationOrchestrator } from '../council/deliberation-orchestrator';
import { CodingOrchestrator } from '../council/coding-orchestrator';
import { getDecision, getLatestOutput } from '../council/context-store';
import { buildAbbreviatedSummary } from '../services/deliberationSummary';
import type { Persona } from '../council/types';
import type { AgentInvocation, AgentResponse } from '../council/deliberation-orchestrator';

// ============================================================================
// Callback Types
// ============================================================================

export interface PipelineExecutorCallbacks {
  /** Same invokeAgent used by DeliberationOrchestrator */
  invokeAgent: (invocation: AgentInvocation, persona: Persona) => Promise<AgentResponse>;

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

  const outputType = artifact.metadata?.outputType || 'string';
  const outputPath = artifact.metadata?.outputPath;

  if (outputType === 'directory' && outputPath) {
    lines.push(`[Output type: directory]`);
    lines.push(`[Output directory: ${outputPath}]`);
    lines.push(`IMPORTANT: The previous step produced output in the directory above. Use your tools to list and read the files in that directory to understand the full context of what was produced.`);
  } else if (outputType === 'file' && outputPath) {
    lines.push(`[Output type: file]`);
    lines.push(`[Output file: ${outputPath}]`);
    lines.push(`IMPORTANT: The previous step produced output in the file above. Use your tools to read that file to understand the full context of what was produced.`);
  } else if (outputPath) {
    lines.push(`[Output file: ${outputPath}]`);
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
    // All step types now route through councils (including decisioning/execution)
    let stepCouncilId: string | null = null;
    const origOnCouncilCreated = this.callbacks.onCouncilCreated;
    this.callbacks.onCouncilCreated = (stepId, councilId) => {
      stepCouncilId = councilId;
      origOnCouncilCreated?.(stepId, councilId);
    };

    try {
      let artifact: StepArtifact;

      if (step.config.type === 'gate') {
        artifact = await this.runGateStep(pipelineId, step);
      } else {
        // Convert LLM steps (decisioning/execution) to lightweight council configs
        const councilStep = this.normalizeToCouncilStep(step);
        artifact = await this.runCouncilStep(pipelineId, councilStep, previousArtifacts, pipelineSettings);
      }

      pipelineStore.setStepArtifact(pipelineId, step.id, artifact);
      pipelineStore.setStepStatus(pipelineId, step.id, 'completed');
      this.callbacks.onStepComplete?.(step.id, artifact);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // For steps that created a council before failing, write a partial
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
      this.callbacks.onCouncilCreated = origOnCouncilCreated;
    }
  }

  /**
   * Ensure a step has a CouncilStepConfig.
   * Steps with councilSetup (new format) pass through unchanged.
   * Legacy LlmStepConfig (flat model/provider/systemPrompt) is migrated.
   */
  private normalizeToCouncilStep(step: PipelineStep): PipelineStep {
    const config = step.config;

    // Already a CouncilStepConfig — has councilSetup
    if ('councilSetup' in config) {
      return step;
    }

    // Legacy LlmStepConfig — migrate to CouncilStepConfig
    const migrated = migrateLlmConfig(config as LlmStepConfig);
    return { ...step, config: migrated };
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

    // Build the problem: task (instructions) + input (context from previous steps)
    const inputContext = renderInputTemplate(config.inputTemplate, previousArtifacts);
    const rawProblem = config.task
      ? `${config.task}\n\n---\n\nInput:\n${inputContext}`
      : inputContext;

    // Resolve effective working directory with inheritance (default: constrained)
    const isConstrained = pipelineSettings.directoryConstrained !== false;
    const effectiveDir = isConstrained
      ? pipelineSettings.workingDirectory
      : config.councilSetup.workingDirectory || pipelineSettings.workingDirectory;

    // Create council via factory
    const council = createCouncilFromSetup({
      ...config.councilSetup,
      task: config.task,
      topic: rawProblem.slice(0, 200),
      workingDirectory: effectiveDir,
      directoryConstrained: isConstrained,
      saveDeliberation: true,
      saveDeliberationMode: 'full',
      stepType: config.type,
      pipelinePrefix: '[Pipeline]',
      pipelineId: pipelineId,
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

    // Extract artifact — decisioning steps use the decision, all others use worker output
    const updatedCouncil = councilStore.get(council.id);
    let content = '';
    let artifactType: StepArtifact['artifactType'] = 'output';
    const metadata: StepArtifact['metadata'] = {
      councilId: council.id,
      outputPath: workerOutputPath,
      outputType: config.outputType || 'string',
      stepName: step.name,
      stepType: config.type,
    };

    if (config.type === 'decisioning') {
      const decision = getDecision(council.id);
      content = decision?.content || 'No decision was made.';
      artifactType = 'decision';
      metadata.decisionId = decision?.id;
    } else {
      const output = getLatestOutput(council.id);
      content = output?.content || 'No output was produced.';
      artifactType = 'output';
      metadata.outputId = output?.id;
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
