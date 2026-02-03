/**
 * Conversation Summary Manager
 * Maintains rolling summaries of conversations for context efficiency
 */

interface ConversationSummary {
  conversationId: string;
  summary: string;
  keyPoints: string[];
  lastUpdated: number;
  messageCount: number;
}

const STORAGE_KEY = 'kondi-conversation-summaries';
const MAX_SUMMARY_LENGTH = 800;
const MAX_KEY_POINTS = 5;

class ConversationSummaryManager {
  private summaries: Map<string, ConversationSummary> = new Map();

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const data = JSON.parse(stored);
        for (const summary of data.summaries || []) {
          this.summaries.set(summary.conversationId, summary);
        }
      }
    } catch (e) {
      console.error('[ConversationSummary] Failed to load:', e);
    }
  }

  private persist(): void {
    try {
      const summaries = Array.from(this.summaries.values());
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ summaries }));
    } catch (e) {
      console.error('[ConversationSummary] Failed to persist:', e);
    }
  }

  /**
   * Get the current summary for a conversation
   */
  getSummary(conversationId: string): ConversationSummary | null {
    return this.summaries.get(conversationId) || null;
  }

  /**
   * Build context string for LLM calls
   * Returns summary + key points formatted for injection
   */
  buildContext(conversationId: string): string | null {
    const summary = this.summaries.get(conversationId);
    if (!summary || (!summary.summary && summary.keyPoints.length === 0)) {
      return null;
    }

    let context = '<conversation_summary>\n';
    if (summary.summary) {
      context += summary.summary + '\n';
    }
    if (summary.keyPoints.length > 0) {
      context += '\nKey points:\n' + summary.keyPoints.map(p => `- ${p}`).join('\n');
    }
    context += '\n</conversation_summary>';
    return context;
  }

  /**
   * Update summary after a conversation turn
   * Call this with the user message and assistant response
   */
  updateSummary(
    conversationId: string,
    userMessage: string,
    assistantResponse: string,
    extractedKeyPoint?: string
  ): void {
    const existing = this.summaries.get(conversationId);

    // Extract a key point from this exchange if not provided
    const keyPoint = extractedKeyPoint || this.extractKeyPoint(userMessage, assistantResponse);

    if (existing) {
      // Update existing summary
      const newKeyPoints = keyPoint
        ? [...existing.keyPoints, keyPoint].slice(-MAX_KEY_POINTS)
        : existing.keyPoints;

      // Compress summary if getting too long
      let newSummary = existing.summary;
      if (existing.messageCount > 0 && existing.messageCount % 5 === 0) {
        // Every 5 messages, add a brief note about recent topic
        const topic = this.extractTopic(userMessage);
        if (topic && !newSummary.includes(topic)) {
          newSummary = this.compressSummary(newSummary, topic);
        }
      }

      this.summaries.set(conversationId, {
        conversationId,
        summary: newSummary,
        keyPoints: newKeyPoints,
        lastUpdated: Date.now(),
        messageCount: existing.messageCount + 1,
      });
    } else {
      // Create new summary
      this.summaries.set(conversationId, {
        conversationId,
        summary: '',
        keyPoints: keyPoint ? [keyPoint] : [],
        lastUpdated: Date.now(),
        messageCount: 1,
      });
    }

    this.persist();
  }

  /**
   * Set summary directly (e.g., from LLM-generated summary)
   */
  setSummary(conversationId: string, summary: string, keyPoints?: string[]): void {
    const existing = this.summaries.get(conversationId);
    this.summaries.set(conversationId, {
      conversationId,
      summary: summary.slice(0, MAX_SUMMARY_LENGTH),
      keyPoints: keyPoints?.slice(0, MAX_KEY_POINTS) || existing?.keyPoints || [],
      lastUpdated: Date.now(),
      messageCount: existing?.messageCount || 0,
    });
    this.persist();
  }

  /**
   * Clear summary for a conversation
   */
  clearSummary(conversationId: string): void {
    this.summaries.delete(conversationId);
    this.persist();
  }

  /**
   * Extract a key point from a user/assistant exchange
   * Simple heuristic extraction - could be enhanced with LLM
   */
  private extractKeyPoint(userMessage: string, assistantResponse: string): string | null {
    // Look for factual statements the user made about themselves or their project
    const userLower = userMessage.toLowerCase();

    // Detect personal info shares
    const personalPatterns = [
      /(?:i am|i'm|my name is|i live in|i work at|i'm from)\s+([^.!?,]+)/i,
      /(?:i have|i've got|i own)\s+([^.!?,]+)/i,
      /(?:i want|i need|i'm looking for)\s+([^.!?,]+)/i,
    ];

    for (const pattern of personalPatterns) {
      const match = userMessage.match(pattern);
      if (match) {
        return `User: ${match[0].trim()}`;
      }
    }

    // Detect project/technical decisions
    if (userLower.includes('use ') || userLower.includes('using ')) {
      const techMatch = userMessage.match(/(?:use|using)\s+(\w+(?:\s+\w+)?)/i);
      if (techMatch) {
        return `Using: ${techMatch[1]}`;
      }
    }

    // If assistant provided specific info, note it
    if (assistantResponse.length < 200 && !assistantResponse.includes('?')) {
      // Short definitive response - might be a key answer
      return null; // Don't clutter with every short response
    }

    return null;
  }

  /**
   * Extract main topic from a message
   */
  private extractTopic(message: string): string | null {
    // Simple topic extraction - first noun phrase or subject
    const words = message.split(/\s+/).slice(0, 10);
    const topic = words.filter(w => w.length > 3 && /^[a-zA-Z]+$/.test(w)).slice(0, 3).join(' ');
    return topic.length > 5 ? topic : null;
  }

  /**
   * Compress summary to stay under limit
   */
  private compressSummary(existing: string, newTopic: string): string {
    let summary = existing;
    if (summary.length + newTopic.length + 20 > MAX_SUMMARY_LENGTH) {
      // Remove oldest part (first sentence or chunk)
      const firstPeriod = summary.indexOf('. ');
      if (firstPeriod > 0 && firstPeriod < summary.length / 2) {
        summary = summary.slice(firstPeriod + 2);
      } else {
        summary = summary.slice(summary.length / 3);
      }
    }
    return summary + (summary ? ' ' : '') + `Discussed: ${newTopic}.`;
  }
}

export const conversationSummary = new ConversationSummaryManager();
