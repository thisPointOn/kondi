/**
 * FlowForge OpenAI-Compatible Adapter
 * Generic adapter for any OpenAI API-compatible provider
 * Supports: OpenRouter, Moonshot/Kimi, Venice AI, Together AI, Groq, etc.
 */

import {
  LLMProvider,
  CompletionParams,
  CompletionResult,
  StreamChunk,
  Model,
} from './interface.js';

// ============================================================================
// Types
// ============================================================================

export interface OpenAICompatibleConfig {
  /** Provider identifier */
  id: string;
  /** Display name */
  name: string;
  /** Base URL for API */
  baseUrl: string;
  /** API key */
  apiKey?: string;
  /** Default model */
  defaultModel?: string;
  /** Available models (if no discovery endpoint) */
  models?: Model[];
  /** Custom headers */
  headers?: Record<string, string>;
  /** Whether provider supports model discovery */
  supportsDiscovery?: boolean;
}

// ============================================================================
// OpenAI Compatible Adapter
// ============================================================================

export class OpenAICompatibleAdapter implements LLMProvider {
  id: string;
  name: string;

  private config: OpenAICompatibleConfig;
  private discoveredModels: Model[] | null = null;

  constructor(config: OpenAICompatibleConfig) {
    this.id = config.id;
    this.name = config.name;
    this.config = config;
  }

  async complete(params: CompletionParams): Promise<CompletionResult> {
    const apiKey = this.config.apiKey || process.env[`${this.id.toUpperCase()}_API_KEY`];
    if (!apiKey) {
      throw new Error(`No API key configured for ${this.name}`);
    }

    const model = params.model || this.config.defaultModel;
    if (!model) {
      throw new Error(`No model specified for ${this.name}`);
    }

    const startTime = Date.now();

    // Build messages
    const messages = params.systemPrompt
      ? [{ role: 'system', content: params.systemPrompt }, ...params.messages]
      : params.messages;

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        ...this.config.headers,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: params.temperature ?? 0.7,
        max_tokens: params.maxTokens ?? 4096,
        top_p: params.topP,
        stop: params.stopSequences,
        stream: false,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`${this.name} error: ${error}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0];

    return {
      content: choice?.message?.content || '',
      model: data.model || model,
      usage: {
        inputTokens: data.usage?.prompt_tokens || 0,
        outputTokens: data.usage?.completion_tokens || 0,
      },
      finishReason: choice?.finish_reason || 'stop',
      latency: Date.now() - startTime,
    };
  }

  async *stream(params: CompletionParams): AsyncIterable<StreamChunk> {
    const apiKey = this.config.apiKey || process.env[`${this.id.toUpperCase()}_API_KEY`];
    if (!apiKey) {
      throw new Error(`No API key configured for ${this.name}`);
    }

    const model = params.model || this.config.defaultModel;
    if (!model) {
      throw new Error(`No model specified for ${this.name}`);
    }

    const messages = params.systemPrompt
      ? [{ role: 'system', content: params.systemPrompt }, ...params.messages]
      : params.messages;

    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        ...this.config.headers,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: params.temperature ?? 0.7,
        max_tokens: params.maxTokens ?? 4096,
        top_p: params.topP,
        stop: params.stopSequences,
        stream: true,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`${this.name} error: ${error}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') {
          yield { type: 'done', finishReason: 'stop' };
          continue;
        }

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            yield { type: 'content', content: delta.content };
          }
          if (parsed.choices?.[0]?.finish_reason) {
            yield { type: 'done', finishReason: parsed.choices[0].finish_reason };
          }
        } catch {
          // Skip invalid JSON
        }
      }
    }
  }

  async listModels(): Promise<Model[]> {
    // Return pre-configured models if no discovery
    if (!this.config.supportsDiscovery) {
      return this.config.models || [];
    }

    if (this.discoveredModels) return this.discoveredModels;

    const apiKey = this.config.apiKey || process.env[`${this.id.toUpperCase()}_API_KEY`];
    if (!apiKey) return this.config.models || [];

    try {
      const response = await fetch(`${this.config.baseUrl}/models`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          ...this.config.headers,
        },
      });

      if (!response.ok) {
        return this.config.models || [];
      }

      const data = await response.json();
      this.discoveredModels = (data.data || []).map((m: any) => ({
        id: m.id,
        name: m.id,
        contextWindow: m.context_length || 4096,
        capabilities: ['text'],
      }));

      return this.discoveredModels;
    } catch {
      return this.config.models || [];
    }
  }

  async validateCredentials(): Promise<boolean> {
    const apiKey = this.config.apiKey || process.env[`${this.id.toUpperCase()}_API_KEY`];
    if (!apiKey) return false;

    try {
      const response = await fetch(`${this.config.baseUrl}/models`, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          ...this.config.headers,
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  setApiKey(apiKey: string): void {
    this.config.apiKey = apiKey;
  }
}

// ============================================================================
// Pre-configured Providers
// ============================================================================

export function createOpenRouterAdapter(apiKey?: string): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey,
    defaultModel: 'anthropic/claude-3.5-sonnet',
    supportsDiscovery: true,
    headers: {
      'HTTP-Referer': 'https://flowforge.app',
      'X-Title': 'FlowForge',
    },
  });
}

export function createGroqAdapter(apiKey?: string): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey,
    defaultModel: 'llama-3.3-70b-versatile',
    supportsDiscovery: true,
    models: [
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', contextWindow: 128000, capabilities: ['text'] },
      { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B', contextWindow: 128000, capabilities: ['text'] },
      { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B', contextWindow: 32768, capabilities: ['text'] },
      { id: 'gemma2-9b-it', name: 'Gemma 2 9B', contextWindow: 8192, capabilities: ['text'] },
    ],
  });
}

export function createMoonshotAdapter(apiKey?: string): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    id: 'moonshot',
    name: 'Moonshot AI (Kimi)',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKey,
    defaultModel: 'moonshot-v1-128k',
    supportsDiscovery: false,
    models: [
      { id: 'moonshot-v1-8k', name: 'Moonshot v1 8K', contextWindow: 8000, capabilities: ['text'] },
      { id: 'moonshot-v1-32k', name: 'Moonshot v1 32K', contextWindow: 32000, capabilities: ['text'] },
      { id: 'moonshot-v1-128k', name: 'Moonshot v1 128K', contextWindow: 128000, capabilities: ['text'] },
      { id: 'kimi-k2.5', name: 'Kimi K2.5', contextWindow: 128000, capabilities: ['text', 'reasoning'] },
    ],
  });
}

export function createVeniceAdapter(apiKey?: string): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    id: 'venice',
    name: 'Venice AI',
    baseUrl: process.env.VENICE_BASE_URL || 'https://api.venice.ai/api/v1',
    apiKey,
    defaultModel: 'llama-3.3-70b',
    supportsDiscovery: true,
  });
}

export function createTogetherAdapter(apiKey?: string): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    id: 'together',
    name: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    apiKey,
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    supportsDiscovery: true,
  });
}

export function createDeepSeekAdapter(apiKey?: string): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey,
    defaultModel: 'deepseek-chat',
    supportsDiscovery: false,
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: 64000, capabilities: ['text'] },
      { id: 'deepseek-coder', name: 'DeepSeek Coder', contextWindow: 64000, capabilities: ['text', 'code'] },
      { id: 'deepseek-reasoner', name: 'DeepSeek R1', contextWindow: 64000, capabilities: ['text', 'reasoning'] },
    ],
  });
}

export function createXiaoMiAdapter(apiKey?: string): OpenAICompatibleAdapter {
  return new OpenAICompatibleAdapter({
    id: 'xiaomi',
    name: 'Xiaomi MiMo',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    apiKey,
    defaultModel: 'mimo-v2-flash',
    supportsDiscovery: false,
    models: [
      { id: 'mimo-v2-flash', name: 'MiMo v2 Flash', contextWindow: 262144, capabilities: ['text'] },
    ],
  });
}
