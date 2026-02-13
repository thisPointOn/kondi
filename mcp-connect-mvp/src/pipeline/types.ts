/**
 * Pipeline System: Type Definitions
 * Councils as Workflow Steps — ordered stages with parallel steps
 */

// ============================================================================
// Step & Pipeline Status
// ============================================================================

export type PipelineStepType = 'planning' | 'decisioning' | 'execution' | 'coding' | 'gate';

export type PipelineStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'waiting_approval';

export type PipelineStatus =
  | 'draft'
  | 'ready'
  | 'running'
  | 'completed'
  | 'failed'
  | 'paused';

// ============================================================================
// Step Artifacts (output produced by a completed step)
// ============================================================================

export interface StepArtifact {
  stepId: string;
  content: string;
  artifactType: 'decision' | 'output' | 'llm_response' | 'approval';
  metadata?: {
    councilId?: string;
    decisionId?: string;
    outputId?: string;
    model?: string;
    tokensUsed?: number;
    outputPath?: string;   // file path where output was saved (planning/coding steps)
    stepName?: string;     // human-readable name of the producing step
    stepType?: string;     // 'planning' | 'coding' | 'decisioning' | 'execution' | 'gate'
  };
  createdAt: string;
}

// ============================================================================
// Pipeline Persona (full-featured, matches council persona capabilities)
// ============================================================================

export interface PipelinePersona {
  templateId?: string;
  name: string;
  role: 'manager' | 'consultant' | 'worker' | 'reviewer';
  model: string;
  provider: string;
  avatar?: string;
  color?: string;
  systemPrompt?: string;
  stance?: 'advocate' | 'critic' | 'neutral' | 'wildcard';
  traits?: string[];
  interactionStyle?: 'debate' | 'build' | 'question' | 'synthesize' | 'review';
  domain?: string;
  temperature?: number;
  verbosity?: 'concise' | 'balanced' | 'thorough';
  focusArea?: string;
  startingStance?: string;
  suppressPersona?: boolean;
  /** Worker-only: save the worker's output to the working directory (default: true) */
  saveOutput?: boolean;
}

// ============================================================================
// Step Configs
// ============================================================================

export interface CouncilStepConfig {
  type: 'planning' | 'coding';
  councilSetup: {
    name: string;
    personas: PipelinePersona[];
    maxRounds?: number;
    maxRevisions?: number;
    expectedOutput?: string;
    decisionCriteria?: string[];
    workingDirectory?: string;
    directoryConstrained?: boolean;
    // Coding orchestrator config
    testCommand?: string;
    maxDebugCycles?: number;
    maxReviewCycles?: number;
  };
  inputTemplate: string;
  outputSelection: 'decision' | 'output' | 'summary';
}

export interface LlmStepConfig {
  type: 'decisioning' | 'execution';
  model: string;
  provider: string;
  systemPrompt: string;
  inputTemplate: string;
  workingDirectory?: string;
  directoryConstrained?: boolean;
}

export interface GateStepConfig {
  type: 'gate';
  approvalPrompt: string;
}

export type StepConfig = CouncilStepConfig | LlmStepConfig | GateStepConfig;

/** Helper: is this a council-based step type? */
export function isCouncilType(type: PipelineStepType): boolean {
  return type === 'planning' || type === 'coding';
}

/** Helper: is this an LLM (non-council) step type? */
export function isLlmType(type: PipelineStepType): boolean {
  return type === 'decisioning' || type === 'execution';
}

// ============================================================================
// Pipeline Step
// ============================================================================

export interface PipelineStep {
  id: string;
  name: string;
  description?: string;
  config: StepConfig;
  status: PipelineStepStatus;
  artifact?: StepArtifact;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

// ============================================================================
// Pipeline Stage
// ============================================================================

export interface PipelineStage {
  id: string;
  name: string;
  steps: PipelineStep[];
  /** How steps in this stage are executed (default: 'sequential') */
  executionMode?: 'sequential' | 'parallel';
}

// ============================================================================
// Pipeline
// ============================================================================

export interface Pipeline {
  id: string;
  name: string;
  description?: string;
  initialInput: string;
  stages: PipelineStage[];
  settings: {
    workingDirectory?: string;
    directoryConstrained?: boolean;
    failurePolicy: 'stop' | 'skip_step';
  };
  status: PipelineStatus;
  currentStageIndex: number;
  createdAt: string;
  updatedAt: string;
  /** Where this pipeline was executed — 'cli' for CLI-imported sessions */
  source?: 'cli' | 'gui';
}

// ============================================================================
// CLI ↔ GUI Session Export/Import
// ============================================================================

export interface KondiSessionCouncilData {
  ledgerIndex: any;
  ledgerChunks: Record<number, any[]>;
  context: any | null;
  contextHistory: any[];
  contextPatches: any[];
  decision: any | null;
  plan: any | null;
  directive: any | null;
  outputs: any[];
}

export interface KondiSession {
  version: 1;
  exportedAt: string;
  source: 'cli';
  pipeline: Pipeline;
  councils: any[];
  councilData: Record<string, KondiSessionCouncilData>;
  execution: {
    status: 'completed' | 'failed';
    startedAt: string;
    completedAt: string;
    durationMs: number;
    workingDirectory: string;
  };
}
