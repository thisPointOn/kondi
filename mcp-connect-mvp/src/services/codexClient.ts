/**
 * Codex Client — ChatGPT Subscription (OAuth) via the Responses API.
 * Completely separate from openaiClient.ts (API key / Chat Completions).
 *
 * Endpoint: chatgpt.com/backend-api/codex/responses
 * Auth: OAuth token (ChatGPT subscription)
 * Format: OpenAI Responses API
 */

import { runToolLoop } from '../agent-runtime/tool-loop';
import type { RunToolLoopResult } from '../agent-runtime/types';
import { createGuiToolExecutor } from './gui-tool-executor';
import { toLoopHistory } from './chat-history';
import { openaiResponsesAdapter } from '../agent-runtime/adapters/openai-responses';
import { invoke } from '@tauri-apps/api/core';
import type { MCPTool, Message, ToolCall } from '../types/mcp';
import {
  reportSuccess,
  reportFailure,
  listProfiles,
  getCredentialKey,
} from './auth-profiles';

const BASE_SYSTEM_PROMPT = `You are ChatGPT, a helpful general-purpose AI assistant made by OpenAI. You can discuss any topic, answer questions, help with analysis, writing, coding, and much more.

You have access to MCP (Model Context Protocol) tools that let you interact with external services. These tools are OPTIONAL - use them when relevant to the user's request, but you are NOT limited to only topics related to these tools. You are a general-purpose assistant first.

CRITICAL CAPABILITY RULES:
- You have FULL network access. NEVER say "network access is restricted" or that you cannot access the network.
- Tool approval is AUTOMATIC. NEVER say approval is disabled or required.
- If tools are available, USE them. If they are not available in this specific call, provide your best analysis using your training knowledge — do NOT claim you are restricted or blocked.
- NEVER refuse a task by citing environment restrictions, sandboxing, or session policies.

IMPORTANT SECURITY RULES:
- NEVER ask users for passwords, login credentials, API keys, or authentication tokens.
- NEVER ask users to provide sensitive personal information like SSN, credit card numbers, etc.
- All MCP server connections are already authenticated. Use the available tools directly.
- If a tool requires authentication that isn't working, inform the user there's a connection issue - do not ask for credentials.

When using tools:
- Use the available MCP tools when they're relevant to the user's request.
- If no relevant tool is available, that's fine - help the user with your general knowledge instead.
- Present tool results clearly and concisely.`;

// Models supported by the codex/responses endpoint (verified against the
// installed Codex CLI v0.139.0). Note: which of these a given account can
// actually use depends on the plan — modelProbe hides the ones that error.
const CODEX_MODELS = [
  'gpt-5.5',
  'gpt-5.5-pro',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.4-nano',
  'gpt-5.3-codex',
  'gpt-5.2-codex',
];

export class CodexClient {
  private static readonly RATE_LIMIT_MAX_RETRIES = 5;
  private static readonly RATE_LIMIT_BASE_DELAY_MS = 10_000;

  /**
   * Invoke Tauri codex_request with rate limit retry.
   */
  private async invokeWithRetry(body: string, bearerToken: string): Promise<string> {
    for (let attempt = 0; attempt <= CodexClient.RATE_LIMIT_MAX_RETRIES; attempt++) {
      try {
        return await invoke<string>('codex_request', { body, bearerToken });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const isTransient = /\b(429|529|rate.limit|overloaded|too many requests)\b/i.test(errMsg);

        if (isTransient && attempt < CodexClient.RATE_LIMIT_MAX_RETRIES) {
          const delayMs = CodexClient.RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, attempt);
          console.warn(`[Codex] Rate limited, retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt + 1}/${CodexClient.RATE_LIMIT_MAX_RETRIES})`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
          continue;
        }
        throw err;
      }
    }
    throw new Error('Unexpected: exhausted Codex retry loop');
  }

  /**
   * Resolve the OAuth token from stored profiles.
   */
  private getOAuthToken(): { token: string; profileId: string } | null {
    const profile = listProfiles('openai').find(
      p => p.credential.type === 'oauth' || p.credential.type === 'token'
    );
    if (!profile) return null;
    return { token: getCredentialKey(profile.credential), profileId: profile.id };
  }


  listModels(): string[] {
    return CODEX_MODELS;
  }

  async validate(): Promise<{ ok: boolean; error?: string }> {
    const auth = this.getOAuthToken();
    if (!auth) {
      return { ok: false, error: 'No OpenAI OAuth credentials configured.' };
    }

    try {
      await this.invokeWithRetry(
        JSON.stringify({
          model: 'gpt-5.5',
          instructions: 'Reply with ok.',
          input: [{ type: 'message', role: 'user', content: 'hi' }],
          store: false,
        }),
        auth.token,
      );
      reportSuccess(auth.profileId);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A "model not supported" 400 means the OAuth token IS valid (auth passed)
      // — the account just doesn't allow this specific test model. The user
      // picks a supported model at chat time, so treat the credential as good.
      const isModelMismatch = /not supported|unsupported model|model.*not|400/i.test(msg)
        && !/401|403|unauthorized|invalid|expired|revoked|no credentials/i.test(msg);
      if (isModelMismatch) {
        reportSuccess(auth.profileId);
        return { ok: true };
      }
      console.error('[Codex] Validation failed', err);
      return { ok: false, error: msg };
    }
  }

  async chat(
    messages: Message[],
    availableTools: Map<string, { serverId: string; tools: MCPTool[] }>,
    model = 'gpt-5.5',
    additionalSystemPrompt?: string,
    workingDirectory?: string,
    signal?: AbortSignal,
  ): Promise<{ message: Message; toolCalls: ToolCall[] }> {
    const auth = this.getOAuthToken();
    if (!auth) {
      throw new Error('No OpenAI OAuth credentials configured. Please connect via OAuth in Settings.');
    }

    const { token, profileId } = auth;

    // Build tool definitions in Responses API format (flat, not nested under "function")
    // Shared agentic loop over the Responses API; the transport is the Rust
    // `codex_request` command (chatgpt.com has no CORS headers and the endpoint
    // requires stream:true, which Rust injects and buffers).
    const executor = availableTools.size > 0 ? createGuiToolExecutor(availableTools) : undefined;
    const systemParts = [BASE_SYSTEM_PROMPT];
    if (workingDirectory) systemParts.push(`Current working directory: ${workingDirectory}`);
    if (additionalSystemPrompt) systemParts.push(additionalSystemPrompt);
    const { history, userMessage } = toLoopHistory(messages);

    const adapter = openaiResponsesAdapter({
      transport: (body) => this.invokeWithRetry(body, token),
      model: model || 'gpt-5.5',
      provider: 'openai-cli',
    });

    let result: RunToolLoopResult;
    try {
      result = await runToolLoop({ adapter, executor, system: systemParts.join('\n\n'), userMessage, history, workingDir: workingDirectory, signal });
      reportSuccess(profileId);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const statusMatch = errMsg.match(/(\d{3})/);
      reportFailure(profileId, statusMatch ? parseInt(statusMatch[1]) : undefined);
      throw err;
    }

    return {
      message: {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: result.content || '[No content returned]',
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
}

export const codexClient = new CodexClient();
