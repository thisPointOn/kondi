/**
 * GUI Pipeline Caller
 *
 * Unified LLM caller for pipeline execution in the GUI.
 * All providers route through direct API calls using auth profiles.
 */

import { isOpenAIModel } from './output-parsers';
import { anthropicClient } from '../services/anthropicClient';
import { openaiClient } from '../services/openaiClient';
import { codexClient } from '../services/codexClient';
import { deepseekClient, xaiClient, ollamaClient } from '../services/openaiCompatibleClient';
import { geminiClient } from '../services/geminiClient';
import { LOCAL_SERVER_ID } from '../services/localTools';
import type { MCPTool } from '../types/mcp';

/**
 * Maps abstract orchestrator tool names to local tool names.
 * The orchestrator uses names like 'Read', 'Write', 'Bash' but
 * the actual local tools are 'read_file', 'write_file', 'run_command'.
 */
const ABSTRACT_TO_LOCAL: Record<string, string[]> = {
  'Read': ['read_file'],
  'Write': ['write_file'],
  'Edit': ['write_file'],   // Edit maps to write_file (overwrite)
  'Bash': ['run_command'],
  'Glob': ['list_directory'],
  'Grep': ['run_command'],   // Grep via run_command (grep/rg)
};

/**
 * Filter available tools based on the orchestrator's allowedTools list.
 * Removes local tools that aren't in the allowed set.
 * MCP server tools are passed through (server-level filtering is separate).
 */
function applyAllowedToolsFilter(
  tools: Map<string, { serverId: string; tools: MCPTool[] }>,
  allowedTools?: string[],
): Map<string, { serverId: string; tools: MCPTool[] }> {
  if (!allowedTools) return tools;

  // Build set of allowed local tool names from abstract names
  const allowedLocalNames = new Set<string>();
  for (const name of allowedTools) {
    const mapped = ABSTRACT_TO_LOCAL[name];
    if (mapped) {
      mapped.forEach(n => allowedLocalNames.add(n));
    }
  }

  const filtered = new Map<string, { serverId: string; tools: MCPTool[] }>();
  for (const [key, value] of tools) {
    if (key === LOCAL_SERVER_ID) {
      // Filter local tools to only allowed ones
      const filteredLocalTools = value.tools.filter(t => allowedLocalNames.has(t.name));
      if (filteredLocalTools.length > 0) {
        filtered.set(key, { serverId: value.serverId, tools: filteredLocalTools });
      }
    } else {
      // MCP server tools pass through (server-level filtering already done)
      filtered.set(key, value);
    }
  }
  return filtered;
}

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
  /** Abstract tool names from orchestrator (e.g. 'Read', 'Write', 'Bash') to filter local tools */
  allowedTools?: string[];
  /** Timeout in ms (default: 600_000 / 10 min) */
  timeoutMs?: number;
  /** Working directory override for local tool calls (bypasses singleton) */
  workingDirectory?: string;
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

  const tools = opts.skipTools ? new Map() : applyAllowedToolsFilter(opts.availableTools || new Map(), opts.allowedTools);

  const result = await anthropicClient.chat(
    messages,
    tools,
    opts.model || 'claude-sonnet-4-5-20250929',
    undefined,
    opts.systemPrompt,
    opts.workingDirectory,
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

  const tools = opts.skipTools ? new Map() : applyAllowedToolsFilter(opts.availableTools || new Map(), opts.allowedTools);

  const result = await openaiClient.chat(
    messages,
    tools,
    opts.model || 'gpt-4o',
    opts.systemPrompt,
    opts.workingDirectory,
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
 * Call Codex API (ChatGPT subscription via OAuth).
 * Used for openai-cli provider.
 */
async function callCodexApi(opts: CallLLMOptions): Promise<CallerResult> {
  const start = Date.now();

  const messages = [
    {
      id: crypto.randomUUID(),
      role: 'user' as const,
      content: opts.userMessage,
      timestamp: new Date(),
    },
  ];

  const tools = opts.skipTools ? new Map() : applyAllowedToolsFilter(opts.availableTools || new Map(), opts.allowedTools);

  const result = await codexClient.chat(
    messages,
    tools,
    opts.model || 'gpt-5.2-codex',
    opts.systemPrompt,
    opts.workingDirectory,
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
  const tools = opts.skipTools ? new Map() : applyAllowedToolsFilter(opts.availableTools || new Map(), opts.allowedTools);

  const result = await client.chat(messages, tools, opts.model, opts.systemPrompt, opts.workingDirectory);

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
  const tools = opts.skipTools ? new Map() : applyAllowedToolsFilter(opts.availableTools || new Map(), opts.allowedTools);

  const result = await geminiClient.chat(messages, tools, opts.model || 'models/gemini-2.5-flash', opts.systemPrompt, opts.workingDirectory);

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
 *   - openai-cli     → Codex API (ChatGPT subscription OAuth)
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

  // OpenAI CLI (ChatGPT subscription) → Codex API
  if (provider === 'openai-cli') {
    return callCodexApi(opts);
  }

  // OpenAI API key providers → direct API
  if (provider === 'openai-api' || provider === 'openai') {
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
