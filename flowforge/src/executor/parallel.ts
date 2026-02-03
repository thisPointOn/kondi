/**
 * FlowForge Parallel Coordinator
 * Coordinates parallel step execution via Kondi
 */

import {
  WorkflowSpec,
  WorkflowState,
  Step,
  ExecutorEvent,
} from '../core/types.js';
import {
  KondiAdapter,
  getDefaultKondiAdapter,
} from '../integrations/kondi/adapter.js';
import {
  KondiHandoff,
  KondiResult,
  SharedContext,
  ParallelGroup,
  KondiEvent,
} from '../integrations/kondi/types.js';
import { ParallelDetector, getDefaultParallelDetector } from './parallel-detector.js';
import { StateManager, getDefaultStateManager } from '../state/manager.js';
import { Logger, createExecutionLogger } from '../utils/logger.js';

// ============================================================================
// Types
// ============================================================================

export interface ParallelCoordinatorConfig {
  /** Kondi adapter for parallel execution */
  kondiAdapter?: KondiAdapter;

  /** Parallel detector for analysis */
  parallelDetector?: ParallelDetector;

  /** State manager for state updates */
  stateManager?: StateManager;

  /** Event handler */
  onEvent?: (event: ExecutorEvent) => void;

  /** Maximum agents per parallel group */
  maxAgentsPerGroup?: number;

  /** Default timeout for parallel execution */
  defaultTimeout?: number;
}

export interface ParallelExecutionResult {
  /** Overall success */
  success: boolean;

  /** Results per step */
  stepResults: Map<string, {
    success: boolean;
    output?: unknown;
    error?: string;
  }>;

  /** Total duration */
  duration: number;
}

// ============================================================================
// Parallel Coordinator
// ============================================================================

export class ParallelCoordinator {
  private config: ParallelCoordinatorConfig;
  private kondiAdapter: KondiAdapter;
  private parallelDetector: ParallelDetector;
  private stateManager: StateManager;

  constructor(config?: ParallelCoordinatorConfig) {
    this.config = {
      maxAgentsPerGroup: 5,
      defaultTimeout: 120000,
      ...config,
    };
    this.kondiAdapter = config?.kondiAdapter || getDefaultKondiAdapter();
    this.parallelDetector = config?.parallelDetector || getDefaultParallelDetector();
    this.stateManager = config?.stateManager || getDefaultStateManager();
  }

  /**
   * Execute a parallel step group
   */
  async executeParallelGroup(
    workflow: WorkflowSpec,
    state: WorkflowState,
    group: ParallelGroup,
    workflowInputs: Record<string, unknown>,
    stepOutputs: Record<string, unknown>
  ): Promise<ParallelExecutionResult> {
    const startTime = Date.now();
    const logger = createExecutionLogger(workflow.id, state.executionId);

    logger.info('Starting parallel group execution', {
      groupId: group.id,
      stepCount: group.stepIds.length,
    });

    // Get steps for this group
    const steps = workflow.steps.filter((s) => group.stepIds.includes(s.id));
    const stepMap = new Map(steps.map((s) => [s.id, s]));

    // Build shared context
    const sharedContext: SharedContext = {
      workflowId: workflow.id,
      executionId: state.executionId,
      stepId: group.id, // Use group ID for parallel context
      inputs: workflowInputs,
      previousOutputs: stepOutputs,
    };

    // Build agent tasks from step descriptions
    const agentTasks = steps.map((step) => this.buildStepTask(step, workflowInputs, stepOutputs));

    // Combine success criteria
    const combinedSuccessCriteria = steps
      .map((s) => `[${s.name}]: ${s.successCriteria || 'Complete successfully'}`)
      .join('\n');

    // Create handoff
    const handoff: KondiHandoff = {
      workflowId: workflow.id,
      executionId: state.executionId,
      stepId: group.id,
      agentCount: steps.length,
      sharedContext,
      task: 'Execute the assigned workflow step',
      successCriteria: combinedSuccessCriteria,
      agentTasks,
      timeout: this.config.defaultTimeout,
      config: {
        provider: workflow.config.defaultProvider,
        model: workflow.config.defaultModel,
      },
    };

    // Mark steps as started
    for (const step of steps) {
      await this.stateManager.startStep(state.executionId, step.id, step.name);
    }

    // Execute via Kondi
    const kondiResult = await this.kondiAdapter.executeParallel(handoff);

    // Process results
    const stepResults = new Map<string, {
      success: boolean;
      output?: unknown;
      error?: string;
    }>();

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const agentResult = kondiResult.agentResults[i];

      if (agentResult) {
        stepResults.set(step.id, {
          success: agentResult.success,
          output: agentResult.output,
          error: agentResult.error,
        });

        // Update state
        if (agentResult.success) {
          await this.stateManager.completeStep(
            state.executionId,
            step.id,
            agentResult.output
          );
        } else {
          await this.stateManager.failStep(
            state.executionId,
            step.id,
            agentResult.error || 'Agent execution failed',
            false
          );
        }
      } else {
        stepResults.set(step.id, {
          success: false,
          error: 'No result from agent',
        });

        await this.stateManager.failStep(
          state.executionId,
          step.id,
          'No result from agent',
          false
        );
      }
    }

    logger.info('Parallel group execution completed', {
      groupId: group.id,
      success: kondiResult.success,
      duration: Date.now() - startTime,
    });

    return {
      success: kondiResult.success,
      stepResults,
      duration: Date.now() - startTime,
    };
  }

  /**
   * Execute a step with internal parallelism (type: 'parallel')
   */
  async executeParallelStep(
    workflow: WorkflowSpec,
    state: WorkflowState,
    step: Step,
    workflowInputs: Record<string, unknown>,
    stepOutputs: Record<string, unknown>
  ): Promise<{
    success: boolean;
    output?: unknown;
    error?: string;
  }> {
    const logger = createExecutionLogger(workflow.id, state.executionId);

    logger.info('Starting parallel step execution', {
      stepId: step.id,
      agentCount: step.config.agentCount || 3,
    });

    // Get configuration
    const agentCount = step.config.agentCount || 3;
    const parallelSteps = step.config.parallelSteps || [];

    if (parallelSteps.length === 0) {
      // No sub-steps defined, use agent-based parallelism
      return this.executeAgentParallel(
        workflow,
        state,
        step,
        agentCount,
        workflowInputs,
        stepOutputs
      );
    }

    // Execute sub-steps in parallel
    return this.executeSubStepsParallel(
      workflow,
      state,
      step,
      parallelSteps,
      workflowInputs,
      stepOutputs
    );
  }

  /**
   * Find and execute all available parallel groups
   */
  async executeAvailableParallelGroups(
    workflow: WorkflowSpec,
    state: WorkflowState,
    workflowInputs: Record<string, unknown>,
    stepOutputs: Record<string, unknown>
  ): Promise<{
    executed: string[];
    results: Map<string, ParallelExecutionResult>;
  }> {
    // Analyze workflow for parallelism
    const analysis = this.parallelDetector.analyze(workflow);

    // Find completed steps
    const completedStepIds = new Set<string>();
    for (const [stepId, stepState] of Object.entries(state.steps)) {
      if (stepState.status === 'completed' || stepState.status === 'skipped') {
        completedStepIds.add(stepId);
      }
    }

    // Find groups ready to execute
    const readyGroups = analysis.parallelGroups.filter((group) => {
      // All blocking steps must be completed
      const allBlockersCompleted = group.blockedBy.every((blockerId) =>
        completedStepIds.has(blockerId)
      );

      // No steps in group should be completed yet
      const noStepsCompleted = group.stepIds.every(
        (stepId) => !completedStepIds.has(stepId)
      );

      return allBlockersCompleted && noStepsCompleted;
    });

    const executed: string[] = [];
    const results = new Map<string, ParallelExecutionResult>();

    // Execute ready groups
    for (const group of readyGroups) {
      const result = await this.executeParallelGroup(
        workflow,
        state,
        group,
        workflowInputs,
        stepOutputs
      );

      executed.push(...group.stepIds);
      results.set(group.id, result);

      // Update stepOutputs with results
      for (const [stepId, stepResult] of result.stepResults) {
        if (stepResult.success && stepResult.output !== undefined) {
          stepOutputs[stepId] = stepResult.output;
        }
      }
    }

    return { executed, results };
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private buildStepTask(
    step: Step,
    workflowInputs: Record<string, unknown>,
    stepOutputs: Record<string, unknown>
  ): string {
    let task = `## Step: ${step.name}\n\n`;
    task += `${step.description}\n\n`;

    // Add input context
    if (step.inputs && step.inputs.length > 0) {
      task += '## Inputs\n';
      for (const input of step.inputs) {
        let value: unknown;
        if (input.source.type === 'workflow') {
          value = workflowInputs[input.source.inputName || input.name];
        } else if (input.source.type === 'step') {
          const sourceOutput = stepOutputs[input.source.stepId!];
          value = input.source.outputPath
            ? this.getNestedValue(sourceOutput, input.source.outputPath)
            : sourceOutput;
        } else if (input.source.type === 'literal') {
          value = input.source.value;
        }
        task += `- ${input.name}: ${JSON.stringify(value)}\n`;
      }
      task += '\n';
    }

    // Add type-specific config
    if (step.type === 'llm' && step.config) {
      if (step.config.systemPrompt) {
        task += `## System Prompt\n${step.config.systemPrompt}\n\n`;
      }
      if (step.config.userPrompt) {
        task += `## Instructions\n${step.config.userPrompt}\n\n`;
      }
    }

    // Add success criteria
    if (step.successCriteria) {
      task += `## Success Criteria\n${step.successCriteria}\n`;
    }

    return task;
  }

  private async executeAgentParallel(
    workflow: WorkflowSpec,
    state: WorkflowState,
    step: Step,
    agentCount: number,
    workflowInputs: Record<string, unknown>,
    stepOutputs: Record<string, unknown>
  ): Promise<{
    success: boolean;
    output?: unknown;
    error?: string;
  }> {
    const sharedContext: SharedContext = {
      workflowId: workflow.id,
      executionId: state.executionId,
      stepId: step.id,
      inputs: workflowInputs,
      previousOutputs: stepOutputs,
    };

    const handoff: KondiHandoff = {
      workflowId: workflow.id,
      executionId: state.executionId,
      stepId: step.id,
      agentCount,
      sharedContext,
      task: step.description,
      successCriteria: step.successCriteria || 'Complete successfully',
      timeout: step.timeout || this.config.defaultTimeout,
      config: {
        provider: step.config.provider || workflow.config.defaultProvider,
        model: step.config.model || workflow.config.defaultModel,
      },
    };

    const result = await this.kondiAdapter.executeParallel(handoff);

    return {
      success: result.success,
      output: result.mergedOutput,
      error: result.error,
    };
  }

  private async executeSubStepsParallel(
    workflow: WorkflowSpec,
    state: WorkflowState,
    parentStep: Step,
    subStepIds: string[],
    workflowInputs: Record<string, unknown>,
    stepOutputs: Record<string, unknown>
  ): Promise<{
    success: boolean;
    output?: unknown;
    error?: string;
  }> {
    // Get sub-steps
    const subSteps = workflow.steps.filter((s) => subStepIds.includes(s.id));

    if (subSteps.length === 0) {
      return {
        success: false,
        error: 'No valid sub-steps found',
      };
    }

    // Create a virtual group
    const group: ParallelGroup = {
      id: `${parentStep.id}-parallel`,
      stepIds: subStepIds,
      blockedBy: parentStep.blockedBy || [],
      fullyIndependent: true,
    };

    const result = await this.executeParallelGroup(
      workflow,
      state,
      group,
      workflowInputs,
      stepOutputs
    );

    // Merge outputs
    const mergedOutput: Record<string, unknown> = {};
    for (const [stepId, stepResult] of result.stepResults) {
      if (stepResult.output !== undefined) {
        mergedOutput[stepId] = stepResult.output;
      }
    }

    return {
      success: result.success,
      output: mergedOutput,
      error: result.success ? undefined : 'One or more sub-steps failed',
    };
  }

  private getNestedValue(obj: unknown, path: string): unknown {
    if (!obj || typeof obj !== 'object') return undefined;

    const parts = path.split('.');
    let current: unknown = obj;

    for (const part of parts) {
      if (current === null || current === undefined) return undefined;
      if (typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[part];
    }

    return current;
  }
}

// ============================================================================
// Default Instance
// ============================================================================

let defaultCoordinator: ParallelCoordinator | null = null;

export function getDefaultParallelCoordinator(): ParallelCoordinator {
  if (!defaultCoordinator) {
    defaultCoordinator = new ParallelCoordinator();
  }
  return defaultCoordinator;
}

export function setDefaultParallelCoordinator(coordinator: ParallelCoordinator): void {
  defaultCoordinator = coordinator;
}

// ============================================================================
// Helper Functions
// ============================================================================

export async function executeParallelGroup(
  workflow: WorkflowSpec,
  state: WorkflowState,
  group: ParallelGroup,
  workflowInputs: Record<string, unknown>,
  stepOutputs: Record<string, unknown>
): Promise<ParallelExecutionResult> {
  return getDefaultParallelCoordinator().executeParallelGroup(
    workflow,
    state,
    group,
    workflowInputs,
    stepOutputs
  );
}

export async function executeParallelStep(
  workflow: WorkflowSpec,
  state: WorkflowState,
  step: Step,
  workflowInputs: Record<string, unknown>,
  stepOutputs: Record<string, unknown>
) {
  return getDefaultParallelCoordinator().executeParallelStep(
    workflow,
    state,
    step,
    workflowInputs,
    stepOutputs
  );
}
