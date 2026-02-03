/**
 * Council: LLM Provider Adapter
 * Bridges existing anthropicClient and openaiClient to the CouncilOrchestrator
 */

import type { LLMProvider } from './orchestrator';
import { anthropicClient } from '../services/anthropicClient';
import { openaiClient } from '../services/openaiClient';

interface CompletionParams {
  model: string;
  provider: string;
  systemPrompt: string;
  userMessage: string;
  temperature?: number;
}

interface CompletionResult {
  content: string;
  tokensUsed: number;
  latencyMs: number;
}

/**
 * Adapter that routes requests to the appropriate LLM client
 */
export class LLMAdapter implements LLMProvider {
  async complete(params: CompletionParams): Promise<CompletionResult> {
    const startTime = Date.now();

    try {
      if (params.provider === 'anthropic' || params.model.includes('claude')) {
        return await this.completeWithAnthropic(params, startTime);
      } else if (params.provider === 'openai' || params.model.includes('gpt')) {
        return await this.completeWithOpenAI(params, startTime);
      } else if (params.provider === 'deepseek' || params.model.includes('deepseek')) {
        // DeepSeek uses OpenAI-compatible API
        return await this.completeWithOpenAI(params, startTime);
      } else {
        // Default to Anthropic
        return await this.completeWithAnthropic(params, startTime);
      }
    } catch (error) {
      console.error('[LLMAdapter] Completion failed:', error);
      throw error;
    }
  }

  private async completeWithAnthropic(
    params: CompletionParams,
    startTime: number
  ): Promise<CompletionResult> {
    // Create a simple message for completion
    const messages = [
      {
        id: crypto.randomUUID(),
        role: 'user' as const,
        content: params.userMessage,
        timestamp: new Date(),
      },
    ];

    // Use the chat method with empty tools (no MCP tools for council)
    const availableTools = new Map();

    const result = await anthropicClient.chat(
      messages,
      availableTools,
      params.model || 'claude-sonnet-4-20250514',
      undefined, // serverSummary
      params.systemPrompt // additionalSystemPrompt
    );

    const latencyMs = Date.now() - startTime;

    // Estimate tokens (rough approximation)
    const inputTokens = Math.ceil((params.systemPrompt.length + params.userMessage.length) / 4);
    const outputTokens = Math.ceil(result.message.content.length / 4);

    return {
      content: result.message.content,
      tokensUsed: inputTokens + outputTokens,
      latencyMs,
    };
  }

  private async completeWithOpenAI(
    params: CompletionParams,
    startTime: number
  ): Promise<CompletionResult> {
    // Create a simple message for completion
    const messages = [
      {
        id: crypto.randomUUID(),
        role: 'user' as const,
        content: params.userMessage,
        timestamp: new Date(),
      },
    ];

    // Use the chat method with empty tools
    const availableTools = new Map();

    const result = await openaiClient.chat(
      messages,
      availableTools,
      params.model || 'gpt-4o',
      params.systemPrompt // additionalSystemPrompt
    );

    const latencyMs = Date.now() - startTime;

    // Estimate tokens (rough approximation)
    const inputTokens = Math.ceil((params.systemPrompt.length + params.userMessage.length) / 4);
    const outputTokens = Math.ceil(result.message.content.length / 4);

    return {
      content: result.message.content,
      tokensUsed: inputTokens + outputTokens,
      latencyMs,
    };
  }
}

// Singleton instance
export const llmAdapter = new LLMAdapter();
