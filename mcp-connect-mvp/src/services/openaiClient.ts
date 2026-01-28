import OpenAI from 'openai';
import type { MCPTool, Message, ToolCall } from '../types/mcp';
import { mcpClient } from './mcpClient';

const BASE_SYSTEM_PROMPT = `You are ChatGPT, a helpful general-purpose AI assistant made by OpenAI. You can discuss any topic, answer questions, help with analysis, writing, coding, and much more.

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

export class OpenAIClient {
  private client: OpenAI | null = null;
  private apiKey: string | null = null;

  setApiKey(key: string) {
    this.apiKey = key;
    this.client = new OpenAI({
      apiKey: key,
      dangerouslyAllowBrowser: true,
    });
  }

  private ensureInitialized() {
    if (!this.client && this.apiKey) {
      console.log('[OpenAI] Re-initializing client');
      this.client = new OpenAI({
        apiKey: this.apiKey,
        dangerouslyAllowBrowser: true,
      });
    }
    if (!this.client) {
      throw new Error('OpenAI client not initialized. Please set your API key in settings.');
    }
  }

  async listModels(key: string): Promise<string[]> {
    try {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: {
          Authorization: `Bearer ${key}`,
        },
      });
      if (!res.ok) return [];
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
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: {
          Authorization: `Bearer ${key}`,
        },
      });
      if (res.ok) return { ok: true };
      const text = await res.text();
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
    additionalSystemPrompt?: string
  ): Promise<{ message: Message; toolCalls: ToolCall[] }> {
    this.ensureInitialized();

    const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [];
    const toolMap = new Map<string, { serverId: string; tool: MCPTool }>();

    // Use short numeric prefixes to stay under OpenAI's 64-char limit
    const serverIds = Array.from(availableTools.keys());
    const serverIndexMap = new Map(serverIds.map((id, i) => [id, `s${i}`]));

    for (const [serverId, { tools: serverTools }] of availableTools) {
      const shortPrefix = serverIndexMap.get(serverId) || 's0';
      for (const tool of serverTools) {
        // Truncate tool name if needed to fit in 64 chars (prefix + __ + name)
        const maxToolNameLen = 64 - shortPrefix.length - 2;
        const truncatedName = tool.name.length > maxToolNameLen
          ? tool.name.slice(0, maxToolNameLen)
          : tool.name;
        const prefixedName = `${shortPrefix}__${truncatedName}`;
        tools.push({
          type: 'function',
          function: {
            name: prefixedName,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        });
        toolMap.set(prefixedName, { serverId, tool });
      }
    }

    console.log('[OpenAI] Available tools:', tools.map(t => (t as any).function?.name));

    const systemPrompt = additionalSystemPrompt
      ? `${BASE_SYSTEM_PROMPT}\n\n${additionalSystemPrompt}`
      : BASE_SYSTEM_PROMPT;

    const openaiMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...messages.map((message) => ({
        role: message.role as 'user' | 'assistant',
        content: message.content,
      })),
    ];

    // First API call
    const completion = await this.client!.chat.completions.create({
      model: model || 'gpt-4o',
      messages: openaiMessages,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? 'auto' : undefined,
    });

    const response = completion.choices[0].message;
    console.log('[OpenAI] First response:', JSON.stringify(response, null, 2));

    const toolCalls: ToolCall[] = [];

    // If the model wants to use tools
    if (response.tool_calls && response.tool_calls.length > 0) {
      console.log('[OpenAI] Tool calls requested:', response.tool_calls.length);

      const toolResults: OpenAI.Chat.Completions.ChatCompletionToolMessageParam[] = [];

      for (const tc of response.tool_calls) {
        if (tc.type !== 'function') continue;

        console.log('[OpenAI] Processing tool call:', tc.function.name);
        const toolInfo = toolMap.get(tc.function.name);
        console.log('[OpenAI] Tool info found:', !!toolInfo);

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
          console.log('[OpenAI] Calling MCP tool:', toolInfo.serverId, toolInfo.tool.name, toolCall.arguments);
          const result = await mcpClient.callTool(
            toolInfo.serverId,
            toolInfo.tool.name,
            toolCall.arguments
          );
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

      // Second API call with tool results
      const followUpMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        ...openaiMessages,
        {
          role: 'assistant',
          content: response.content,
          tool_calls: response.tool_calls,
        },
        ...toolResults,
      ];

      const followUp = await this.client!.chat.completions.create({
        model: model || 'gpt-4o',
        messages: followUpMessages,
        tools: tools.length > 0 ? tools : undefined,
      });

      const finalResponse = followUp.choices[0].message;
      console.log('[OpenAI] Final response:', finalResponse.content);

      return {
        message: {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: finalResponse.content || '[No content returned]',
          timestamp: new Date(),
        },
        toolCalls,
      };
    }

    // No tool use, just return the response
    return {
      message: {
        id: crypto.randomUUID(),
        role: 'assistant',
        content:
          typeof response.content === 'string'
            ? response.content
            : JSON.stringify(response.content || ''),
        timestamp: new Date(),
      },
      toolCalls,
    };
  }
}

export const openaiClient = new OpenAIClient();
