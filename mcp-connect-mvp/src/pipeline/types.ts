/**
 * Pipeline System: Type Definitions
 * Councils as Workflow Steps — ordered stages with parallel steps
 */

// ============================================================================
// Step & Pipeline Status
// ============================================================================

export type PipelineStepType = 'council' | 'execution' | 'gate';

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
  };
  createdAt: string;
}

// ============================================================================
// Step Configs
// ============================================================================

export interface CouncilStepConfig {
  type: 'council';
  councilSetup: {
    name: string;
    personas: Array<{
      templateId?: string;
      name: string;
      role: 'manager' | 'consultant' | 'worker';
      model: string;
      provider: string;
    }>;
    maxRounds?: number;
    maxRevisions?: number;
    expectedOutput?: string;
    decisionCriteria?: string[];
    workingDirectory?: string;
  };
  inputTemplate: string;
  outputSelection: 'decision' | 'output' | 'summary';
}

export interface ExecutionStepConfig {
  type: 'execution';
  model: string;
  provider: string;
  systemPrompt: string;
  inputTemplate: string;
  workingDirectory?: string;
}

export interface GateStepConfig {
  type: 'gate';
  approvalPrompt: string;
}

export type StepConfig = CouncilStepConfig | ExecutionStepConfig | GateStepConfig;

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
    failurePolicy: 'stop' | 'skip_step';
  };
  status: PipelineStatus;
  currentStageIndex: number;
  createdAt: string;
  updatedAt: string;
}
