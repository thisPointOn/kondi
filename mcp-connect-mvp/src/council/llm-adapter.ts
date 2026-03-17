/**
 * Council: LLM Provider Adapter
 *
 * Thin wrapper around the unified LLM router that implements the
 * LLMProvider interface expected by CouncilOrchestrator.
 */

import type { LLMProvider } from './orchestrator';
import type { MCPTool } from '../types/mcp';
import { simpleCompletion } from '../services/llm-router';

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
 * Adapter that routes requests to the appropriate LLM client via the unified router.
 */
export class LLMAdapter implements LLMProvider {
  async complete(params: CompletionParams): Promise<CompletionResult> {
    return simpleCompletion({
      provider: params.provider,
      model: params.model,
      systemPrompt: params.systemPrompt,
      userMessage: params.userMessage,
      availableTools: params.availableTools,
      workingDirectory: params.workingDirectory,
    });
  }
}

// Singleton instance
export const llmAdapter = new LLMAdapter();
