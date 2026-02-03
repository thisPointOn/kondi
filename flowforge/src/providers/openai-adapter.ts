/**
 * FlowForge OpenAI Provider Adapter
 * Wraps the existing OpenAI client from mcp-connect-mvp
 */

import {
  BaseProvider,
  CompletionParams,
  CompletionResult,
  StreamChunk,
  Model,
  ProviderConfig,
  ChatMessage,
  ToolDefinition,
  ToolCallRequest,
  ContentBlock,
  TextContentBlock,
  ToolResultContentBlock,
} from './interface.js';

// OpenAI API types
interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: string;
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

interface OpenAIResponse {
  id: string;
  model: string;
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// Type for the request function (to be injected)
export type OpenAIRequestFn = (
  path: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
  apiKey?: string
) => Promise<OpenAIResponse>;

export class OpenAIAdapter extends BaseProvider {
  readonly id = 'openai';
  readonly name = 'OpenAI';

  private requestFn: OpenAIRequestFn | null = null;

  constructor(requestFn?: OpenAIRequestFn) {
    super();
    if (requestFn) {
      this.requestFn = requestFn;
    }
  }

  /**
   * Set the request function (for dependency injection)
   */
  setRequestFn(fn: OpenAIRequestFn): void {
    this.requestFn = fn;
  }

  private async request(
    path: string,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>
  ): Promise<OpenAIResponse> {
    const apiKey = this.ensureApiKey();

    // If no custom request function, use fetch directly
    if (!this.requestFn) {
      const response = await fetch(`https://api.openai.com${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`OpenAI API error: ${response.status} ${text}`);
      }

      return response.json();
    }

    return this.requestFn(path, method, body, apiKey);
  }

  async complete(params: CompletionParams): Promise<CompletionResult> {
    const startTime = Date.now();
    this.emit({ type: 'request_start', params });

    try {
      const messages = this.convertMessages(params.messages, params.systemPrompt);
      const tools = params.tools ? this.convertTools(params.tools) : undefined;

      const response = await this.request('/v1/chat/completions', 'POST', {
        model: params.model,
        messages,
        tools: tools && tools.length > 0 ? tools : undefined,
        tool_choice: tools && tools.length > 0 ? 'auto' : undefined,
        max_tokens: params.maxTokens,
        temperature: params.temperature,
        stop: params.stopSequences,
        response_format:
          params.responseFormat === 'json' ? { type: 'json_object' } : undefined,
      });

      const result = this.parseResponse(response);
      const duration = Date.now() - startTime;
      this.emit({ type: 'request_complete', result, duration });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      const err = error instanceof Error ? error : new Error(String(error));

      if (this.isRateLimitError(err)) {
        this.emit({ type: 'rate_limit' });
      } else if (this.isAuthError(err)) {
        this.emit({ type: 'auth_error', message: err.message });
      }

      this.emit({ type: 'request_error', error: err, duration });
      throw error;
    }
  }

  async *stream(params: CompletionParams): AsyncIterable<StreamChunk> {
    // For now, fall back to non-streaming completion
    // TODO: Implement actual streaming
    const result = await this.complete(params);

    yield {
      type: 'text_done',
      text: result.content,
    };

    if (result.toolCalls && result.toolCalls.length > 0) {
      for (const toolCall of result.toolCalls) {
        yield {
          type: 'tool_use_done',
          toolCall,
        };
      }
    }

    yield {
      type: 'done',
      result,
    };
  }

  async listModels(): Promise<Model[]> {
    try {
      const response = await this.request('/v1/models', 'GET');
      const data = response as unknown as { data?: Array<{ id: string }> };
      if (data && Array.isArray(data.data)) {
        return data.data
          .filter((m) => m.id.startsWith('gpt'))
          .map((m) => ({
            id: m.id,
            name: m.id,
            capabilities: {
              vision: m.id.includes('vision') || m.id.includes('gpt-4o'),
              toolUse: true,
              streaming: true,
              jsonMode: true,
            },
          }));
      }
      return this.getDefaultModels();
    } catch {
      return this.getDefaultModels();
    }
  }

  async validateCredentials(): Promise<boolean> {
    try {
      await this.request('/v1/models', 'GET');
      return true;
    } catch {
      return false;
    }
  }

  getConfig(): ProviderConfig {
    return {
      id: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com',
      defaultModel: 'gpt-4o',
      supportedModels: [
        'gpt-4o',
        'gpt-4o-mini',
        'gpt-4-turbo',
        'gpt-4',
        'gpt-3.5-turbo',
        'o1',
        'o1-mini',
      ],
      maxTokensLimit: 16384,
      supportsStreaming: true,
      supportsToolUse: true,
      rateLimits: {
        requestsPerMinute: 500,
        tokensPerMinute: 200000,
      },
    };
  }

  private convertMessages(
    messages: ChatMessage[],
    systemPrompt?: string
  ): OpenAIMessage[] {
    const result: OpenAIMessage[] = [];

    // Add system message if provided
    if (systemPrompt) {
      result.push({
        role: 'system',
        content: systemPrompt,
      });
    }

    // Add system messages from the messages array first
    for (const msg of messages) {
      if (msg.role === 'system') {
        result.push({
          role: 'system',
          content: this.extractTextContent(msg.content),
        });
      }
    }

    // Add other messages
    for (const msg of messages) {
      if (msg.role === 'system') continue;

      if (msg.role === 'user') {
        const content = msg.content;
        if (typeof content === 'string') {
          result.push({ role: 'user', content });
        } else {
          // Handle tool results in user messages
          const toolResults = content.filter(
            (b): b is ToolResultContentBlock => b.type === 'tool_result'
          );
          const textBlocks = content.filter(
            (b): b is TextContentBlock => b.type === 'text'
          );

          // Add tool results as tool messages
          for (const tr of toolResults) {
            result.push({
              role: 'tool',
              tool_call_id: tr.toolUseId,
              content: tr.content,
            });
          }

          // Add text content as user message
          if (textBlocks.length > 0) {
            result.push({
              role: 'user',
              content: textBlocks.map((b) => b.text).join('\n'),
            });
          }
        }
      } else if (msg.role === 'assistant') {
        const content = msg.content;
        if (typeof content === 'string') {
          result.push({ role: 'assistant', content });
        } else {
          // Extract text and tool calls
          const textContent = content
            .filter((b): b is TextContentBlock => b.type === 'text')
            .map((b) => b.text)
            .join('');

          const toolCalls = content
            .filter((b): b is { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> } =>
              b.type === 'tool_use'
            )
            .map((b) => ({
              id: b.id,
              type: 'function' as const,
              function: {
                name: b.name,
                arguments: JSON.stringify(b.input),
              },
            }));

          result.push({
            role: 'assistant',
            content: textContent || null,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          });
        }
      }
    }

    return result;
  }

  private extractTextContent(content: string | ContentBlock[]): string {
    if (typeof content === 'string') return content;
    return content
      .filter((b): b is TextContentBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  }

  private convertTools(tools: ToolDefinition[]): OpenAITool[] {
    return tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  private parseResponse(response: OpenAIResponse): CompletionResult {
    const choice = response.choices[0];
    const message = choice.message;

    const toolCalls: ToolCallRequest[] =
      message.tool_calls?.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments),
      })) || [];

    return {
      id: response.id,
      model: response.model,
      content: message.content || '',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      stopReason: this.mapStopReason(choice.finish_reason),
      usage: {
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      },
      raw: response,
    };
  }

  private mapStopReason(
    reason: string
  ): 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' {
    switch (reason) {
      case 'stop':
        return 'end_turn';
      case 'length':
        return 'max_tokens';
      case 'tool_calls':
        return 'tool_use';
      default:
        return 'end_turn';
    }
  }

  private getDefaultModels(): Model[] {
    return [
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        contextWindow: 128000,
        maxOutputTokens: 16384,
        capabilities: { vision: true, toolUse: true, streaming: true, jsonMode: true },
      },
      {
        id: 'gpt-4o-mini',
        name: 'GPT-4o Mini',
        contextWindow: 128000,
        maxOutputTokens: 16384,
        capabilities: { vision: true, toolUse: true, streaming: true, jsonMode: true },
      },
      {
        id: 'gpt-4-turbo',
        name: 'GPT-4 Turbo',
        contextWindow: 128000,
        maxOutputTokens: 4096,
        capabilities: { vision: true, toolUse: true, streaming: true, jsonMode: true },
      },
      {
        id: 'o1',
        name: 'O1',
        contextWindow: 128000,
        maxOutputTokens: 32768,
        capabilities: { vision: false, toolUse: false, streaming: false, jsonMode: false },
      },
    ];
  }

  private isRateLimitError(error: Error): boolean {
    const msg = error.message.toLowerCase();
    return msg.includes('rate') || msg.includes('429') || msg.includes('too many');
  }

  private isAuthError(error: Error): boolean {
    const msg = error.message.toLowerCase();
    return (
      msg.includes('401') ||
      msg.includes('403') ||
      msg.includes('unauthorized') ||
      msg.includes('invalid api key')
    );
  }
}

// Default export for convenience
export const openaiProvider = new OpenAIAdapter();
