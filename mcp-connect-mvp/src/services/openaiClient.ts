import OpenAI from 'openai';
import { runToolLoop } from '../agent-runtime/tool-loop';
import type { RunToolLoopResult } from '../agent-runtime/types';
import { createGuiToolExecutor } from './gui-tool-executor';
import { toLoopHistory } from './chat-history';
import { openaiCompatibleAdapter } from '../agent-runtime/adapters/openai-compatible';
import { getModelById } from '../config/models';
import type { MCPTool, Message, ToolCall } from '../types/mcp';
import {
  resolveApiKey,
  reportSuccess,
  reportFailure,
  PROFILE_IDS,
} from './auth-profiles';

const BASE_SYSTEM_PROMPT = `You are ChatGPT, a helpful general-purpose AI assistant made by OpenAI. You can discuss any topic, answer questions, help with analysis, writing, coding, and much more.

You have access to MCP (Model Context Protocol) tools that let you interact with external services. These tools are OPTIONAL - use them when relevant to the user's request, but you are NOT limited to only topics related to these tools. You are a general-purpose assistant first.

CRITICAL EXECUTION RULES — TOOL CALLING:
A response that says "I'm doing it now" or "proceeding with execution" WITHOUT tool_use blocks is a FAILED response. You MUST include actual tool calls. Every response where you promise to act MUST contain tool_use function calls — no exceptions.

BANNED PATTERNS (these are failures — never produce them):
- "I'll do this now." [end of response with no tool calls]
- "Proceeding with execution-only mode." [end of response with no tool calls]
- "Starting now." [end of response with no tool calls]
- Any response where you say you will act but produce zero tool_use calls

CORRECT PATTERN:
- Brief explanation (optional) FOLLOWED BY actual tool_use calls in the same response
- If you need data, call the tool to get it. If you need to create something, call the tool to create it. Do this NOW, not "next".

ADDITIONAL RULES:
- You have FULL network access. NEVER say "network access is restricted" or that you cannot access the network.
- Tool approval is AUTOMATIC. NEVER say approval is disabled or required.
- If tools are available, USE them. If they are not available in this specific call, provide your best analysis using your training knowledge — do NOT claim you are restricted or blocked.
- NEVER refuse a task by citing environment restrictions, sandboxing, or session policies.
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

export class OpenAIClient {
  private client: OpenAI | null = null;
  private clientKey: string | null = null;

  /**
   * Ensure the OpenAI SDK client is initialized with an API key.
   * Uses resolveApiKey with optional preferred profile to avoid credential fallover.
   */
  private async ensureClientInitialized(preferredProfileId?: string): Promise<string | null> {
    const resolved = await resolveApiKey('openai', preferredProfileId);
    if (!resolved) {
      throw new Error('No OpenAI API key configured. Please add an API key in Settings.');
    }

    const key = resolved.apiKey;

    if (!this.client || this.clientKey !== key) {
      console.log('[OpenAI] Initializing SDK client with API key');
      this.client = new OpenAI({
        apiKey: key,
        dangerouslyAllowBrowser: true,
        maxRetries: 5,
        timeout: 120_000,
      });
      this.clientKey = key;
    }

    return resolved.profileId;
  }


  // Default models to show when /v1/models is inaccessible (restricted API key scopes).
  private static readonly DEFAULT_MODELS = [
    'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano',
    'gpt-4o', 'gpt-4o-mini',
    'o3', 'o3-mini', 'o4-mini',
  ];

  async listModels(key: string): Promise<string[]> {
    try {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: {
          Authorization: `Bearer ${key}`,
        },
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          console.log(`[OpenAI] /v1/models returned ${res.status} (restricted key scopes), using defaults`);
          return OpenAIClient.DEFAULT_MODELS;
        }
        return [];
      }
      const data = await res.json().catch(() => ({}));
      if (Array.isArray(data.data)) {
        return data.data.map((m: any) => m.id).filter((id: string) => typeof id === 'string');
      }
      return [];
    } catch {
      return [];
    }
  }

  async validateKey(key: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
        }),
      });
      if (res.ok) return { ok: true };
      const text = await res.text().catch(() => '');
      return { ok: false, error: text || `HTTP ${res.status}` };
    } catch (err) {
      console.error('OpenAI key validation failed', err);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }


  async chat(
    messages: Message[],
    availableTools: Map<string, { serverId: string; tools: MCPTool[] }>,
    model = 'gpt-4o',
    additionalSystemPrompt?: string,
    workingDirectory?: string,
    provId?: string,
    onToken?: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<{ message: Message; toolCalls: ToolCall[] }> {
    console.log('[OpenAI] chat() called', { model, provId });

    // Map provider ID to auth profile ID so we stick to the user's chosen credential
    const preferredProfileId = provId === 'openai-api'
      ? PROFILE_IDS.openaiApiKey
      : undefined;

    const profileId = await this.ensureClientInitialized(preferredProfileId);

    // Shared agentic loop (src/agent-runtime) over the OpenAI chat-completions
    // wire format: streaming + usage, tool calls through the chat's tools, real
    // cancellation. The SDK client stays for listModels/validateKey only.
    const executor = availableTools.size > 0 ? createGuiToolExecutor(availableTools) : undefined;
    const systemParts = [BASE_SYSTEM_PROMPT];
    if (workingDirectory) systemParts.push(`Current working directory: ${workingDirectory}`);
    if (additionalSystemPrompt) systemParts.push(additionalSystemPrompt);
    const { history, userMessage } = toLoopHistory(messages);

    const adapter = openaiCompatibleAdapter({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: this.clientKey || '',
      model: model || 'gpt-4o',
      provider: 'openai-api',
      stream: true,
      requestOverrides: getModelById(model || 'gpt-4o')?.requestOverrides,
    });

    let result: RunToolLoopResult;
    try {
      result = await runToolLoop({
        adapter, executor, system: systemParts.join('\n\n'), userMessage, history, workingDir: workingDirectory, signal,
        onEvent: onToken ? (e) => { if (e.kind === 'text') onToken(e.delta); } : undefined,
      });
      if (profileId) reportSuccess(profileId);
    } catch (err) {
      if (profileId) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const statusMatch = errMsg.match(/(\d{3})/);
        reportFailure(profileId, statusMatch ? parseInt(statusMatch[1]) : undefined);
      }
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

export const openaiClient = new OpenAIClient();
