/**
 * FlowForge Kondi Integration Types
 * Type definitions for multi-agent parallel execution
 */

// ============================================================================
// Core Kondi Types
// ============================================================================

/**
 * Agent status in Kondi execution
 */
export type AgentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Agent identity and metadata
 */
export interface KondiAgent {
  /** Unique agent identifier */
  id: string;

  /** Agent index in the pool (0-based) */
  index: number;

  /** Current status */
  status: AgentStatus;

  /** Assigned task description */
  task: string;

  /** When the agent started */
  startedAt?: string;

  /** When the agent completed */
  completedAt?: string;

  /** Error message if failed */
  error?: string;
}

/**
 * Shared context accessible to all agents
 */
export interface SharedContext {
  /** Workflow ID */
  workflowId: string;

  /** Execution ID */
  executionId: string;

  /** Step ID being executed in parallel */
  stepId: string;

  /** Workflow inputs */
  inputs: Record<string, unknown>;

  /** Outputs from previous steps */
  previousOutputs: Record<string, unknown>;

  /** Custom context data */
  custom?: Record<string, unknown>;
}

/**
 * Handoff request to Kondi for parallel execution
 */
export interface KondiHandoff {
  /** Workflow ID */
  workflowId: string;

  /** Execution ID */
  executionId: string;

  /** Step ID being parallelized */
  stepId: string;

  /** Number of agents to spawn */
  agentCount: number;

  /** Shared context for all agents */
  sharedContext: SharedContext;

  /** Task description for each agent */
  task: string;

  /** Success criteria for evaluation */
  successCriteria: string;

  /** Optional per-agent task variations */
  agentTasks?: string[];

  /** Maximum execution time per agent (ms) */
  timeout?: number;

  /** Provider/model configuration */
  config?: {
    provider?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
  };
}

/**
 * Result from a single agent
 */
export interface AgentResult {
  /** Agent ID */
  agentId: string;

  /** Agent index */
  agentIndex: number;

  /** Whether execution succeeded */
  success: boolean;

  /** Output from the agent */
  output?: unknown;

  /** Error message if failed */
  error?: string;

  /** Execution duration (ms) */
  duration: number;

  /** Token usage */
  tokenUsage?: {
    input: number;
    output: number;
  };
}

/**
 * Overall result from Kondi execution
 */
export interface KondiResult {
  /** Execution ID */
  executionId: string;

  /** Step ID */
  stepId: string;

  /** Overall success (all agents succeeded) */
  success: boolean;

  /** Number of successful agents */
  successCount: number;

  /** Total number of agents */
  totalAgents: number;

  /** Individual agent results */
  agentResults: AgentResult[];

  /** Merged output (if applicable) */
  mergedOutput?: unknown;

  /** Total execution duration (ms) */
  duration: number;

  /** Overall error message if failed */
  error?: string;
}

// ============================================================================
// Kondi Events
// ============================================================================

/**
 * Events emitted during Kondi execution
 */
export type KondiEvent =
  | {
      type: 'kondi-started';
      executionId: string;
      stepId: string;
      agentCount: number;
    }
  | {
      type: 'agent-started';
      executionId: string;
      stepId: string;
      agentId: string;
      agentIndex: number;
    }
  | {
      type: 'agent-progress';
      executionId: string;
      stepId: string;
      agentId: string;
      message: string;
    }
  | {
      type: 'agent-completed';
      executionId: string;
      stepId: string;
      agentId: string;
      agentIndex: number;
      success: boolean;
      output?: unknown;
      error?: string;
    }
  | {
      type: 'kondi-completed';
      executionId: string;
      stepId: string;
      result: KondiResult;
    };

// ============================================================================
// Kondi Configuration
// ============================================================================

/**
 * Configuration for Kondi adapter
 */
export interface KondiConfig {
  /** Maximum concurrent agents */
  maxConcurrentAgents?: number;

  /** Default timeout per agent (ms) */
  defaultTimeout?: number;

  /** Whether to fail fast on first agent failure */
  failFast?: boolean;

  /** Event handler for Kondi events */
  onEvent?: (event: KondiEvent) => void;

  /** Provider configuration */
  provider?: {
    default?: string;
    fallback?: string;
  };

  /** Output merging strategy */
  mergeStrategy?: 'concat' | 'first' | 'last' | 'custom';

  /** Custom merge function */
  customMerge?: (results: AgentResult[]) => unknown;
}

// ============================================================================
// Parallel Step Detection
// ============================================================================

/**
 * A group of steps that can execute in parallel
 */
export interface ParallelGroup {
  /** Unique group identifier */
  id: string;

  /** Step IDs in this group */
  stepIds: string[];

  /** Steps that must complete before this group */
  blockedBy: string[];

  /** Whether all steps in the group are independent */
  fullyIndependent: boolean;
}

/**
 * Result of analyzing workflow for parallelization
 */
export interface ParallelAnalysis {
  /** Original step execution order */
  originalOrder: string[];

  /** Optimized execution plan with parallel groups */
  parallelGroups: ParallelGroup[];

  /** Steps that cannot be parallelized */
  sequentialSteps: string[];

  /** Estimated time savings (percentage) */
  estimatedSavings: number;

  /** Analysis metadata */
  metadata: {
    totalSteps: number;
    parallelizableSteps: number;
    maxParallelism: number;
  };
}

// ============================================================================
// Merge Strategies
// ============================================================================

/**
 * Available output merge strategies
 */
export const MergeStrategies = {
  /**
   * Concatenate all outputs into an array
   */
  concat: (results: AgentResult[]): unknown[] => {
    return results
      .filter((r) => r.success && r.output !== undefined)
      .map((r) => r.output);
  },

  /**
   * Use the first successful result
   */
  first: (results: AgentResult[]): unknown | undefined => {
    const successful = results.find((r) => r.success && r.output !== undefined);
    return successful?.output;
  },

  /**
   * Use the last successful result
   */
  last: (results: AgentResult[]): unknown | undefined => {
    const successful = results
      .filter((r) => r.success && r.output !== undefined)
      .pop();
    return successful?.output;
  },

  /**
   * Merge object outputs (shallow)
   */
  mergeObjects: (results: AgentResult[]): Record<string, unknown> => {
    const merged: Record<string, unknown> = {};
    for (const result of results) {
      if (result.success && result.output && typeof result.output === 'object') {
        Object.assign(merged, result.output);
      }
    }
    return merged;
  },

  /**
   * Majority vote (for boolean/enum outputs)
   */
  majorityVote: <T>(results: AgentResult[]): T | undefined => {
    const counts = new Map<T, number>();
    for (const result of results) {
      if (result.success && result.output !== undefined) {
        const output = result.output as T;
        counts.set(output, (counts.get(output) || 0) + 1);
      }
    }

    let maxCount = 0;
    let winner: T | undefined;
    for (const [value, count] of counts) {
      if (count > maxCount) {
        maxCount = count;
        winner = value;
      }
    }

    return winner;
  },
};
