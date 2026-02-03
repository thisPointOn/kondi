/**
 * FlowForge Execution History
 * Tracks and queries workflow execution history
 */

import {
  WorkflowState,
  ExecutionHistory,
  ExecutionStatus,
} from '../core/types.js';
import { StorageError } from '../core/errors.js';

// ============================================================================
// History Types
// ============================================================================

export interface HistoryManagerConfig {
  /** Base directory for history storage */
  basePath: string;

  /** Maximum history entries to keep per workflow */
  maxEntriesPerWorkflow?: number;

  /** Maximum total history entries */
  maxTotalEntries?: number;

  /** File system functions */
  fs?: {
    readFile: (path: string) => Promise<string>;
    writeFile: (path: string, content: string) => Promise<void>;
    unlink: (path: string) => Promise<void>;
    readdir: (path: string) => Promise<string[]>;
    mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
    exists: (path: string) => Promise<boolean>;
  };
}

export interface HistoryQueryOptions {
  workflowId?: string;
  status?: ExecutionStatus | ExecutionStatus[];
  startedAfter?: string;
  startedBefore?: string;
  triggeredBy?: string;
  limit?: number;
  offset?: number;
  sortBy?: 'startedAt' | 'completedAt' | 'duration';
  sortOrder?: 'asc' | 'desc';
}

export interface HistoryQueryResult {
  entries: ExecutionHistory[];
  total: number;
  limit: number;
  offset: number;
}

export interface HistoryStats {
  totalExecutions: number;
  successfulExecutions: number;
  failedExecutions: number;
  averageDuration: number;
  executionsByWorkflow: Record<string, number>;
  executionsByStatus: Partial<Record<ExecutionStatus, number>>;
  recentExecutions: ExecutionHistory[];
}

// ============================================================================
// Default File System
// ============================================================================

async function createDefaultFs() {
  const fs = await import('fs/promises');
  const path = await import('path');

  return {
    readFile: async (filePath: string) => fs.readFile(filePath, 'utf-8'),
    writeFile: async (filePath: string, content: string) => {
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, content, 'utf-8');
    },
    unlink: async (filePath: string) => fs.unlink(filePath),
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
// History Store (single JSON file per workflow)
// ============================================================================

interface HistoryStore {
  version: number;
  entries: ExecutionHistory[];
}

// ============================================================================
// History Manager
// ============================================================================

export class HistoryManager {
  private config: HistoryManagerConfig;
  private fs: NonNullable<HistoryManagerConfig['fs']> | null = null;
  private initialized = false;

  constructor(config: HistoryManagerConfig) {
    this.config = {
      maxEntriesPerWorkflow: 100,
      maxTotalEntries: 1000,
      ...config,
    };
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

    await this.fs.mkdir(this.config.basePath, { recursive: true });
    this.initialized = true;
  }

  private getHistoryPath(workflowId: string): string {
    return `${this.config.basePath}/${workflowId}.json`;
  }

  // ============================================================================
  // History Operations
  // ============================================================================

  /**
   * Record an execution in history
   */
  async recordExecution(
    state: WorkflowState,
    workflowName: string
  ): Promise<ExecutionHistory> {
    await this.ensureInitialized();

    const duration = state.completedAt
      ? new Date(state.completedAt).getTime() - new Date(state.startedAt).getTime()
      : undefined;

    const stepsCompleted = Object.values(state.steps).filter(
      (s) => s.status === 'completed' || s.status === 'skipped'
    ).length;

    const entry: ExecutionHistory = {
      executionId: state.executionId,
      workflowId: state.workflowId,
      workflowName,
      status: state.status,
      startedAt: state.startedAt,
      completedAt: state.completedAt,
      duration,
      stepsCompleted,
      totalSteps: Object.keys(state.steps).length,
      triggeredBy: state.metadata?.triggeredBy,
      error: state.error?.message,
    };

    // Load existing history
    const store = await this.loadHistoryStore(state.workflowId);

    // Add or update entry
    const existingIndex = store.entries.findIndex(
      (e) => e.executionId === entry.executionId
    );
    if (existingIndex >= 0) {
      store.entries[existingIndex] = entry;
    } else {
      store.entries.unshift(entry); // Add to beginning (newest first)
    }

    // Cleanup old entries
    if (store.entries.length > (this.config.maxEntriesPerWorkflow || 100)) {
      store.entries = store.entries.slice(0, this.config.maxEntriesPerWorkflow);
    }

    await this.saveHistoryStore(state.workflowId, store);

    return entry;
  }

  /**
   * Get execution history entry
   */
  async getEntry(
    workflowId: string,
    executionId: string
  ): Promise<ExecutionHistory | null> {
    await this.ensureInitialized();

    const store = await this.loadHistoryStore(workflowId);
    return store.entries.find((e) => e.executionId === executionId) || null;
  }

  /**
   * Query execution history
   */
  async query(options?: HistoryQueryOptions): Promise<HistoryQueryResult> {
    await this.ensureInitialized();

    let allEntries: ExecutionHistory[] = [];

    if (options?.workflowId) {
      // Load history for specific workflow
      const store = await this.loadHistoryStore(options.workflowId);
      allEntries = store.entries;
    } else {
      // Load history for all workflows
      const files = await this.fs!.readdir(this.config.basePath);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        try {
          const content = await this.fs!.readFile(`${this.config.basePath}/${file}`);
          const store = JSON.parse(content) as HistoryStore;
          allEntries.push(...store.entries);
        } catch {
          // Skip invalid files
        }
      }
    }

    // Apply filters
    let filtered = allEntries;

    if (options?.status) {
      const statuses = Array.isArray(options.status) ? options.status : [options.status];
      filtered = filtered.filter((e) => statuses.includes(e.status));
    }

    if (options?.startedAfter) {
      const after = new Date(options.startedAfter).getTime();
      filtered = filtered.filter((e) => new Date(e.startedAt).getTime() >= after);
    }

    if (options?.startedBefore) {
      const before = new Date(options.startedBefore).getTime();
      filtered = filtered.filter((e) => new Date(e.startedAt).getTime() <= before);
    }

    if (options?.triggeredBy) {
      filtered = filtered.filter((e) => e.triggeredBy === options.triggeredBy);
    }

    // Sort
    const sortBy = options?.sortBy || 'startedAt';
    const sortOrder = options?.sortOrder || 'desc';

    filtered.sort((a, b) => {
      let aVal: number;
      let bVal: number;

      if (sortBy === 'startedAt') {
        aVal = new Date(a.startedAt).getTime();
        bVal = new Date(b.startedAt).getTime();
      } else if (sortBy === 'completedAt') {
        aVal = a.completedAt ? new Date(a.completedAt).getTime() : 0;
        bVal = b.completedAt ? new Date(b.completedAt).getTime() : 0;
      } else {
        aVal = a.duration || 0;
        bVal = b.duration || 0;
      }

      return sortOrder === 'asc' ? aVal - bVal : bVal - aVal;
    });

    const total = filtered.length;

    // Apply pagination
    const limit = options?.limit || 50;
    const offset = options?.offset || 0;
    const entries = filtered.slice(offset, offset + limit);

    return {
      entries,
      total,
      limit,
      offset,
    };
  }

  /**
   * Get history statistics
   */
  async getStats(workflowId?: string): Promise<HistoryStats> {
    const result = await this.query({ workflowId, limit: 10000 });
    const entries = result.entries;

    const totalExecutions = entries.length;
    const successfulExecutions = entries.filter((e) => e.status === 'completed').length;
    const failedExecutions = entries.filter((e) => e.status === 'failed').length;

    const durations = entries.filter((e) => e.duration).map((e) => e.duration!);
    const averageDuration =
      durations.length > 0
        ? durations.reduce((a, b) => a + b, 0) / durations.length
        : 0;

    const executionsByWorkflow: Record<string, number> = {};
    const executionsByStatus: Partial<Record<ExecutionStatus, number>> = {};

    for (const entry of entries) {
      executionsByWorkflow[entry.workflowId] =
        (executionsByWorkflow[entry.workflowId] || 0) + 1;
      executionsByStatus[entry.status] = (executionsByStatus[entry.status] || 0) + 1;
    }

    const recentExecutions = entries.slice(0, 10);

    return {
      totalExecutions,
      successfulExecutions,
      failedExecutions,
      averageDuration,
      executionsByWorkflow,
      executionsByStatus,
      recentExecutions,
    };
  }

  /**
   * Delete history for a workflow
   */
  async deleteWorkflowHistory(workflowId: string): Promise<void> {
    await this.ensureInitialized();

    const path = this.getHistoryPath(workflowId);

    try {
      await this.fs!.unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new StorageError('delete', `Failed to delete history: ${error}`);
      }
    }
  }

  /**
   * Delete a specific execution from history
   */
  async deleteExecution(workflowId: string, executionId: string): Promise<boolean> {
    await this.ensureInitialized();

    const store = await this.loadHistoryStore(workflowId);
    const initialLength = store.entries.length;
    store.entries = store.entries.filter((e) => e.executionId !== executionId);

    if (store.entries.length < initialLength) {
      await this.saveHistoryStore(workflowId, store);
      return true;
    }

    return false;
  }

  /**
   * Prune old history entries
   */
  async pruneHistory(maxAge?: number): Promise<number> {
    await this.ensureInitialized();

    const cutoff = maxAge
      ? Date.now() - maxAge
      : Date.now() - 30 * 24 * 60 * 60 * 1000; // Default: 30 days

    let totalPruned = 0;
    const files = await this.fs!.readdir(this.config.basePath);

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      const workflowId = file.replace('.json', '');

      try {
        const store = await this.loadHistoryStore(workflowId);
        const initialLength = store.entries.length;

        store.entries = store.entries.filter(
          (e) => new Date(e.startedAt).getTime() >= cutoff
        );

        if (store.entries.length < initialLength) {
          await this.saveHistoryStore(workflowId, store);
          totalPruned += initialLength - store.entries.length;
        }
      } catch {
        // Skip invalid files
      }
    }

    return totalPruned;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private async loadHistoryStore(workflowId: string): Promise<HistoryStore> {
    const path = this.getHistoryPath(workflowId);

    try {
      const content = await this.fs!.readFile(path);
      return JSON.parse(content) as HistoryStore;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, entries: [] };
      }
      throw new StorageError('read', `Failed to read history: ${error}`);
    }
  }

  private async saveHistoryStore(workflowId: string, store: HistoryStore): Promise<void> {
    const path = this.getHistoryPath(workflowId);

    try {
      await this.fs!.writeFile(path, JSON.stringify(store, null, 2));
    } catch (error) {
      throw new StorageError('write', `Failed to save history: ${error}`);
    }
  }
}

// ============================================================================
// Default Instance
// ============================================================================

let defaultManager: HistoryManager | null = null;

export function getDefaultHistoryManager(): HistoryManager {
  if (!defaultManager) {
    const homedir = process.env.HOME || process.env.USERPROFILE || '.';
    defaultManager = new HistoryManager({
      basePath: `${homedir}/.flowforge/history`,
    });
  }
  return defaultManager;
}

export function setDefaultHistoryManager(manager: HistoryManager): void {
  defaultManager = manager;
}

// ============================================================================
// Helper Functions
// ============================================================================

export async function recordExecution(
  state: WorkflowState,
  workflowName: string
): Promise<ExecutionHistory> {
  return getDefaultHistoryManager().recordExecution(state, workflowName);
}

export async function queryHistory(options?: HistoryQueryOptions): Promise<HistoryQueryResult> {
  return getDefaultHistoryManager().query(options);
}

export async function getHistoryStats(workflowId?: string): Promise<HistoryStats> {
  return getDefaultHistoryManager().getStats(workflowId);
}
