/**
 * FlowForge OpenAI OAuth Adapter
 * Supports OpenAI with OAuth/session-based authentication (ChatGPT Plus)
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

export interface OpenAIOAuthConfig {
  /** OAuth access token */
  accessToken?: string;
  /** Refresh token */
  refreshToken?: string;
  /** Token expiry time */
  expiresAt?: number;
  /** Default model */
  defaultModel?: string;
  /** OpenAI organization ID */
  organizationId?: string;
}

// ============================================================================
// OpenAI OAuth Adapter
// ============================================================================

export class OpenAIOAuthAdapter implements LLMProvider {
  id = 'openai-oauth';
  name = 'OpenAI (OAuth)';

  private config: OpenAIOAuthConfig;
  private onTokenRefresh?: (tokens: {
    accessToken: string;
    refreshToken?: string;
    expiresAt: number;
  }) => void;

  constructor(config?: OpenAIOAuthConfig) {
    this.config = {
      defaultModel: 'gpt-4o',
      ...config,
    };
  }

  setTokenRefreshCallback(
    callback: (tokens: { accessToken: string; refreshToken?: string; expiresAt: number }) => void
  ): void {
    this.onTokenRefresh = callback;
  }

  /**
   * Set tokens from OAuth callback
   */
  setTokens(accessToken: string, refreshToken?: string, expiresIn?: number): void {
    this.config.accessToken = accessToken;
    this.config.refreshToken = refreshToken;
    this.config.expiresAt = expiresIn ? Date.now() + expiresIn * 1000 : undefined;

    if (this.onTokenRefresh && this.config.expiresAt) {
      this.onTokenRefresh({
        accessToken,
        refreshToken,
        expiresAt: this.config.expiresAt,
      });
    }
  }

  async complete(params: CompletionParams): Promise<CompletionResult> {
    const model = params.model || this.config.defaultModel!;
    const startTime = Date.now();

    await this.ensureAuth();

    const messages = params.systemPrompt
      ? [{ role: 'system', content: params.systemPrompt }, ...params.messages]
      : params.messages;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: this.buildHeaders(),
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
      throw new Error(`OpenAI error: ${error}`);
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
    const model = params.model || this.config.defaultModel!;

    await this.ensureAuth();

    const messages = params.systemPrompt
      ? [{ role: 'system', content: params.systemPrompt }, ...params.messages]
      : params.messages;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: this.buildHeaders(),
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
      throw new Error(`OpenAI error: ${error}`);
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
    try {
      await this.ensureAuth();

      const response = await fetch('https://api.openai.com/v1/models', {
        headers: this.buildHeaders(),
      });

      if (!response.ok) {
        return this.getDefaultModels();
      }

      const data = await response.json();
      const chatModels = (data.data || []).filter(
        (m: any) => m.id.includes('gpt') || m.id.includes('o1') || m.id.includes('o3')
      );

      return chatModels.map((m: any) => ({
        id: m.id,
        name: m.id,
        contextWindow: this.estimateContextWindow(m.id),
        capabilities: this.inferCapabilities(m.id),
      }));
    } catch {
      return this.getDefaultModels();
    }
  }

  async validateCredentials(): Promise<boolean> {
    if (!this.config.accessToken) {
      return false;
    }

    try {
      await this.ensureAuth();

      const response = await fetch('https://api.openai.com/v1/models', {
        headers: this.buildHeaders(),
      });

      return response.ok;
    } catch {
      return false;
    }
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private async ensureAuth(): Promise<void> {
    if (!this.config.accessToken) {
      throw new Error('No access token configured');
    }

    // Check if token needs refresh
    if (this.config.expiresAt && this.config.refreshToken) {
      const now = Date.now();
      const expiresIn = this.config.expiresAt - now;

      // Refresh if less than 5 minutes remaining
      if (expiresIn < 5 * 60 * 1000) {
        await this.refreshAccessToken();
      }
    }
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.config.refreshToken) {
      throw new Error('No refresh token available');
    }

    // OpenAI doesn't have a standard refresh endpoint for OAuth
    // This is a placeholder for when/if they implement one
    // In practice, users need to re-authenticate

    throw new Error('Token expired. Please re-authenticate.');
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.accessToken}`,
    };

    if (this.config.organizationId) {
      headers['OpenAI-Organization'] = this.config.organizationId;
    }

    return headers;
  }

  private getDefaultModels(): Model[] {
    return [
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        contextWindow: 128000,
        capabilities: ['text', 'vision', 'code'],
      },
      {
        id: 'gpt-4o-mini',
        name: 'GPT-4o Mini',
        contextWindow: 128000,
        capabilities: ['text', 'code'],
      },
      {
        id: 'gpt-4-turbo',
        name: 'GPT-4 Turbo',
        contextWindow: 128000,
        capabilities: ['text', 'vision', 'code'],
      },
      {
        id: 'gpt-4',
        name: 'GPT-4',
        contextWindow: 8192,
        capabilities: ['text', 'code'],
      },
      {
        id: 'gpt-3.5-turbo',
        name: 'GPT-3.5 Turbo',
        contextWindow: 16385,
        capabilities: ['text'],
      },
      {
        id: 'o1-preview',
        name: 'o1 Preview',
        contextWindow: 128000,
        capabilities: ['text', 'code', 'reasoning'],
      },
      {
        id: 'o1-mini',
        name: 'o1 Mini',
        contextWindow: 128000,
        capabilities: ['text', 'code', 'reasoning'],
      },
    ];
  }

  private estimateContextWindow(modelId: string): number {
    if (modelId.includes('128k')) return 128000;
    if (modelId.includes('32k')) return 32768;
    if (modelId.includes('16k')) return 16385;
    if (modelId.includes('gpt-4o') || modelId.includes('o1')) return 128000;
    if (modelId.includes('gpt-4-turbo')) return 128000;
    if (modelId.includes('gpt-4')) return 8192;
    if (modelId.includes('gpt-3.5-turbo')) return 16385;
    return 4096;
  }

  private inferCapabilities(modelId: string): string[] {
    const caps: string[] = ['text'];
    if (modelId.includes('gpt-4o') || modelId.includes('vision')) {
      caps.push('vision');
    }
    if (modelId.includes('gpt-4') || modelId.includes('o1') || modelId.includes('o3')) {
      caps.push('code');
    }
    if (modelId.includes('o1') || modelId.includes('o3')) {
      caps.push('reasoning');
    }
    return caps;
  }
}

// ============================================================================
// Default Instance
// ============================================================================

let defaultAdapter: OpenAIOAuthAdapter | null = null;

export function getOpenAIOAuthAdapter(): OpenAIOAuthAdapter {
  if (!defaultAdapter) {
    defaultAdapter = new OpenAIOAuthAdapter();
  }
  return defaultAdapter;
}
