import { invoke } from '@tauri-apps/api/core';
import type { MCPTool, Message, ToolCall } from '../types/mcp';
import { mcpClient } from './mcpClient';
import { LOCAL_SERVER_ID, localToolsService } from './localTools';
import { formatToolCallSummary } from './formatToolCallSummary';
import {
  resolveApiKey,
  resolveApiKeySync,
  isOAuthToken,
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
    const url = `https://api.anthropic.com${path}`;
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

    const toolMap = new Map<string, { serverId: string; tool: MCPTool }>();

    // Use short numeric prefixes to stay under API tool name limits
    const serverIds = Array.from(availableTools.keys());
    const serverIndexMap = new Map(serverIds.map((id, i) => [id, `s${i}`]));

    const tools =
      Array.from(availableTools.values()).flatMap(({ serverId, tools }) => {
        const shortPrefix = serverIndexMap.get(serverId) || 's0';
        return tools.map((tool) => {
          // Truncate tool name if needed to fit in 64 chars
          const maxToolNameLen = 64 - shortPrefix.length - 2;
          const truncatedName = tool.name.length > maxToolNameLen
            ? tool.name.slice(0, maxToolNameLen)
            : tool.name;
          const name = `${shortPrefix}__${truncatedName}`;
          toolMap.set(name, { serverId, tool });
          return {
            name,
            description: (tool.description || '').slice(0, 300),
            input_schema: this.minimizeSchema(tool.inputSchema),
          };
        });
      }) || undefined;

    console.log('[Anthropic] Available tools:', tools);
    console.log('[Anthropic] Tool map keys:', Array.from(toolMap.keys()));

    const anthropicMessages: AnthropicMessage[] = messages.map((m) => {
      const text = m.role === 'assistant' && m.toolCalls?.length
        ? m.content + '\n\n' + formatToolCallSummary(m.toolCalls)
        : m.content;
      return {
        role: m.role === 'assistant' ? 'assistant' as const : 'user' as const,
        content: [{ type: 'text' as const, text }],
      };
    });

    const systemParts = [
      BASE_SYSTEM_PROMPT,
      workingDirectory ? `Current working directory: ${workingDirectory}` : undefined,
      additionalSystemPrompt,
      serverSummary,
    ];

    const system = systemParts
      .filter(Boolean)
      .join('\n\n')
      .trim();

    // Agentic tool-use loop: keep sending requests until the model stops
    // requesting tools or we hit the max turn limit.
    const MAX_TOOL_TURNS = 25;
    const toolCalls: ToolCall[] = [];
    const allTextParts: string[] = [];
    let currentMessages = [...anthropicMessages];
    let turnCount = 0;

    while (turnCount < MAX_TOOL_TURNS) {
      turnCount++;
      const response = await this.sendMessage(currentMessages, tools, model, system || undefined, preferredProfileId);
      console.log(`[Anthropic] Turn ${turnCount} response:`, JSON.stringify(response, null, 2));

      // Check for API errors
      if (response.error) {
        console.error('[Anthropic] API error:', response.error);
        throw new Error(response.error.message || JSON.stringify(response.error));
      }

      // Extract text parts from this turn
      const textParts =
        Array.isArray(response.content) && response.content.length > 0
          ? response.content
              .filter((p: any) => p.type === 'text')
              .map((p: any) => p.text)
              .join('\n')
          : '';
      if (textParts) {
        allTextParts.push(textParts);
      }

      // Extract tool uses
      const toolUses =
        Array.isArray(response.content) && response.content.length > 0
          ? response.content.filter((p: any) => p.type === 'tool_use')
          : [];
      console.log(`[Anthropic] Turn ${turnCount}: ${toolUses.length} tool calls, stop_reason: ${response.stop_reason}`);

      // No tool calls — we're done
      if (toolUses.length === 0) {
        break;
      }

      // Execute all tool calls for this turn
      const toolResultsContent: { type: 'tool_result'; tool_use_id: string; content: string }[] = [];

      for (const use of toolUses) {
        console.log('[Anthropic] Processing tool use:', use.name);
        const toolInfo = toolMap.get(use.name);
        const call: ToolCall = {
          id: use.id || crypto.randomUUID(),
          serverId: toolInfo?.serverId || 'unknown',
          toolName: toolInfo?.tool.name || use.name,
          arguments: use.input || {},
          status: 'pending',
        };
        try {
          call.status = 'running';
          console.log('[Anthropic] Calling tool:', call.serverId, call.toolName, call.arguments);

          let result;
          if (call.serverId === LOCAL_SERVER_ID) {
            result = await localToolsService.callTool(call.toolName, call.arguments, workingDirectory);
          } else {
            result = await mcpClient.callTool(call.serverId, call.toolName, call.arguments);
          }

          console.log('[Anthropic] Tool result:', result);
          call.result = result;
          call.status = 'completed';
          toolResultsContent.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          });
        } catch (err) {
          call.error = err instanceof Error ? err.message : 'Unknown error';
          call.status = 'failed';
          toolResultsContent.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: `Error: ${call.error}`,
          });
        }
        toolCalls.push(call);
      }

      // Append assistant response + tool results and loop for next turn
      currentMessages = [
        ...currentMessages,
        { role: 'assistant' as const, content: response.content },
        { role: 'user' as const, content: toolResultsContent },
      ];
    }

    if (turnCount >= MAX_TOOL_TURNS) {
      console.warn(`[Anthropic] Hit max tool turns (${MAX_TOOL_TURNS})`);
    }

    // Combine all text across turns
    const finalContent = allTextParts.filter(Boolean).join('\n\n');

    if (!finalContent) {
      console.warn('[Anthropic] No text content across all turns');
    }

    return {
      message: {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: finalContent || '[No content returned - check console for details]',
        timestamp: new Date(),
      },
      toolCalls,
    };
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

  private async sendMessage(
    messages: AnthropicMessage[],
    tools?: any[],
    model?: string,
    system?: string,
    preferredProfileId?: string,
  ) {
    // Use array format for system prompt to enable prompt caching
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

    return this.request('/v1/messages', 'POST', {
      model: model || 'claude-sonnet-4-5-20250929',
      max_tokens: 16384,
      messages,
      tools: cachedTools && cachedTools.length > 0 ? cachedTools : undefined,
      system: systemContent,
    }, undefined, preferredProfileId);
  }
}

export const anthropicClient = new AnthropicClient();
