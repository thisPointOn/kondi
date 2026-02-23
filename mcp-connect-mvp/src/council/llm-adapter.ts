/**
 * Council: LLM Provider Adapter
 * Bridges existing anthropicClient and openaiClient to the CouncilOrchestrator
 * All providers route through direct API calls using auth profiles.
 */

import type { LLMProvider } from './orchestrator';
import type { MCPTool } from '../types/mcp';
import { anthropicClient } from '../services/anthropicClient';
import { openaiClient } from '../services/openaiClient';
import { codexClient } from '../services/codexClient';
import { deepseekClient, xaiClient, ollamaClient } from '../services/openaiCompatibleClient';
import { geminiClient } from '../services/geminiClient';

interface CompletionParams {
  model: string;
  provider: string;
  systemPrompt: string;
  userMessage: string;
  temperature?: number;
  availableTools?: Map<string, { serverId: string; tools: MCPTool[] }>;
  workingDirectory?: string;
}

interface CompletionResult {
  content: string;
  tokensUsed: number;
  latencyMs: number;
}

/**
 * Adapter that routes requests to the appropriate LLM client.
 * Council/pipeline calls are standalone — each call gets a fresh context.
 */
export class LLMAdapter implements LLMProvider {
  async complete(params: CompletionParams): Promise<CompletionResult> {
    const startTime = Date.now();

    const isAnthropic =
      params.provider === 'anthropic' ||
      params.provider === 'anthropic-cli' ||
      params.provider === 'anthropic-api' ||
      params.model.includes('claude');

    const isOpenAI =
      params.provider === 'openai' ||
      params.provider === 'openai-cli' ||
      params.provider === 'openai-api' ||
      params.model.includes('gpt');

    const isDeepSeek =
      params.provider === 'deepseek' ||
      params.model.includes('deepseek');

    const isXai =
      params.provider === 'xai' ||
      params.model.includes('grok');

    const isOllama =
      params.provider === 'ollama';

    const isGoogle =
      params.provider === 'google' ||
      params.model.includes('gemini');

    try {
      if (isAnthropic) {
        return await this.completeWithAnthropic(params, startTime);
      } else if (isDeepSeek) {
        return await this.completeWithCompatible(deepseekClient, params, startTime);
      } else if (isXai) {
        return await this.completeWithCompatible(xaiClient, params, startTime);
      } else if (isOllama) {
        return await this.completeWithCompatible(ollamaClient, params, startTime);
      } else if (isGoogle) {
        return await this.completeWithGemini(params, startTime);
      } else if (params.provider === 'openai-cli') {
        return await this.completeWithCodex(params, startTime);
      } else if (isOpenAI) {
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

    const availableTools = params.availableTools || new Map();

    const result = await anthropicClient.chat(
      messages,
      availableTools,
      params.model || 'claude-sonnet-4-5-20250929',
      undefined,
      params.systemPrompt,
      params.workingDirectory
    );

    const latencyMs = Date.now() - startTime;
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
    const messages = [
      {
        id: crypto.randomUUID(),
        role: 'user' as const,
        content: params.userMessage,
        timestamp: new Date(),
      },
    ];

    const availableTools = params.availableTools || new Map();

    const result = await openaiClient.chat(
      messages,
      availableTools,
      params.model || 'gpt-4o',
      params.systemPrompt,
      params.workingDirectory,
    );

    const latencyMs = Date.now() - startTime;
    const inputTokens = Math.ceil((params.systemPrompt.length + params.userMessage.length) / 4);
    const outputTokens = Math.ceil(result.message.content.length / 4);

    return {
      content: result.message.content,
      tokensUsed: inputTokens + outputTokens,
      latencyMs,
    };
  }
  private async completeWithCodex(
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

    const availableTools = params.availableTools || new Map();

    const result = await codexClient.chat(
      messages,
      availableTools,
      params.model || 'gpt-5.2-codex',
      params.systemPrompt,
      params.workingDirectory,
    );

    const latencyMs = Date.now() - startTime;
    const inputTokens = Math.ceil((params.systemPrompt.length + params.userMessage.length) / 4);
    const outputTokens = Math.ceil(result.message.content.length / 4);

    return {
      content: result.message.content,
      tokensUsed: inputTokens + outputTokens,
      latencyMs,
    };
  }

  private async completeWithCompatible(
    client: import('../services/openaiCompatibleClient').OpenAICompatibleClient,
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

    const availableTools = params.availableTools || new Map();

    const result = await client.chat(
      messages,
      availableTools,
      params.model,
      params.systemPrompt,
      params.workingDirectory
    );

    const latencyMs = Date.now() - startTime;
    const inputTokens = Math.ceil((params.systemPrompt.length + params.userMessage.length) / 4);
    const outputTokens = Math.ceil(result.message.content.length / 4);

    return {
      content: result.message.content,
      tokensUsed: inputTokens + outputTokens,
      latencyMs,
    };
  }

  private async completeWithGemini(
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

    const availableTools = params.availableTools || new Map();

    const result = await geminiClient.chat(
      messages,
      availableTools,
      params.model || 'models/gemini-2.5-flash',
      params.systemPrompt,
      params.workingDirectory
    );

    const latencyMs = Date.now() - startTime;
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
