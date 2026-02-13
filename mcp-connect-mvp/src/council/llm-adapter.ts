/**
 * Council: LLM Provider Adapter
 * Bridges existing anthropicClient and openaiClient to the CouncilOrchestrator
 */

import type { LLMProvider } from './orchestrator';
import type { MCPTool } from '../types/mcp';
import { anthropicClient } from '../services/anthropicClient';
import { openaiClient } from '../services/openaiClient';

interface CompletionParams {
  model: string;
  provider: string;
  systemPrompt: string;
  userMessage: string;
  temperature?: number;
  availableTools?: Map<string, { serverId: string; tools: MCPTool[] }>;
  /** Resume an existing session (per-persona persistence within a council/step) */
  conversationId?: string;
}

interface CompletionResult {
  content: string;
  tokensUsed: number;
  latencyMs: number;
  /** Session ID for resuming this conversation */
  sessionId?: string;
}

/**
 * Adapter that routes requests to the appropriate LLM client.
 * Council/pipeline calls are standalone (no CLI session sharing) so each
 * call gets a fresh context — the orchestrator supplies all needed context
 * in the prompt itself.
 */
export class LLMAdapter implements LLMProvider {
  async complete(params: CompletionParams): Promise<CompletionResult> {
    const startTime = Date.now();

    const isAnthropic =
      params.provider === 'anthropic' ||
      params.provider === 'anthropic-cli' ||
      params.model.includes('claude');

    const isOpenAI =
      params.provider === 'openai' ||
      params.provider === 'openai-cli' ||
      params.model.includes('gpt');

    const isDeepSeek =
      params.provider === 'deepseek' ||
      params.model.includes('deepseek');

    try {
      if (isAnthropic) {
        return await this.completeWithAnthropic(params, startTime);
      } else if (isOpenAI) {
        return await this.completeWithOpenAI(params, startTime);
      } else if (isDeepSeek) {
        return await this.completeWithOpenAI(params, startTime);
      } else {
        // Default to Anthropic
        return await this.completeWithAnthropic(params, startTime);
      }
    } catch (error) {
      console.error('[LLMAdapter] Completion failed:', {
        provider: params.provider,
        model: params.model,
        error,
      });
      throw error;
    }
  }

  private async completeWithAnthropic(
    params: CompletionParams,
    startTime: number
  ): Promise<CompletionResult> {
    const messages = [
      {
        id: crypto.randomUUID(),
        role: 'user' as const,
        content: params.userMessage,
        timestamp: new Date(),
      },
    ];

    // Pass through MCP tools if provided, otherwise empty map
    const availableTools = params.availableTools || new Map();

    // For anthropic-cli providers, ensure CLI mode is active
    // so the request goes through the Claude CLI, not the direct API.
    const needsCliForce = params.provider === 'anthropic-cli' && !anthropicClient.getUseCliWrapper();

    // Use provided conversation ID for per-persona session persistence,
    // or create a fresh isolated ID to avoid polluting the user's chat session.
    const savedConversationId = anthropicClient.getCurrentConversationId();
    const sessionConversationId = params.conversationId || `council-${crypto.randomUUID()}`;
    anthropicClient.setCurrentConversationId(sessionConversationId);
    if (needsCliForce) anthropicClient.setUseCliWrapper(true);

    let result;
    try {
      result = await anthropicClient.chat(
        messages,
        availableTools,
        params.model || 'claude-sonnet-4-5-20250929',
        undefined, // serverSummary
        params.systemPrompt // additionalSystemPrompt
      );
    } finally {
      // Restore the main chat conversation ID and CLI mode
      anthropicClient.setCurrentConversationId(savedConversationId);
      if (needsCliForce) anthropicClient.setUseCliWrapper(false);
    }

    const latencyMs = Date.now() - startTime;

    // Estimate tokens (rough approximation)
    const inputTokens = Math.ceil((params.systemPrompt.length + params.userMessage.length) / 4);
    const outputTokens = Math.ceil(result.message.content.length / 4);

    return {
      content: result.message.content,
      tokensUsed: inputTokens + outputTokens,
      latencyMs,
      sessionId: sessionConversationId,
    };
  }

  private async completeWithOpenAI(
    params: CompletionParams,
    startTime: number
  ): Promise<CompletionResult> {
    const messages = [
      {
        id: crypto.randomUUID(),
        role: 'user' as const,
        content: params.userMessage,
        timestamp: new Date(),
      },
    ];

    // Pass through MCP tools if provided, otherwise empty map
    const availableTools = params.availableTools || new Map();

    // For openai-cli providers (codex models), ensure CLI mode is active
    // so the request goes through the Codex CLI, not the v1/chat/completions API.
    const needsCliForce = params.provider === 'openai-cli' && !openaiClient.getUseCliWrapper();

    // Use provided conversation ID for per-persona session persistence,
    // or create a fresh isolated ID.
    const savedConversationId = openaiClient.getCurrentConversationId();
    const sessionConversationId = params.conversationId || `council-${crypto.randomUUID()}`;
    openaiClient.setCurrentConversationId(sessionConversationId);
    if (needsCliForce) openaiClient.setUseCliWrapper(true);

    let result;
    try {
      result = await openaiClient.chat(
        messages,
        availableTools,
        params.model || 'gpt-4o',
        params.systemPrompt // additionalSystemPrompt
      );
    } finally {
      openaiClient.setCurrentConversationId(savedConversationId);
      if (needsCliForce) openaiClient.setUseCliWrapper(false);
    }

    const latencyMs = Date.now() - startTime;

    // Estimate tokens (rough approximation)
    const inputTokens = Math.ceil((params.systemPrompt.length + params.userMessage.length) / 4);
    const outputTokens = Math.ceil(result.message.content.length / 4);

    return {
      content: result.message.content,
      tokensUsed: inputTokens + outputTokens,
      latencyMs,
      sessionId: sessionConversationId,
    };
  }
}

// Singleton instance
export const llmAdapter = new LLMAdapter();
