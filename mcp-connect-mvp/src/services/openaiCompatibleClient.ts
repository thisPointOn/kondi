/**
 * OpenAI-Compatible Client Factory
 *
 * Wraps the OpenAI SDK with configurable baseURL for providers that
 * expose an OpenAI-compatible API (DeepSeek, x.ai/Grok, Ollama, etc.)
 */

import OpenAI from 'openai';
import { Channel, invoke } from '@tauri-apps/api/core';
import type { MCPTool, Message, ToolCall } from '../types/mcp';
import { mcpClient } from './mcpClient';
import { LOCAL_SERVER_ID, localToolsService } from './localTools';
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

type RelayStreamEvent =
  | { type: 'status'; status: number; headers: Record<string, string> }
  | { type: 'chunk'; data: string }
  | { type: 'end' }
  | { type: 'error'; message: string };

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * fetch-compatible shim over the `http_relay_stream` Tauri command. reqwest on
 * the Rust side is not subject to CORS, and response bytes are forwarded over
 * an IPC channel AS THEY ARRIVE — so SSE token deltas stream live (a buffered
 * relay trips the chat's 90s no-first-byte watchdog on long generations).
 * AbortSignal rejects/errors the webview side; the backend request then just
 * runs out on its own.
 */
const relayFetch: typeof fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
  const signal = init?.signal;

  return new Promise<Response>((resolve, reject) => {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let settled = false; // response resolved/rejected
    let done = false;    // stream closed/errored

    const stream = new ReadableStream<Uint8Array>({
      start(c) { controller = c; },
    });

    const fail = (err: Error) => {
      if (!settled) { settled = true; reject(err); }
      else if (!done) { done = true; try { controller?.error(err); } catch { /* already closed */ } }
    };

    if (signal) {
      const onAbort = () => fail(new DOMException('The operation was aborted.', 'AbortError'));
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const channel = new Channel<RelayStreamEvent>();
    channel.onmessage = (msg) => {
      if (msg.type === 'status') {
        if (settled) return;
        settled = true;
        // Response() throws if a body is passed with these status codes.
        const bodyless = msg.status === 204 || msg.status === 205 || msg.status === 304;
        resolve(new Response(bodyless ? null : stream, { status: msg.status, headers: msg.headers }));
      } else if (msg.type === 'chunk') {
        if (!done) { try { controller?.enqueue(base64ToBytes(msg.data)); } catch { /* consumer gone */ } }
      } else if (msg.type === 'end') {
        if (!done) { done = true; try { controller?.close(); } catch { /* already closed */ } }
      } else if (msg.type === 'error') {
        fail(new Error(msg.message));
      }
    };

    invoke('http_relay_stream', {
      url,
      method: (init?.method || 'GET').toUpperCase(),
      headers,
      body: init?.body != null ? String(init.body) : null,
      channel,
    }).catch((err) => fail(err instanceof Error ? err : new Error(String(err))));
  });
};

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

  private minimizeSchema(schema: any): any {
    if (!schema || typeof schema !== 'object') return schema;
    const result: any = {};
    if (schema.type) result.type = schema.type;
    if (schema.description) {
      result.description = schema.description.length > 150
        ? schema.description.slice(0, 147) + '...'
        : schema.description;
    }
    if (schema.enum) result.enum = schema.enum;
    if (schema.properties) {
      result.properties = {};
      for (const [key, value] of Object.entries(schema.properties)) {
        result.properties[key] = this.minimizeSchema(value);
      }
    }
    if (schema.required && schema.required.length > 0) result.required = schema.required;
    if (schema.items) result.items = this.minimizeSchema(schema.items);
    if (schema.oneOf) result.oneOf = schema.oneOf.map((s: any) => this.minimizeSchema(s));
    if (schema.anyOf) result.anyOf = schema.anyOf.map((s: any) => this.minimizeSchema(s));
    if (schema.allOf) result.allOf = schema.allOf.map((s: any) => this.minimizeSchema(s));
    return result;
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

  /**
   * Run one completion as an SSE stream, assembling content + tool-call deltas.
   * Returns a message-shaped object compatible with the non-streaming path.
   * `onToken` is called for each text delta (live chat streaming).
   */
  private async streamOnce(
    params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
    onToken: (delta: string) => void,
  ): Promise<{ content: string | null; tool_calls?: any[] }> {
    // Idle-abort watchdog: GLM/z.ai (and other OpenAI-compatible streams) sometimes
    // stall mid-stream — no further tokens, no error — and `for await` waits forever
    // (the SDK's default timeout is 10 min). If no chunk arrives for IDLE_TIMEOUT_MS
    // (reset on every chunk), abort the request so it throws instead of hanging.
    const IDLE_TIMEOUT_MS = 90_000;
    const ac = new AbortController();
    let lastChunk = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastChunk > IDLE_TIMEOUT_MS) {
        clearInterval(watchdog);
        ac.abort();
      }
    }, 5000);
    try {
      const stream = await this.client!.chat.completions.create({ ...params, stream: true }, { signal: ac.signal });
      let content = '';
      const toolCallsAcc: any[] = [];
      for await (const chunk of stream as any) {
        lastChunk = Date.now();
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) { content += delta.content; onToken(delta.content); }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            if (!toolCallsAcc[idx]) toolCallsAcc[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
            if (tc.id) toolCallsAcc[idx].id = tc.id;
            if (tc.function?.name) toolCallsAcc[idx].function.name += tc.function.name;
            if (tc.function?.arguments) toolCallsAcc[idx].function.arguments += tc.function.arguments;
          }
        }
      }
      return { content: content || null, tool_calls: toolCallsAcc.length ? toolCallsAcc : undefined };
    } catch (err: any) {
      if (ac.signal.aborted) {
        throw new Error(
          `${this.config.providerName} stream stalled — no data for ${Math.round(IDLE_TIMEOUT_MS / 1000)}s (the request hung). Try again, or switch the model for this chat.`
        );
      }
      throw err;
    } finally {
      clearInterval(watchdog);
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

    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [];
    const toolMap = new Map<string, { serverId: string; tool: MCPTool }>();

    const serverIds = Array.from(availableTools.keys());
    const serverIndexMap = new Map(serverIds.map((id, i) => [id, `s${i}`]));

    for (const [serverId, { tools: serverTools }] of availableTools) {
      const shortPrefix = serverIndexMap.get(serverId) || 's0';
      for (const tool of serverTools) {
        const maxToolNameLen = 64 - shortPrefix.length - 2;
        const truncatedName = tool.name.length > maxToolNameLen
          ? tool.name.slice(0, maxToolNameLen)
          : tool.name;
        const prefixedName = `${shortPrefix}__${truncatedName}`;
        tools.push({
          type: 'function',
          function: {
            name: prefixedName,
            description: (tool.description || '').slice(0, 300),
            parameters: this.minimizeSchema(tool.inputSchema),
          },
        });
        toolMap.set(prefixedName, { serverId, tool });
      }
    }

    const systemParts = [BASE_SYSTEM_PROMPT];
    if (workingDirectory) {
      systemParts.push(`Current working directory: ${workingDirectory}`);
    }
    if (additionalSystemPrompt) {
      systemParts.push(additionalSystemPrompt);
    }
    const systemPrompt = systemParts.join('\n\n');

    const openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...messages.map((message) => ({
        role: message.role as 'user' | 'assistant',
        content: message.role === 'assistant' && message.toolCalls?.length
          ? message.content + '\n\n' + formatToolCallSummary(message.toolCalls)
          : message.content,
      })),
    ];

    const MAX_TOOL_TURNS = 25;
    const toolCalls: ToolCall[] = [];
    let currentMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [...openaiMessages];
    let turnCount = 0;
    let finalContent = '';

    try {
      while (turnCount < MAX_TOOL_TURNS) {
        turnCount++;
        const createParams = {
          model: model || this.config.defaultModel,
          messages: currentMessages,
          tools: tools.length > 0 ? tools : undefined,
          tool_choice: (turnCount === 1 && tools.length > 0 ? 'auto' : undefined) as any,
        };

        // Stream the response when a token callback is provided (live chat).
        const response = onToken
          ? await this.streamOnce(createParams, onToken)
          : (await this.client!.chat.completions.create(createParams)).choices[0].message;

        if (!response.tool_calls || response.tool_calls.length === 0) {
          finalContent = typeof response.content === 'string'
            ? response.content
            : JSON.stringify(response.content || '');
          break;
        }

        const toolResults: OpenAI.Chat.Completions.ChatCompletionToolMessageParam[] = [];

        for (const tc of response.tool_calls) {
          if (tc.type !== 'function') continue;
          const toolInfo = toolMap.get(tc.function.name);
          if (!toolInfo) {
            toolResults.push({ role: 'tool', tool_call_id: tc.id, content: `Error: Unknown tool ${tc.function.name}` });
            continue;
          }

          const toolCall: ToolCall = {
            id: tc.id,
            serverId: toolInfo.serverId,
            toolName: toolInfo.tool.name,
            arguments: JSON.parse(tc.function.arguments),
            status: 'pending',
          };

          try {
            toolCall.status = 'running';
            let result;
            if (toolInfo.serverId === LOCAL_SERVER_ID) {
              result = await localToolsService.callTool(toolInfo.tool.name, toolCall.arguments, workingDirectory);
            } else {
              result = await mcpClient.callTool(toolInfo.serverId, toolInfo.tool.name, toolCall.arguments);
            }
            toolCall.result = result;
            toolCall.status = 'completed';
            toolResults.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
            });
          } catch (error) {
            toolCall.error = error instanceof Error ? error.message : 'Unknown error';
            toolCall.status = 'failed';
            toolResults.push({ role: 'tool', tool_call_id: tc.id, content: `Error: ${toolCall.error}` });
          }
          toolCalls.push(toolCall);
        }

        currentMessages = [
          ...currentMessages,
          { role: 'assistant' as const, content: response.content, tool_calls: response.tool_calls },
          ...toolResults,
        ];
      }

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
        content: finalContent || '[No content returned]',
        timestamp: new Date(),
      },
      toolCalls,
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
