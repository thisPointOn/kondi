import OpenAI from 'openai';
import type { MCPTool, Message, ToolCall } from '../types/mcp';
import { mcpClient } from './mcpClient';
import { LOCAL_SERVER_ID, localToolsService } from './localTools';
import { formatToolCallSummary } from './formatToolCallSummary';
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

  /**
   * Minimize a JSON Schema to reduce token count.
   */
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

    if (schema.required && schema.required.length > 0) {
      result.required = schema.required;
    }

    if (schema.items) {
      result.items = this.minimizeSchema(schema.items);
    }

    if (schema.oneOf) result.oneOf = schema.oneOf.map((s: any) => this.minimizeSchema(s));
    if (schema.anyOf) result.anyOf = schema.anyOf.map((s: any) => this.minimizeSchema(s));
    if (schema.allOf) result.allOf = schema.allOf.map((s: any) => this.minimizeSchema(s));

    return result;
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
  ): Promise<{ message: Message; toolCalls: ToolCall[] }> {
    console.log('[OpenAI] chat() called', { model, provId });

    // Map provider ID to auth profile ID so we stick to the user's chosen credential
    const preferredProfileId = provId === 'openai-api'
      ? PROFILE_IDS.openaiApiKey
      : undefined;

    const profileId = await this.ensureClientInitialized(preferredProfileId);

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

    console.log('[OpenAI] Available tools:', tools.map(t => (t as any).function?.name));

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
          model: model || 'gpt-4o',
          messages: currentMessages,
          tools: tools.length > 0 ? tools : undefined,
          tool_choice: turnCount === 1 && tools.length > 0 ? 'auto' : undefined,
        });

        const response = completion.choices[0].message;
        console.log(`[OpenAI] Turn ${turnCount} response:`, JSON.stringify(response, null, 2));

        if (!response.tool_calls || response.tool_calls.length === 0) {
          finalContent = typeof response.content === 'string'
            ? response.content
            : JSON.stringify(response.content || '');
          break;
        }

        console.log(`[OpenAI] Turn ${turnCount}: ${response.tool_calls.length} tool calls`);
        const toolResults: OpenAI.Chat.Completions.ChatCompletionToolMessageParam[] = [];

        for (const tc of response.tool_calls) {
          if (tc.type !== 'function') continue;

          console.log('[OpenAI] Processing tool call:', tc.function.name);
          const toolInfo = toolMap.get(tc.function.name);

          if (!toolInfo) {
            toolResults.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: `Error: Unknown tool ${tc.function.name}`,
            });
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
            console.log('[OpenAI] Calling tool:', toolInfo.serverId, toolInfo.tool.name, toolCall.arguments);

            const TOOL_CALL_TIMEOUT = 300_000; // 5 min per tool call
            const toolPromise = toolInfo.serverId === LOCAL_SERVER_ID
              ? localToolsService.callTool(toolInfo.tool.name, toolCall.arguments, workingDirectory)
              : mcpClient.callTool(toolInfo.serverId, toolInfo.tool.name, toolCall.arguments);
            const result = await Promise.race([
              toolPromise,
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`Tool ${toolInfo.tool.name} timed out after ${TOOL_CALL_TIMEOUT / 1000}s`)), TOOL_CALL_TIMEOUT)
              ),
            ]);

            console.log('[OpenAI] Tool result:', result);
            toolCall.result = result;
            toolCall.status = 'completed';

            toolResults.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
            });
          } catch (error) {
            console.error('[OpenAI] Tool call failed:', error);
            toolCall.error = error instanceof Error ? error.message : 'Unknown error';
            toolCall.status = 'failed';

            toolResults.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: `Error: ${toolCall.error}`,
            });
          }

          toolCalls.push(toolCall);
        }

        currentMessages = [
          ...currentMessages,
          {
            role: 'assistant' as const,
            content: response.content,
            tool_calls: response.tool_calls,
          },
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

    if (turnCount >= MAX_TOOL_TURNS) {
      console.warn(`[OpenAI] Hit max tool turns (${MAX_TOOL_TURNS})`);
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

export const openaiClient = new OpenAIClient();
