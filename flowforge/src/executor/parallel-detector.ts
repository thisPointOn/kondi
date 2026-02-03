/**
 * FlowForge Parallel Detector
 * Analyzes workflow DAG for parallelization opportunities
 */

import { Step, WorkflowSpec } from '../core/types.js';
import { ParallelGroup, ParallelAnalysis } from '../integrations/kondi/types.js';
import { v4 as uuidv4 } from 'uuid';

// ============================================================================
// Parallel Detector
// ============================================================================

export class ParallelDetector {
  /**
   * Analyze a workflow for parallelization opportunities
   */
  analyze(workflow: WorkflowSpec): ParallelAnalysis {
    const steps = workflow.steps;

    if (steps.length === 0) {
      return this.emptyAnalysis();
    }

    // Build dependency graph
    const { graph, reverseGraph } = this.buildDependencyGraph(steps);

    // Calculate original topological order
    const originalOrder = this.topologicalSort(steps, graph);

    // Find parallel groups using level-based approach
    const levels = this.assignLevels(steps, graph);
    const parallelGroups = this.createParallelGroups(steps, levels, graph);

    // Identify steps that cannot be parallelized
    const parallelStepIds = new Set(parallelGroups.flatMap((g) => g.stepIds));
    const sequentialSteps = steps
      .map((s) => s.id)
      .filter((id) => !parallelStepIds.has(id));

    // Calculate estimated savings
    const estimatedSavings = this.calculateSavings(parallelGroups, steps.length);

    // Find max parallelism
    const maxParallelism = Math.max(...parallelGroups.map((g) => g.stepIds.length), 1);

    return {
      originalOrder,
      parallelGroups,
      sequentialSteps,
      estimatedSavings,
      metadata: {
        totalSteps: steps.length,
        parallelizableSteps: parallelStepIds.size,
        maxParallelism,
      },
    };
  }

  /**
   * Find steps that can be executed in parallel right now
   * given the current execution state
   */
  findParallelizableSteps(
    workflow: WorkflowSpec,
    completedStepIds: Set<string>,
    runningStepIds: Set<string>
  ): Step[] {
    const steps = workflow.steps;
    const parallelizable: Step[] = [];

    for (const step of steps) {
      // Skip if already completed or running
      if (completedStepIds.has(step.id) || runningStepIds.has(step.id)) {
        continue;
      }

      // Skip if not marked as parallelizable
      if (!step.parallelizable) {
        continue;
      }

      // Check if all dependencies are satisfied
      const blockedBy = step.blockedBy || [];
      const dependenciesMet = blockedBy.every(
        (depId) => completedStepIds.has(depId)
      );

      if (dependenciesMet) {
        parallelizable.push(step);
      }
    }

    return parallelizable;
  }

  /**
   * Determine if a step can be parallelized based on its type and config
   */
  canParallelize(step: Step): boolean {
    // Explicitly marked as parallelizable
    if (step.parallelizable === true) {
      return true;
    }

    // Explicitly marked as not parallelizable
    if (step.parallelizable === false) {
      return false;
    }

    // Type-based heuristics
    switch (step.type) {
      case 'llm':
        // LLM steps can generally be parallelized
        return true;

      case 'tool':
        // Tool steps might have side effects, be conservative
        return false;

      case 'human':
        // Human steps require user interaction
        return false;

      case 'conditional':
        // Conditional steps affect control flow
        return false;

      case 'parallel':
        // Already parallel, handled separately
        return false;

      default:
        return false;
    }
  }

  /**
   * Suggest parallelization for a workflow
   */
  suggestParallelization(workflow: WorkflowSpec): {
    suggestions: Array<{
      stepId: string;
      reason: string;
      confidence: 'high' | 'medium' | 'low';
    }>;
    warnings: string[];
  } {
    const suggestions: Array<{
      stepId: string;
      reason: string;
      confidence: 'high' | 'medium' | 'low';
    }> = [];
    const warnings: string[] = [];

    const { graph } = this.buildDependencyGraph(workflow.steps);

    for (const step of workflow.steps) {
      // Skip if already marked as parallelizable
      if (step.parallelizable === true) {
        continue;
      }

      // Check if can be parallelized
      if (this.canParallelize(step)) {
        // Check if it has no dependents (safe to parallelize)
        const dependents = workflow.steps.filter(
          (s) => s.blockedBy?.includes(step.id)
        );

        if (dependents.length === 0) {
          suggestions.push({
            stepId: step.id,
            reason: 'No dependent steps, safe to run in parallel',
            confidence: 'high',
          });
        } else {
          // Has dependents, check if output is used
          const outputUsed = this.isOutputUsedByDependents(step, dependents);
          if (!outputUsed) {
            suggestions.push({
              stepId: step.id,
              reason: 'Output not used by dependents, can parallelize',
              confidence: 'medium',
            });
          } else {
            suggestions.push({
              stepId: step.id,
              reason: 'LLM step that could potentially be parallelized',
              confidence: 'low',
            });
          }
        }
      }

      // Check for potential issues
      if (step.type === 'tool' && step.parallelizable) {
        warnings.push(
          `Step "${step.name}" (${step.id}) is a tool step marked as parallelizable. ` +
            'Tool steps may have side effects - verify this is intentional.'
        );
      }
    }

    return { suggestions, warnings };
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private emptyAnalysis(): ParallelAnalysis {
    return {
      originalOrder: [],
      parallelGroups: [],
      sequentialSteps: [],
      estimatedSavings: 0,
      metadata: {
        totalSteps: 0,
        parallelizableSteps: 0,
        maxParallelism: 0,
      },
    };
  }

  private buildDependencyGraph(steps: Step[]): {
    graph: Map<string, Set<string>>;
    reverseGraph: Map<string, Set<string>>;
  } {
    const graph = new Map<string, Set<string>>(); // step -> dependencies
    const reverseGraph = new Map<string, Set<string>>(); // step -> dependents

    for (const step of steps) {
      graph.set(step.id, new Set(step.blockedBy || []));
      reverseGraph.set(step.id, new Set());
    }

    for (const step of steps) {
      for (const depId of step.blockedBy || []) {
        reverseGraph.get(depId)?.add(step.id);
      }
    }

    return { graph, reverseGraph };
  }

  private topologicalSort(steps: Step[], graph: Map<string, Set<string>>): string[] {
    const order: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const stepMap = new Map(steps.map((s) => [s.id, s]));

    const visit = (stepId: string): void => {
      if (visited.has(stepId)) return;
      if (visiting.has(stepId)) {
        throw new Error(`Circular dependency detected: ${stepId}`);
      }

      visiting.add(stepId);

      const deps = graph.get(stepId) || new Set();
      for (const depId of deps) {
        visit(depId);
      }

      visiting.delete(stepId);
      visited.add(stepId);
      order.push(stepId);
    };

    for (const step of steps) {
      visit(step.id);
    }

    return order;
  }

  private assignLevels(
    steps: Step[],
    graph: Map<string, Set<string>>
  ): Map<string, number> {
    const levels = new Map<string, number>();

    // Steps with no dependencies are at level 0
    for (const step of steps) {
      const deps = graph.get(step.id) || new Set();
      if (deps.size === 0) {
        levels.set(step.id, 0);
      }
    }

    // Assign levels based on maximum dependency level + 1
    let changed = true;
    while (changed) {
      changed = false;
      for (const step of steps) {
        if (levels.has(step.id)) continue;

        const deps = graph.get(step.id) || new Set();
        const depLevels = Array.from(deps)
          .map((depId) => levels.get(depId))
          .filter((l): l is number => l !== undefined);

        if (depLevels.length === deps.size) {
          // All dependencies have levels assigned
          const maxDepLevel = Math.max(...depLevels);
          levels.set(step.id, maxDepLevel + 1);
          changed = true;
        }
      }
    }

    return levels;
  }

  private createParallelGroups(
    steps: Step[],
    levels: Map<string, number>,
    graph: Map<string, Set<string>>
  ): ParallelGroup[] {
    const groups: ParallelGroup[] = [];
    const stepMap = new Map(steps.map((s) => [s.id, s]));

    // Group steps by level
    const levelGroups = new Map<number, string[]>();
    for (const [stepId, level] of levels) {
      if (!levelGroups.has(level)) {
        levelGroups.set(level, []);
      }
      levelGroups.get(level)!.push(stepId);
    }

    // Create parallel groups for levels with multiple parallelizable steps
    const sortedLevels = Array.from(levelGroups.keys()).sort((a, b) => a - b);

    for (const level of sortedLevels) {
      const stepsAtLevel = levelGroups.get(level)!;

      // Filter to parallelizable steps
      const parallelizableSteps = stepsAtLevel.filter((stepId) => {
        const step = stepMap.get(stepId);
        return step && this.canParallelize(step);
      });

      if (parallelizableSteps.length > 1) {
        // Find blocking steps (from previous levels)
        const blockedBy = new Set<string>();
        for (const stepId of parallelizableSteps) {
          const deps = graph.get(stepId) || new Set();
          for (const depId of deps) {
            blockedBy.add(depId);
          }
        }

        groups.push({
          id: uuidv4(),
          stepIds: parallelizableSteps,
          blockedBy: Array.from(blockedBy),
          fullyIndependent: this.areFullyIndependent(parallelizableSteps, graph),
        });
      }
    }

    return groups;
  }

  private areFullyIndependent(
    stepIds: string[],
    graph: Map<string, Set<string>>
  ): boolean {
    const stepSet = new Set(stepIds);

    for (const stepId of stepIds) {
      const deps = graph.get(stepId) || new Set();
      // Check if any dependency is within the same group
      for (const depId of deps) {
        if (stepSet.has(depId)) {
          return false;
        }
      }
    }

    return true;
  }

  private calculateSavings(
    parallelGroups: ParallelGroup[],
    totalSteps: number
  ): number {
    if (totalSteps === 0) return 0;

    // Calculate steps that can be saved through parallelization
    let savedSteps = 0;
    for (const group of parallelGroups) {
      // In a parallel group of N steps, we save N-1 sequential executions
      savedSteps += group.stepIds.length - 1;
    }

    return Math.round((savedSteps / totalSteps) * 100);
  }

  private isOutputUsedByDependents(step: Step, dependents: Step[]): boolean {
    const outputNames = step.outputs?.map((o) => o.name) || [];
    if (outputNames.length === 0) return false;

    for (const dependent of dependents) {
      const inputs = dependent.inputs || [];
      for (const input of inputs) {
        if (
          input.source.type === 'step' &&
          input.source.stepId === step.id
        ) {
          return true;
        }
      }
    }

    return false;
  }
}

// ============================================================================
// Default Instance
// ============================================================================

let defaultDetector: ParallelDetector | null = null;

export function getDefaultParallelDetector(): ParallelDetector {
  if (!defaultDetector) {
    defaultDetector = new ParallelDetector();
  }
  return defaultDetector;
}

// ============================================================================
// Helper Functions
// ============================================================================

export function analyzeWorkflowParallelism(workflow: WorkflowSpec): ParallelAnalysis {
  return getDefaultParallelDetector().analyze(workflow);
}

export function findParallelizableSteps(
  workflow: WorkflowSpec,
  completedStepIds: Set<string>,
  runningStepIds: Set<string>
): Step[] {
  return getDefaultParallelDetector().findParallelizableSteps(
    workflow,
    completedStepIds,
    runningStepIds
  );
}

export function suggestParallelization(workflow: WorkflowSpec) {
  return getDefaultParallelDetector().suggestParallelization(workflow);
}
