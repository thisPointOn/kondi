/**
 * FlowForge Checkpoint System
 * Enables checkpoint/resume for long-running workflow executions
 */

import { v4 as uuidv4 } from 'uuid';
import {
  WorkflowState,
  Checkpoint,
  ExecutorEvent,
} from '../core/types.js';
import {
  CheckpointNotFoundError,
  CheckpointCorruptedError,
  StorageError,
} from '../core/errors.js';

// ============================================================================
// Checkpoint Manager Types
// ============================================================================

export interface CheckpointManagerConfig {
  /** Base directory for checkpoint storage */
  basePath: string;

  /** Maximum checkpoints to keep per execution */
  maxCheckpointsPerExecution?: number;

  /** File system functions */
  fs?: {
    readFile: (path: string) => Promise<string>;
    writeFile: (path: string, content: string) => Promise<void>;
    unlink: (path: string) => Promise<void>;
    readdir: (path: string) => Promise<string[]>;
    mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
    exists: (path: string) => Promise<boolean>;
  };

  /** Event emitter for checkpoint events */
  onEvent?: (event: ExecutorEvent) => void;
}

export interface ListCheckpointsOptions {
  executionId?: string;
  workflowId?: string;
  limit?: number;
  offset?: number;
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
// Checkpoint Manager
// ============================================================================

export class CheckpointManager {
  private config: CheckpointManagerConfig;
  private fs: NonNullable<CheckpointManagerConfig['fs']> | null = null;
  private initialized = false;

  constructor(config: CheckpointManagerConfig) {
    this.config = {
      maxCheckpointsPerExecution: 10,
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

  private getCheckpointDir(executionId: string): string {
    return `${this.config.basePath}/${executionId}`;
  }

  private getCheckpointPath(executionId: string, checkpointId: string): string {
    return `${this.getCheckpointDir(executionId)}/${checkpointId}.json`;
  }

  private emit(event: ExecutorEvent): void {
    if (this.config.onEvent) {
      try {
        this.config.onEvent(event);
      } catch {
        // Ignore event handler errors
      }
    }
  }

  // ============================================================================
  // Checkpoint Operations
  // ============================================================================

  /**
   * Create a checkpoint for an execution
   */
  async createCheckpoint(
    state: WorkflowState,
    stepId: string,
    description?: string
  ): Promise<Checkpoint> {
    await this.ensureInitialized();

    const checkpointId = uuidv4();
    const now = new Date().toISOString();

    const checkpoint: Checkpoint = {
      id: checkpointId,
      executionId: state.executionId,
      workflowId: state.workflowId,
      state: JSON.parse(JSON.stringify(state)), // Deep clone
      createdAt: now,
      stepId,
      description,
    };

    // Save checkpoint
    const dir = this.getCheckpointDir(state.executionId);
    await this.fs!.mkdir(dir, { recursive: true });

    const path = this.getCheckpointPath(state.executionId, checkpointId);
    await this.fs!.writeFile(path, JSON.stringify(checkpoint, null, 2));

    // Emit event
    this.emit({
      type: 'checkpoint-created',
      executionId: state.executionId,
      workflowId: state.workflowId,
      checkpointId,
      stepId,
      timestamp: now,
    });

    // Clean up old checkpoints if needed
    await this.cleanupOldCheckpoints(state.executionId);

    return checkpoint;
  }

  /**
   * Get a checkpoint by ID
   */
  async getCheckpoint(executionId: string, checkpointId: string): Promise<Checkpoint> {
    await this.ensureInitialized();

    const path = this.getCheckpointPath(executionId, checkpointId);

    try {
      const content = await this.fs!.readFile(path);
      const checkpoint = JSON.parse(content) as Checkpoint;

      // Validate checkpoint integrity
      if (!checkpoint.id || !checkpoint.state || !checkpoint.executionId) {
        throw new CheckpointCorruptedError(checkpointId, 'Missing required fields');
      }

      return checkpoint;
    } catch (error) {
      if (error instanceof CheckpointCorruptedError) {
        throw error;
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new CheckpointNotFoundError(checkpointId);
      }
      throw new StorageError('read', `Failed to read checkpoint: ${error}`);
    }
  }

  /**
   * Get the latest checkpoint for an execution
   */
  async getLatestCheckpoint(executionId: string): Promise<Checkpoint | null> {
    await this.ensureInitialized();

    const checkpoints = await this.listCheckpoints({ executionId, limit: 1 });
    return checkpoints.length > 0 ? checkpoints[0] : null;
  }

  /**
   * List checkpoints with optional filtering
   */
  async listCheckpoints(options?: ListCheckpointsOptions): Promise<Checkpoint[]> {
    await this.ensureInitialized();

    const checkpoints: Checkpoint[] = [];

    if (options?.executionId) {
      // List checkpoints for specific execution
      const dir = this.getCheckpointDir(options.executionId);
      const files = await this.fs!.readdir(dir);

      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        try {
          const content = await this.fs!.readFile(`${dir}/${file}`);
          const checkpoint = JSON.parse(content) as Checkpoint;
          checkpoints.push(checkpoint);
        } catch {
          // Skip invalid files
        }
      }
    } else {
      // List all checkpoints
      const executionDirs = await this.fs!.readdir(this.config.basePath);

      for (const execDir of executionDirs) {
        const dir = `${this.config.basePath}/${execDir}`;
        const files = await this.fs!.readdir(dir);

        for (const file of files) {
          if (!file.endsWith('.json')) continue;

          try {
            const content = await this.fs!.readFile(`${dir}/${file}`);
            const checkpoint = JSON.parse(content) as Checkpoint;

            // Filter by workflowId if specified
            if (options?.workflowId && checkpoint.workflowId !== options.workflowId) {
              continue;
            }

            checkpoints.push(checkpoint);
          } catch {
            // Skip invalid files
          }
        }
      }
    }

    // Sort by creation time, newest first
    checkpoints.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    // Apply pagination
    const offset = options?.offset || 0;
    const limit = options?.limit || checkpoints.length;

    return checkpoints.slice(offset, offset + limit);
  }

  /**
   * Delete a checkpoint
   */
  async deleteCheckpoint(executionId: string, checkpointId: string): Promise<void> {
    await this.ensureInitialized();

    const path = this.getCheckpointPath(executionId, checkpointId);

    try {
      await this.fs!.unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new CheckpointNotFoundError(checkpointId);
      }
      throw new StorageError('delete', `Failed to delete checkpoint: ${error}`);
    }
  }

  /**
   * Delete all checkpoints for an execution
   */
  async deleteAllCheckpoints(executionId: string): Promise<number> {
    await this.ensureInitialized();

    const dir = this.getCheckpointDir(executionId);
    const files = await this.fs!.readdir(dir);

    let deleted = 0;
    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      try {
        await this.fs!.unlink(`${dir}/${file}`);
        deleted++;
      } catch {
        // Ignore deletion errors
      }
    }

    return deleted;
  }

  /**
   * Restore execution state from a checkpoint
   */
  async restoreFromCheckpoint(
    executionId: string,
    checkpointId: string
  ): Promise<WorkflowState> {
    const checkpoint = await this.getCheckpoint(executionId, checkpointId);

    // Create a fresh copy of the state
    const restoredState: WorkflowState = JSON.parse(JSON.stringify(checkpoint.state));

    // Update checkpoint reference
    restoredState.checkpointId = checkpointId;

    return restoredState;
  }

  /**
   * Check if any checkpoints exist for an execution
   */
  async hasCheckpoints(executionId: string): Promise<boolean> {
    await this.ensureInitialized();

    const dir = this.getCheckpointDir(executionId);
    const exists = await this.fs!.exists(dir);
    if (!exists) return false;

    const files = await this.fs!.readdir(dir);
    return files.some((f) => f.endsWith('.json'));
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private async cleanupOldCheckpoints(executionId: string): Promise<void> {
    const maxCheckpoints = this.config.maxCheckpointsPerExecution || 10;
    const checkpoints = await this.listCheckpoints({ executionId });

    if (checkpoints.length <= maxCheckpoints) return;

    // Delete oldest checkpoints
    const toDelete = checkpoints.slice(maxCheckpoints);
    for (const checkpoint of toDelete) {
      try {
        await this.deleteCheckpoint(executionId, checkpoint.id);
      } catch {
        // Ignore deletion errors
      }
    }
  }
}

// ============================================================================
// Default Instance
// ============================================================================

let defaultManager: CheckpointManager | null = null;

export function getDefaultCheckpointManager(): CheckpointManager {
  if (!defaultManager) {
    const homedir = process.env.HOME || process.env.USERPROFILE || '.';
    defaultManager = new CheckpointManager({
      basePath: `${homedir}/.flowforge/checkpoints`,
    });
  }
  return defaultManager;
}

export function setDefaultCheckpointManager(manager: CheckpointManager): void {
  defaultManager = manager;
}

// ============================================================================
// Helper Functions
// ============================================================================

export async function createCheckpoint(
  state: WorkflowState,
  stepId: string,
  description?: string
): Promise<Checkpoint> {
  return getDefaultCheckpointManager().createCheckpoint(state, stepId, description);
}

export async function restoreFromCheckpoint(
  executionId: string,
  checkpointId: string
): Promise<WorkflowState> {
  return getDefaultCheckpointManager().restoreFromCheckpoint(executionId, checkpointId);
}

export async function getLatestCheckpoint(executionId: string): Promise<Checkpoint | null> {
  return getDefaultCheckpointManager().getLatestCheckpoint(executionId);
}
