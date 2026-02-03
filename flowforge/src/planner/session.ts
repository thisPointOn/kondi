/**
 * FlowForge Planning Session
 * Manages planning conversation state
 */

import { v4 as uuidv4 } from 'uuid';
import {
  PlanningSession,
  PlanningStatus,
  PlanningMessage,
  WorkflowSpec,
} from '../core/types.js';
import { PlanningSessionNotFoundError, PlanningSessionClosedError, StorageError } from '../core/errors.js';

// ============================================================================
// Session Manager Types
// ============================================================================

export interface SessionManagerConfig {
  /** Base directory for session storage */
  basePath: string;

  /** Maximum messages per session */
  maxMessages?: number;

  /** Session timeout (ms) - auto-close after inactivity */
  sessionTimeout?: number;

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
// Session Manager
// ============================================================================

export class SessionManager {
  private config: SessionManagerConfig;
  private fs: NonNullable<SessionManagerConfig['fs']> | null = null;
  private initialized = false;
  private sessions: Map<string, PlanningSession> = new Map();

  constructor(config: SessionManagerConfig) {
    this.config = {
      maxMessages: 100,
      sessionTimeout: 30 * 60 * 1000, // 30 minutes
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

  private getSessionPath(sessionId: string): string {
    return `${this.config.basePath}/${sessionId}.json`;
  }

  // ============================================================================
  // Session CRUD
  // ============================================================================

  /**
   * Create a new planning session
   */
  async createSession(): Promise<PlanningSession> {
    await this.ensureInitialized();

    const now = new Date().toISOString();
    const session: PlanningSession = {
      id: uuidv4(),
      status: 'active',
      messages: [],
      createdAt: now,
      updatedAt: now,
    };

    await this.saveSession(session);
    this.sessions.set(session.id, session);

    return session;
  }

  /**
   * Get a session by ID
   */
  async getSession(sessionId: string): Promise<PlanningSession> {
    // Check in-memory cache first
    const cached = this.sessions.get(sessionId);
    if (cached) return cached;

    await this.ensureInitialized();

    const path = this.getSessionPath(sessionId);
    try {
      const content = await this.fs!.readFile(path);
      const session = JSON.parse(content) as PlanningSession;
      this.sessions.set(sessionId, session);
      return session;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new PlanningSessionNotFoundError(sessionId);
      }
      throw new StorageError('read', `Failed to read session: ${error}`);
    }
  }

  /**
   * Update session status
   */
  async setStatus(sessionId: string, status: PlanningStatus): Promise<PlanningSession> {
    const session = await this.getSession(sessionId);
    session.status = status;
    session.updatedAt = new Date().toISOString();
    await this.saveSession(session);
    return session;
  }

  /**
   * Delete a session
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.ensureInitialized();
    this.sessions.delete(sessionId);

    const path = this.getSessionPath(sessionId);
    try {
      await this.fs!.unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new StorageError('delete', `Failed to delete session: ${error}`);
      }
    }
  }

  /**
   * List all sessions
   */
  async listSessions(status?: PlanningStatus): Promise<PlanningSession[]> {
    await this.ensureInitialized();

    const files = await this.fs!.readdir(this.config.basePath);
    const sessions: PlanningSession[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;

      try {
        const content = await this.fs!.readFile(`${this.config.basePath}/${file}`);
        const session = JSON.parse(content) as PlanningSession;

        if (!status || session.status === status) {
          sessions.push(session);
        }
      } catch {
        // Skip invalid files
      }
    }

    // Sort by updated time, newest first
    return sessions.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }

  // ============================================================================
  // Message Management
  // ============================================================================

  /**
   * Add a message to the session
   */
  async addMessage(
    sessionId: string,
    role: 'user' | 'assistant' | 'system',
    content: string,
    specUpdate?: Partial<WorkflowSpec>
  ): Promise<PlanningMessage> {
    const session = await this.getSession(sessionId);

    if (session.status !== 'active') {
      throw new PlanningSessionClosedError(sessionId);
    }

    const message: PlanningMessage = {
      id: uuidv4(),
      role,
      content,
      timestamp: new Date().toISOString(),
      specUpdate,
    };

    session.messages.push(message);
    session.updatedAt = new Date().toISOString();

    // If there's a spec update, merge it
    if (specUpdate) {
      session.currentSpec = this.mergeSpec(session.currentSpec, specUpdate);
    }

    // Trim old messages if needed
    if (session.messages.length > (this.config.maxMessages || 100)) {
      // Keep system messages and trim oldest user/assistant messages
      const systemMessages = session.messages.filter((m) => m.role === 'system');
      const otherMessages = session.messages.filter((m) => m.role !== 'system');
      const trimmed = otherMessages.slice(-(this.config.maxMessages! - systemMessages.length));
      session.messages = [...systemMessages, ...trimmed];
    }

    await this.saveSession(session);

    return message;
  }

  /**
   * Get conversation history
   */
  async getMessages(sessionId: string): Promise<PlanningMessage[]> {
    const session = await this.getSession(sessionId);
    return session.messages;
  }

  /**
   * Clear conversation history (keep spec)
   */
  async clearMessages(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    session.messages = [];
    session.updatedAt = new Date().toISOString();
    await this.saveSession(session);
  }

  // ============================================================================
  // Spec Management
  // ============================================================================

  /**
   * Get the current workflow spec draft
   */
  async getSpec(sessionId: string): Promise<Partial<WorkflowSpec> | undefined> {
    const session = await this.getSession(sessionId);
    return session.currentSpec;
  }

  /**
   * Update the workflow spec draft
   */
  async updateSpec(
    sessionId: string,
    specUpdate: Partial<WorkflowSpec>
  ): Promise<Partial<WorkflowSpec>> {
    const session = await this.getSession(sessionId);

    if (session.status !== 'active') {
      throw new PlanningSessionClosedError(sessionId);
    }

    session.currentSpec = this.mergeSpec(session.currentSpec, specUpdate);
    session.updatedAt = new Date().toISOString();
    await this.saveSession(session);

    return session.currentSpec;
  }

  /**
   * Set the complete workflow spec
   */
  async setSpec(
    sessionId: string,
    spec: Partial<WorkflowSpec>
  ): Promise<Partial<WorkflowSpec>> {
    const session = await this.getSession(sessionId);

    if (session.status !== 'active') {
      throw new PlanningSessionClosedError(sessionId);
    }

    session.currentSpec = spec;
    session.updatedAt = new Date().toISOString();
    await this.saveSession(session);

    return session.currentSpec;
  }

  /**
   * Clear the workflow spec
   */
  async clearSpec(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    session.currentSpec = undefined;
    session.updatedAt = new Date().toISOString();
    await this.saveSession(session);
  }

  // ============================================================================
  // Session Lifecycle
  // ============================================================================

  /**
   * Complete a session (workflow accepted)
   */
  async completeSession(sessionId: string): Promise<PlanningSession> {
    return this.setStatus(sessionId, 'completed');
  }

  /**
   * Abandon a session
   */
  async abandonSession(sessionId: string): Promise<PlanningSession> {
    return this.setStatus(sessionId, 'abandoned');
  }

  /**
   * Check if session is active
   */
  async isActive(sessionId: string): Promise<boolean> {
    try {
      const session = await this.getSession(sessionId);
      return session.status === 'active';
    } catch {
      return false;
    }
  }

  /**
   * Clean up stale sessions
   */
  async cleanupStaleSessions(): Promise<number> {
    const sessions = await this.listSessions('active');
    const timeout = this.config.sessionTimeout || 30 * 60 * 1000;
    const cutoff = Date.now() - timeout;

    let cleaned = 0;
    for (const session of sessions) {
      if (new Date(session.updatedAt).getTime() < cutoff) {
        await this.setStatus(session.id, 'abandoned');
        cleaned++;
      }
    }

    return cleaned;
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private async saveSession(session: PlanningSession): Promise<void> {
    const path = this.getSessionPath(session.id);
    const content = JSON.stringify(session, null, 2);

    try {
      await this.fs!.writeFile(path, content);
      this.sessions.set(session.id, session);
    } catch (error) {
      throw new StorageError('write', `Failed to save session: ${error}`);
    }
  }

  private mergeSpec(
    current: Partial<WorkflowSpec> | undefined,
    update: Partial<WorkflowSpec>
  ): Partial<WorkflowSpec> {
    if (!current) return update;

    return {
      ...current,
      ...update,
      // Deep merge arrays
      inputs: update.inputs || current.inputs,
      outputs: update.outputs || current.outputs,
      steps: update.steps || current.steps,
      // Merge config
      config: current.config || update.config
        ? { ...current.config, ...update.config }
        : undefined,
      // Merge metadata
      metadata: current.metadata || update.metadata
        ? { ...current.metadata, ...update.metadata }
        : undefined,
    };
  }
}

// ============================================================================
// Default Instance
// ============================================================================

let defaultManager: SessionManager | null = null;

export function getDefaultSessionManager(): SessionManager {
  if (!defaultManager) {
    const homedir = process.env.HOME || process.env.USERPROFILE || '.';
    defaultManager = new SessionManager({
      basePath: `${homedir}/.flowforge/sessions`,
    });
  }
  return defaultManager;
}

export function setDefaultSessionManager(manager: SessionManager): void {
  defaultManager = manager;
}

// ============================================================================
// Helper Functions
// ============================================================================

export async function createPlanningSession(): Promise<PlanningSession> {
  return getDefaultSessionManager().createSession();
}

export async function getPlanningSession(sessionId: string): Promise<PlanningSession> {
  return getDefaultSessionManager().getSession(sessionId);
}

export async function addSessionMessage(
  sessionId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
  specUpdate?: Partial<WorkflowSpec>
): Promise<PlanningMessage> {
  return getDefaultSessionManager().addMessage(sessionId, role, content, specUpdate);
}

export async function getSessionSpec(
  sessionId: string
): Promise<Partial<WorkflowSpec> | undefined> {
  return getDefaultSessionManager().getSpec(sessionId);
}
