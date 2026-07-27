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
import { deepseekClient, xaiClient, ollamaClient, zaiClient,
  moonshotClient, nvidiaRouterClient } from './openaiCompatibleClient';
import { geminiClient } from './geminiClient';
import { mcpClient } from './mcpClient';
import { isRoutedModel, routeProfileName } from '../router/profile-options';
import { resolveRoutedModel } from '../router/resolve';
import type { LedgerPhase } from '../router/types';
import { recordModelCallFailure, recordModelCallSuccess } from './modelProbe';

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
  /**
   * Router phase hint. When provider/model select a routed profile
   * (`route:<name>`), this tells the Smart Router which kind of work this
   * call performs so it can pick an appropriately-priced model. Defaults to
   * 'discuss' (chat) when omitted.
   */
  routePhase?: LedgerPhase;
  /**
   * Live streaming callback. When provided, supported providers (OpenAI &
   * OpenAI-compatible: openai-api, deepseek, xai, zai, nvidia-router, ollama)
   * stream the assistant's text token-by-token. Used by chat; council/pipeline
   * leave it unset (buffered).
   */
  onToken?: (delta: string) => void;
}

/** Input for simple single-shot completion (council/pipeline) */
export interface SimpleCompletionParams {
  provider: string;
  model: string;
  systemPrompt: string;
  userMessage: string;
  availableTools?: Map<string, { serverId: string; tools: MCPTool[] }>;
  workingDirectory?: string;
  /** Router phase hint for routed profiles (see ChatCompletionParams). */
  routePhase?: LedgerPhase;
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
  'openai-cli': 'gpt-5.5',
  'google': 'models/gemini-2.5-flash',
  'deepseek': 'deepseek-v4-pro',
  'xai': 'grok-3',
  'zai': 'glm-4.6',
  'moonshot': 'kimi-k2.6',
  'nvidia-router': 'nvidia/nemotron-3-super-120b-a12b',
  'ollama': 'llama3.1',
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
  let prov = resolveProvider(params.provider);
  const tools = params.availableTools || new Map();
  let model = params.model || DEFAULT_MODELS[prov] || 'claude-sonnet-4-5-20250929';

  // Smart Router: a `route:<profile>` model (or the 'router' pseudo-provider)
  // defers model choice to the per-phase router. Resolve it to a concrete
  // provider+model here, then fall through to the normal dispatch below.
  if (isRoutedModel(prov, params.model)) {
    const profileName = routeProfileName(prov, params.model);
    const phase: LedgerPhase = params.routePhase || 'discuss';
    const lastUser = [...params.messages].reverse().find(m => m.role === 'user');
    const resolved = await resolveRoutedModel(profileName, phase, { prompt: lastUser?.content || '' });
    console.log(`[llm-router] route:${profileName} (${phase}) → ${resolved.provider}/${resolved.model} — ${resolved.reason}`);
    prov = resolved.provider;
    model = resolved.model;
  }

  // Ensure MCP proxies backing the provided tools are running and synced
  const toolServerIds = Array.from(tools.values()).map(t => t.serverId).filter(Boolean);
  if (toolServerIds.length > 0) {
    await mcpClient.ensureProxiesForServers(toolServerIds);
  }

  // The whole dispatch is wrapped so a "model not supported / not found" error
  // from any provider auto-hides that model (modelProbe), and a success clears
  // any stale broken flag. See modelProbe.recordModelCallFailure.
  const dispatch = async (): Promise<ChatResult> => {
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
      params.onToken,
    );
  }

  if (prov === 'deepseek') {
    return deepseekClient.chat(params.messages, tools, model, params.systemPrompt, params.workingDirectory, prov, params.onToken);
  }

  if (prov === 'xai') {
    return xaiClient.chat(params.messages, tools, model, params.systemPrompt, params.workingDirectory, prov, params.onToken);
  }

  if (prov === 'zai') {
    return zaiClient.chat(params.messages, tools, model, params.systemPrompt, params.workingDirectory, prov, params.onToken);
  }

  if (prov === 'moonshot') {
    return moonshotClient.chat(params.messages, tools, model, params.systemPrompt, params.workingDirectory, prov, params.onToken);
  }

  if (prov === 'nvidia-router') {
    return nvidiaRouterClient.chat(params.messages, tools, model, params.systemPrompt, params.workingDirectory, prov, params.onToken);
  }

  if (prov === 'ollama') {
    return ollamaClient.chat(params.messages, tools, model, params.systemPrompt, params.workingDirectory, prov, params.onToken);
  }

  if (prov === 'google') {
    return geminiClient.chat(params.messages, tools, model, params.systemPrompt, params.workingDirectory, prov);
  }

  // Default fallback: Anthropic API
  return anthropicClient.chat(
    params.messages, tools, model,
    params.serverSummary, params.systemPrompt, params.workingDirectory, prov,
  );
  };

  try {
    const result = await dispatch();
    recordModelCallSuccess(model);
    return result;
  } catch (err) {
    recordModelCallFailure(model, prov, err);
    throw err;
  }
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
    routePhase: params.routePhase,
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
