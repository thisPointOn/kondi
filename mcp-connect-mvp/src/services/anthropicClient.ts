import { invoke } from '@tauri-apps/api/core';
import type { MCPTool, Message, ToolCall } from '../types/mcp';
import { mcpClient } from './mcpClient';
import { LOCAL_SERVER_ID, localToolsService } from './localTools';

type AnthropicMessage = {
  role: 'user' | 'assistant';
  content: { type: 'text' | 'tool_use' | 'tool_result'; text?: string; id?: string; name?: string; input?: any; tool_use_id?: string }[];
};

const BASE_SYSTEM_PROMPT = `You are Claude, a helpful general-purpose AI assistant made by Anthropic. You can discuss any topic, answer questions, help with analysis, writing, coding, and much more.

You also have access to MCP (Model Context Protocol) tools that let you interact with external services. These tools are OPTIONAL - use them when relevant to the user's request, but you are NOT limited to only topics related to these tools. You are a general-purpose assistant first.

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
  private apiKey: string | null = null;

  setApiKey(key: string) {
    this.apiKey = key;
  }

  private ensureInitialized(): string {
    if (this.apiKey) return this.apiKey;

    // Try to recover from localStorage
    try {
      const stored = localStorage.getItem('mcp-api-keys');
      if (stored) {
        const keys = JSON.parse(stored);
        if (keys.anthropic) {
          console.log('[Anthropic] Re-initializing from stored key');
          const key = keys.anthropic as string;
          this.apiKey = key;
          return key;
        }
      }
    } catch (e) {
      console.error('[Anthropic] Failed to recover key from storage:', e);
    }

    throw new Error('Anthropic client not initialized. Please set your API key in settings.');
  }

  private async request(
    path: string,
    method: 'GET' | 'POST',
    body?: Record<string, any>,
    apiKeyOverride?: string
  ): Promise<any> {
    const apiKey = apiKeyOverride || this.ensureInitialized();
    if (!apiKey) throw new Error('Anthropic client not initialized. Please set your API key in settings.');
    const url = `https://api.anthropic.com${path}`;
    const payload = body ? JSON.stringify(body) : null;

    // Use Tauri proxy to avoid CORS. If Tauri is unavailable, surface that error (do not fall back to fetch).
    const text = await invoke<string>('anthropic_request', {
      url,
      method,
      body: payload,
      apiKey,
    });
    return JSON.parse(text);
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
    model = 'claude-3-5-sonnet-latest',
    serverSummary?: string,
    additionalSystemPrompt?: string
  ): Promise<{ message: Message; toolCalls: ToolCall[] }> {
    if (!this.apiKey) throw new Error('Anthropic client not initialized');

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
            description: tool.description || '',
            input_schema: tool.inputSchema,
          };
        });
      }) || undefined;

    console.log('[Anthropic] Available tools:', tools);
    console.log('[Anthropic] Tool map keys:', Array.from(toolMap.keys()));

    const anthropicMessages: AnthropicMessage[] = messages.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: [{ type: 'text', text: m.content }],
    }));

    const toolSummary =
      tools && tools.length > 0
        ? `Available MCP tools:\n${Array.from(availableTools.values())
            .map(({ serverId, tools }) => {
              const names = tools.map((t) => t.name).join(', ');
              return `- ${serverId}: ${names}`;
            })
            .join('\n')}\nWhen you use a tool, pick the best one for the task.`
        : undefined;

    const system = [BASE_SYSTEM_PROMPT, additionalSystemPrompt, toolSummary, serverSummary]
      .filter(Boolean)
      .join('\n\n')
      .trim();

    // First turn
    const first = await this.sendMessage(anthropicMessages, tools, model, system || undefined);
    console.log('[Anthropic] First response:', JSON.stringify(first, null, 2));

    // Check for API errors
    if (first.error) {
      console.error('[Anthropic] API error:', first.error);
      throw new Error(first.error.message || JSON.stringify(first.error));
    }

    // Extract text and tool uses from first response
    const firstTextParts =
      Array.isArray(first.content) && first.content.length > 0
        ? first.content
            .filter((p: any) => p.type === 'text')
            .map((p: any) => p.text)
            .join('\n')
        : '';
    console.log('[Anthropic] First response text:', firstTextParts ? firstTextParts.slice(0, 200) + '...' : '(none)');

    // Extract tool uses
    const toolUses =
      Array.isArray(first.content) && first.content.length > 0
        ? first.content.filter((p: any) => p.type === 'tool_use')
        : [];
    console.log('[Anthropic] Tool uses found:', toolUses.length);

    const toolCalls: ToolCall[] = [];

    if (toolUses.length > 0) {
      const toolResultsContent: { type: 'tool_result'; tool_use_id: string; content: string }[] = [];

      for (const use of toolUses) {
        console.log('[Anthropic] Processing tool use:', use.name);
        const toolInfo = toolMap.get(use.name);
        console.log('[Anthropic] Tool info found:', !!toolInfo, toolInfo?.serverId, toolInfo?.tool?.name);
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

          // Route to local tools service or MCP client
          let result;
          if (call.serverId === LOCAL_SERVER_ID) {
            result = await localToolsService.callTool(call.toolName, call.arguments);
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

      // Second turn with tool results to get final response
      const followupMessages: AnthropicMessage[] = [
        ...anthropicMessages,
        { role: 'assistant', content: first.content },
        { role: 'user', content: toolResultsContent },
      ];

      const second = await this.sendMessage(followupMessages, tools, model, system || undefined);
      console.log('[Anthropic] Second response:', JSON.stringify(second, null, 2));

      const secondTextParts =
        Array.isArray(second.content) && second.content.length > 0
          ? second.content
              .filter((p: any) => p.type === 'text')
              .map((p: any) => p.text)
              .join('\n')
          : '';

      // Combine any text from first response with second response
      const combinedText = [firstTextParts, secondTextParts].filter(Boolean).join('\n\n');

      return {
        message: {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: combinedText || '[No content returned after tool use]',
          timestamp: new Date(),
        },
        toolCalls,
      };
    }

    // No tool use, just return first response
    // Use the already extracted firstTextParts
    let content = firstTextParts;

    // If no text content, provide more helpful message
    if (!content) {
      console.warn('[Anthropic] No text content in response. Full response:', first);
      if (first.stop_reason) {
        content = `[Response ended with reason: ${first.stop_reason}]`;
      } else {
        content = '[No content returned - check console for details]';
      }
    }

    return {
      message: {
        id: crypto.randomUUID(),
        role: 'assistant',
        content,
        timestamp: new Date(),
      },
      toolCalls,
    };
  }

  private async sendMessage(
    messages: AnthropicMessage[],
    tools?: any[],
    model?: string,
    system?: string
  ) {
    return this.request('/v1/messages', 'POST', {
      model: model || 'claude-3-5-sonnet-latest',
      max_tokens: 1024,
      messages,
      tools: tools && tools.length > 0 ? tools : undefined,
      system,
    });
  }
}

export const anthropicClient = new AnthropicClient();
