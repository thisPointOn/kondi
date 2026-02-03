/**
 * FlowForge Planner Parser
 * Parses LLM output into workflow spec changes
 */

import { v4 as uuidv4 } from 'uuid';
import {
  WorkflowSpec,
  Step,
  InputDefinition,
  OutputDefinition,
  ExecutionConfig,
} from '../core/types.js';
import { validateWorkflowSpec, validateStep } from '../core/schema.js';

// ============================================================================
// Parser Types
// ============================================================================

export interface ParseResult {
  success: boolean;
  spec?: Partial<WorkflowSpec>;
  errors?: string[];
  warnings?: string[];
}

export interface StepParseResult {
  success: boolean;
  step?: Step;
  errors?: string[];
}

// ============================================================================
// JSON Extraction
// ============================================================================

/**
 * Extract JSON from LLM response
 * Handles markdown code blocks and raw JSON
 */
export function extractJSON(content: string): string | null {
  // Try to find JSON in code blocks first
  const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  // Try to find raw JSON object
  const objectMatch = content.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    // Verify it's valid JSON
    try {
      JSON.parse(objectMatch[0]);
      return objectMatch[0];
    } catch {
      // Not valid JSON
    }
  }

  // Try to find raw JSON array
  const arrayMatch = content.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      JSON.parse(arrayMatch[0]);
      return arrayMatch[0];
    } catch {
      // Not valid JSON
    }
  }

  return null;
}

/**
 * Parse JSON safely with error handling
 */
export function safeParseJSON<T>(json: string): { success: true; data: T } | { success: false; error: string } {
  try {
    const data = JSON.parse(json) as T;
    return { success: true, data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Invalid JSON',
    };
  }
}

// ============================================================================
// Workflow Spec Parsing
// ============================================================================

/**
 * Parse LLM response into workflow spec
 */
export function parseWorkflowSpec(content: string): ParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Extract JSON
  const jsonStr = extractJSON(content);
  if (!jsonStr) {
    return {
      success: false,
      errors: ['No JSON found in response'],
    };
  }

  // Parse JSON
  const parseResult = safeParseJSON<Record<string, unknown>>(jsonStr);
  if (!parseResult.success) {
    return {
      success: false,
      errors: [`Failed to parse JSON: ${parseResult.error}`],
    };
  }

  const raw = parseResult.data;

  // Normalize the spec
  const spec = normalizeWorkflowSpec(raw, warnings);

  // Validate
  const validation = validateWorkflowSpec(spec);
  if (!validation.success) {
    // Add validation errors but still return partial spec
    for (const issue of validation.error.issues) {
      errors.push(`${issue.path.join('.')}: ${issue.message}`);
    }
  }

  return {
    success: errors.length === 0,
    spec,
    errors: errors.length > 0 ? errors : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Normalize raw spec data into WorkflowSpec shape
 */
function normalizeWorkflowSpec(
  raw: Record<string, unknown>,
  warnings: string[]
): Partial<WorkflowSpec> {
  const now = new Date().toISOString();

  const spec: Partial<WorkflowSpec> = {
    id: typeof raw.id === 'string' ? raw.id : uuidv4(),
    name: typeof raw.name === 'string' ? raw.name : 'Untitled Workflow',
    description: typeof raw.description === 'string' ? raw.description : '',
    version: typeof raw.version === 'string' ? raw.version : '1.0.0',
    status: 'draft',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : now,
    updatedAt: now,
  };

  // Parse inputs
  if (Array.isArray(raw.inputs)) {
    spec.inputs = raw.inputs.map((input) => normalizeInputDefinition(input, warnings));
  }

  // Parse outputs
  if (Array.isArray(raw.outputs)) {
    spec.outputs = raw.outputs.map((output) => normalizeOutputDefinition(output, warnings));
  }

  // Parse steps
  if (Array.isArray(raw.steps)) {
    spec.steps = raw.steps.map((step, index) => normalizeStep(step, index, warnings));
  }

  // Parse config
  if (raw.config && typeof raw.config === 'object') {
    spec.config = normalizeExecutionConfig(raw.config as Record<string, unknown>);
  } else {
    spec.config = getDefaultConfig();
  }

  // Parse metadata
  if (raw.metadata && typeof raw.metadata === 'object') {
    spec.metadata = raw.metadata as WorkflowSpec['metadata'];
  }

  return spec;
}

/**
 * Normalize input definition
 */
function normalizeInputDefinition(
  raw: unknown,
  warnings: string[]
): InputDefinition {
  if (typeof raw !== 'object' || raw === null) {
    warnings.push('Invalid input definition, using default');
    return {
      name: 'unknown',
      type: 'string',
      description: '',
      required: false,
    };
  }

  const obj = raw as Record<string, unknown>;

  return {
    name: typeof obj.name === 'string' ? obj.name : 'unnamed_input',
    type: isValidInputType(obj.type) ? obj.type : 'string',
    description: typeof obj.description === 'string' ? obj.description : '',
    required: obj.required === true,
    default: obj.default,
    validation: obj.validation as InputDefinition['validation'],
  };
}

/**
 * Normalize output definition
 */
function normalizeOutputDefinition(
  raw: unknown,
  warnings: string[]
): OutputDefinition {
  if (typeof raw !== 'object' || raw === null) {
    warnings.push('Invalid output definition, using default');
    return {
      name: 'unknown',
      type: 'string',
      description: '',
    };
  }

  const obj = raw as Record<string, unknown>;

  return {
    name: typeof obj.name === 'string' ? obj.name : 'unnamed_output',
    type: isValidInputType(obj.type) ? obj.type : 'string',
    description: typeof obj.description === 'string' ? obj.description : '',
    fromStep: typeof obj.fromStep === 'string' ? obj.fromStep : undefined,
  };
}

/**
 * Normalize step
 */
function normalizeStep(raw: unknown, index: number, warnings: string[]): Step {
  if (typeof raw !== 'object' || raw === null) {
    warnings.push(`Invalid step at index ${index}, using default`);
    return createDefaultStep(index);
  }

  const obj = raw as Record<string, unknown>;

  const step: Step = {
    id: typeof obj.id === 'string' ? obj.id : `step_${index + 1}`,
    name: typeof obj.name === 'string' ? obj.name : `Step ${index + 1}`,
    type: isValidStepType(obj.type) ? obj.type : 'llm',
    description: typeof obj.description === 'string' ? obj.description : '',
    config: normalizeStepConfig(obj.config, obj.type as string),
  };

  // Optional fields
  if (Array.isArray(obj.inputs)) {
    step.inputs = obj.inputs as Step['inputs'];
  }
  if (Array.isArray(obj.outputs)) {
    step.outputs = obj.outputs as Step['outputs'];
  }
  if (typeof obj.successCriteria === 'string') {
    step.successCriteria = obj.successCriteria;
  }
  if (typeof obj.evaluationModel === 'string') {
    step.evaluationModel = obj.evaluationModel;
  }
  if (typeof obj.maxRetries === 'number') {
    step.maxRetries = obj.maxRetries;
  }
  if (typeof obj.retryDelay === 'number') {
    step.retryDelay = obj.retryDelay;
  }
  if (typeof obj.timeout === 'number') {
    step.timeout = obj.timeout;
  }
  if (obj.condition) {
    step.condition = obj.condition as Step['condition'];
  }
  if (obj.requiresApproval === true) {
    step.requiresApproval = true;
    if (typeof obj.approvalMessage === 'string') {
      step.approvalMessage = obj.approvalMessage;
    }
  }
  if (Array.isArray(obj.blockedBy)) {
    step.blockedBy = obj.blockedBy.filter((b): b is string => typeof b === 'string');
  }
  if (obj.parallelizable === true) {
    step.parallelizable = true;
  }

  return step;
}

/**
 * Normalize step config
 */
function normalizeStepConfig(raw: unknown, stepType: string): Step['config'] {
  const config: Step['config'] = {};

  if (typeof raw !== 'object' || raw === null) {
    return config;
  }

  const obj = raw as Record<string, unknown>;

  // LLM config
  if (typeof obj.provider === 'string') config.provider = obj.provider;
  if (typeof obj.model === 'string') config.model = obj.model;
  if (typeof obj.systemPrompt === 'string') config.systemPrompt = obj.systemPrompt;
  if (typeof obj.userPrompt === 'string') config.userPrompt = obj.userPrompt;
  if (typeof obj.temperature === 'number') config.temperature = obj.temperature;
  if (typeof obj.maxTokens === 'number') config.maxTokens = obj.maxTokens;

  // Tool config
  if (typeof obj.serverId === 'string') config.serverId = obj.serverId;
  if (typeof obj.toolName === 'string') config.toolName = obj.toolName;
  if (obj.toolArguments && typeof obj.toolArguments === 'object') {
    config.toolArguments = obj.toolArguments as Record<string, unknown>;
  }

  // Human config
  if (typeof obj.prompt === 'string') config.prompt = obj.prompt;
  if (isValidInputType(obj.inputType)) config.inputType = obj.inputType;

  // Conditional config
  if (Array.isArray(obj.branches)) {
    config.branches = obj.branches as Step['config']['branches'];
  }

  // Parallel config
  if (Array.isArray(obj.parallelSteps)) {
    config.parallelSteps = obj.parallelSteps.filter((s): s is string => typeof s === 'string');
  }
  if (typeof obj.agentCount === 'number') config.agentCount = obj.agentCount;

  return config;
}

/**
 * Normalize execution config
 */
function normalizeExecutionConfig(raw: Record<string, unknown>): ExecutionConfig {
  return {
    defaultProvider:
      typeof raw.defaultProvider === 'string' ? raw.defaultProvider : 'anthropic',
    defaultModel:
      typeof raw.defaultModel === 'string'
        ? raw.defaultModel
        : 'claude-3-5-sonnet-latest',
    defaultMaxRetries:
      typeof raw.defaultMaxRetries === 'number' ? raw.defaultMaxRetries : 3,
    defaultRetryDelay:
      typeof raw.defaultRetryDelay === 'number' ? raw.defaultRetryDelay : 1000,
    defaultTimeout:
      typeof raw.defaultTimeout === 'number' ? raw.defaultTimeout : 30000,
    evaluationModel:
      typeof raw.evaluationModel === 'string' ? raw.evaluationModel : undefined,
    parallelExecution: raw.parallelExecution === true,
    checkpointEnabled: raw.checkpointEnabled !== false,
    maxConcurrentSteps:
      typeof raw.maxConcurrentSteps === 'number' ? raw.maxConcurrentSteps : 1,
  };
}

/**
 * Get default execution config
 */
function getDefaultConfig(): ExecutionConfig {
  return {
    defaultProvider: 'anthropic',
    defaultModel: 'claude-3-5-sonnet-latest',
    defaultMaxRetries: 3,
    defaultRetryDelay: 1000,
    defaultTimeout: 30000,
    parallelExecution: false,
    checkpointEnabled: true,
    maxConcurrentSteps: 1,
  };
}

/**
 * Create default step
 */
function createDefaultStep(index: number): Step {
  return {
    id: `step_${index + 1}`,
    name: `Step ${index + 1}`,
    type: 'llm',
    description: '',
    config: {},
  };
}

// ============================================================================
// Step Parsing
// ============================================================================

/**
 * Parse a single step from LLM response
 */
export function parseStep(content: string): StepParseResult {
  const jsonStr = extractJSON(content);
  if (!jsonStr) {
    return {
      success: false,
      errors: ['No JSON found in response'],
    };
  }

  const parseResult = safeParseJSON<Record<string, unknown>>(jsonStr);
  if (!parseResult.success) {
    return {
      success: false,
      errors: [`Failed to parse JSON: ${parseResult.error}`],
    };
  }

  const warnings: string[] = [];
  const step = normalizeStep(parseResult.data, 0, warnings);

  const validation = validateStep(step);
  if (!validation.success) {
    return {
      success: false,
      step,
      errors: validation.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }

  return {
    success: true,
    step,
  };
}

// ============================================================================
// Type Guards
// ============================================================================

function isValidInputType(type: unknown): type is InputDefinition['type'] {
  return ['string', 'number', 'boolean', 'array', 'object', 'file'].includes(
    type as string
  );
}

function isValidStepType(type: unknown): type is Step['type'] {
  return ['llm', 'tool', 'human', 'conditional', 'parallel'].includes(type as string);
}

// ============================================================================
// Spec Validation
// ============================================================================

export interface ValidationResult {
  valid: boolean;
  issues: string[];
  suggestions: string[];
  missingFields: string[];
}

/**
 * Parse validation response from LLM
 */
export function parseValidationResponse(content: string): ValidationResult {
  const jsonStr = extractJSON(content);
  if (!jsonStr) {
    return {
      valid: false,
      issues: ['Could not parse validation response'],
      suggestions: [],
      missingFields: [],
    };
  }

  const parseResult = safeParseJSON<Record<string, unknown>>(jsonStr);
  if (!parseResult.success) {
    return {
      valid: false,
      issues: [`Invalid validation response: ${parseResult.error}`],
      suggestions: [],
      missingFields: [],
    };
  }

  const data = parseResult.data;

  return {
    valid: data.valid === true,
    issues: Array.isArray(data.issues) ? data.issues.filter((i): i is string => typeof i === 'string') : [],
    suggestions: Array.isArray(data.suggestions) ? data.suggestions.filter((s): s is string => typeof s === 'string') : [],
    missingFields: Array.isArray(data.missingFields) ? data.missingFields.filter((f): f is string => typeof f === 'string') : [],
  };
}

// ============================================================================
// Spec Comparison
// ============================================================================

/**
 * Find differences between two specs
 */
export function diffSpecs(
  oldSpec: Partial<WorkflowSpec>,
  newSpec: Partial<WorkflowSpec>
): {
  added: string[];
  removed: string[];
  modified: string[];
} {
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];

  // Compare basic fields
  const fields = ['name', 'description', 'version'] as const;
  for (const field of fields) {
    if (oldSpec[field] !== newSpec[field]) {
      modified.push(field);
    }
  }

  // Compare steps
  const oldStepIds = new Set(oldSpec.steps?.map((s) => s.id) || []);
  const newStepIds = new Set(newSpec.steps?.map((s) => s.id) || []);

  for (const id of newStepIds) {
    if (!oldStepIds.has(id)) {
      added.push(`step:${id}`);
    }
  }

  for (const id of oldStepIds) {
    if (!newStepIds.has(id)) {
      removed.push(`step:${id}`);
    }
  }

  // Compare inputs
  const oldInputNames = new Set(oldSpec.inputs?.map((i) => i.name) || []);
  const newInputNames = new Set(newSpec.inputs?.map((i) => i.name) || []);

  for (const name of newInputNames) {
    if (!oldInputNames.has(name)) {
      added.push(`input:${name}`);
    }
  }

  for (const name of oldInputNames) {
    if (!newInputNames.has(name)) {
      removed.push(`input:${name}`);
    }
  }

  return { added, removed, modified };
}
