/**
 * Pipeline System: Type Definitions
 * Councils as Workflow Steps — ordered stages with parallel steps
 */

// ============================================================================
// Step & Pipeline Status
// ============================================================================

export type PipelineStepType = 'planning' | 'decisioning' | 'execution' | 'coding' | 'gate';

/** What kind of data a step produces for downstream consumption */
export type OutputType = 'string' | 'file' | 'directory';

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
    outputType?: OutputType; // what kind of data this artifact represents
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
  /** MCP servers this persona can access (undefined = all servers) */
  allowedServerIds?: string[];
  /** Override default tool behavior: 'full' = enable all tools, 'none' = disable tools */
  toolAccess?: 'full' | 'none';
}

// ============================================================================
// Step Configs
// ============================================================================

export interface CouncilStepConfig {
  type: 'planning' | 'coding' | 'decisioning' | 'execution';
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
    /** MCP servers this step can access (undefined = all servers) */
    allowedServerIds?: string[];
  };
  /** Standing instructions — what this step should DO (supplemental to input context) */
  task?: string;
  /** Template that renders previous step outputs as input context */
  inputTemplate: string;
  /** What kind of data this step produces (default: 'string') */
  outputType?: OutputType;
}

export interface LlmStepConfig {
  type: 'decisioning' | 'execution';
  model: string;
  provider: string;
  systemPrompt: string;
  inputTemplate: string;
  workingDirectory?: string;
  directoryConstrained?: boolean;
  /** MCP servers this step can access (undefined = all servers) */
  allowedServerIds?: string[];
}

export interface GateStepConfig {
  type: 'gate';
  approvalPrompt: string;
}

export type StepConfig = CouncilStepConfig | LlmStepConfig | GateStepConfig;

/** Helper: is this a council-based step type? All non-gate types are councils. */
export function isCouncilType(type: PipelineStepType): boolean {
  return type !== 'gate';
}

/** Helper: is this a lightweight council (single-agent, 0-round)? */
export function isLightweightCouncilType(type: PipelineStepType): boolean {
  return type === 'decisioning' || type === 'execution';
}

/**
 * @deprecated Use isLightweightCouncilType instead.
 * Kept for backwards compatibility with existing code.
 */
export function isLlmType(type: PipelineStepType): boolean {
  return type === 'decisioning' || type === 'execution';
}

/**
 * Migrate legacy LlmStepConfig to CouncilStepConfig.
 * Old pipelines may have { type: 'decisioning'|'execution', model, provider, systemPrompt, ... }
 * without a councilSetup. This creates one from the flat fields.
 */
export function migrateLlmConfig(config: LlmStepConfig): CouncilStepConfig {
  const isDecisioning = config.type === 'decisioning';
  return {
    type: config.type,
    councilSetup: {
      name: isDecisioning ? 'Decisioning' : 'Execution',
      personas: [{
        name: isDecisioning ? 'Analyst' : 'Executor',
        role: isDecisioning ? 'manager' : 'worker',
        model: config.model,
        provider: config.provider,
        systemPrompt: config.systemPrompt,
        suppressPersona: true,
      }],
      maxRounds: 0,
      maxRevisions: 0,
      workingDirectory: config.workingDirectory,
      directoryConstrained: config.directoryConstrained,
      allowedServerIds: config.allowedServerIds,
    },
    inputTemplate: config.inputTemplate,
    outputType: 'string',
  };
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

// ============================================================================
// Schedule Config
// ============================================================================

export interface PipelineSchedule {
  enabled: boolean;
  /** Time of day in HH:MM (24-hour) format */
  time: string;
  /** Recurrence mode */
  mode: 'once' | 'daily' | 'weekly';
  /** For 'once' mode: ISO date string (YYYY-MM-DD) */
  date?: string;
  /** For 'weekly' mode: 0 = Sunday, 1 = Monday, ... 6 = Saturday */
  dayOfWeek?: number;
  /** ISO timestamp of the last scheduled run (to avoid double-fires) */
  lastRunAt?: string;
}

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
    schedule?: PipelineSchedule;
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
