import type { Workflow, WorkflowStep } from '../types/workflow';
import { createEmptyWorkflow, createEmptyStep } from '../types/workflow';

const WORKFLOW_STORAGE_KEY = 'mcp-step-workflows';

/**
 * Service for managing workflow persistence and CRUD operations
 */
class WorkflowService {
  private workflows: Map<string, Workflow> = new Map();
  private initialized = false;

  /**
   * Initialize the service by loading workflows from localStorage
   */
  init(): void {
    if (this.initialized) return;

    try {
      const stored = localStorage.getItem(WORKFLOW_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as Workflow[];
        parsed.forEach((w) => this.workflows.set(w.id, w));
      }
    } catch (err) {
      console.error('[WorkflowService] Failed to load workflows:', err);
    }

    this.initialized = true;
  }

  /**
   * Persist all workflows to localStorage
   */
  private persist(): void {
    try {
      const data = Array.from(this.workflows.values());
      localStorage.setItem(WORKFLOW_STORAGE_KEY, JSON.stringify(data));
    } catch (err) {
      console.error('[WorkflowService] Failed to persist workflows:', err);
    }
  }

  /**
   * Get all workflows
   */
  listWorkflows(): Workflow[] {
    this.init();
    return Array.from(this.workflows.values()).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }

  /**
   * Get a single workflow by ID
   */
  getWorkflow(id: string): Workflow | null {
    this.init();
    return this.workflows.get(id) || null;
  }

  /**
   * Create a new workflow
   */
  createWorkflow(name?: string): Workflow {
    this.init();
    const workflow = createEmptyWorkflow();
    if (name) {
      workflow.name = name;
    }
    this.workflows.set(workflow.id, workflow);
    this.persist();
    return workflow;
  }

  /**
   * Save/update a workflow
   */
  saveWorkflow(workflow: Workflow): Workflow {
    this.init();
    const updated = {
      ...workflow,
      updatedAt: new Date().toISOString(),
    };
    this.workflows.set(updated.id, updated);
    this.persist();
    return updated;
  }

  /**
   * Delete a workflow
   */
  deleteWorkflow(id: string): boolean {
    this.init();
    const deleted = this.workflows.delete(id);
    if (deleted) {
      this.persist();
    }
    return deleted;
  }

  /**
   * Duplicate a workflow
   */
  duplicateWorkflow(id: string): Workflow | null {
    this.init();
    const original = this.workflows.get(id);
    if (!original) return null;

    const duplicate: Workflow = {
      ...original,
      id: crypto.randomUUID(),
      name: `${original.name} (Copy)`,
      status: 'draft',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      steps: original.steps.map((step) => ({
        ...step,
        id: crypto.randomUUID(),
        status: 'pending',
        output: undefined,
        evaluation: undefined,
        discussion: undefined,
      })),
    };

    this.workflows.set(duplicate.id, duplicate);
    this.persist();
    return duplicate;
  }

  /**
   * Update a specific step in a workflow
   */
  updateStep(workflowId: string, stepId: string, updates: Partial<WorkflowStep>): Workflow | null {
    this.init();
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return null;

    const stepIndex = workflow.steps.findIndex((s) => s.id === stepId);
    if (stepIndex === -1) return null;

    const updatedSteps = [...workflow.steps];
    updatedSteps[stepIndex] = { ...updatedSteps[stepIndex], ...updates };

    return this.saveWorkflow({ ...workflow, steps: updatedSteps });
  }

  /**
   * Add a new step to a workflow
   */
  addStep(workflowId: string, afterStepId?: string): Workflow | null {
    this.init();
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return null;

    const newStep = createEmptyStep();
    let newSteps: WorkflowStep[];

    if (afterStepId) {
      const index = workflow.steps.findIndex((s) => s.id === afterStepId);
      if (index === -1) {
        newSteps = [...workflow.steps, newStep];
      } else {
        newSteps = [
          ...workflow.steps.slice(0, index + 1),
          newStep,
          ...workflow.steps.slice(index + 1),
        ];
      }
    } else {
      newSteps = [...workflow.steps, newStep];
    }

    return this.saveWorkflow({ ...workflow, steps: newSteps });
  }

  /**
   * Remove a step from a workflow
   */
  removeStep(workflowId: string, stepId: string): Workflow | null {
    this.init();
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return null;

    const newSteps = workflow.steps.filter((s) => s.id !== stepId);
    return this.saveWorkflow({ ...workflow, steps: newSteps });
  }

  /**
   * Reorder steps in a workflow
   */
  reorderSteps(workflowId: string, stepIds: string[]): Workflow | null {
    this.init();
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return null;

    // Build new steps array in the specified order
    const stepMap = new Map(workflow.steps.map((s) => [s.id, s]));
    const newSteps: WorkflowStep[] = [];

    for (const id of stepIds) {
      const step = stepMap.get(id);
      if (step) {
        newSteps.push(step);
      }
    }

    // Preserve any steps not in the provided order (shouldn't happen, but safe)
    workflow.steps.forEach((s) => {
      if (!stepIds.includes(s.id)) {
        newSteps.push(s);
      }
    });

    return this.saveWorkflow({ ...workflow, steps: newSteps });
  }

  /**
   * Reset all step execution states in a workflow
   */
  resetWorkflowExecution(workflowId: string): Workflow | null {
    this.init();
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return null;

    const resetSteps = workflow.steps.map((step) => ({
      ...step,
      status: 'pending' as const,
      output: undefined,
      evaluation: undefined,
      discussion: undefined,
    }));

    return this.saveWorkflow({
      ...workflow,
      steps: resetSteps,
      status: 'ready',
    });
  }

  /**
   * Update workflow status
   */
  updateWorkflowStatus(workflowId: string, status: Workflow['status']): Workflow | null {
    this.init();
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return null;

    return this.saveWorkflow({ ...workflow, status });
  }
}

// Singleton instance
export const workflowService = new WorkflowService();
