/**
 * FlowForge Kondi Adapter
 * Multi-agent parallel execution adapter
 */

import { v4 as uuidv4 } from 'uuid';
import {
  KondiConfig,
  KondiHandoff,
  KondiResult,
  KondiEvent,
  AgentResult,
  AgentStatus,
  KondiAgent,
  MergeStrategies,
} from './types.js';
import { providerRegistry } from '../../providers/registry.js';

// ============================================================================
// Kondi Adapter
// ============================================================================

export class KondiAdapter {
  private config: KondiConfig;
  private activeExecutions: Map<string, {
    agents: Map<string, KondiAgent>;
    aborted: boolean;
  }> = new Map();

  constructor(config?: KondiConfig) {
    this.config = {
      maxConcurrentAgents: 5,
      defaultTimeout: 60000,
      failFast: false,
      mergeStrategy: 'concat',
      ...config,
    };
  }

  /**
   * Execute steps in parallel using multiple agents
   */
  async executeParallel(handoff: KondiHandoff): Promise<KondiResult> {
    const startTime = Date.now();
    const executionKey = `${handoff.executionId}:${handoff.stepId}`;

    // Initialize execution tracking
    const agents = new Map<string, KondiAgent>();
    for (let i = 0; i < handoff.agentCount; i++) {
      const agentId = uuidv4();
      agents.set(agentId, {
        id: agentId,
        index: i,
        status: 'pending',
        task: handoff.agentTasks?.[i] || handoff.task,
      });
    }

    this.activeExecutions.set(executionKey, { agents, aborted: false });

    // Emit start event
    this.emitEvent({
      type: 'kondi-started',
      executionId: handoff.executionId,
      stepId: handoff.stepId,
      agentCount: handoff.agentCount,
    });

    try {
      // Execute agents with concurrency control
      const results = await this.executeAgents(handoff, agents);

      // Calculate success
      const successCount = results.filter((r) => r.success).length;
      const success = successCount === handoff.agentCount;

      // Merge outputs
      const mergedOutput = this.mergeResults(results);

      const result: KondiResult = {
        executionId: handoff.executionId,
        stepId: handoff.stepId,
        success,
        successCount,
        totalAgents: handoff.agentCount,
        agentResults: results,
        mergedOutput,
        duration: Date.now() - startTime,
      };

      // Emit completion event
      this.emitEvent({
        type: 'kondi-completed',
        executionId: handoff.executionId,
        stepId: handoff.stepId,
        result,
      });

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      return {
        executionId: handoff.executionId,
        stepId: handoff.stepId,
        success: false,
        successCount: 0,
        totalAgents: handoff.agentCount,
        agentResults: [],
        duration: Date.now() - startTime,
        error: errorMessage,
      };
    } finally {
      this.activeExecutions.delete(executionKey);
    }
  }

  /**
   * Get status of agents in an execution
   */
  getAgentStatus(executionId: string, stepId: string): KondiAgent[] {
    const key = `${executionId}:${stepId}`;
    const execution = this.activeExecutions.get(key);
    if (!execution) return [];
    return Array.from(execution.agents.values());
  }

  /**
   * Abort a parallel execution
   */
  abort(executionId: string, stepId: string): void {
    const key = `${executionId}:${stepId}`;
    const execution = this.activeExecutions.get(key);
    if (execution) {
      execution.aborted = true;
      // Mark all pending agents as cancelled
      for (const agent of execution.agents.values()) {
        if (agent.status === 'pending' || agent.status === 'running') {
          agent.status = 'cancelled';
        }
      }
    }
  }

  /**
   * Check if execution is aborted
   */
  isAborted(executionId: string, stepId: string): boolean {
    const key = `${executionId}:${stepId}`;
    return this.activeExecutions.get(key)?.aborted || false;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private async executeAgents(
    handoff: KondiHandoff,
    agents: Map<string, KondiAgent>
  ): Promise<AgentResult[]> {
    const maxConcurrent = this.config.maxConcurrentAgents || 5;
    const results: AgentResult[] = [];
    const agentArray = Array.from(agents.values());

    // Process agents in batches
    for (let i = 0; i < agentArray.length; i += maxConcurrent) {
      const batch = agentArray.slice(i, i + maxConcurrent);
      const executionKey = `${handoff.executionId}:${handoff.stepId}`;

      // Check if aborted
      if (this.activeExecutions.get(executionKey)?.aborted) {
        // Mark remaining as cancelled
        for (let j = i; j < agentArray.length; j++) {
          results.push({
            agentId: agentArray[j].id,
            agentIndex: agentArray[j].index,
            success: false,
            error: 'Execution aborted',
            duration: 0,
          });
        }
        break;
      }

      // Execute batch in parallel
      const batchResults = await Promise.all(
        batch.map((agent) => this.executeAgent(handoff, agent))
      );

      results.push(...batchResults);

      // Check for fail-fast
      if (this.config.failFast && batchResults.some((r) => !r.success)) {
        // Cancel remaining agents
        for (let j = i + maxConcurrent; j < agentArray.length; j++) {
          results.push({
            agentId: agentArray[j].id,
            agentIndex: agentArray[j].index,
            success: false,
            error: 'Cancelled due to fail-fast',
            duration: 0,
          });
        }
        break;
      }
    }

    return results;
  }

  private async executeAgent(
    handoff: KondiHandoff,
    agent: KondiAgent
  ): Promise<AgentResult> {
    const startTime = Date.now();

    // Update agent status
    agent.status = 'running';
    agent.startedAt = new Date().toISOString();

    // Emit agent started event
    this.emitEvent({
      type: 'agent-started',
      executionId: handoff.executionId,
      stepId: handoff.stepId,
      agentId: agent.id,
      agentIndex: agent.index,
    });

    try {
      // Build agent prompt
      const prompt = this.buildAgentPrompt(handoff, agent);

      // Execute with timeout
      const timeout = handoff.timeout || this.config.defaultTimeout || 60000;
      const output = await Promise.race([
        this.callLLM(handoff, prompt),
        this.timeoutPromise(timeout),
      ]);

      // Update agent status
      agent.status = 'completed';
      agent.completedAt = new Date().toISOString();

      const result: AgentResult = {
        agentId: agent.id,
        agentIndex: agent.index,
        success: true,
        output,
        duration: Date.now() - startTime,
      };

      // Emit agent completed event
      this.emitEvent({
        type: 'agent-completed',
        executionId: handoff.executionId,
        stepId: handoff.stepId,
        agentId: agent.id,
        agentIndex: agent.index,
        success: true,
        output,
      });

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Update agent status
      agent.status = 'failed';
      agent.completedAt = new Date().toISOString();
      agent.error = errorMessage;

      const result: AgentResult = {
        agentId: agent.id,
        agentIndex: agent.index,
        success: false,
        error: errorMessage,
        duration: Date.now() - startTime,
      };

      // Emit agent completed event
      this.emitEvent({
        type: 'agent-completed',
        executionId: handoff.executionId,
        stepId: handoff.stepId,
        agentId: agent.id,
        agentIndex: agent.index,
        success: false,
        error: errorMessage,
      });

      return result;
    }
  }

  private buildAgentPrompt(handoff: KondiHandoff, agent: KondiAgent): string {
    const context = handoff.sharedContext;

    return `You are Agent #${agent.index + 1} of ${handoff.agentCount} working on a parallel task.

## Shared Context
Workflow: ${context.workflowId}
Step: ${context.stepId}

## Previous Step Outputs
${JSON.stringify(context.previousOutputs, null, 2)}

## Your Task
${agent.task}

## Success Criteria
${handoff.successCriteria}

## Instructions
- Focus only on your assigned task
- Do not duplicate work that other agents might be doing
- Be thorough but efficient
- Return structured output when possible

Complete your assigned task:`;
  }

  private async callLLM(
    handoff: KondiHandoff,
    prompt: string
  ): Promise<unknown> {
    const provider = handoff.config?.provider || this.config.provider?.default || 'anthropic';
    const model = handoff.config?.model || 'claude-3-5-sonnet-latest';

    const result = await providerRegistry.complete(
      {
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: handoff.config?.temperature ?? 0.7,
        maxTokens: handoff.config?.maxTokens ?? 4096,
      },
      { preferredProvider: provider }
    );

    // Try to parse as JSON
    try {
      const jsonMatch = result.content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[1]);
      }

      // Try parsing the whole response
      return JSON.parse(result.content);
    } catch {
      // Return as string
      return result.content;
    }
  }

  private timeoutPromise(ms: number): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Agent timed out after ${ms}ms`)), ms);
    });
  }

  private mergeResults(results: AgentResult[]): unknown {
    const strategy = this.config.mergeStrategy || 'concat';

    if (strategy === 'custom' && this.config.customMerge) {
      return this.config.customMerge(results);
    }

    switch (strategy) {
      case 'concat':
        return MergeStrategies.concat(results);
      case 'first':
        return MergeStrategies.first(results);
      case 'last':
        return MergeStrategies.last(results);
      default:
        return MergeStrategies.concat(results);
    }
  }

  private emitEvent(event: KondiEvent): void {
    if (this.config.onEvent) {
      try {
        this.config.onEvent(event);
      } catch {
        // Ignore event handler errors
      }
    }
  }
}

// ============================================================================
// Default Instance
// ============================================================================

let defaultAdapter: KondiAdapter | null = null;

export function getDefaultKondiAdapter(): KondiAdapter {
  if (!defaultAdapter) {
    defaultAdapter = new KondiAdapter();
  }
  return defaultAdapter;
}

export function setDefaultKondiAdapter(adapter: KondiAdapter): void {
  defaultAdapter = adapter;
}

// ============================================================================
// Helper Functions
// ============================================================================

export async function executeParallel(handoff: KondiHandoff): Promise<KondiResult> {
  return getDefaultKondiAdapter().executeParallel(handoff);
}

export function getAgentStatus(executionId: string, stepId: string): KondiAgent[] {
  return getDefaultKondiAdapter().getAgentStatus(executionId, stepId);
}

export function abortParallelExecution(executionId: string, stepId: string): void {
  getDefaultKondiAdapter().abort(executionId, stepId);
}
