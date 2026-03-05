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
import { BUILTIN_SERVER_IDS, countTools } from '../utils/filterTools';
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
// Timeout Helper
// ============================================================================

/**
 * Race a promise against a timeout. If the timeout fires first, the returned
 * promise rejects with a descriptive error. Passing `undefined` or `0` for
 * `ms` disables the timeout and returns the original promise unchanged.
 */
function withTimeout<T>(promise: Promise<T>, ms: number | undefined, label: string): Promise<T> {
  if (!ms) return promise;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms)
    ),
  ]);
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

  const result = await withTimeout(
    anthropicClient.chat(
      messages,
      tools,
      opts.model || 'claude-sonnet-4-5-20250929',
      undefined,
      opts.systemPrompt,
      opts.workingDirectory,
      opts.provider,
    ),
    opts.timeoutMs,
    'Anthropic API',
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

  const result = await withTimeout(
    openaiClient.chat(
      messages,
      tools,
      opts.model || 'gpt-4o',
      opts.systemPrompt,
      opts.workingDirectory,
      opts.provider,
    ),
    opts.timeoutMs,
    'OpenAI API',
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

  const result = await withTimeout(
    codexClient.chat(
      messages,
      tools,
      opts.model || 'gpt-5.2-codex',
      opts.systemPrompt,
      opts.workingDirectory,
    ),
    opts.timeoutMs,
    'Codex API',
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

  const result = await withTimeout(
    client.chat(messages, tools, opts.model, opts.systemPrompt, opts.workingDirectory, opts.provider),
    opts.timeoutMs,
    'Compatible API',
  );

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

  const result = await withTimeout(
    geminiClient.chat(messages, tools, opts.model || 'models/gemini-2.5-flash', opts.systemPrompt, opts.workingDirectory, opts.provider),
    opts.timeoutMs,
    'Gemini API',
  );

  const latencyMs = Date.now() - start;
  const inputTokens = Math.ceil((opts.systemPrompt.length + opts.userMessage.length) / 4);
  const outputTokens = Math.ceil(result.message.content.length / 4);

  return { content: result.message.content, tokensUsed: inputTokens + outputTokens, latencyMs };
}

// ============================================================================
// Tool Discovery
// ============================================================================

/**
 * Threshold above which we run an LLM discovery call to select tools.
 * ~40 tools × ~2K tokens/tool = ~80K tokens — safe margin under 200K limit.
 */
const TOOL_DISCOVERY_THRESHOLD = 40;

/**
 * Hard cap on tool definition tokens. Tool schemas average ~1.5K tokens each.
 * Leave ~100K for prompt + response within the 200K context window.
 */
const MAX_TOOL_TOKENS = 90_000;
const AVG_TOKENS_PER_TOOL = 1500;

/**
 * LLM-powered tool discovery: sends a compact tool index (names + short descriptions)
 * to the model and asks it to select which tools it needs for the task.
 * Returns a filtered tools map containing only the selected tools.
 */
async function discoverTools(
  tools: Map<string, { serverId: string; tools: MCPTool[] }>,
  opts: CallLLMOptions,
): Promise<Map<string, { serverId: string; tools: MCPTool[] }>> {
  // Build compact index of non-builtin tools
  const toolIndex: string[] = [];
  const toolLookup = new Map<string, { serverId: string; tool: MCPTool }>();

  for (const [key, { serverId, tools: serverTools }] of tools) {
    if (BUILTIN_SERVER_IDS.includes(key)) continue;
    for (const tool of serverTools) {
      toolIndex.push(`- ${tool.name}: ${(tool.description || '').slice(0, 120)}`);
      toolLookup.set(tool.name, { serverId, tool });
    }
  }

  const taskPreview = opts.userMessage.slice(0, 3000);

  const discoveryPrompt =
    `You are about to perform a task. Select ALL MCP tools you will need.\n\n` +
    `Available tools:\n${toolIndex.join('\n')}\n\n` +
    `Task context:\n${taskPreview}\n\n` +
    `System context:\n${(opts.systemPrompt || '').slice(0, 1000)}\n\n` +
    `Respond with ONLY a JSON array of tool name strings. Be inclusive — select every tool you might reasonably need.\n` +
    `Example: ["tool_a", "tool_b", "tool_c"]`;

  try {
    const start = Date.now();
    const result = await routeToProvider({
      ...opts,
      userMessage: discoveryPrompt,
      systemPrompt: 'You are a tool selector. Analyze the task and select all MCP tools that may be needed. Respond with ONLY a JSON array of tool name strings. Be generous — include any tool that could be useful.',
      skipTools: true,
      availableTools: undefined,
    });

    // Parse tool names from response
    const match = result.content.match(/\[[\s\S]*?\]/);
    let selectedNames: string[] = [];
    if (match) {
      try {
        selectedNames = JSON.parse(match[0]).filter((n: any) => typeof n === 'string');
      } catch { /* parse failure — fall through to fallback */ }
    }

    if (selectedNames.length === 0) {
      console.warn('[ToolDiscovery] No tools selected — sending all tools (will be capped)');
      return tools;
    }

    // Build filtered map — always keep built-in tools
    const filtered = new Map<string, { serverId: string; tools: MCPTool[] }>();
    for (const [key, value] of tools) {
      if (BUILTIN_SERVER_IDS.includes(key)) {
        filtered.set(key, value);
      }
    }
    for (const name of selectedNames) {
      const info = toolLookup.get(name);
      if (info) {
        if (!filtered.has(info.serverId)) {
          filtered.set(info.serverId, { serverId: info.serverId, tools: [] });
        }
        filtered.get(info.serverId)!.tools.push(info.tool);
      }
    }

    const selectedCount = countTools(filtered);
    console.log(`[ToolDiscovery] ${countTools(tools)} → ${selectedCount} tools in ${Date.now() - start}ms`);
    console.log(`[ToolDiscovery] Selected: ${selectedNames.join(', ')}`);
    return capToolTokens(filtered);
  } catch (err) {
    console.error('[ToolDiscovery] Discovery failed, sending all tools (will be capped):', err);
    return tools;
  }
}

/**
 * Cap tool definitions to stay within the token budget.
 * Drops non-builtin tools from the end until under the limit.
 */
function capToolTokens(
  tools: Map<string, { serverId: string; tools: MCPTool[] }>,
): Map<string, { serverId: string; tools: MCPTool[] }> {
  const total = countTools(tools);
  const estimatedTokens = total * AVG_TOKENS_PER_TOOL;
  if (estimatedTokens <= MAX_TOOL_TOKENS) return tools;

  const maxTools = Math.floor(MAX_TOOL_TOKENS / AVG_TOKENS_PER_TOOL);
  console.warn(`[ToolCap] ${total} tools (~${estimatedTokens} tokens) exceeds budget. Capping to ${maxTools} tools.`);

  const capped = new Map<string, { serverId: string; tools: MCPTool[] }>();
  let count = 0;

  // Always include builtin tools first
  for (const [key, value] of tools) {
    if (BUILTIN_SERVER_IDS.includes(key)) {
      capped.set(key, value);
      count += value.tools.length;
    }
  }

  // Add non-builtin tools until budget is reached
  for (const [key, value] of tools) {
    if (BUILTIN_SERVER_IDS.includes(key)) continue;
    const remaining = maxTools - count;
    if (remaining <= 0) break;
    if (value.tools.length <= remaining) {
      capped.set(key, value);
      count += value.tools.length;
    } else {
      capped.set(key, { serverId: value.serverId, tools: value.tools.slice(0, remaining) });
      count += remaining;
      break;
    }
  }

  console.log(`[ToolCap] Reduced to ${countTools(capped)} tools`);
  return capped;
}

// ============================================================================
// Unified Router
// ============================================================================

/**
 * Route a call to the appropriate provider without tool discovery.
 * Used internally by discoverTools to avoid recursion into discovery.
 */
function routeToProvider(opts: CallLLMOptions): Promise<CallerResult> {
  const provider = opts.provider || '';
  if (provider === 'anthropic-cli' || provider === 'anthropic-api' || provider === 'anthropic') return callAnthropicApi(opts);
  if (provider === 'openai-cli') return callCodexApi(opts);
  if (provider === 'openai-api' || provider === 'openai') return callOpenAiApi(opts);
  if (provider === 'deepseek') return callCompatibleApi(deepseekClient, opts);
  if (provider === 'xai') return callCompatibleApi(xaiClient, opts);
  if (provider === 'ollama') return callCompatibleApi(ollamaClient, opts);
  if (provider === 'google') return callGeminiApi(opts);
  if (opts.model?.includes('grok')) return callCompatibleApi(xaiClient, opts);
  if (opts.model?.includes('deepseek')) return callCompatibleApi(deepseekClient, opts);
  if (opts.model?.includes('gemini')) return callGeminiApi(opts);
  if (opts.model && isOpenAIModel(opts.model)) return callOpenAiApi(opts);
  return callAnthropicApi(opts);
}

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
 *
 * Automatically runs LLM tool discovery when the tool count exceeds the
 * threshold, asking the model to select which tools it needs before the
 * real call.
 */
export async function callLLM(opts: CallLLMOptions): Promise<CallerResult> {
  // Auto-discover tools when there are too many to send directly
  if (!opts.skipTools && opts.availableTools && countTools(opts.availableTools) > TOOL_DISCOVERY_THRESHOLD) {
    const discovered = await discoverTools(opts.availableTools, opts);
    opts = { ...opts, availableTools: discovered };
  }

  // Safety cap: ensure tool definitions don't blow the token budget even after discovery
  if (opts.availableTools) {
    opts = { ...opts, availableTools: capToolTokens(opts.availableTools) };
  }

  return routeToProvider(opts);
}
