/**
 * FlowForge Zod Validation Schemas
 */

import { z } from 'zod';

// ============================================================================
// Basic Types
// ============================================================================

export const InputTypeSchema = z.enum(['string', 'number', 'boolean', 'array', 'object', 'file']);

export const WorkflowStatusSchema = z.enum(['draft', 'ready', 'archived']);

export const StepTypeSchema = z.enum(['llm', 'tool', 'human', 'conditional', 'parallel']);

export const StepStatusSchema = z.enum([
  'pending',
  'running',
  'evaluating',
  'retrying',
  'waiting_approval',
  'completed',
  'failed',
  'skipped',
]);

export const ExecutionStatusSchema = z.enum([
  'pending',
  'running',
  'paused',
  'waiting_approval',
  'completed',
  'failed',
  'aborted',
]);

export const EvaluationVerdictSchema = z.enum(['PASS', 'FAIL', 'PARTIAL']);

// ============================================================================
// Validation Rule Schema
// ============================================================================

export const ValidationRuleSchema = z.object({
  pattern: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  enum: z.array(z.unknown()).optional(),
  custom: z.string().optional(),
});

// ============================================================================
// Input/Output Definition Schemas
// ============================================================================

export const InputDefinitionSchema = z.object({
  name: z.string().min(1, 'Input name is required'),
  type: InputTypeSchema,
  description: z.string(),
  required: z.boolean(),
  default: z.unknown().optional(),
  validation: ValidationRuleSchema.optional(),
});

export const OutputDefinitionSchema = z.object({
  name: z.string().min(1, 'Output name is required'),
  type: InputTypeSchema,
  description: z.string(),
  fromStep: z.string().optional(),
});

// ============================================================================
// Step Input/Output Schemas
// ============================================================================

export const InputSourceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('workflow_input'),
    name: z.string(),
  }),
  z.object({
    type: z.literal('step_output'),
    stepId: z.string(),
    outputName: z.string(),
  }),
  z.object({
    type: z.literal('literal'),
    value: z.unknown(),
  }),
  z.object({
    type: z.literal('template'),
    template: z.string(),
  }),
]);

export const StepInputSchema = z.object({
  name: z.string(),
  source: InputSourceSchema,
});

export const StepOutputSchema = z.object({
  name: z.string(),
  path: z.string().optional(),
});

// ============================================================================
// Step Condition Schema
// ============================================================================

export const StepConditionSchema = z.object({
  type: z.enum(['expression', 'step_status', 'input_value']),
  expression: z.string().optional(),
  stepId: z.string().optional(),
  status: StepStatusSchema.optional(),
  inputName: z.string().optional(),
  operator: z.enum(['eq', 'neq', 'gt', 'lt', 'gte', 'lte', 'contains', 'exists']).optional(),
  value: z.unknown().optional(),
});

// ============================================================================
// Conditional Branch Schema
// ============================================================================

export const ConditionalBranchSchema = z.object({
  condition: z.string(),
  stepId: z.string(),
});

// ============================================================================
// Step Config Schema
// ============================================================================

export const StepConfigSchema = z.object({
  // LLM step config
  provider: z.string().optional(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  userPrompt: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().positive().optional(),

  // Tool step config
  serverId: z.string().optional(),
  toolName: z.string().optional(),
  toolArguments: z.record(z.unknown()).optional(),

  // Human step config
  prompt: z.string().optional(),
  inputType: InputTypeSchema.optional(),

  // Conditional step config
  branches: z.array(ConditionalBranchSchema).optional(),

  // Parallel step config
  parallelSteps: z.array(z.string()).optional(),
  agentCount: z.number().positive().optional(),
});

// ============================================================================
// Step Schema
// ============================================================================

export const StepSchema = z.object({
  id: z.string().min(1, 'Step ID is required'),
  name: z.string().min(1, 'Step name is required'),
  type: StepTypeSchema,
  description: z.string(),
  config: StepConfigSchema,
  inputs: z.array(StepInputSchema).optional(),
  outputs: z.array(StepOutputSchema).optional(),
  successCriteria: z.string().optional(),
  evaluationModel: z.string().optional(),
  maxRetries: z.number().int().min(0).optional(),
  retryDelay: z.number().positive().optional(),
  timeout: z.number().positive().optional(),
  condition: StepConditionSchema.optional(),
  requiresApproval: z.boolean().optional(),
  approvalMessage: z.string().optional(),
  blockedBy: z.array(z.string()).optional(),
  parallelizable: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
});

// ============================================================================
// Execution Config Schema
// ============================================================================

export const ExecutionConfigSchema = z.object({
  defaultProvider: z.string().default('anthropic'),
  defaultModel: z.string().default('claude-3-5-sonnet-latest'),
  defaultMaxRetries: z.number().int().min(0).default(3),
  defaultRetryDelay: z.number().positive().default(1000),
  defaultTimeout: z.number().positive().default(30000),
  evaluationModel: z.string().optional(),
  parallelExecution: z.boolean().default(false),
  checkpointEnabled: z.boolean().default(true),
  maxConcurrentSteps: z.number().int().positive().default(1),
});

// ============================================================================
// Workflow Metadata Schema
// ============================================================================

export const WorkflowMetadataSchema = z.object({
  author: z.string().optional(),
  tags: z.array(z.string()).optional(),
  category: z.string().optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
  estimatedDuration: z.number().positive().optional(),
}).passthrough();

// ============================================================================
// Workflow Spec Schema
// ============================================================================

export const WorkflowSpecSchema = z.object({
  id: z.string().min(1, 'Workflow ID is required'),
  name: z.string().min(1, 'Workflow name is required'),
  description: z.string(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'Version must be in semver format (x.y.z)'),
  status: WorkflowStatusSchema,
  inputs: z.array(InputDefinitionSchema),
  outputs: z.array(OutputDefinitionSchema),
  steps: z.array(StepSchema).min(1, 'At least one step is required'),
  config: ExecutionConfigSchema,
  metadata: WorkflowMetadataSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

// ============================================================================
// Evaluation Result Schema
// ============================================================================

export const CriterionResultSchema = z.object({
  criterion: z.string(),
  met: z.boolean(),
  explanation: z.string(),
});

export const EvaluationResultSchema = z.object({
  verdict: EvaluationVerdictSchema,
  score: z.number().min(0).max(100),
  criteriaResults: z.array(CriterionResultSchema),
  feedback: z.string().optional(),
  suggestion: z.string().optional(),
  evaluatedAt: z.string().datetime(),
  evaluationModel: z.string(),
});

// ============================================================================
// Attempt Record Schema
// ============================================================================

export const AttemptRecordSchema = z.object({
  attemptNumber: z.number().int().positive(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  output: z.unknown().optional(),
  evaluation: EvaluationResultSchema.optional(),
  error: z.string().optional(),
  retryFeedback: z.string().optional(),
});

// ============================================================================
// Step State Schema
// ============================================================================

export const StepStateSchema = z.object({
  stepId: z.string(),
  status: StepStatusSchema,
  attempts: z.array(AttemptRecordSchema),
  currentAttempt: z.number().int().min(0),
  output: z.unknown().optional(),
  error: z.string().optional(),
  startedAt: z.string().datetime().optional(),
  completedAt: z.string().datetime().optional(),
  approvedAt: z.string().datetime().optional(),
  approvedBy: z.string().optional(),
  skipped: z.boolean().optional(),
  skipReason: z.string().optional(),
});

// ============================================================================
// Execution Error Schema
// ============================================================================

export const ExecutionErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  stepId: z.string().optional(),
  details: z.unknown().optional(),
});

// ============================================================================
// Execution Metadata Schema
// ============================================================================

export const ExecutionMetadataSchema = z.object({
  triggeredBy: z.string().optional(),
  triggerType: z.enum(['manual', 'scheduled', 'webhook', 'api']).optional(),
  parentExecutionId: z.string().optional(),
  tags: z.array(z.string()).optional(),
}).passthrough();

// ============================================================================
// Workflow State Schema
// ============================================================================

export const WorkflowStateSchema = z.object({
  executionId: z.string(),
  workflowId: z.string(),
  status: ExecutionStatusSchema,
  inputs: z.record(z.unknown()),
  outputs: z.record(z.unknown()),
  steps: z.record(StepStateSchema),
  currentStepId: z.string().optional(),
  error: ExecutionErrorSchema.optional(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  checkpointId: z.string().optional(),
  metadata: ExecutionMetadataSchema.optional(),
});

// ============================================================================
// Checkpoint Schema
// ============================================================================

export const CheckpointSchema = z.object({
  id: z.string(),
  executionId: z.string(),
  workflowId: z.string(),
  state: WorkflowStateSchema,
  createdAt: z.string().datetime(),
  stepId: z.string(),
  description: z.string().optional(),
});

// ============================================================================
// Planning Session Schemas
// ============================================================================

export const PlanningStatusSchema = z.enum(['active', 'completed', 'abandoned']);

export const PlanningMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  timestamp: z.string().datetime(),
  specUpdate: WorkflowSpecSchema.partial().optional(),
});

export const PlanningSessionSchema = z.object({
  id: z.string(),
  status: PlanningStatusSchema,
  messages: z.array(PlanningMessageSchema),
  currentSpec: WorkflowSpecSchema.partial().optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

// ============================================================================
// API Request Schemas
// ============================================================================

export const CreateWorkflowRequestSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  description: z.string(),
  inputs: z.array(InputDefinitionSchema).optional(),
  outputs: z.array(OutputDefinitionSchema).optional(),
  steps: z.array(StepSchema).optional(),
  config: ExecutionConfigSchema.partial().optional(),
  metadata: WorkflowMetadataSchema.optional(),
});

export const UpdateWorkflowRequestSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  status: WorkflowStatusSchema.optional(),
  inputs: z.array(InputDefinitionSchema).optional(),
  outputs: z.array(OutputDefinitionSchema).optional(),
  steps: z.array(StepSchema).optional(),
  config: ExecutionConfigSchema.partial().optional(),
  metadata: WorkflowMetadataSchema.optional(),
});

export const ExecuteWorkflowRequestSchema = z.object({
  inputs: z.record(z.unknown()),
  config: ExecutionConfigSchema.partial().optional(),
  metadata: ExecutionMetadataSchema.optional(),
});

export const ResumeExecutionRequestSchema = z.object({
  checkpointId: z.string().optional(),
  modifiedInputs: z.record(z.unknown()).optional(),
});

export const ApproveStepRequestSchema = z.object({
  approved: z.boolean(),
  comment: z.string().optional(),
  modifiedOutput: z.unknown().optional(),
});

export const PlannerMessageRequestSchema = z.object({
  message: z.string().min(1, 'Message is required'),
  specEdit: WorkflowSpecSchema.partial().optional(),
});

// ============================================================================
// Validation Helpers
// ============================================================================

export function validateWorkflowSpec(data: unknown) {
  return WorkflowSpecSchema.safeParse(data);
}

export function validateStep(data: unknown) {
  return StepSchema.safeParse(data);
}

export function validateWorkflowState(data: unknown) {
  return WorkflowStateSchema.safeParse(data);
}

export function validateEvaluationResult(data: unknown) {
  return EvaluationResultSchema.safeParse(data);
}

export function validateCreateWorkflowRequest(data: unknown) {
  return CreateWorkflowRequestSchema.safeParse(data);
}

export function validateExecuteWorkflowRequest(data: unknown) {
  return ExecuteWorkflowRequestSchema.safeParse(data);
}

// ============================================================================
// Type Exports from Schemas
// ============================================================================

export type WorkflowSpecInput = z.input<typeof WorkflowSpecSchema>;
export type WorkflowSpecOutput = z.output<typeof WorkflowSpecSchema>;
export type StepInput = z.input<typeof StepSchema>;
export type StepOutput = z.output<typeof StepSchema>;
export type ExecutionConfigInput = z.input<typeof ExecutionConfigSchema>;
export type ExecutionConfigOutput = z.output<typeof ExecutionConfigSchema>;
