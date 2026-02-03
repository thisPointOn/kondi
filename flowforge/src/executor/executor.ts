/**
 * FlowForge Executor
 * Main workflow execution orchestrator
 */

import {
  WorkflowSpec,
  WorkflowState,
  Step,
  ExecutionStatus,
  ExecutorEvent,
  ExecutionError,
} from '../core/types.js';
import {
  WorkflowNotReadyError,
  ExecutionAbortedError,
  MaxRetriesExceededError,
  ApprovalDeniedError,
} from '../core/errors.js';
import { StateManager, getDefaultStateManager } from '../state/manager.js';
import { CheckpointManager, getDefaultCheckpointManager } from '../state/checkpoint.js';
import { HistoryManager, getDefaultHistoryManager } from '../state/history.js';
import { StepRunner, StepExecutionContext, getDefaultStepRunner } from './step-runner.js';
import { enqueueWorkflowStep, setWorkflowConcurrency, clearWorkflowQueue } from '../utils/queue.js';
import { Logger, createExecutionLogger } from '../utils/logger.js';

// ============================================================================
// Executor Types
// ============================================================================

export interface ExecutorConfig {
  /** State manager for execution state */
  stateManager?: StateManager;

  /** Checkpoint manager for checkpointing */
  checkpointManager?: CheckpointManager;

  /** History manager for execution history */
  historyManager?: HistoryManager;

  /** Step runner for executing steps */
  stepRunner?: StepRunner;

  /** Event handler for execution events */
  onEvent?: (event: ExecutorEvent) => void;

  /** Whether to auto-checkpoint after each step */
  autoCheckpoint?: boolean;

  /** Abort signal for cancellation */
  abortSignal?: AbortSignal;
}

export interface ExecutionOptions {
  /** Input values for the workflow */
  inputs: Record<string, unknown>;

  /** Execution metadata */
  metadata?: {
    triggeredBy?: string;
    triggerType?: 'manual' | 'scheduled' | 'webhook' | 'api';
    tags?: string[];
  };

  /** Resume from checkpoint ID */
  checkpointId?: string;

  /** Override execution config */
  config?: Partial<WorkflowSpec['config']>;
}

export interface ExecutionResult {
  executionId: string;
  workflowId: string;
  status: ExecutionStatus;
  outputs: Record<string, unknown>;
  error?: ExecutionError;
  duration: number;
}

// ============================================================================
// Executor
// ============================================================================

export class Executor {
  private config: ExecutorConfig;
  private stateManager: StateManager;
  private checkpointManager: CheckpointManager;
  private historyManager: HistoryManager;
  private stepRunner: StepRunner;

  // Active executions
  private activeExecutions: Map<
    string,
    { workflow: WorkflowSpec; state: WorkflowState; aborted: boolean }
  > = new Map();

  // Approval waiters
  private approvalWaiters: Map<
    string,
    { resolve: (approved: boolean) => void; stepId: string }
  > = new Map();

  constructor(config?: ExecutorConfig) {
    this.config = {
      autoCheckpoint: true,
      ...config,
    };
    this.stateManager = config?.stateManager || getDefaultStateManager();
    this.checkpointManager = config?.checkpointManager || getDefaultCheckpointManager();
    this.historyManager = config?.historyManager || getDefaultHistoryManager();
    this.stepRunner = config?.stepRunner || getDefaultStepRunner();
  }

  /**
   * Execute a workflow
   */
  async execute(workflow: WorkflowSpec, options: ExecutionOptions): Promise<ExecutionResult> {
    // Validate workflow is ready
    if (workflow.status !== 'ready' && workflow.status !== 'draft') {
      throw new WorkflowNotReadyError(workflow.id, workflow.status);
    }

    const startTime = Date.now();
    let state: WorkflowState;

    // Create or restore state
    if (options.checkpointId) {
      state = await this.checkpointManager.restoreFromCheckpoint(
        options.checkpointId,
        options.checkpointId
      );
      state.status = 'running';
    } else {
      state = await this.stateManager.createExecution({
        workflowId: workflow.id,
        workflow,
        inputs: options.inputs,
        metadata: options.metadata,
      });
    }

    const logger = createExecutionLogger(workflow.id, state.executionId);
    logger.info('Starting workflow execution', { workflowName: workflow.name });

    // Register active execution
    this.activeExecutions.set(state.executionId, {
      workflow,
      state,
      aborted: false,
    });

    // Set up queue for this execution
    const maxConcurrent = options.config?.maxConcurrentSteps ?? workflow.config.maxConcurrentSteps;
    setWorkflowConcurrency(workflow.id, state.executionId, maxConcurrent);

    try {
      // Start execution
      await this.stateManager.setExecutionStatus(state.executionId, 'running');

      // Execute steps
      await this.executeSteps(workflow, state, options, logger);

      // Check final status
      const finalState = await this.stateManager.getExecution(state.executionId);

      if (finalState.status === 'aborted') {
        throw new ExecutionAbortedError(state.executionId, 'Execution was aborted');
      }

      // Collect outputs
      const outputs = this.collectOutputs(workflow, finalState);

      // Mark as completed
      await this.stateManager.setExecutionStatus(state.executionId, 'completed');
      await this.stateManager.setOutputs(state.executionId, outputs);

      const duration = Date.now() - startTime;

      // Record in history
      const completedState = await this.stateManager.getExecution(state.executionId);
      await this.historyManager.recordExecution(completedState, workflow.name);

      logger.info('Workflow execution completed', { duration });

      return {
        executionId: state.executionId,
        workflowId: workflow.id,
        status: 'completed',
        outputs,
        duration,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('Workflow execution failed', error);

      // Determine final status
      const execution = this.activeExecutions.get(state.executionId);
      const finalStatus: ExecutionStatus = execution?.aborted ? 'aborted' : 'failed';

      const executionError: ExecutionError = {
        code: error instanceof Error ? error.constructor.name : 'UNKNOWN_ERROR',
        message: errorMessage,
        stepId: state.currentStepId,
      };

      await this.stateManager.setExecutionStatus(
        state.executionId,
        finalStatus,
        executionError
      );

      // Record in history
      const failedState = await this.stateManager.getExecution(state.executionId);
      await this.historyManager.recordExecution(failedState, workflow.name);

      return {
        executionId: state.executionId,
        workflowId: workflow.id,
        status: finalStatus,
        outputs: {},
        error: executionError,
        duration,
      };
    } finally {
      // Cleanup
      this.activeExecutions.delete(state.executionId);
      clearWorkflowQueue(workflow.id, state.executionId);
    }
  }

  /**
   * Abort an execution
   */
  async abort(executionId: string, reason?: string): Promise<void> {
    const execution = this.activeExecutions.get(executionId);
    if (execution) {
      execution.aborted = true;
    }

    // Clear the queue
    const state = await this.stateManager.getExecution(executionId);
    clearWorkflowQueue(state.workflowId, executionId);

    // Update state
    await this.stateManager.setExecutionStatus(executionId, 'aborted', {
      code: 'ABORTED',
      message: reason || 'Execution aborted by user',
    });

    // Reject any pending approvals
    const waiter = this.approvalWaiters.get(executionId);
    if (waiter) {
      waiter.resolve(false);
      this.approvalWaiters.delete(executionId);
    }
  }

  /**
   * Approve a step
   */
  async approveStep(
    executionId: string,
    stepId: string,
    approved: boolean,
    approvedBy?: string
  ): Promise<void> {
    const waiter = this.approvalWaiters.get(executionId);
    if (waiter && waiter.stepId === stepId) {
      if (approved) {
        await this.stateManager.approveStep(executionId, stepId, approvedBy);
      }
      waiter.resolve(approved);
      this.approvalWaiters.delete(executionId);
    }
  }

  /**
   * Get execution status
   */
  async getStatus(executionId: string): Promise<WorkflowState> {
    return this.stateManager.getExecution(executionId);
  }

  /**
   * Check if execution is active
   */
  isActive(executionId: string): boolean {
    return this.activeExecutions.has(executionId);
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private async executeSteps(
    workflow: WorkflowSpec,
    state: WorkflowState,
    options: ExecutionOptions,
    logger: Logger
  ): Promise<void> {
    // Build execution order (respecting dependencies)
    const executionOrder = this.buildExecutionOrder(workflow.steps);

    // Collect step outputs as we go
    const stepOutputs: Record<string, unknown> = {};

    for (const step of executionOrder) {
      // Check if aborted
      const execution = this.activeExecutions.get(state.executionId);
      if (execution?.aborted) {
        throw new ExecutionAbortedError(state.executionId, 'Execution aborted');
      }

      // Check if step should be skipped
      if (this.shouldSkipStep(step, state, options)) {
        await this.stateManager.skipStep(
          state.executionId,
          step.id,
          'Condition not met or already completed'
        );
        continue;
      }

      // Check if blocked by dependencies
      if (step.blockedBy && step.blockedBy.length > 0) {
        const blocked = step.blockedBy.some((depId) => {
          const depState = state.steps[depId];
          return depState?.status !== 'completed' && depState?.status !== 'skipped';
        });

        if (blocked) {
          logger.debug(`Step ${step.id} blocked by dependencies`);
          continue;
        }
      }

      // Execute step
      await this.executeStep(
        workflow,
        state,
        step,
        options.inputs,
        stepOutputs,
        logger
      );

      // Store output for dependent steps
      const stepState = await this.stateManager.getStepState(state.executionId, step.id);
      if (stepState.output !== undefined) {
        stepOutputs[step.id] = stepState.output;
      }

      // Checkpoint if enabled
      if (this.config.autoCheckpoint && workflow.config.checkpointEnabled) {
        await this.checkpointManager.createCheckpoint(
          await this.stateManager.getExecution(state.executionId),
          step.id,
          `After step: ${step.name}`
        );
      }
    }
  }

  private async executeStep(
    workflow: WorkflowSpec,
    state: WorkflowState,
    step: Step,
    workflowInputs: Record<string, unknown>,
    stepOutputs: Record<string, unknown>,
    logger: Logger
  ): Promise<void> {
    // Queue the step execution
    await enqueueWorkflowStep(
      workflow.id,
      state.executionId,
      step.id,
      async () => {
        // Start step
        await this.stateManager.startStep(state.executionId, step.id, step.name);

        const context: Omit<StepExecutionContext, 'attemptNumber' | 'retryFeedback'> = {
          workflow,
          state: await this.stateManager.getExecution(state.executionId),
          step,
          workflowInputs,
          stepOutputs,
        };

        // Execute with retry
        const result = await this.stepRunner.executeStepWithRetry(context, {
          onAttemptStart: (attempt) => {
            logger.debug(`Step ${step.name} attempt ${attempt}`);
          },
          onAttemptComplete: async (attempt, stepResult) => {
            logger.debug(`Step ${step.name} attempt ${attempt} complete`, {
              success: stepResult.success,
              evaluation: stepResult.evaluation?.verdict,
            });
          },
          onRetry: async (attempt, delay, feedback) => {
            logger.debug(`Step ${step.name} retrying after ${delay}ms`);
            await this.stateManager.startRetry(
              state.executionId,
              step.id,
              feedback || 'Retrying due to failure'
            );
          },
        });

        // Handle approval requirement
        if (result.requiresApproval) {
          await this.stateManager.requestApproval(
            state.executionId,
            step.id,
            step.name,
            result.approvalMessage || 'Approval required',
            { step, context }
          );

          // Wait for approval
          const approved = await this.waitForApproval(state.executionId, step.id);
          if (!approved) {
            throw new ApprovalDeniedError(step.id, 'User denied approval');
          }

          // Re-execute after approval
          const retryResult = await this.stepRunner.executeStepWithRetry(context);
          if (!retryResult.success) {
            throw new Error(retryResult.error || 'Step failed after approval');
          }

          await this.stateManager.completeStep(
            state.executionId,
            step.id,
            retryResult.output,
            retryResult.evaluation
          );
          return;
        }

        // Handle result
        if (result.success) {
          await this.stateManager.completeStep(
            state.executionId,
            step.id,
            result.output,
            result.evaluation
          );
        } else {
          await this.stateManager.failStep(
            state.executionId,
            step.id,
            result.error || 'Step failed',
            false
          );
          throw new Error(result.error || 'Step failed');
        }
      }
    );
  }

  private buildExecutionOrder(steps: Step[]): Step[] {
    // Topological sort based on blockedBy dependencies
    const order: Step[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const stepMap = new Map(steps.map((s) => [s.id, s]));

    const visit = (stepId: string): void => {
      if (visited.has(stepId)) return;
      if (visiting.has(stepId)) {
        throw new Error(`Circular dependency detected involving step: ${stepId}`);
      }

      visiting.add(stepId);
      const step = stepMap.get(stepId);
      if (!step) return;

      // Visit dependencies first
      for (const depId of step.blockedBy || []) {
        visit(depId);
      }

      visiting.delete(stepId);
      visited.add(stepId);
      order.push(step);
    };

    for (const step of steps) {
      visit(step.id);
    }

    return order;
  }

  private shouldSkipStep(
    step: Step,
    state: WorkflowState,
    options: ExecutionOptions
  ): boolean {
    // Skip if already completed (for resumed executions)
    const stepState = state.steps[step.id];
    if (stepState?.status === 'completed' || stepState?.status === 'skipped') {
      return true;
    }

    return false;
  }

  private collectOutputs(
    workflow: WorkflowSpec,
    state: WorkflowState
  ): Record<string, unknown> {
    const outputs: Record<string, unknown> = {};

    for (const outputDef of workflow.outputs) {
      if (outputDef.fromStep) {
        const stepState = state.steps[outputDef.fromStep];
        outputs[outputDef.name] = stepState?.output;
      }
    }

    return outputs;
  }

  private waitForApproval(executionId: string, stepId: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.approvalWaiters.set(executionId, { resolve, stepId });

      // Also allow step runner to provide approval
      this.stepRunner.waitForApproval(stepId).then(({ approved }) => {
        const waiter = this.approvalWaiters.get(executionId);
        if (waiter?.stepId === stepId) {
          waiter.resolve(approved);
          this.approvalWaiters.delete(executionId);
        }
      });
    });
  }
}

// ============================================================================
// Default Instance
// ============================================================================

let defaultExecutor: Executor | null = null;

export function getDefaultExecutor(): Executor {
  if (!defaultExecutor) {
    defaultExecutor = new Executor();
  }
  return defaultExecutor;
}

export function setDefaultExecutor(executor: Executor): void {
  defaultExecutor = executor;
}

// ============================================================================
// Helper Functions
// ============================================================================

export async function executeWorkflow(
  workflow: WorkflowSpec,
  options: ExecutionOptions
): Promise<ExecutionResult> {
  return getDefaultExecutor().execute(workflow, options);
}

export async function abortExecution(executionId: string, reason?: string): Promise<void> {
  return getDefaultExecutor().abort(executionId, reason);
}

export async function approveStep(
  executionId: string,
  stepId: string,
  approved: boolean,
  approvedBy?: string
): Promise<void> {
  return getDefaultExecutor().approveStep(executionId, stepId, approved, approvedBy);
}
