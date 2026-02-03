/**
 * FlowForge State Manager
 * Manages workflow execution state with atomic updates
 */

import { v4 as uuidv4 } from 'uuid';
import {
  WorkflowSpec,
  WorkflowState,
  StepState,
  ExecutionStatus,
  StepStatus,
  AttemptRecord,
  EvaluationResult,
  ExecutionError,
  ExecutionMetadata,
  ExecutorEvent,
} from '../core/types.js';
import {
  ExecutionNotFoundError,
  StorageError,
} from '../core/errors.js';

// ============================================================================
// State Manager Types
// ============================================================================

export interface StateManagerConfig {
  /** Base directory for execution state storage */
  basePath: string;

  /** File system functions */
  fs?: {
    readFile: (path: string) => Promise<string>;
    writeFile: (path: string, content: string) => Promise<void>;
    unlink: (path: string) => Promise<void>;
    readdir: (path: string) => Promise<string[]>;
    mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
    exists: (path: string) => Promise<boolean>;
  };

  /** Event emitter for state changes */
  onEvent?: (event: ExecutorEvent) => void;
}

export interface CreateExecutionParams {
  workflowId: string;
  workflow: WorkflowSpec;
  inputs: Record<string, unknown>;
  metadata?: ExecutionMetadata;
}

// ============================================================================
// Default File System
// ============================================================================

async function createDefaultFs() {
  const fs = await import('fs/promises');
  const path = await import('path');

  return {
    readFile: async (filePath: string) => fs.readFile(filePath, 'utf-8'),
    writeFile: async (filePath: string, content: string) => {
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, content, 'utf-8');
    },
    unlink: async (filePath: string) => fs.unlink(filePath),
    readdir: async (dirPath: string) => {
      try {
        return await fs.readdir(dirPath);
      } catch {
        return [];
      }
    },
    mkdir: async (dirPath: string, options?: { recursive?: boolean }) => {
      await fs.mkdir(dirPath, options);
    },
    exists: async (filePath: string) => {
      try {
        await fs.access(filePath);
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ============================================================================
// State Manager
// ============================================================================

export class StateManager {
  private config: StateManagerConfig;
  private fs: NonNullable<StateManagerConfig['fs']> | null = null;
  private initialized = false;
  private states: Map<string, WorkflowState> = new Map();

  constructor(config: StateManagerConfig) {
    this.config = config;
    if (config.fs) {
      this.fs = config.fs;
      this.initialized = true;
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized && this.fs) return;

    if (!this.fs) {
      this.fs = await createDefaultFs();
    }

    await this.fs.mkdir(this.config.basePath, { recursive: true });
    this.initialized = true;
  }

  private getStatePath(executionId: string): string {
    return `${this.config.basePath}/${executionId}.json`;
  }

  private emit(event: ExecutorEvent): void {
    if (this.config.onEvent) {
      try {
        this.config.onEvent(event);
      } catch {
        // Ignore event handler errors
      }
    }
  }

  // ============================================================================
  // Execution Lifecycle
  // ============================================================================

  /**
   * Create a new execution state
   */
  async createExecution(params: CreateExecutionParams): Promise<WorkflowState> {
    await this.ensureInitialized();

    const executionId = uuidv4();
    const now = new Date().toISOString();

    // Initialize step states
    const steps: Record<string, StepState> = {};
    for (const step of params.workflow.steps) {
      steps[step.id] = {
        stepId: step.id,
        status: 'pending',
        attempts: [],
        currentAttempt: 0,
      };
    }

    const state: WorkflowState = {
      executionId,
      workflowId: params.workflowId,
      status: 'pending',
      inputs: params.inputs,
      outputs: {},
      steps,
      startedAt: now,
      metadata: params.metadata,
    };

    await this.saveState(state);
    this.states.set(executionId, state);

    return state;
  }

  /**
   * Get execution state
   */
  async getExecution(executionId: string): Promise<WorkflowState> {
    // Check in-memory cache first
    const cached = this.states.get(executionId);
    if (cached) return cached;

    await this.ensureInitialized();

    const path = this.getStatePath(executionId);
    try {
      const content = await this.fs!.readFile(path);
      const state = JSON.parse(content) as WorkflowState;
      this.states.set(executionId, state);
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ExecutionNotFoundError(executionId);
      }
      throw new StorageError('read', `Failed to read execution state: ${error}`);
    }
  }

  /**
   * Update execution status
   */
  async setExecutionStatus(
    executionId: string,
    status: ExecutionStatus,
    error?: ExecutionError
  ): Promise<WorkflowState> {
    const state = await this.getExecution(executionId);
    const now = new Date().toISOString();

    state.status = status;
    if (error) state.error = error;

    if (status === 'completed' || status === 'failed' || status === 'aborted') {
      state.completedAt = now;
    }

    await this.saveState(state);

    // Emit events
    if (status === 'running') {
      this.emit({
        type: 'workflow-started',
        executionId,
        workflowId: state.workflowId,
        timestamp: now,
      });
    } else if (status === 'completed') {
      this.emit({
        type: 'workflow-completed',
        executionId,
        workflowId: state.workflowId,
        outputs: state.outputs,
        duration: this.calculateDuration(state.startedAt, state.completedAt),
        timestamp: now,
      });
    } else if (status === 'failed' && state.error) {
      this.emit({
        type: 'workflow-failed',
        executionId,
        workflowId: state.workflowId,
        error: state.error,
        timestamp: now,
      });
    } else if (status === 'aborted') {
      this.emit({
        type: 'workflow-aborted',
        executionId,
        workflowId: state.workflowId,
        reason: error?.message || 'Execution aborted',
        timestamp: now,
      });
    }

    return state;
  }

  /**
   * Set current step being executed
   */
  async setCurrentStep(executionId: string, stepId: string): Promise<WorkflowState> {
    const state = await this.getExecution(executionId);
    state.currentStepId = stepId;
    await this.saveState(state);
    return state;
  }

  /**
   * Set workflow outputs
   */
  async setOutputs(
    executionId: string,
    outputs: Record<string, unknown>
  ): Promise<WorkflowState> {
    const state = await this.getExecution(executionId);
    state.outputs = { ...state.outputs, ...outputs };
    await this.saveState(state);
    return state;
  }

  // ============================================================================
  // Step State Management
  // ============================================================================

  /**
   * Start a step execution
   */
  async startStep(executionId: string, stepId: string, stepName: string): Promise<StepState> {
    const state = await this.getExecution(executionId);
    const now = new Date().toISOString();

    const stepState = state.steps[stepId];
    if (!stepState) {
      throw new Error(`Step not found: ${stepId}`);
    }

    stepState.status = 'running';
    stepState.startedAt = now;
    stepState.currentAttempt += 1;

    // Start new attempt record
    const attempt: AttemptRecord = {
      attemptNumber: stepState.currentAttempt,
      startedAt: now,
    };
    stepState.attempts.push(attempt);

    state.currentStepId = stepId;
    await this.saveState(state);

    this.emit({
      type: 'step-started',
      executionId,
      workflowId: state.workflowId,
      stepId,
      stepName,
      timestamp: now,
    });

    return stepState;
  }

  /**
   * Update step progress
   */
  async updateStepProgress(
    executionId: string,
    stepId: string,
    message: string,
    progress?: number
  ): Promise<void> {
    const state = await this.getExecution(executionId);

    this.emit({
      type: 'step-progress',
      executionId,
      workflowId: state.workflowId,
      stepId,
      message,
      progress,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Complete a step successfully
   */
  async completeStep(
    executionId: string,
    stepId: string,
    output: unknown,
    evaluation?: EvaluationResult
  ): Promise<StepState> {
    const state = await this.getExecution(executionId);
    const now = new Date().toISOString();

    const stepState = state.steps[stepId];
    if (!stepState) {
      throw new Error(`Step not found: ${stepId}`);
    }

    stepState.status = 'completed';
    stepState.completedAt = now;
    stepState.output = output;

    // Update current attempt
    const currentAttempt = stepState.attempts[stepState.attempts.length - 1];
    if (currentAttempt) {
      currentAttempt.completedAt = now;
      currentAttempt.output = output;
      currentAttempt.evaluation = evaluation;
    }

    await this.saveState(state);

    this.emit({
      type: 'step-completed',
      executionId,
      workflowId: state.workflowId,
      stepId,
      output,
      evaluation,
      timestamp: now,
    });

    return stepState;
  }

  /**
   * Fail a step
   */
  async failStep(
    executionId: string,
    stepId: string,
    error: string,
    willRetry: boolean
  ): Promise<StepState> {
    const state = await this.getExecution(executionId);
    const now = new Date().toISOString();

    const stepState = state.steps[stepId];
    if (!stepState) {
      throw new Error(`Step not found: ${stepId}`);
    }

    stepState.status = willRetry ? 'retrying' : 'failed';
    stepState.error = error;

    if (!willRetry) {
      stepState.completedAt = now;
    }

    // Update current attempt
    const currentAttempt = stepState.attempts[stepState.attempts.length - 1];
    if (currentAttempt) {
      currentAttempt.completedAt = now;
      currentAttempt.error = error;
    }

    await this.saveState(state);

    this.emit({
      type: 'step-failed',
      executionId,
      workflowId: state.workflowId,
      stepId,
      error,
      attemptNumber: stepState.currentAttempt,
      willRetry,
      timestamp: now,
    });

    return stepState;
  }

  /**
   * Set step to evaluating status
   */
  async setStepEvaluating(executionId: string, stepId: string): Promise<StepState> {
    const state = await this.getExecution(executionId);

    const stepState = state.steps[stepId];
    if (!stepState) {
      throw new Error(`Step not found: ${stepId}`);
    }

    stepState.status = 'evaluating';
    await this.saveState(state);

    return stepState;
  }

  /**
   * Start a retry for a step
   */
  async startRetry(
    executionId: string,
    stepId: string,
    feedback: string
  ): Promise<StepState> {
    const state = await this.getExecution(executionId);
    const now = new Date().toISOString();

    const stepState = state.steps[stepId];
    if (!stepState) {
      throw new Error(`Step not found: ${stepId}`);
    }

    stepState.status = 'running';
    stepState.currentAttempt += 1;

    // Start new attempt record with retry feedback
    const attempt: AttemptRecord = {
      attemptNumber: stepState.currentAttempt,
      startedAt: now,
      retryFeedback: feedback,
    };
    stepState.attempts.push(attempt);

    await this.saveState(state);

    this.emit({
      type: 'step-retry',
      executionId,
      workflowId: state.workflowId,
      stepId,
      attemptNumber: stepState.currentAttempt,
      feedback,
      timestamp: now,
    });

    return stepState;
  }

  /**
   * Skip a step
   */
  async skipStep(executionId: string, stepId: string, reason: string): Promise<StepState> {
    const state = await this.getExecution(executionId);
    const now = new Date().toISOString();

    const stepState = state.steps[stepId];
    if (!stepState) {
      throw new Error(`Step not found: ${stepId}`);
    }

    stepState.status = 'skipped';
    stepState.skipped = true;
    stepState.skipReason = reason;
    stepState.completedAt = now;

    await this.saveState(state);

    return stepState;
  }

  /**
   * Request approval for a step
   */
  async requestApproval(
    executionId: string,
    stepId: string,
    stepName: string,
    message: string,
    context: unknown
  ): Promise<StepState> {
    const state = await this.getExecution(executionId);
    const now = new Date().toISOString();

    const stepState = state.steps[stepId];
    if (!stepState) {
      throw new Error(`Step not found: ${stepId}`);
    }

    stepState.status = 'waiting_approval';
    state.status = 'waiting_approval';

    await this.saveState(state);

    this.emit({
      type: 'approval-needed',
      executionId,
      workflowId: state.workflowId,
      stepId,
      stepName,
      message,
      context,
      timestamp: now,
    });

    return stepState;
  }

  /**
   * Approve a step
   */
  async approveStep(
    executionId: string,
    stepId: string,
    approvedBy?: string
  ): Promise<StepState> {
    const state = await this.getExecution(executionId);
    const now = new Date().toISOString();

    const stepState = state.steps[stepId];
    if (!stepState) {
      throw new Error(`Step not found: ${stepId}`);
    }

    stepState.approvedAt = now;
    stepState.approvedBy = approvedBy;
    stepState.status = 'running';
    state.status = 'running';

    await this.saveState(state);

    return stepState;
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * Get step state
   */
  async getStepState(executionId: string, stepId: string): Promise<StepState> {
    const state = await this.getExecution(executionId);
    const stepState = state.steps[stepId];
    if (!stepState) {
      throw new Error(`Step not found: ${stepId}`);
    }
    return stepState;
  }

  /**
   * Get step output
   */
  async getStepOutput(executionId: string, stepId: string): Promise<unknown> {
    const stepState = await this.getStepState(executionId, stepId);
    return stepState.output;
  }

  /**
   * Check if all steps are complete
   */
  async areAllStepsComplete(executionId: string): Promise<boolean> {
    const state = await this.getExecution(executionId);
    return Object.values(state.steps).every(
      (s) => s.status === 'completed' || s.status === 'skipped'
    );
  }

  /**
   * Get pending steps
   */
  async getPendingSteps(executionId: string): Promise<string[]> {
    const state = await this.getExecution(executionId);
    return Object.entries(state.steps)
      .filter(([_, s]) => s.status === 'pending')
      .map(([id]) => id);
  }

  /**
   * Delete execution state
   */
  async deleteExecution(executionId: string): Promise<void> {
    await this.ensureInitialized();
    this.states.delete(executionId);

    const path = this.getStatePath(executionId);
    try {
      await this.fs!.unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new StorageError('delete', `Failed to delete execution state: ${error}`);
      }
    }
  }

  /**
   * List executions for a workflow
   */
  async listExecutions(workflowId?: string): Promise<WorkflowState[]> {
    await this.ensureInitialized();

    const files = await this.fs!.readdir(this.config.basePath);
    const executions: WorkflowState[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      try {
        const content = await this.fs!.readFile(`${this.config.basePath}/${file}`);
        const state = JSON.parse(content) as WorkflowState;

        if (!workflowId || state.workflowId === workflowId) {
          executions.push(state);
        }
      } catch {
        // Skip invalid files
      }
    }

    // Sort by start time, newest first
    return executions.sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
    );
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private async saveState(state: WorkflowState): Promise<void> {
    const path = this.getStatePath(state.executionId);
    const content = JSON.stringify(state, null, 2);

    try {
      await this.fs!.writeFile(path, content);
      this.states.set(state.executionId, state);
    } catch (error) {
      throw new StorageError('write', `Failed to save execution state: ${error}`);
    }
  }

  private calculateDuration(startedAt: string, completedAt?: string): number {
    const start = new Date(startedAt).getTime();
    const end = completedAt ? new Date(completedAt).getTime() : Date.now();
    return end - start;
  }
}

// ============================================================================
// Default Instance
// ============================================================================

let defaultManager: StateManager | null = null;

export function getDefaultStateManager(): StateManager {
  if (!defaultManager) {
    const homedir = process.env.HOME || process.env.USERPROFILE || '.';
    defaultManager = new StateManager({
      basePath: `${homedir}/.flowforge/executions`,
    });
  }
  return defaultManager;
}

export function setDefaultStateManager(manager: StateManager): void {
  defaultManager = manager;
}
