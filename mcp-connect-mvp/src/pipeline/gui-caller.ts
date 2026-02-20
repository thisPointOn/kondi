/**
 * GUI Pipeline Caller
 *
 * Unified LLM caller for pipeline execution in the GUI.
 * All providers route through direct API calls using auth profiles.
 */

import { isOpenAIModel } from './output-parsers';
import { anthropicClient } from '../services/anthropicClient';
import { openaiClient } from '../services/openaiClient';
import { deepseekClient, xaiClient, ollamaClient } from '../services/openaiCompatibleClient';
import { geminiClient } from '../services/geminiClient';
import type { MCPTool } from '../types/mcp';

export interface CallerResult {
  content: string;
  tokensUsed: number;
  latencyMs: number;
}

/** Options accepted by all callLLM variants */
export interface CallLLMOptions {
  systemPrompt: string;
  userMessage: string;
  model?: string;
  provider?: string;
  skipTools?: boolean;
  temperature?: number;
  /** MCP tools from GUI-connected servers (passed through to API providers) */
  availableTools?: Map<string, { serverId: string; tools: MCPTool[] }>;
  /** Timeout in ms (default: 600_000 / 10 min) */
  timeoutMs?: number;
}

// ============================================================================
// API Callers (direct API calls, support MCP tools from GUI)
// ============================================================================

/**
 * Call Anthropic API directly.
 * Receives MCP tools from GUI-connected servers if provided.
 */
async function callAnthropicApi(opts: CallLLMOptions): Promise<CallerResult> {
  const start = Date.now();

  const messages = [
    {
      id: crypto.randomUUID(),
      role: 'user' as const,
      content: opts.userMessage,
      timestamp: new Date(),
    },
  ];

  const tools = opts.skipTools ? new Map() : (opts.availableTools || new Map());

  const result = await anthropicClient.chat(
    messages,
    tools,
    opts.model || 'claude-sonnet-4-5-20250929',
    undefined,
    opts.systemPrompt,
  );

  const latencyMs = Date.now() - start;
  const inputTokens = Math.ceil((opts.systemPrompt.length + opts.userMessage.length) / 4);
  const outputTokens = Math.ceil(result.message.content.length / 4);

  return {
    content: result.message.content,
    tokensUsed: inputTokens + outputTokens,
    latencyMs,
  };
}

/**
 * Call OpenAI API directly.
 * Receives MCP tools from GUI-connected servers if provided.
 */
async function callOpenAiApi(opts: CallLLMOptions): Promise<CallerResult> {
  const start = Date.now();

  const messages = [
    {
      id: crypto.randomUUID(),
      role: 'user' as const,
      content: opts.userMessage,
      timestamp: new Date(),
    },
  ];

  const tools = opts.skipTools ? new Map() : (opts.availableTools || new Map());

  const result = await openaiClient.chat(
    messages,
    tools,
    opts.model || 'gpt-4o',
    opts.systemPrompt,
  );

  const latencyMs = Date.now() - start;
  const inputTokens = Math.ceil((opts.systemPrompt.length + opts.userMessage.length) / 4);
  const outputTokens = Math.ceil(result.message.content.length / 4);

  return {
    content: result.message.content,
    tokensUsed: inputTokens + outputTokens,
    latencyMs,
  };
}

/**
 * Call an OpenAI-compatible provider (DeepSeek, xAI, Ollama).
 */
async function callCompatibleApi(
  client: import('../services/openaiCompatibleClient').OpenAICompatibleClient,
  opts: CallLLMOptions
): Promise<CallerResult> {
  const start = Date.now();
  const messages = [
    { id: crypto.randomUUID(), role: 'user' as const, content: opts.userMessage, timestamp: new Date() },
  ];
  const tools = opts.skipTools ? new Map() : (opts.availableTools || new Map());

  const result = await client.chat(messages, tools, opts.model, opts.systemPrompt);

  const latencyMs = Date.now() - start;
  const inputTokens = Math.ceil((opts.systemPrompt.length + opts.userMessage.length) / 4);
  const outputTokens = Math.ceil(result.message.content.length / 4);

  return { content: result.message.content, tokensUsed: inputTokens + outputTokens, latencyMs };
}

/**
 * Call Gemini API via Tauri proxy.
 */
async function callGeminiApi(opts: CallLLMOptions): Promise<CallerResult> {
  const start = Date.now();
  const messages = [
    { id: crypto.randomUUID(), role: 'user' as const, content: opts.userMessage, timestamp: new Date() },
  ];
  const tools = opts.skipTools ? new Map() : (opts.availableTools || new Map());

  const result = await geminiClient.chat(messages, tools, opts.model || 'models/gemini-2.5-flash', opts.systemPrompt);

  const latencyMs = Date.now() - start;
  const inputTokens = Math.ceil((opts.systemPrompt.length + opts.userMessage.length) / 4);
  const outputTokens = Math.ceil(result.message.content.length / 4);

  return { content: result.message.content, tokensUsed: inputTokens + outputTokens, latencyMs };
}

// ============================================================================
// Unified Router
// ============================================================================

/**
 * Unified LLM caller for GUI pipeline execution.
 *
 * Routes based on provider:
 *   - anthropic-cli  → Direct Anthropic API (OAuth tokens)
 *   - anthropic-api  → Direct Anthropic API (API key)
 *   - openai-cli     → Direct OpenAI API (OAuth tokens)
 *   - openai-api     → Direct OpenAI API (API key)
 *   - deepseek       → Direct DeepSeek API (OpenAI-compatible)
 *
 * Falls back to model-name heuristic if provider is not specified.
 */
export function callLLM(opts: CallLLMOptions): Promise<CallerResult> {
  const provider = opts.provider || '';

  // All Anthropic providers → direct API
  if (provider === 'anthropic-cli' || provider === 'anthropic-api' || provider === 'anthropic') {
    return callAnthropicApi(opts);
  }

  // All OpenAI providers → direct API
  if (provider === 'openai-cli' || provider === 'openai-api' || provider === 'openai') {
    return callOpenAiApi(opts);
  }

  if (provider === 'deepseek') {
    return callCompatibleApi(deepseekClient, opts);
  }

  if (provider === 'xai') {
    return callCompatibleApi(xaiClient, opts);
  }

  if (provider === 'ollama') {
    return callCompatibleApi(ollamaClient, opts);
  }

  if (provider === 'google') {
    return callGeminiApi(opts);
  }

  // Fallback: route based on model name
  if (opts.model?.includes('grok')) return callCompatibleApi(xaiClient, opts);
  if (opts.model?.includes('deepseek')) return callCompatibleApi(deepseekClient, opts);
  if (opts.model?.includes('gemini')) return callGeminiApi(opts);
  if (opts.model && isOpenAIModel(opts.model)) return callOpenAiApi(opts);
  return callAnthropicApi(opts);
}
