/**
 * Unified LLM Router
 *
 * Single source of truth for all provider routing.
 * Used by chat (ChatArea), councils (LLMAdapter), and pipelines (gui-caller).
 *
 * All provider detection, default model resolution, and client dispatch
 * happens here. No other file should contain provider-routing logic.
 *
 * Both anthropic-cli and anthropic-api use the Anthropic Messages API.
 * The difference is auth: CLI uses the OAuth token from Claude Code's
 * credentials (openclaw pattern), API uses a direct API key.
 * Credential routing is handled by anthropicClient via the provId parameter.
 *
 * Similarly, openai-cli uses the Codex API with OAuth, openai-api uses
 * the OpenAI API with an API key.
 */

import type { Message, ToolCall, MCPTool } from '../types/mcp';
import { anthropicClient } from './anthropicClient';
import { claudeCliChat } from './claudeCliClient';
import { openaiClient } from './openaiClient';
import { codexClient } from './codexClient';
import { codexCliChat } from './codexCliClient';
import { deepseekClient, xaiClient, ollamaClient } from './openaiCompatibleClient';
import { geminiClient } from './geminiClient';

// ============================================================================
// Types
// ============================================================================

/** Result from any client's .chat() call */
export interface ChatResult {
  message: Message;
  toolCalls: ToolCall[];
}

/** Input for full chat path (multi-turn with tool loop) */
export interface ChatCompletionParams {
  provider: string;
  model: string;
  messages: Message[];
  availableTools: Map<string, { serverId: string; tools: MCPTool[] }>;
  systemPrompt?: string;
  workingDirectory?: string;
  /** Anthropic-only: server connection summary */
  serverSummary?: string;
  /** Chat ID for CLI session resumption (anthropic-cli) */
  chatId?: string;
}

/** Input for simple single-shot completion (council/pipeline) */
export interface SimpleCompletionParams {
  provider: string;
  model: string;
  systemPrompt: string;
  userMessage: string;
  availableTools?: Map<string, { serverId: string; tools: MCPTool[] }>;
  workingDirectory?: string;
}

export interface SimpleCompletionResult {
  content: string;
  tokensUsed: number;
  latencyMs: number;
}

// ============================================================================
// Default Models
// ============================================================================

export const DEFAULT_MODELS: Record<string, string> = {
  'anthropic': 'claude-sonnet-4-5-20250929',
  'anthropic-cli': 'claude-sonnet-4-5-20250929',
  'anthropic-api': 'claude-sonnet-4-5-20250929',
  'openai': 'gpt-4o',
  'openai-api': 'gpt-4o',
  'openai-cli': 'gpt-5.2-codex',
  'google': 'models/gemini-2.5-flash',
};

// ============================================================================
// Provider Resolution
// ============================================================================

/**
 * Validate that a provider was specified. Every call site must pass an
 * explicit provider — silent heuristic fallback is not allowed.
 */
function resolveProvider(provider: string): string {
  if (!provider) {
    throw new Error('LLM router: provider is required — every call must specify a provider explicitly');
  }
  return provider;
}

// ============================================================================
// Chat Completion (used by ChatArea for multi-turn chat)
// ============================================================================

/**
 * Route a chat request to the appropriate provider client.
 * This is the core routing function — all LLM calls go through here.
 *
 * anthropic-cli and anthropic-api both use the Anthropic Messages API.
 * The provId is passed through so the client resolves the correct
 * credential (OAuth token vs API key). They NEVER fall back to each other.
 */
export async function chatCompletion(params: ChatCompletionParams): Promise<ChatResult> {
  const prov = resolveProvider(params.provider);
  const tools = params.availableTools || new Map();
  const model = params.model || DEFAULT_MODELS[prov] || 'claude-sonnet-4-5-20250929';

  // Anthropic CLI — route through Claude CLI binary (OAuth tokens require it)
  if (prov === 'anthropic-cli') {
    return claudeCliChat(
      params.messages,
      tools,
      model,
      params.serverSummary,
      params.systemPrompt,
      params.workingDirectory,
      params.chatId,
    );
  }

  // Anthropic API — direct HTTP with API key
  if (prov.startsWith('anthropic')) {
    return anthropicClient.chat(
      params.messages,
      tools,
      model,
      params.serverSummary,
      params.systemPrompt,
      params.workingDirectory,
      prov,
    );
  }

  // OpenAI CLI — route through Codex CLI binary (OAuth tokens)
  if (prov === 'openai-cli') {
    return codexCliChat(
      params.messages,
      tools,
      model,
      params.systemPrompt,
      params.workingDirectory,
      params.chatId,
    );
  }

  // OpenAI API (direct API key)
  if (prov === 'openai-api' || prov.startsWith('openai')) {
    return openaiClient.chat(
      params.messages,
      tools,
      model,
      params.systemPrompt,
      params.workingDirectory,
      prov,
    );
  }

  if (prov === 'deepseek') {
    return deepseekClient.chat(params.messages, tools, model, params.systemPrompt, params.workingDirectory, prov);
  }

  if (prov === 'xai') {
    return xaiClient.chat(params.messages, tools, model, params.systemPrompt, params.workingDirectory, prov);
  }

  if (prov === 'ollama') {
    return ollamaClient.chat(params.messages, tools, model, params.systemPrompt, params.workingDirectory, prov);
  }

  if (prov === 'google') {
    return geminiClient.chat(params.messages, tools, model, params.systemPrompt, params.workingDirectory, prov);
  }

  // Default fallback: Anthropic API
  return anthropicClient.chat(
    params.messages, tools, model,
    params.serverSummary, params.systemPrompt, params.workingDirectory, prov,
  );
}

// ============================================================================
// Simple Completion (used by councils and pipelines)
// ============================================================================

/** Rough token estimate from character count */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Single-shot completion: creates a one-message conversation, routes to the
 * correct provider, and returns content + token estimate + latency.
 */
export async function simpleCompletion(params: SimpleCompletionParams): Promise<SimpleCompletionResult> {
  const startTime = Date.now();

  const messages: Message[] = [{
    id: crypto.randomUUID(),
    role: 'user' as const,
    content: params.userMessage,
    timestamp: new Date(),
  }];

  const result = await chatCompletion({
    provider: params.provider,
    model: params.model,
    messages,
    availableTools: params.availableTools || new Map(),
    systemPrompt: params.systemPrompt,
    workingDirectory: params.workingDirectory,
  });

  const latencyMs = Date.now() - startTime;
  const inputTokens = estimateTokens(params.systemPrompt + params.userMessage);
  const outputTokens = estimateTokens(result.message.content);

  return {
    content: result.message.content,
    tokensUsed: inputTokens + outputTokens,
    latencyMs,
  };
}
