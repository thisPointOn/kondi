/**
 * FlowForge Core Types
 * Self-healing LLM workflow orchestration system
 */

// ============================================================================
// Workflow Specification Types
// ============================================================================

export interface WorkflowSpec {
  id: string;
  name: string;
  description: string;
  version: string;
  status: WorkflowStatus;
  inputs: InputDefinition[];
  outputs: OutputDefinition[];
  steps: Step[];
  config: ExecutionConfig;
  metadata?: WorkflowMetadata;
  createdAt: string;
  updatedAt: string;
}

export type WorkflowStatus = 'draft' | 'ready' | 'archived';

export interface InputDefinition {
  name: string;
  type: InputType;
  description: string;
  required: boolean;
  default?: unknown;
  validation?: ValidationRule;
}

export type InputType = 'string' | 'number' | 'boolean' | 'array' | 'object' | 'file';

export interface ValidationRule {
  pattern?: string;
  min?: number;
  max?: number;
  enum?: unknown[];
  custom?: string;
}

export interface OutputDefinition {
  name: string;
  type: InputType;
  description: string;
  fromStep?: string;
}

export interface Step {
  id: string;
  name: string;
  type: StepType;
  description: string;
  config: StepConfig;
  inputs?: StepInput[];
  outputs?: StepOutput[];
  successCriteria?: string;
  evaluationModel?: string;
  maxRetries?: number;
  retryDelay?: number;
  timeout?: number;
  condition?: StepCondition;
  requiresApproval?: boolean;
  approvalMessage?: string;
  blockedBy?: string[];
  parallelizable?: boolean;
  metadata?: Record<string, unknown>;
}

export type StepType = 'llm' | 'tool' | 'human' | 'conditional' | 'parallel';

export interface StepConfig {
  // LLM step config
  provider?: string;
  model?: string;
  systemPrompt?: string;
  userPrompt?: string;
  temperature?: number;
  maxTokens?: number;

  // Tool step config
  serverId?: string;
  toolName?: string;
  toolArguments?: Record<string, unknown>;

  // Human step config
  prompt?: string;
  inputType?: InputType;

  // Conditional step config
  branches?: ConditionalBranch[];

  // Parallel step config
  parallelSteps?: string[];
  agentCount?: number;
}

export interface ConditionalBranch {
  condition: string;
  stepId: string;
}

export interface StepInput {
  name: string;
  source: InputSource;
}

export type InputSource =
  | { type: 'workflow_input'; name: string }
  | { type: 'step_output'; stepId: string; outputName: string }
  | { type: 'literal'; value: unknown }
  | { type: 'template'; template: string };

export interface StepOutput {
  name: string;
  path?: string;
}

export interface StepCondition {
  type: 'expression' | 'step_status' | 'input_value';
  expression?: string;
  stepId?: string;
  status?: StepStatus;
  inputName?: string;
  operator?: 'eq' | 'neq' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains' | 'exists';
  value?: unknown;
}

export interface ExecutionConfig {
  defaultProvider: string;
  defaultModel: string;
  defaultMaxRetries: number;
  defaultRetryDelay: number;
  defaultTimeout: number;
  evaluationModel?: string;
  parallelExecution: boolean;
  checkpointEnabled: boolean;
  maxConcurrentSteps: number;
}

export interface WorkflowMetadata {
  author?: string;
  tags?: string[];
  category?: string;
  icon?: string;
  color?: string;
  estimatedDuration?: number;
  [key: string]: unknown;
}

// ============================================================================
// Workflow State Types
// ============================================================================

export interface WorkflowState {
  executionId: string;
  workflowId: string;
  status: ExecutionStatus;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  steps: Record<string, StepState>;
  currentStepId?: string;
  error?: ExecutionError;
  startedAt: string;
  completedAt?: string;
  checkpointId?: string;
  metadata?: ExecutionMetadata;
}

export type ExecutionStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'aborted';

export interface StepState {
  stepId: string;
  status: StepStatus;
  attempts: AttemptRecord[];
  currentAttempt: number;
  output?: unknown;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  approvedAt?: string;
  approvedBy?: string;
  skipped?: boolean;
  skipReason?: string;
}

export type StepStatus =
  | 'pending'
  | 'running'
  | 'evaluating'
  | 'retrying'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface AttemptRecord {
  attemptNumber: number;
  startedAt: string;
  completedAt?: string;
  output?: unknown;
  evaluation?: EvaluationResult;
  error?: string;
  retryFeedback?: string;
}

export interface EvaluationResult {
  verdict: EvaluationVerdict;
  score: number;
  criteriaResults: CriterionResult[];
  feedback?: string;
  suggestion?: string;
  evaluatedAt: string;
  evaluationModel: string;
}

export type EvaluationVerdict = 'PASS' | 'FAIL' | 'PARTIAL';

export interface CriterionResult {
  criterion: string;
  met: boolean;
  explanation: string;
}

export interface ExecutionError {
  code: string;
  message: string;
  stepId?: string;
  details?: unknown;
}

export interface ExecutionMetadata {
  triggeredBy?: string;
  triggerType?: 'manual' | 'scheduled' | 'webhook' | 'api';
  parentExecutionId?: string;
  tags?: string[];
  [key: string]: unknown;
}

// ============================================================================
// Checkpoint Types
// ============================================================================

export interface Checkpoint {
  id: string;
  executionId: string;
  workflowId: string;
  state: WorkflowState;
  createdAt: string;
  stepId: string;
  description?: string;
}

// ============================================================================
// Execution History Types
// ============================================================================

export interface ExecutionHistory {
  executionId: string;
  workflowId: string;
  workflowName: string;
  status: ExecutionStatus;
  startedAt: string;
  completedAt?: string;
  duration?: number;
  stepsCompleted: number;
  totalSteps: number;
  triggeredBy?: string;
  error?: string;
}

// ============================================================================
// Event Types
// ============================================================================

export type ExecutorEvent =
  | WorkflowStartedEvent
  | StepStartedEvent
  | StepProgressEvent
  | StepCompletedEvent
  | StepFailedEvent
  | StepRetryEvent
  | ApprovalNeededEvent
  | WorkflowCompletedEvent
  | WorkflowFailedEvent
  | WorkflowAbortedEvent
  | CheckpointCreatedEvent;

export interface WorkflowStartedEvent {
  type: 'workflow-started';
  executionId: string;
  workflowId: string;
  timestamp: string;
}

export interface StepStartedEvent {
  type: 'step-started';
  executionId: string;
  workflowId: string;
  stepId: string;
  stepName: string;
  timestamp: string;
}

export interface StepProgressEvent {
  type: 'step-progress';
  executionId: string;
  workflowId: string;
  stepId: string;
  message: string;
  progress?: number;
  timestamp: string;
}

export interface StepCompletedEvent {
  type: 'step-completed';
  executionId: string;
  workflowId: string;
  stepId: string;
  output: unknown;
  evaluation?: EvaluationResult;
  timestamp: string;
}

export interface StepFailedEvent {
  type: 'step-failed';
  executionId: string;
  workflowId: string;
  stepId: string;
  error: string;
  attemptNumber: number;
  willRetry: boolean;
  timestamp: string;
}

export interface StepRetryEvent {
  type: 'step-retry';
  executionId: string;
  workflowId: string;
  stepId: string;
  attemptNumber: number;
  feedback: string;
  timestamp: string;
}

export interface ApprovalNeededEvent {
  type: 'approval-needed';
  executionId: string;
  workflowId: string;
  stepId: string;
  stepName: string;
  message: string;
  context: unknown;
  timestamp: string;
}

export interface WorkflowCompletedEvent {
  type: 'workflow-completed';
  executionId: string;
  workflowId: string;
  outputs: Record<string, unknown>;
  duration: number;
  timestamp: string;
}

export interface WorkflowFailedEvent {
  type: 'workflow-failed';
  executionId: string;
  workflowId: string;
  error: ExecutionError;
  timestamp: string;
}

export interface WorkflowAbortedEvent {
  type: 'workflow-aborted';
  executionId: string;
  workflowId: string;
  reason: string;
  timestamp: string;
}

export interface CheckpointCreatedEvent {
  type: 'checkpoint-created';
  executionId: string;
  workflowId: string;
  checkpointId: string;
  stepId: string;
  timestamp: string;
}

// ============================================================================
// Planning Session Types
// ============================================================================

export interface PlanningSession {
  id: string;
  status: PlanningStatus;
  messages: PlanningMessage[];
  currentSpec?: Partial<WorkflowSpec>;
  createdAt: string;
  updatedAt: string;
}

export type PlanningStatus = 'active' | 'completed' | 'abandoned';

export interface PlanningMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  specUpdate?: Partial<WorkflowSpec>;
}

// ============================================================================
// API Request/Response Types
// ============================================================================

export interface CreateWorkflowRequest {
  name: string;
  description: string;
  inputs?: InputDefinition[];
  outputs?: OutputDefinition[];
  steps?: Step[];
  config?: Partial<ExecutionConfig>;
  metadata?: WorkflowMetadata;
}

export interface UpdateWorkflowRequest {
  name?: string;
  description?: string;
  status?: WorkflowStatus;
  inputs?: InputDefinition[];
  outputs?: OutputDefinition[];
  steps?: Step[];
  config?: Partial<ExecutionConfig>;
  metadata?: WorkflowMetadata;
}

export interface ExecuteWorkflowRequest {
  inputs: Record<string, unknown>;
  config?: Partial<ExecutionConfig>;
  metadata?: ExecutionMetadata;
}

export interface ResumeExecutionRequest {
  checkpointId?: string;
  modifiedInputs?: Record<string, unknown>;
}

export interface ApproveStepRequest {
  approved: boolean;
  comment?: string;
  modifiedOutput?: unknown;
}

export interface PlannerMessageRequest {
  message: string;
  specEdit?: Partial<WorkflowSpec>;
}
