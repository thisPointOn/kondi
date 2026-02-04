// Workflow Step Editor Types
// Enables independent program development with step verification gates
// and multi-LLM collaboration

export type TagType = 'llm' | 'tool' | 'file' | 'code' | 'custom';

export interface StepTag {
  type: TagType;
  value: string;
  icon?: string;
  metadata?: Record<string, unknown>;
}

export type DiscussionMessageType = 'insight' | 'argument' | 'suggestion' | 'concern';

export interface LLMDiscussion {
  llmId: string;
  llmName: string;
  message: string;
  timestamp: string;
  type: DiscussionMessageType;
}

export interface StepEvaluation {
  verdict: 'pass' | 'fail' | 'partial';
  score: number;
  feedback: string;
  llmVotes?: Record<string, 'pass' | 'fail'>;
}

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'waiting_review';
export type GateType = 'stop' | 'continue';

export interface WorkflowStep {
  id: string;
  name: string;
  description: string;
  successCriteria: string[];

  // Tag categories
  tags: StepTag[];

  // Execution gate
  gate: GateType;

  // Multi-LLM collaboration
  assignedLLMs: string[];
  discussion?: LLMDiscussion[];

  // Execution state
  status: StepStatus;
  output?: string;
  evaluation?: StepEvaluation;
}

export interface ProjectDescription {
  content: string;
  tags: StepTag[];
  sharedContext: string;
}

export type WorkflowStatus = 'draft' | 'ready' | 'running' | 'completed';
export type ExecutionMode = 'sequential' | 'parallel-where-possible';

export interface Workflow {
  id: string;
  name: string;

  // Project description is the first "step" conceptually
  projectDescription: ProjectDescription;

  steps: WorkflowStep[];

  // Global settings
  defaultLLMs: string[];
  executionMode: ExecutionMode;

  status: WorkflowStatus;
  createdAt: string;
  updatedAt: string;
}

// Helper function to create default empty step
export function createEmptyStep(id?: string): WorkflowStep {
  return {
    id: id || crypto.randomUUID(),
    name: 'New Step',
    description: '',
    successCriteria: [],
    tags: [],
    gate: 'continue',
    assignedLLMs: [],
    status: 'pending',
  };
}

// Helper function to create default empty workflow
export function createEmptyWorkflow(id?: string): Workflow {
  return {
    id: id || crypto.randomUUID(),
    name: 'New Workflow',
    projectDescription: {
      content: '',
      tags: [],
      sharedContext: '',
    },
    steps: [],
    defaultLLMs: [],
    executionMode: 'sequential',
    status: 'draft',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// Tag type icons mapping
export const TAG_ICONS: Record<TagType, string> = {
  llm: '🤖',
  tool: '🔧',
  file: '📁',
  code: '💻',
  custom: '🏷️',
};

// Discussion message type styles
export const DISCUSSION_TYPE_STYLES: Record<DiscussionMessageType, { icon: string; color: string }> = {
  insight: { icon: '💡', color: '#3b82f6' },   // blue
  argument: { icon: '⚔️', color: '#f97316' },  // orange
  suggestion: { icon: '💭', color: '#22c55e' }, // green
  concern: { icon: '⚠️', color: '#eab308' },   // yellow
};

// Known LLM options for autocomplete
export const KNOWN_LLMS = [
  // Anthropic - Latest
  { id: 'claude-opus-4-5-20251101', name: 'Claude Opus 4.5', icon: '🧠' },
  { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', icon: '🤖' },
  { id: 'claude-3-5-sonnet-latest', name: 'Claude 3.5 Sonnet', icon: '🤖' },
  { id: 'claude-3-5-haiku-latest', name: 'Claude 3.5 Haiku', icon: '⚡' },
  // OpenAI - Latest
  { id: 'gpt-5.2', name: 'GPT-5.2', icon: '🧠' },
  { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', icon: '💻' },
  { id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max', icon: '🔬' },
  { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini', icon: '⚡' },
  { id: 'gpt-4o', name: 'GPT-4o', icon: '🤖' },
  { id: 'o1-preview', name: 'o1 Preview', icon: '🔬' },
  // Google
  { id: 'gemini-2.0-flash-exp', name: 'Gemini 2.0 Flash', icon: '⚡' },
  { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', icon: '🤖' },
];
