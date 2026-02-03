/**
 * FlowForge Workflow Store
 * File-based persistence for workflow specs (following OpenClaw patterns)
 */

import { v4 as uuidv4 } from 'uuid';
import {
  WorkflowSpec,
  WorkflowStatus,
  ExecutionConfig,
  WorkflowMetadata,
  InputDefinition,
  OutputDefinition,
  Step,
} from '../core/types.js';
import {
  WorkflowNotFoundError,
  WorkflowValidationError,
  StorageError,
  LockAcquisitionError,
} from '../core/errors.js';
import { validateWorkflowSpec } from '../core/schema.js';

// ============================================================================
// Store Types
// ============================================================================

export interface WorkflowStoreConfig {
  /** Base directory for workflow storage */
  basePath: string;

  /** File system functions (for dependency injection) */
  fs?: {
    readFile: (path: string) => Promise<string>;
    writeFile: (path: string, content: string) => Promise<void>;
    unlink: (path: string) => Promise<void>;
    readdir: (path: string) => Promise<string[]>;
    mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
    exists: (path: string) => Promise<boolean>;
  };

  /** Lock functions (for concurrent access safety) */
  lock?: {
    lock: (path: string) => Promise<() => Promise<void>>;
  };
}

export interface ListWorkflowsOptions {
  status?: WorkflowStatus | WorkflowStatus[];
  tags?: string[];
  category?: string;
  limit?: number;
  offset?: number;
  sortBy?: 'name' | 'createdAt' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
}

export interface WorkflowListResult {
  workflows: WorkflowSpec[];
  total: number;
  limit: number;
  offset: number;
}

// ============================================================================
// Default File System Implementation
// ============================================================================

async function createDefaultFs() {
  // Dynamic import to work in both Node.js and browser
  const fs = await import('fs/promises');
  const path = await import('path');

  return {
    readFile: async (filePath: string) => {
      return fs.readFile(filePath, 'utf-8');
    },
    writeFile: async (filePath: string, content: string) => {
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, content, 'utf-8');
    },
    unlink: async (filePath: string) => {
      await fs.unlink(filePath);
    },
    readdir: async (dirPath: string) => {
      try {
        return await fs.readdir(dirPath);
      } catch {
        return [];
      }
    },
    mkdir: async (dirPath: string, options?: { recursive?: boolean }) => {
      await fs.mkdir(dirPath, options);
    },
    exists: async (filePath: string) => {
      try {
        await fs.access(filePath);
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ============================================================================
// Workflow Store
// ============================================================================

export class WorkflowStore {
  private config: WorkflowStoreConfig;
  private fs: NonNullable<WorkflowStoreConfig['fs']> | null = null;
  private initialized = false;

  constructor(config: WorkflowStoreConfig) {
    this.config = config;
    if (config.fs) {
      this.fs = config.fs;
      this.initialized = true;
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized && this.fs) return;

    if (!this.fs) {
      this.fs = await createDefaultFs();
    }

    // Ensure base directory exists
    await this.fs.mkdir(this.config.basePath, { recursive: true });
    this.initialized = true;
  }

  private getWorkflowPath(workflowId: string): string {
    return `${this.config.basePath}/${workflowId}.json`;
  }

  // ============================================================================
  // CRUD Operations
  // ============================================================================

  /**
   * Create a new workflow
   */
  async create(params: {
    name: string;
    description: string;
    inputs?: InputDefinition[];
    outputs?: OutputDefinition[];
    steps?: Step[];
    config?: Partial<ExecutionConfig>;
    metadata?: WorkflowMetadata;
  }): Promise<WorkflowSpec> {
    await this.ensureInitialized();

    const now = new Date().toISOString();
    const workflow: WorkflowSpec = {
      id: uuidv4(),
      name: params.name,
      description: params.description,
      version: '1.0.0',
      status: 'draft',
      inputs: params.inputs || [],
      outputs: params.outputs || [],
      steps: params.steps || [],
      config: {
        defaultProvider: 'anthropic',
        defaultModel: 'claude-3-5-sonnet-latest',
        defaultMaxRetries: 3,
        defaultRetryDelay: 1000,
        defaultTimeout: 30000,
        parallelExecution: false,
        checkpointEnabled: true,
        maxConcurrentSteps: 1,
        ...params.config,
      },
      metadata: params.metadata,
      createdAt: now,
      updatedAt: now,
    };

    await this.save(workflow);
    return workflow;
  }

  /**
   * Get a workflow by ID
   */
  async get(workflowId: string): Promise<WorkflowSpec> {
    await this.ensureInitialized();

    const path = this.getWorkflowPath(workflowId);

    try {
      const content = await this.fs!.readFile(path);
      const workflow = JSON.parse(content) as WorkflowSpec;
      return workflow;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new WorkflowNotFoundError(workflowId);
      }
      throw new StorageError('read', `Failed to read workflow: ${error}`);
    }
  }

  /**
   * Update a workflow
   */
  async update(
    workflowId: string,
    updates: Partial<Omit<WorkflowSpec, 'id' | 'createdAt'>>
  ): Promise<WorkflowSpec> {
    await this.ensureInitialized();

    const existing = await this.get(workflowId);
    const updated: WorkflowSpec = {
      ...existing,
      ...updates,
      id: workflowId, // Ensure ID isn't changed
      createdAt: existing.createdAt, // Preserve creation time
      updatedAt: new Date().toISOString(),
    };

    // Validate if steps or other critical fields changed
    if (updates.steps || updates.inputs || updates.outputs) {
      const validation = validateWorkflowSpec(updated);
      if (!validation.success) {
        throw new WorkflowValidationError(
          'Workflow validation failed',
          validation.error.errors
        );
      }
    }

    await this.save(updated);
    return updated;
  }

  /**
   * Delete a workflow
   */
  async delete(workflowId: string): Promise<void> {
    await this.ensureInitialized();

    const path = this.getWorkflowPath(workflowId);

    try {
      await this.fs!.unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new WorkflowNotFoundError(workflowId);
      }
      throw new StorageError('delete', `Failed to delete workflow: ${error}`);
    }
  }

  /**
   * List workflows with filtering and pagination
   */
  async list(options?: ListWorkflowsOptions): Promise<WorkflowListResult> {
    await this.ensureInitialized();

    const files = await this.fs!.readdir(this.config.basePath);
    const jsonFiles = files.filter((f) => f.endsWith('.json'));

    let workflows: WorkflowSpec[] = [];

    for (const file of jsonFiles) {
      try {
        const content = await this.fs!.readFile(`${this.config.basePath}/${file}`);
        const workflow = JSON.parse(content) as WorkflowSpec;
        workflows.push(workflow);
      } catch {
        // Skip invalid files
      }
    }

    // Apply filters
    if (options?.status) {
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      workflows = workflows.filter((w) => statuses.includes(w.status));
    }

    if (options?.tags && options.tags.length > 0) {
      workflows = workflows.filter((w) =>
        options.tags!.some((tag) => w.metadata?.tags?.includes(tag))
      );
    }

    if (options?.category) {
      workflows = workflows.filter((w) => w.metadata?.category === options.category);
    }

    // Sort
    const sortBy = options?.sortBy || 'updatedAt';
    const sortOrder = options?.sortOrder || 'desc';

    workflows.sort((a, b) => {
      let aVal: string | number;
      let bVal: string | number;

      if (sortBy === 'name') {
        aVal = a.name.toLowerCase();
        bVal = b.name.toLowerCase();
      } else if (sortBy === 'createdAt') {
        aVal = new Date(a.createdAt).getTime();
        bVal = new Date(b.createdAt).getTime();
      } else {
        aVal = new Date(a.updatedAt).getTime();
        bVal = new Date(b.updatedAt).getTime();
      }

      if (sortOrder === 'asc') {
        return aVal < bVal ? -1 : aVal > bVal ? 1 : 0;
      } else {
        return aVal > bVal ? -1 : aVal < bVal ? 1 : 0;
      }
    });

    const total = workflows.length;

    // Apply pagination
    const limit = options?.limit || 50;
    const offset = options?.offset || 0;
    workflows = workflows.slice(offset, offset + limit);

    return {
      workflows,
      total,
      limit,
      offset,
    };
  }

  /**
   * Check if a workflow exists
   */
  async exists(workflowId: string): Promise<boolean> {
    await this.ensureInitialized();
    const path = this.getWorkflowPath(workflowId);
    return this.fs!.exists(path);
  }

  /**
   * Duplicate a workflow
   */
  async duplicate(workflowId: string, newName?: string): Promise<WorkflowSpec> {
    const original = await this.get(workflowId);

    const now = new Date().toISOString();
    const duplicate: WorkflowSpec = {
      ...original,
      id: uuidv4(),
      name: newName || `${original.name} (Copy)`,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    };

    await this.save(duplicate);
    return duplicate;
  }

  /**
   * Update workflow status
   */
  async setStatus(workflowId: string, status: WorkflowStatus): Promise<WorkflowSpec> {
    return this.update(workflowId, { status });
  }

  /**
   * Add a step to a workflow
   */
  async addStep(workflowId: string, step: Step): Promise<WorkflowSpec> {
    const workflow = await this.get(workflowId);
    return this.update(workflowId, {
      steps: [...workflow.steps, step],
    });
  }

  /**
   * Update a step in a workflow
   */
  async updateStep(workflowId: string, stepId: string, updates: Partial<Step>): Promise<WorkflowSpec> {
    const workflow = await this.get(workflowId);
    const steps = workflow.steps.map((s) =>
      s.id === stepId ? { ...s, ...updates, id: stepId } : s
    );
    return this.update(workflowId, { steps });
  }

  /**
   * Remove a step from a workflow
   */
  async removeStep(workflowId: string, stepId: string): Promise<WorkflowSpec> {
    const workflow = await this.get(workflowId);
    const steps = workflow.steps.filter((s) => s.id !== stepId);
    return this.update(workflowId, { steps });
  }

  /**
   * Reorder steps in a workflow
   */
  async reorderSteps(workflowId: string, stepIds: string[]): Promise<WorkflowSpec> {
    const workflow = await this.get(workflowId);
    const stepMap = new Map(workflow.steps.map((s) => [s.id, s]));
    const steps = stepIds.map((id) => stepMap.get(id)).filter((s): s is Step => s !== undefined);
    return this.update(workflowId, { steps });
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private async save(workflow: WorkflowSpec): Promise<void> {
    const path = this.getWorkflowPath(workflow.id);

    const lock = this.config.lock;
    let release: (() => Promise<void>) | undefined;

    try {
      if (lock) {
        release = await lock.lock(path);
      }

      const content = JSON.stringify(workflow, null, 2);
      await this.fs!.writeFile(path, content);
    } catch (error) {
      if (error instanceof Error && error.message.includes('lock')) {
        throw new LockAcquisitionError(path);
      }
      throw new StorageError('write', `Failed to save workflow: ${error}`);
    } finally {
      if (release) {
        try {
          await release();
        } catch {
          // Ignore release errors
        }
      }
    }
  }
}

// ============================================================================
// Default Store Instance
// ============================================================================

let defaultStore: WorkflowStore | null = null;

export function getDefaultWorkflowStore(): WorkflowStore {
  if (!defaultStore) {
    const homedir = process.env.HOME || process.env.USERPROFILE || '.';
    defaultStore = new WorkflowStore({
      basePath: `${homedir}/.flowforge/workflows`,
    });
  }
  return defaultStore;
}

export function setDefaultWorkflowStore(store: WorkflowStore): void {
  defaultStore = store;
}

// ============================================================================
// Helper Functions
// ============================================================================

export async function createWorkflow(params: Parameters<WorkflowStore['create']>[0]): Promise<WorkflowSpec> {
  return getDefaultWorkflowStore().create(params);
}

export async function getWorkflow(workflowId: string): Promise<WorkflowSpec> {
  return getDefaultWorkflowStore().get(workflowId);
}

export async function updateWorkflow(
  workflowId: string,
  updates: Parameters<WorkflowStore['update']>[1]
): Promise<WorkflowSpec> {
  return getDefaultWorkflowStore().update(workflowId, updates);
}

export async function deleteWorkflow(workflowId: string): Promise<void> {
  return getDefaultWorkflowStore().delete(workflowId);
}

export async function listWorkflows(options?: ListWorkflowsOptions): Promise<WorkflowListResult> {
  return getDefaultWorkflowStore().list(options);
}
