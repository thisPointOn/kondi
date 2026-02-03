/**
 * Claude Code Session Manager
 * Maps Kondi conversation IDs to Claude Code session IDs
 */

interface SessionMapping {
  kondiConversationId: string;
  claudeSessionId: string;
  model: string;
  createdAt: number;
  lastUsedAt: number;
  messageCount: number;
}

const STORAGE_KEY = 'kondi-claude-sessions';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

class ClaudeSessionManager {
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
        console.log('[SessionManager] Loaded', this.mappings.size, 'session mappings');
      }
    } catch (e) {
      console.error('[SessionManager] Failed to load sessions:', e);
    }
  }

  private persist(): void {
    try {
      const sessions = Array.from(this.mappings.values());
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessions }));
    } catch (e) {
      console.error('[SessionManager] Failed to persist sessions:', e);
    }
  }

  /**
   * Get Claude session ID for a Kondi conversation
   * Returns null if this is a new conversation
   */
  getClaudeSessionId(kondiConversationId: string): string | null {
    const mapping = this.mappings.get(kondiConversationId);
    if (!mapping) return null;

    // Check if session is too old
    if (Date.now() - mapping.lastUsedAt > MAX_AGE_MS) {
      this.mappings.delete(kondiConversationId);
      this.persist();
      return null;
    }

    return mapping.claudeSessionId;
  }

  /**
   * Record mapping after first message in a new conversation
   */
  registerSession(kondiConversationId: string, claudeSessionId: string, model: string): void {
    this.mappings.set(kondiConversationId, {
      kondiConversationId,
      claudeSessionId,
      model,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messageCount: 1,
    });
    this.persist();
    console.log('[SessionManager] Registered session:', kondiConversationId, '->', claudeSessionId);
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
   * Clear a specific session (e.g., when conversation is deleted)
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
      console.log('[SessionManager] Pruned', pruned, 'stale sessions');
    }
    return pruned;
  }
}

export const claudeSessionManager = new ClaudeSessionManager();
