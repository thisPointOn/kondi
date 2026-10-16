import { invoke } from '@tauri-apps/api/core';
import { runToolLoop } from '../agent-runtime/tool-loop';
import type { RunToolLoopResult } from '../agent-runtime/types';
import { createGuiToolExecutor } from './gui-tool-executor';
import { toLoopHistory } from './chat-history';
import { anthropicAdapter } from '../agent-runtime/adapters/anthropic';
import { relayFetch } from './relayFetch';
import type { MCPTool, Message, ToolCall } from '../types/mcp';
import {
  resolveApiKey,
  resolveApiKeySync,
  getBetasForToken,
  reportSuccess,
  reportFailure,
  PROFILE_IDS,
} from './auth-profiles';

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: { type: 'text' | 'tool_use' | 'tool_result'; text?: string; id?: string; name?: string; input?: any; tool_use_id?: string }[];
};

const BASE_SYSTEM_PROMPT = `You are Claude, a helpful general-purpose AI assistant made by Anthropic. You can discuss any topic, answer questions, help with analysis, writing, coding, and much more.

You also have access to MCP (Model Context Protocol) tools that let you interact with external services. These tools are OPTIONAL - use them when relevant to the user's request, but you are NOT limited to only topics related to these tools. You are a general-purpose assistant first.

CRITICAL EXECUTION RULES — TOOL CALLING:
A response that says "I'm doing it now" or "proceeding" WITHOUT tool_use blocks is a FAILED response. You MUST include actual tool calls. Every response where you promise to act MUST contain tool_use function calls — no exceptions.

BANNED PATTERNS (these are failures — never produce them):
- "I'll do this now." [end of response with no tool calls]
- "Proceeding with execution-only mode." [end of response with no tool calls]
- "Starting now." [end of response with no tool calls]
- Any response where you say you will act but produce zero tool_use calls

CORRECT PATTERN:
- Brief explanation (optional) FOLLOWED BY actual tool_use calls in the same response
- If you need data, call the tool to get it. If you need to create something, call the tool to create it. Do this NOW, not "next".
- Do NOT ask for confirmation before using tools unless the operation is destructive (deleting data, overwriting files). For read operations, searches, and data retrieval — just execute.

IMPORTANT SECURITY RULES:
- NEVER ask users for passwords, login credentials, API keys, or authentication tokens.
- NEVER ask users to provide sensitive personal information like SSN, credit card numbers, etc.
- All MCP server connections are already authenticated. Use the available tools directly.
- If a tool requires authentication that isn't working, inform the user there's a connection issue - do not ask for credentials.

When using tools:
- Use the available MCP tools when they're relevant to the user's request.
- If no relevant tool is available, that's fine - help the user with your general knowledge instead.
- Present tool results clearly and concisely.`;

class AnthropicClient {
  getAuthMethod(): 'oauth' | 'api_key' | 'none' {
    // Synchronous check — looks at what profiles are available
    // This is used for UI display only; actual auth resolution happens async in request()
    const resolved = resolveApiKeySync('anthropic');
    if (resolved) {
      return resolved.credential.type === 'api_key' ? 'api_key' : 'oauth';
    }
    return 'none';
  }

  private static readonly RATE_LIMIT_MAX_RETRIES = 5;
  private static readonly RATE_LIMIT_BASE_DELAY_MS = 10_000; // 10 seconds

  private async request(
    path: string,
    method: 'GET' | 'POST',
    body?: Record<string, any>,
    apiKeyOverride?: string,
    preferredProfileId?: string,
  ): Promise<any> {
    const payload = body ? JSON.stringify(body) : null;

    let token: string;
    let profileId: string | null = null;

    if (apiKeyOverride) {
      token = apiKeyOverride;
    } else {
      const resolved = await resolveApiKey('anthropic', preferredProfileId);
      if (!resolved) {
        throw new Error('No Anthropic authentication configured. Please set up credentials in Settings.');
      }
      token = resolved.apiKey;
      profileId = resolved.profileId;
    }

    // Determine beta headers based on token type
    const betas = getBetasForToken(token);
    const url = `https://api.anthropic.com${path}`;

    // Debug: log the full request details for diagnosing 400 errors
    if (method === 'POST' && path === '/v1/messages') {
      console.log(`[Anthropic request] POST ${url}`);
      console.log(`[Anthropic request] betas: ${betas.join(', ')}`);
      console.log(`[Anthropic request] token prefix: ${token.substring(0, 15)}...`);
      console.log(`[Anthropic request] payload (first 2000 chars):`, payload?.substring(0, 2000));
    }

    for (let attempt = 0; attempt <= AnthropicClient.RATE_LIMIT_MAX_RETRIES; attempt++) {
      try {
        const text = await invoke<string>('anthropic_request', {
          url,
          method,
          body: payload,
          apiKey: token,
          betas,
        });

        // Report success
        if (profileId) reportSuccess(profileId);

        return JSON.parse(text);
      } catch (err) {
        // Parse HTTP status from error message (format: "HTTP 401: ...")
        const errMsg = err instanceof Error ? err.message : String(err);
        const statusMatch = errMsg.match(/^HTTP (\d+):/);
        const httpStatus = statusMatch ? parseInt(statusMatch[1]) : undefined;

        // Retry on 429 (rate limit) and 529 (overloaded) with exponential backoff
        if ((httpStatus === 429 || httpStatus === 529) && attempt < AnthropicClient.RATE_LIMIT_MAX_RETRIES) {
          // Parse retry-after from error body if available
          const retryAfterMatch = errMsg.match(/retry.after[:\s"]*(\d+)/i);
          const retryAfterSec = retryAfterMatch ? parseInt(retryAfterMatch[1]) : 0;
          const backoffMs = Math.max(
            retryAfterSec * 1000,
            AnthropicClient.RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, attempt),
          );
          console.warn(`[Anthropic] Rate limited (${httpStatus}), retrying in ${Math.round(backoffMs / 1000)}s (attempt ${attempt + 1}/${AnthropicClient.RATE_LIMIT_MAX_RETRIES})...`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
          continue;
        }

        // Non-retryable error — report failure and throw
        if (profileId) reportFailure(profileId, httpStatus);
        throw err;
      }
    }

    // Should not reach here, but satisfy TypeScript
    throw new Error('Unexpected: exhausted retry loop');
  }

  async validateKey(key: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.request('/v1/models', 'GET', undefined, key);
      return { ok: true };
    } catch (err) {
      console.error('Anthropic key validation failed', err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listModels(apiKeyOverride?: string): Promise<string[]> {
    const data = await this.request('/v1/models', 'GET', undefined, apiKeyOverride);
    if (data && Array.isArray(data.data)) {
      return data.data
        .map((d: any) => d.id)
        .filter((id: string) => typeof id === 'string');
    }
    return [];
  }

  async chat(
    messages: Message[],
    availableTools: Map<string, { serverId: string; tools: MCPTool[] }>,
    model = 'claude-sonnet-4-5-20250929',
    serverSummary?: string,
    additionalSystemPrompt?: string,
    workingDirectory?: string,
    provId?: string,
    signal?: AbortSignal,
  ): Promise<{ message: Message; toolCalls: ToolCall[] }> {
    const authMethod = this.getAuthMethod();
    console.log('[Anthropic] chat() called', { authMethod, model, provId });

    if (authMethod === 'none') {
      throw new Error('No Anthropic authentication configured. Please set up credentials in Settings.');
    }

    // Map provider ID to auth profile ID so we stick to the user's chosen credential
    const preferredProfileId = provId === 'anthropic-cli'
      ? PROFILE_IDS.anthropicCli
      : provId === 'anthropic-api'
        ? PROFILE_IDS.anthropicApiKey
        : undefined;

    const resolved = await resolveApiKey('anthropic', preferredProfileId);
    if (!resolved) {
      throw new Error('No Anthropic authentication configured. Please set up credentials in Settings.');
    }
    const token = resolved.apiKey;
    const profileId = resolved.profileId;

    // Shared agentic loop (src/agent-runtime): streaming via the Rust relay
    // (api.anthropic.com over HTTPS, no CORS worries), tool calls executed through
    // the chat's local + MCP tools, real cancellation via `signal`, usage summed.
    const executor = availableTools.size > 0 ? createGuiToolExecutor(availableTools) : undefined;
    const system = [
      BASE_SYSTEM_PROMPT,
      workingDirectory ? `Current working directory: ${workingDirectory}` : undefined,
      additionalSystemPrompt,
      serverSummary,
    ].filter(Boolean).join('\n\n').trim();
    const { history, userMessage } = toLoopHistory(messages);

    const adapter = anthropicAdapter({
      fetchImpl: relayFetch,
      apiKey: token,
      model: model || 'claude-sonnet-4-5-20250929',
      betas: getBetasForToken(token),
      stream: true,
      provider: provId || 'anthropic-api',
    });

    let result: RunToolLoopResult;
    try {
      result = await runToolLoop({ adapter, executor, system, userMessage, history, workingDir: workingDirectory, signal });
      reportSuccess(profileId);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const statusMatch = errMsg.match(/HTTP (\d{3})/);
      reportFailure(profileId, statusMatch ? parseInt(statusMatch[1]) : undefined);
      if (/prompt is too long|too many tokens|context length exceeded/i.test(errMsg)) {
        throw new Error(`${errMsg}\n\nThe conversation (messages + tool results + ${executor?.list().length ?? 0} tool schemas) exceeded the model's context window. Start a new chat or trim the tool set.`);
      }
      throw err;
    }

    return {
      message: {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: result.content || '[No content returned - check console for details]',
        timestamp: new Date(),
        usage: result.usage.reported || result.usage.inputTokens > 0 || result.usage.outputTokens > 0 ? {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          billedInputTokens: result.usage.inputTokens + (result.usage.cacheReadTokens || 0) + (result.usage.cacheWriteTokens || 0),
          cacheRead: result.usage.cacheReadTokens,
          cacheCreation: result.usage.cacheWriteTokens,
          apiTurns: result.usage.apiTurns,
        } : undefined,
      },
      toolCalls: executor?.toolCalls ?? [],
    };
  }


  private async sendMessage(
    messages: AnthropicMessage[],
    tools?: any[],
    model?: string,
    system?: string,
    preferredProfileId?: string,
  ) {
    // Use array format for system prompt to enable prompt caching (API key path only)
    const systemContent = system ? [{
      type: 'text',
      text: system,
      cache_control: { type: 'ephemeral' }
    }] : undefined;

    // Add cache_control to last tool so the full tool list is cached
    let cachedTools = tools;
    if (tools && tools.length > 0) {
      cachedTools = tools.map((tool, i) =>
        i === tools.length - 1
          ? { ...tool, cache_control: { type: 'ephemeral' } }
          : tool
      );
    }

    const resolvedModel = model || 'claude-sonnet-4-5-20250929';

    // Debug: log exactly what we're sending so we can diagnose 400 errors
    const resolved = await resolveApiKey('anthropic', preferredProfileId);
    const tokenPrefix = resolved?.apiKey?.substring(0, 12) || 'none';
    const tokenType = resolved?.credential?.type || 'unknown';
    console.log(`[Anthropic sendMessage] model=${resolvedModel}, profileId=${preferredProfileId || 'auto'}, tokenType=${tokenType}, tokenPrefix=${tokenPrefix}...`);
    console.log(`[Anthropic sendMessage] messages=${messages.length}, tools=${cachedTools?.length || 0}, system=${systemContent ? 'yes' : 'no'}`);

    return this.request('/v1/messages', 'POST', {
      model: resolvedModel,
      max_tokens: 16384,
      messages,
      tools: cachedTools && cachedTools.length > 0 ? cachedTools : undefined,
      system: systemContent,
    }, undefined, preferredProfileId);
  }
}

export const anthropicClient = new AnthropicClient();

