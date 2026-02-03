/**
 * FlowForge Error Types
 */

export class FlowForgeError extends Error {
  public readonly code: string;
  public readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'FlowForgeError';
    this.code = code;
    this.details = details;
    Object.setPrototypeOf(this, FlowForgeError.prototype);
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}

// ============================================================================
// Workflow Errors
// ============================================================================

export class WorkflowNotFoundError extends FlowForgeError {
  constructor(workflowId: string) {
    super('WORKFLOW_NOT_FOUND', `Workflow not found: ${workflowId}`, { workflowId });
    this.name = 'WorkflowNotFoundError';
    Object.setPrototypeOf(this, WorkflowNotFoundError.prototype);
  }
}

export class WorkflowValidationError extends FlowForgeError {
  public readonly validationErrors: unknown[];

  constructor(message: string, validationErrors: unknown[]) {
    super('WORKFLOW_VALIDATION_ERROR', message, { validationErrors });
    this.name = 'WorkflowValidationError';
    this.validationErrors = validationErrors;
    Object.setPrototypeOf(this, WorkflowValidationError.prototype);
  }
}

export class WorkflowNotReadyError extends FlowForgeError {
  constructor(workflowId: string, currentStatus: string) {
    super(
      'WORKFLOW_NOT_READY',
      `Workflow ${workflowId} is not ready for execution (status: ${currentStatus})`,
      { workflowId, currentStatus }
    );
    this.name = 'WorkflowNotReadyError';
    Object.setPrototypeOf(this, WorkflowNotReadyError.prototype);
  }
}

// ============================================================================
// Execution Errors
// ============================================================================

export class ExecutionNotFoundError extends FlowForgeError {
  constructor(executionId: string) {
    super('EXECUTION_NOT_FOUND', `Execution not found: ${executionId}`, { executionId });
    this.name = 'ExecutionNotFoundError';
    Object.setPrototypeOf(this, ExecutionNotFoundError.prototype);
  }
}

export class ExecutionAlreadyRunningError extends FlowForgeError {
  constructor(executionId: string) {
    super('EXECUTION_ALREADY_RUNNING', `Execution is already running: ${executionId}`, {
      executionId,
    });
    this.name = 'ExecutionAlreadyRunningError';
    Object.setPrototypeOf(this, ExecutionAlreadyRunningError.prototype);
  }
}

export class ExecutionAbortedError extends FlowForgeError {
  constructor(executionId: string, reason: string) {
    super('EXECUTION_ABORTED', `Execution aborted: ${reason}`, { executionId, reason });
    this.name = 'ExecutionAbortedError';
    Object.setPrototypeOf(this, ExecutionAbortedError.prototype);
  }
}

// ============================================================================
// Step Errors
// ============================================================================

export class StepNotFoundError extends FlowForgeError {
  constructor(stepId: string, workflowId: string) {
    super('STEP_NOT_FOUND', `Step not found: ${stepId} in workflow ${workflowId}`, {
      stepId,
      workflowId,
    });
    this.name = 'StepNotFoundError';
    Object.setPrototypeOf(this, StepNotFoundError.prototype);
  }
}

export class StepExecutionError extends FlowForgeError {
  public readonly stepId: string;
  public readonly attemptNumber: number;

  constructor(stepId: string, attemptNumber: number, message: string, details?: unknown) {
    super('STEP_EXECUTION_ERROR', message, { stepId, attemptNumber, ...details });
    this.name = 'StepExecutionError';
    this.stepId = stepId;
    this.attemptNumber = attemptNumber;
    Object.setPrototypeOf(this, StepExecutionError.prototype);
  }
}

export class StepTimeoutError extends FlowForgeError {
  constructor(stepId: string, timeout: number) {
    super('STEP_TIMEOUT', `Step ${stepId} timed out after ${timeout}ms`, { stepId, timeout });
    this.name = 'StepTimeoutError';
    Object.setPrototypeOf(this, StepTimeoutError.prototype);
  }
}

export class StepEvaluationError extends FlowForgeError {
  constructor(stepId: string, message: string, details?: unknown) {
    super('STEP_EVALUATION_ERROR', message, { stepId, ...details });
    this.name = 'StepEvaluationError';
    Object.setPrototypeOf(this, StepEvaluationError.prototype);
  }
}

export class MaxRetriesExceededError extends FlowForgeError {
  constructor(stepId: string, maxRetries: number, lastError?: string) {
    super(
      'MAX_RETRIES_EXCEEDED',
      `Step ${stepId} failed after ${maxRetries} retries`,
      { stepId, maxRetries, lastError }
    );
    this.name = 'MaxRetriesExceededError';
    Object.setPrototypeOf(this, MaxRetriesExceededError.prototype);
  }
}

// ============================================================================
// Provider Errors
// ============================================================================

export class ProviderNotFoundError extends FlowForgeError {
  constructor(providerId: string) {
    super('PROVIDER_NOT_FOUND', `LLM provider not found: ${providerId}`, { providerId });
    this.name = 'ProviderNotFoundError';
    Object.setPrototypeOf(this, ProviderNotFoundError.prototype);
  }
}

export class ProviderAuthError extends FlowForgeError {
  constructor(providerId: string, message: string) {
    super('PROVIDER_AUTH_ERROR', `Authentication failed for provider ${providerId}: ${message}`, {
      providerId,
    });
    this.name = 'ProviderAuthError';
    Object.setPrototypeOf(this, ProviderAuthError.prototype);
  }
}

export class ProviderRateLimitError extends FlowForgeError {
  public readonly retryAfter?: number;

  constructor(providerId: string, retryAfter?: number) {
    super(
      'PROVIDER_RATE_LIMIT',
      `Rate limit exceeded for provider ${providerId}${retryAfter ? `, retry after ${retryAfter}s` : ''}`,
      { providerId, retryAfter }
    );
    this.name = 'ProviderRateLimitError';
    this.retryAfter = retryAfter;
    Object.setPrototypeOf(this, ProviderRateLimitError.prototype);
  }
}

export class ProviderUnavailableError extends FlowForgeError {
  constructor(providerId: string, reason?: string) {
    super(
      'PROVIDER_UNAVAILABLE',
      `Provider ${providerId} is unavailable${reason ? `: ${reason}` : ''}`,
      { providerId, reason }
    );
    this.name = 'ProviderUnavailableError';
    Object.setPrototypeOf(this, ProviderUnavailableError.prototype);
  }
}

// ============================================================================
// Tool Errors
// ============================================================================

export class ToolNotFoundError extends FlowForgeError {
  constructor(toolName: string, serverId: string) {
    super('TOOL_NOT_FOUND', `Tool not found: ${toolName} on server ${serverId}`, {
      toolName,
      serverId,
    });
    this.name = 'ToolNotFoundError';
    Object.setPrototypeOf(this, ToolNotFoundError.prototype);
  }
}

export class ToolExecutionError extends FlowForgeError {
  constructor(toolName: string, serverId: string, message: string, details?: unknown) {
    super('TOOL_EXECUTION_ERROR', `Tool execution failed: ${message}`, {
      toolName,
      serverId,
      ...details,
    });
    this.name = 'ToolExecutionError';
    Object.setPrototypeOf(this, ToolExecutionError.prototype);
  }
}

export class ServerNotConnectedError extends FlowForgeError {
  constructor(serverId: string) {
    super('SERVER_NOT_CONNECTED', `MCP server not connected: ${serverId}`, { serverId });
    this.name = 'ServerNotConnectedError';
    Object.setPrototypeOf(this, ServerNotConnectedError.prototype);
  }
}

// ============================================================================
// Checkpoint Errors
// ============================================================================

export class CheckpointNotFoundError extends FlowForgeError {
  constructor(checkpointId: string) {
    super('CHECKPOINT_NOT_FOUND', `Checkpoint not found: ${checkpointId}`, { checkpointId });
    this.name = 'CheckpointNotFoundError';
    Object.setPrototypeOf(this, CheckpointNotFoundError.prototype);
  }
}

export class CheckpointCorruptedError extends FlowForgeError {
  constructor(checkpointId: string, reason: string) {
    super('CHECKPOINT_CORRUPTED', `Checkpoint corrupted: ${reason}`, { checkpointId, reason });
    this.name = 'CheckpointCorruptedError';
    Object.setPrototypeOf(this, CheckpointCorruptedError.prototype);
  }
}

// ============================================================================
// Planning Errors
// ============================================================================

export class PlanningSessionNotFoundError extends FlowForgeError {
  constructor(sessionId: string) {
    super('PLANNING_SESSION_NOT_FOUND', `Planning session not found: ${sessionId}`, { sessionId });
    this.name = 'PlanningSessionNotFoundError';
    Object.setPrototypeOf(this, PlanningSessionNotFoundError.prototype);
  }
}

export class PlanningSessionClosedError extends FlowForgeError {
  constructor(sessionId: string) {
    super('PLANNING_SESSION_CLOSED', `Planning session is already closed: ${sessionId}`, {
      sessionId,
    });
    this.name = 'PlanningSessionClosedError';
    Object.setPrototypeOf(this, PlanningSessionClosedError.prototype);
  }
}

// ============================================================================
// Input Validation Errors
// ============================================================================

export class InputValidationError extends FlowForgeError {
  public readonly inputName: string;

  constructor(inputName: string, message: string, details?: unknown) {
    super('INPUT_VALIDATION_ERROR', `Invalid input '${inputName}': ${message}`, {
      inputName,
      ...details,
    });
    this.name = 'InputValidationError';
    this.inputName = inputName;
    Object.setPrototypeOf(this, InputValidationError.prototype);
  }
}

export class MissingInputError extends FlowForgeError {
  constructor(inputName: string) {
    super('MISSING_INPUT', `Required input missing: ${inputName}`, { inputName });
    this.name = 'MissingInputError';
    Object.setPrototypeOf(this, MissingInputError.prototype);
  }
}

// ============================================================================
// Storage Errors
// ============================================================================

export class StorageError extends FlowForgeError {
  constructor(operation: string, message: string, details?: unknown) {
    super('STORAGE_ERROR', `Storage ${operation} failed: ${message}`, { operation, ...details });
    this.name = 'StorageError';
    Object.setPrototypeOf(this, StorageError.prototype);
  }
}

export class LockAcquisitionError extends FlowForgeError {
  constructor(resource: string) {
    super('LOCK_ACQUISITION_ERROR', `Failed to acquire lock on: ${resource}`, { resource });
    this.name = 'LockAcquisitionError';
    Object.setPrototypeOf(this, LockAcquisitionError.prototype);
  }
}

// ============================================================================
// Approval Errors
// ============================================================================

export class ApprovalRequiredError extends FlowForgeError {
  constructor(stepId: string, message: string) {
    super('APPROVAL_REQUIRED', message, { stepId });
    this.name = 'ApprovalRequiredError';
    Object.setPrototypeOf(this, ApprovalRequiredError.prototype);
  }
}

export class ApprovalDeniedError extends FlowForgeError {
  constructor(stepId: string, reason?: string) {
    super('APPROVAL_DENIED', `Approval denied for step ${stepId}${reason ? `: ${reason}` : ''}`, {
      stepId,
      reason,
    });
    this.name = 'ApprovalDeniedError';
    Object.setPrototypeOf(this, ApprovalDeniedError.prototype);
  }
}

// ============================================================================
// Error Type Guards
// ============================================================================

export function isFlowForgeError(error: unknown): error is FlowForgeError {
  return error instanceof FlowForgeError;
}

export function isRetryableError(error: unknown): boolean {
  if (!isFlowForgeError(error)) return false;

  const retryableCodes = [
    'PROVIDER_RATE_LIMIT',
    'PROVIDER_UNAVAILABLE',
    'STEP_TIMEOUT',
    'STORAGE_ERROR',
    'LOCK_ACQUISITION_ERROR',
  ];

  return retryableCodes.includes(error.code);
}

export function getErrorCode(error: unknown): string {
  if (isFlowForgeError(error)) return error.code;
  if (error instanceof Error) return 'UNKNOWN_ERROR';
  return 'UNKNOWN_ERROR';
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'An unknown error occurred';
}
