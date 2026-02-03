/**
 * FlowForge Anthropic Provider Adapter
 * Wraps the existing Anthropic client from mcp-connect-mvp
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
  ToolUseContentBlock,
  ToolResultContentBlock,
} from './interface.js';

// Type for the underlying Anthropic API response
interface AnthropicContentBlock {
  type: 'text' | 'tool_use';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicResponse {
  id: string;
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  error?: {
    message: string;
  };
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicContentBlock[] | string;
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// Type for the request function (to be injected)
export type AnthropicRequestFn = (
  path: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
  apiKey?: string
) => Promise<AnthropicResponse>;

export class AnthropicAdapter extends BaseProvider {
  readonly id = 'anthropic';
  readonly name = 'Anthropic';

  private requestFn: AnthropicRequestFn | null = null;

  constructor(requestFn?: AnthropicRequestFn) {
    super();
    if (requestFn) {
      this.requestFn = requestFn;
    }
  }

  /**
   * Set the request function (for dependency injection)
   * This allows using the Tauri proxy or direct fetch
   */
  setRequestFn(fn: AnthropicRequestFn): void {
    this.requestFn = fn;
  }

  private async request(
    path: string,
    method: 'GET' | 'POST',
    body?: Record<string, unknown>
  ): Promise<AnthropicResponse> {
    if (!this.requestFn) {
      throw new Error('Anthropic request function not configured');
    }
    const apiKey = this.ensureApiKey();
    return this.requestFn(path, method, body, apiKey);
  }

  async complete(params: CompletionParams): Promise<CompletionResult> {
    const startTime = Date.now();
    this.emit({ type: 'request_start', params });

    try {
      const messages = this.convertMessages(params.messages);
      const tools = params.tools ? this.convertTools(params.tools) : undefined;

      const response = await this.request('/v1/messages', 'POST', {
        model: params.model,
        max_tokens: params.maxTokens || 4096,
        messages,
        tools: tools && tools.length > 0 ? tools : undefined,
        system: params.systemPrompt,
        temperature: params.temperature,
        stop_sequences: params.stopSequences,
      });

      if (response.error) {
        throw new Error(response.error.message);
      }

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
    // TODO: Implement actual streaming when available
    const result = await this.complete(params);

    // Simulate streaming by yielding the full result
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
        return data.data.map((m) => ({
          id: m.id,
          name: m.id,
          capabilities: {
            vision: m.id.includes('claude-3'),
            toolUse: true,
            streaming: true,
            jsonMode: false,
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
      id: 'anthropic',
      name: 'Anthropic',
      baseUrl: 'https://api.anthropic.com',
      defaultModel: 'claude-3-5-sonnet-latest',
      supportedModels: [
        'claude-3-5-sonnet-latest',
        'claude-3-5-haiku-latest',
        'claude-3-opus-latest',
        'claude-3-sonnet-20240229',
        'claude-3-haiku-20240307',
      ],
      maxTokensLimit: 8192,
      supportsStreaming: true,
      supportsToolUse: true,
      rateLimits: {
        requestsPerMinute: 60,
        tokensPerMinute: 100000,
      },
    };
  }

  private convertMessages(messages: ChatMessage[]): AnthropicMessage[] {
    return messages
      .filter((m) => m.role !== 'system') // System messages handled separately
      .map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: this.convertContent(m.content),
      }));
  }

  private convertContent(
    content: string | ContentBlock[]
  ): AnthropicContentBlock[] | string {
    if (typeof content === 'string') {
      return content;
    }

    return content.map((block): AnthropicContentBlock => {
      if (block.type === 'text') {
        const textBlock = block as TextContentBlock;
        return { type: 'text', text: textBlock.text };
      }
      if (block.type === 'tool_use') {
        const toolBlock = block as ToolUseContentBlock;
        return {
          type: 'tool_use',
          id: toolBlock.id,
          name: toolBlock.name,
          input: toolBlock.input,
        };
      }
      if (block.type === 'tool_result') {
        const resultBlock = block as ToolResultContentBlock;
        // Anthropic expects tool results in user messages
        return {
          type: 'text',
          text: resultBlock.content,
        };
      }
      return { type: 'text', text: '' };
    });
  }

  private convertTools(tools: ToolDefinition[]): AnthropicTool[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }));
  }

  private parseResponse(response: AnthropicResponse): CompletionResult {
    const textContent = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text || '')
      .join('');

    const toolCalls: ToolCallRequest[] = response.content
      .filter((block) => block.type === 'tool_use')
      .map((block) => ({
        id: block.id || crypto.randomUUID(),
        name: block.name || '',
        input: block.input || {},
      }));

    return {
      id: response.id,
      model: response.model,
      content: textContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      stopReason: this.mapStopReason(response.stop_reason),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      },
      raw: response,
    };
  }

  private mapStopReason(
    reason: string
  ): 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' {
    switch (reason) {
      case 'end_turn':
        return 'end_turn';
      case 'max_tokens':
        return 'max_tokens';
      case 'stop_sequence':
        return 'stop_sequence';
      case 'tool_use':
        return 'tool_use';
      default:
        return 'end_turn';
    }
  }

  private getDefaultModels(): Model[] {
    return [
      {
        id: 'claude-3-5-sonnet-latest',
        name: 'Claude 3.5 Sonnet',
        contextWindow: 200000,
        maxOutputTokens: 8192,
        capabilities: { vision: true, toolUse: true, streaming: true },
      },
      {
        id: 'claude-3-5-haiku-latest',
        name: 'Claude 3.5 Haiku',
        contextWindow: 200000,
        maxOutputTokens: 8192,
        capabilities: { vision: true, toolUse: true, streaming: true },
      },
      {
        id: 'claude-3-opus-latest',
        name: 'Claude 3 Opus',
        contextWindow: 200000,
        maxOutputTokens: 4096,
        capabilities: { vision: true, toolUse: true, streaming: true },
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
      msg.includes('authentication') ||
      msg.includes('invalid api key')
    );
  }
}

// Default export for convenience
export const anthropicProvider = new AnthropicAdapter();
