/**
 * OpenAI-Compatible Client Factory
 *
 * Wraps the OpenAI SDK with configurable baseURL for providers that
 * expose an OpenAI-compatible API (DeepSeek, x.ai/Grok, Ollama, etc.)
 */

import OpenAI from 'openai';
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
}

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
        dangerouslyAllowBrowser: true,
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
        const completion = await this.client!.chat.completions.create({
          model: model || this.config.defaultModel,
          messages: currentMessages,
          tools: tools.length > 0 ? tools : undefined,
          tool_choice: turnCount === 1 && tools.length > 0 ? 'auto' : undefined,
        });

        const response = completion.choices[0].message;

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
  defaultModel: 'deepseek-chat',
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
