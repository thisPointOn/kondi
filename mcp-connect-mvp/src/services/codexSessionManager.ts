/**
 * Codex CLI Session Manager
 * Maps Kondi conversation IDs to Codex thread IDs
 */

interface SessionMapping {
  kondiConversationId: string;
  codexThreadId: string;
  model: string;
  createdAt: number;
  lastUsedAt: number;
  messageCount: number;
}

const STORAGE_KEY = 'kondi-codex-sessions';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

class CodexSessionManager {
  private mappings: Map<string, SessionMapping> = new Map();

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const data = JSON.parse(stored);
        for (const mapping of data.sessions || []) {
          this.mappings.set(mapping.kondiConversationId, mapping);
        }
        console.log('[CodexSessionManager] Loaded', this.mappings.size, 'session mappings');
      }
    } catch (e) {
      console.error('[CodexSessionManager] Failed to load sessions:', e);
    }
  }

  private persist(): void {
    try {
      const sessions = Array.from(this.mappings.values());
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessions }));
    } catch (e) {
      console.error('[CodexSessionManager] Failed to persist sessions:', e);
    }
  }

  /**
   * Get Codex thread ID for a Kondi conversation
   * Returns null if this is a new conversation
   */
  getCodexThreadId(kondiConversationId: string): string | null {
    const mapping = this.mappings.get(kondiConversationId);
    if (!mapping) return null;

    // Check if session is too old
    if (Date.now() - mapping.lastUsedAt > MAX_AGE_MS) {
      this.mappings.delete(kondiConversationId);
      this.persist();
      return null;
    }

    return mapping.codexThreadId;
  }

  /**
   * Record mapping after first message in a new conversation
   */
  registerSession(kondiConversationId: string, codexThreadId: string, model: string): void {
    this.mappings.set(kondiConversationId, {
      kondiConversationId,
      codexThreadId,
      model,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messageCount: 1,
    });
    this.persist();
    console.log('[CodexSessionManager] Registered session:', kondiConversationId, '->', codexThreadId);
  }

  /**
   * Update last used time and message count
   */
  touch(kondiConversationId: string): void {
    const mapping = this.mappings.get(kondiConversationId);
    if (mapping) {
      mapping.lastUsedAt = Date.now();
      mapping.messageCount++;
      this.persist();
    }
  }

  /**
   * Get session info for debugging
   */
  getSessionInfo(kondiConversationId: string): SessionMapping | null {
    return this.mappings.get(kondiConversationId) || null;
  }

  /**
   * Clear a specific session
   */
  clearSession(kondiConversationId: string): void {
    this.mappings.delete(kondiConversationId);
    this.persist();
  }

  /**
   * Evict stale sessions
   */
  prune(): number {
    const cutoff = Date.now() - MAX_AGE_MS;
    let pruned = 0;
    for (const [id, mapping] of this.mappings) {
      if (mapping.lastUsedAt < cutoff) {
        this.mappings.delete(id);
        pruned++;
      }
    }
    if (pruned > 0) {
      this.persist();
      console.log('[CodexSessionManager] Pruned', pruned, 'stale sessions');
    }
    return pruned;
  }
}

export const codexSessionManager = new CodexSessionManager();
