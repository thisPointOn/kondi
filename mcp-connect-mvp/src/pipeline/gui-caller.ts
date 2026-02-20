/**
 * GUI Pipeline Caller
 *
 * Unified LLM caller for pipeline execution in the GUI.
 *
 * CLI providers (anthropic-cli, openai-cli) spawn the Claude/Codex CLI tools
 * via Tauri IPC — the same code path as the CLI pipeline runner. These tools
 * have their own MCP server support configured via their own settings.
 *
 * API providers (anthropic-api, openai-api, deepseek) use the direct API
 * clients and can receive MCP tools from the GUI's connected servers.
 */

import { invoke } from '@tauri-apps/api/core';
import { parseStreamJsonOutput, parseCodexJsonOutput, isOpenAIModel } from './output-parsers';
import { anthropicClient } from '../services/anthropicClient';
import { openaiClient } from '../services/openaiClient';
import { CLI_AVAILABLE } from '../services/cli-providers';
import type { MCPTool } from '../types/mcp';

export interface CallerResult {
  content: string;
  tokensUsed: number;
  latencyMs: number;
  sessionId?: string;
}

/** Options accepted by all callLLM variants */
export interface CallLLMOptions {
  systemPrompt: string;
  userMessage: string;
  model?: string;
  provider?: string;
  workingDir?: string;
  allowedTools?: string[];
  skipTools?: boolean;
  conversationId?: string;
  temperature?: number;
  /** MCP tools from GUI-connected servers (passed through to API providers) */
  availableTools?: Map<string, { serverId: string; tools: MCPTool[] }>;
}

interface ClaudeCommandResult {
  success: boolean;
  output: string;
  error: string | null;
  session_id: string | null;
}

interface CodexCommandResult {
  success: boolean;
  output: string;
  error: string | null;
  session_id: string | null;
}

// ============================================================================
// CLI Callers (spawn CLI tools via Tauri IPC)
// ============================================================================

/**
 * Call Claude CLI via Tauri's run_claude_streaming command.
 * Mirrors cli/claude-caller.ts callClaude() but uses Tauri IPC instead of Node spawn.
 *
 * MCP tools: Claude CLI uses its own configured MCP servers (via `claude mcp add`).
 */
export async function callClaudeGui(opts: CallLLMOptions): Promise<CallerResult> {
  const start = Date.now();

  const args: string[] = [];

  // Resume existing conversation or start new one
  if (opts.conversationId) {
    args.push('--resume', opts.conversationId, '--verbose', '--output-format', 'stream-json');
  } else {
    args.push('--print', '--verbose', '--output-format', 'stream-json');
  }

  if (opts.model) {
    args.push('--model', opts.model);
  }

  // System prompt only on first call (not when resuming)
  if (opts.systemPrompt && !opts.conversationId) {
    args.push('--system-prompt', opts.systemPrompt);
  }

  if (opts.skipTools) {
    args.push('--allowedTools', 'none');
  } else {
    const tools = (opts.allowedTools && opts.allowedTools.length > 0)
      ? opts.allowedTools
      : ['WebSearch', 'WebFetch', 'Edit', 'Write', 'Read', 'Bash', 'Glob', 'Grep'];
    args.push('--allowedTools', tools.join(','));
  }

  // Prompt piped via stdin (never as positional arg — --allowedTools is variadic)
  const result = await invoke<ClaudeCommandResult>('run_claude_streaming', {
    args,
    cwd: opts.workingDir || null,
    stdinInput: opts.userMessage,
    timeoutMs: 600_000, // 10 min for long agent runs
  });

  const latencyMs = Date.now() - start;

  if (!result.success && !result.output.includes('{"type":')) {
    throw new Error(`Claude CLI failed: ${result.error || result.output}`);
  }

  const parsed = parseStreamJsonOutput(result.output);

  return {
    content: parsed.text,
    tokensUsed: parsed.tokensUsed,
    latencyMs,
    sessionId: parsed.sessionId || result.session_id || undefined,
  };
}

/**
 * Call Codex CLI via Tauri's run_codex_command command.
 * Mirrors cli/codex-caller.ts callCodex() but uses Tauri IPC instead of Node spawn.
 *
 * MCP tools: Codex CLI uses its own configured MCP servers (via `codex mcp add`).
 */
export async function callCodexGui(opts: CallLLMOptions): Promise<CallerResult> {
  const start = Date.now();

  const args: string[] = ['exec'];

  // Resume existing conversation or start fresh
  if (opts.conversationId) {
    args.push('resume', opts.conversationId);
  }

  args.push('--json', '--skip-git-repo-check');

  if (opts.model) {
    args.push('--model', opts.model);
  }

  // Working directory only for new sessions
  if (!opts.conversationId && opts.workingDir) {
    args.push('--cd', opts.workingDir);
  }

  // Sandbox/full-auto flags only on new sessions — Codex resume rejects them
  if (!opts.conversationId) {
    if (opts.skipTools) {
      args.push('--sandbox', 'read-only');
    } else {
      args.push('--full-auto');
    }
  }

  // Prompt from stdin
  args.push('-');

  // Build the full prompt (include system prompt as prefix since codex exec
  // doesn't have a --system-prompt flag)
  const fullPrompt = opts.systemPrompt
    ? `${opts.systemPrompt}\n\n---\n\n${opts.userMessage}`
    : opts.userMessage;

  const result = await invoke<CodexCommandResult>('run_codex_command', {
    args,
    cwd: opts.workingDir || null,
    timeoutMs: 600_000, // 10 min
    input: fullPrompt,
  });

  const latencyMs = Date.now() - start;

  if (!result.success && !result.output.includes('thread.started')) {
    throw new Error(`Codex CLI failed: ${result.error || result.output}`);
  }

  const parsed = parseCodexJsonOutput(result.output);

  return {
    content: parsed.text,
    tokensUsed: parsed.tokensUsed,
    latencyMs,
    sessionId: parsed.sessionId || result.session_id || undefined,
  };
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

  // Temporarily force direct API mode and use a fresh conversation
  const savedUseCliWrapper = anthropicClient.getUseCliWrapper();
  const savedUseOAuth = anthropicClient.getUseOAuth();
  const savedConversationId = anthropicClient.getCurrentConversationId();
  anthropicClient.setUseCliWrapper(false);
  anthropicClient.setUseOAuth(false);
  anthropicClient.setCurrentConversationId(`pipeline-${crypto.randomUUID()}`);

  try {
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
  } finally {
    anthropicClient.setUseCliWrapper(savedUseCliWrapper);
    anthropicClient.setUseOAuth(savedUseOAuth);
    anthropicClient.setCurrentConversationId(savedConversationId);
  }
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

  // Temporarily force direct API mode and use a fresh conversation
  const savedUseCliWrapper = openaiClient.getUseCliWrapper();
  const savedUseOAuth = openaiClient.getUseOAuth();
  const savedConversationId = openaiClient.getCurrentConversationId();
  openaiClient.setUseCliWrapper(false);
  openaiClient.setUseOAuth(false);
  openaiClient.setCurrentConversationId(`pipeline-${crypto.randomUUID()}`);

  try {
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
  } finally {
    openaiClient.setUseCliWrapper(savedUseCliWrapper);
    openaiClient.setUseOAuth(savedUseOAuth);
    openaiClient.setCurrentConversationId(savedConversationId);
  }
}

/**
 * Call DeepSeek API directly.
 * DeepSeek uses an OpenAI-compatible API but has its own base URL and API key
 * configured in the openaiClient.
 */
async function callDeepSeekApi(opts: CallLLMOptions): Promise<CallerResult> {
  // DeepSeek uses the same openaiClient with a different base URL.
  // The openaiClient already handles provider routing based on model prefix.
  return callOpenAiApi({
    ...opts,
    model: opts.model || 'deepseek-chat',
  });
}

// ============================================================================
// Unified Router
// ============================================================================

/**
 * Unified LLM caller for GUI pipeline execution.
 *
 * Routes based on provider:
 *   - anthropic-cli  → Claude CLI via Tauri (same path as CLI runner)
 *   - openai-cli     → Codex CLI via Tauri (same path as CLI runner)
 *   - anthropic-api  → Direct Anthropic API (supports MCP tools)
 *   - openai-api     → Direct OpenAI API (supports MCP tools)
 *   - deepseek       → Direct DeepSeek API (OpenAI-compatible, supports MCP tools)
 *
 * Legacy providers ('anthropic', 'openai') route to CLI for backwards compat.
 * Falls back to model-name heuristic if provider is not specified.
 */
export function callLLM(opts: CallLLMOptions): Promise<CallerResult> {
  const provider = opts.provider || '';

  // CLI providers → spawn CLI tools directly via Tauri
  if (provider === 'anthropic-cli' || provider === 'anthropic') {
    return callClaudeGui(opts);
  }
  if (provider === 'openai-cli' || provider === 'openai') {
    return callCodexGui(opts);
  }

  // API providers → direct API calls (with MCP tool support)
  if (provider === 'anthropic-api') {
    return callAnthropicApi(opts);
  }
  if (provider === 'openai-api') {
    return callOpenAiApi(opts);
  }
  if (provider === 'deepseek') {
    return callDeepSeekApi(opts);
  }

  // Fallback: route based on model name, prefer API if CLI not available
  if (opts.model && isOpenAIModel(opts.model)) {
    return CLI_AVAILABLE ? callCodexGui(opts) : callOpenAiApi(opts);
  }
  return CLI_AVAILABLE ? callClaudeGui(opts) : callAnthropicApi(opts);
}
