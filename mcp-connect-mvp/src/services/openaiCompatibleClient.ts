/**
 * OpenAI-Compatible Client Factory
 *
 * Wraps the OpenAI SDK with configurable baseURL for providers that
 * expose an OpenAI-compatible API (DeepSeek, x.ai/Grok, Ollama, etc.)
 */

import OpenAI from 'openai';
import type { MCPTool, Message, ToolCall } from '../types/mcp';
import { runToolLoop } from '../agent-runtime/tool-loop';
import { openaiCompatibleAdapter } from '../agent-runtime/adapters/openai-compatible';
import type { LoopMessage, RunToolLoopResult } from '../agent-runtime/types';
import { createGuiToolExecutor } from './gui-tool-executor';
import { getModelById } from '../config/models';
import { formatToolCallSummary } from './formatToolCallSummary';
import {
  resolveApiKey,
  resolveApiKeySync,
  reportSuccess,
  reportFailure,
  PROFILE_IDS,
} from './auth-profiles';
import type { AuthProvider } from './auth-profiles';

interface OpenAICompatibleConfig {
  baseURL: string;
  providerName: string;
  authProvider: AuthProvider;
  defaultModel: string;
  requiresAuth?: boolean; // default true; false for Ollama
  /**
   * Route requests through the Rust backend (`http_relay_stream` Tauri
   * command) instead of the webview's fetch. Required for providers whose
   * APIs send no CORS headers (e.g. NVIDIA NIM) — the webview blocks their
   * responses, so a direct call surfaces as "Connection error". Response
   * bytes are forwarded over an IPC channel as they arrive, so SSE token
   * streaming stays live.
   */
  relayViaBackend?: boolean;
}

// relayFetch moved to ./relayFetch.ts (shared with the agent-runtime adapters).
import { relayFetch } from './relayFetch';

const BASE_SYSTEM_PROMPT = `You are a helpful general-purpose AI assistant. You can discuss any topic, answer questions, help with analysis, writing, coding, and much more.

You have access to MCP (Model Context Protocol) tools that let you interact with external services. These tools are OPTIONAL - use them when relevant to the user's request, but you are NOT limited to only topics related to these tools. You are a general-purpose assistant first.

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

export class OpenAICompatibleClient {
  private client: OpenAI | null = null;
  private clientKey: string | null = null;
  private config: OpenAICompatibleConfig;

  constructor(config: OpenAICompatibleConfig) {
    this.config = { requiresAuth: true, ...config };
  }

  /**
   * Map a UI provider ID (e.g. 'deepseek') to the corresponding auth profile ID.
   */
  private mapProvIdToProfileId(provId: string): string | undefined {
    const map: Record<string, string> = {
      'deepseek': PROFILE_IDS.deepseekApiKey,
      'xai': PROFILE_IDS.xaiApiKey,
      'zai': PROFILE_IDS.zaiApiKey,
      'moonshot': PROFILE_IDS.moonshotApiKey,
      'nvidia-router': PROFILE_IDS.nvidiaApiKey,
      'google-api': PROFILE_IDS.googleApiKey,
    };
    return map[provId];
  }

  getAuthMethod(): 'api_key' | 'none' {
    if (!this.config.requiresAuth) return 'api_key'; // Ollama — always "available"
    const resolved = resolveApiKeySync(this.config.authProvider);
    return resolved ? 'api_key' : 'none';
  }

  private async ensureClientInitialized(): Promise<void> {
    let key: string;

    if (!this.config.requiresAuth) {
      key = 'no-key-required';
    } else {
      const resolved = await resolveApiKey(this.config.authProvider);
      if (!resolved) {
        throw new Error(`No ${this.config.providerName} authentication configured. Please set up credentials in Settings.`);
      }
      key = resolved.apiKey;
    }

    if (!this.client || this.clientKey !== key) {
      this.client = new OpenAI({
        apiKey: key,
        baseURL: this.config.baseURL,
        ...(this.config.relayViaBackend ? { fetch: relayFetch } : {}),
        dangerouslyAllowBrowser: true,
        // Bound how long a hang can last: the SDK retries timeouts, so 5 retries ×
        // 120s turned one stalled GLM request into ~10 minutes of "hanging". Fewer
        // retries + a tighter per-attempt timeout surfaces the failure fast. The
        // streaming path additionally idle-aborts (streamOnce) so it can't wait the
        // full timeout for a mid-stream stall.
        maxRetries: 2,
        timeout: 90_000,
      });
      this.clientKey = key;
    }
  }

  async validateKey(key: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const client = new OpenAI({
        apiKey: key,
        baseURL: this.config.baseURL,
        ...(this.config.relayViaBackend ? { fetch: relayFetch } : {}),
        dangerouslyAllowBrowser: true,
      });
      await client.chat.completions.create({
        model: this.config.defaultModel,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async validateConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.ensureClientInitialized();
      await this.client!.chat.completions.create({
        model: this.config.defaultModel,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listModels(): Promise<string[]> {
    try {
      await this.ensureClientInitialized();
      const list = await this.client!.models.list();
      const models: string[] = [];
      for await (const model of list) {
        models.push(model.id);
      }
      return models;
    } catch {
      return [];
    }
  }

  /**
   * Ollama-specific: discover locally installed models via /api/tags
   */
  async discoverModels(): Promise<Array<{ name: string; size: number; modified: string }>> {
    try {
      const res = await fetch(`${this.config.baseURL.replace('/v1', '')}/api/tags`);
      if (!res.ok) return [];
      const data = await res.json();
      return (data.models || []).map((m: any) => ({
        name: m.name,
        size: m.size || 0,
        modified: m.modified_at || '',
      }));
    } catch {
      return [];
    }
  }

  async chat(
    messages: Message[],
    availableTools: Map<string, { serverId: string; tools: MCPTool[] }>,
    model?: string,
    additionalSystemPrompt?: string,
    workingDirectory?: string,
    provId?: string,
    onToken?: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<{ message: Message; toolCalls: ToolCall[] }> {
    const authMethod = this.getAuthMethod();
    console.log(`[${this.config.providerName}] chat() called`, { authMethod, model, provId });

    if (this.config.requiresAuth && authMethod === 'none') {
      throw new Error(`No ${this.config.providerName} authentication configured. Please set up credentials in Settings.`);
    }

    await this.ensureClientInitialized();

    // Map provider ID to auth profile ID to prevent credential fallover
    const preferredProfileId = provId
      ? this.mapProvIdToProfileId(provId)
      : undefined;

    const resolved = this.config.requiresAuth ? await resolveApiKey(this.config.authProvider, preferredProfileId) : null;
    const profileId = resolved?.profileId || null;

    // One shared agentic loop (src/agent-runtime) over this provider's wire
    // format: streaming (SSE) with usage, tool calls executed through the chat's
    // local + MCP tools, real cancellation via `signal`. NIM goes through the
    // Rust relay (no CORS headers — rule 14).
    const executor = availableTools.size > 0 ? createGuiToolExecutor(availableTools) : undefined;

    const systemParts = [BASE_SYSTEM_PROMPT];
    if (workingDirectory) {
      systemParts.push(`Current working directory: ${workingDirectory}`);
    }
    if (additionalSystemPrompt) {
      systemParts.push(additionalSystemPrompt);
    }
    const systemPrompt = systemParts.join('\n\n');

    // Multi-turn: everything before the last user message is history; earlier
    // tool calls are folded into the assistant text (their ids can't replay).
    const turns = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
    const lastUserIdx = (() => { for (let k = turns.length - 1; k >= 0; k--) if (turns[k].role === 'user') return k; return -1; })();
    const lastUser = lastUserIdx >= 0 ? turns[lastUserIdx] : undefined;
    const historySrc = lastUserIdx >= 0 ? turns.slice(0, lastUserIdx) : turns;
    const history: LoopMessage[] = historySrc.map((m) => m.role === 'assistant'
      ? { role: 'assistant' as const, content: m.toolCalls?.length ? `${m.content}\n\n${formatToolCallSummary(m.toolCalls)}` : m.content }
      : { role: 'user' as const, content: m.content });

    const adapter = openaiCompatibleAdapter({
      fetchImpl: this.config.relayViaBackend ? relayFetch : undefined,
      baseUrl: this.config.baseURL,
      apiKey: this.config.requiresAuth ? (this.clientKey || '') : '', // empty → no Authorization header (Ollama)
      model: model || this.config.defaultModel,
      provider: this.config.authProvider,
      stream: true,
      requestOverrides: getModelById(model || this.config.defaultModel)?.requestOverrides,
    });

    let result: RunToolLoopResult;
    try {
      result = await runToolLoop({
        adapter,
        executor,
        system: systemPrompt,
        userMessage: lastUser?.content || '',
        history,
        workingDir: workingDirectory,
        signal,
        onEvent: onToken ? (e) => { if (e.kind === 'text') onToken(e.delta); } : undefined,
      });
      if (profileId) reportSuccess(profileId);
    } catch (err) {
      if (profileId) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const statusMatch = errMsg.match(/(\d{3})/);
        const httpStatus = statusMatch ? parseInt(statusMatch[1]) : undefined;
        reportFailure(profileId, httpStatus);
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
          billedInputTokens: result.usage.inputTokens,
          cacheRead: result.usage.cacheReadTokens,
          cacheCreation: result.usage.cacheWriteTokens,
          apiTurns: result.usage.apiTurns,
        } : undefined,
      },
      toolCalls: executor?.toolCalls ?? [],
    };
  }
}

// ============================================================================
// Provider Singletons
// ============================================================================

export const deepseekClient = new OpenAICompatibleClient({
  baseURL: 'https://api.deepseek.com',
  providerName: 'DeepSeek',
  authProvider: 'deepseek',
  defaultModel: 'deepseek-v4-flash',
});

export const xaiClient = new OpenAICompatibleClient({
  baseURL: 'https://api.x.ai/v1',
  providerName: 'xAI',
  authProvider: 'xai',
  defaultModel: 'grok-3',
});

export const ollamaClient = new OpenAICompatibleClient({
  baseURL: 'http://localhost:11434/v1',
  providerName: 'Ollama',
  authProvider: 'ollama',
  defaultModel: 'llama3.1',
  requiresAuth: false,
});

/** Z.AI (GLM) — OpenAI-compatible Coding Plan endpoint */
export const zaiClient = new OpenAICompatibleClient({
  baseURL: 'https://api.z.ai/api/coding/paas/v4',
  providerName: 'Z.AI',
  authProvider: 'zai',
  defaultModel: 'glm-4.6',
});

/** Moonshot AI (Kimi) — OpenAI-compatible; full CORS support, no relay needed */
export const moonshotClient = new OpenAICompatibleClient({
  baseURL: 'https://api.moonshot.ai/v1',
  providerName: 'Moonshot (Kimi)',
  authProvider: 'moonshot',
  defaultModel: 'kimi-k2.6',
});

/**
 * NVIDIA NIM — OpenAI-compatible, hosted at integrate.api.nvidia.com (nvapi-*
 * key). Base URL is overridable via the VITE_NVIDIA_ROUTER_URL build env for
 * a local NIM/router deployment.
 */
const NVIDIA_BASE_URL: string =
  (import.meta as any).env?.VITE_NVIDIA_ROUTER_URL || 'https://integrate.api.nvidia.com/v1';
export const nvidiaRouterClient = new OpenAICompatibleClient({
  baseURL: NVIDIA_BASE_URL,
  providerName: 'NVIDIA NIM',
  authProvider: 'nvidia-router',
  defaultModel: 'nvidia/nemotron-3-super-120b-a12b',
  // NIM's hosted API sends no CORS headers, so the webview cannot call it
  // directly (every request dies as "Connection error"). Relay through the
  // Rust backend. A local (http://) router override talks to localhost
  // directly and skips the relay — http_relay is https-only anyway.
  relayViaBackend: NVIDIA_BASE_URL.startsWith('https://'),
});
