/**
 * FlowForge Google Gemini Adapter
 * Supports both API key and OAuth authentication
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

export interface GeminiConfig {
  /** API key (for direct API access) */
  apiKey?: string;
  /** OAuth access token (for Gemini CLI auth) */
  accessToken?: string;
  /** OAuth refresh token */
  refreshToken?: string;
  /** Token expiry time */
  expiresAt?: number;
  /** Default model */
  defaultModel?: string;
  /** Project ID (for Vertex AI) */
  projectId?: string;
  /** Region (for Vertex AI) */
  region?: string;
}

interface GeminiMessage {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

// ============================================================================
// Gemini Adapter
// ============================================================================

export class GeminiAdapter implements LLMProvider {
  id = 'gemini';
  name = 'Google Gemini';

  private config: GeminiConfig;
  private onTokenRefresh?: (tokens: { accessToken: string; refreshToken?: string; expiresAt: number }) => void;

  constructor(config?: GeminiConfig) {
    this.config = {
      defaultModel: 'gemini-2.0-flash-exp',
      ...config,
    };
  }

  setTokenRefreshCallback(
    callback: (tokens: { accessToken: string; refreshToken?: string; expiresAt: number }) => void
  ): void {
    this.onTokenRefresh = callback;
  }

  async complete(params: CompletionParams): Promise<CompletionResult> {
    const model = params.model || this.config.defaultModel!;
    const startTime = Date.now();

    // Ensure we have valid auth
    await this.ensureAuth();

    // Build Gemini messages format
    const contents = this.buildContents(params);

    const response = await this.makeRequest(model, {
      contents,
      generationConfig: {
        temperature: params.temperature ?? 0.7,
        maxOutputTokens: params.maxTokens ?? 8192,
        topP: params.topP,
        stopSequences: params.stopSequences,
      },
      systemInstruction: params.systemPrompt
        ? { parts: [{ text: params.systemPrompt }] }
        : undefined,
    });

    const data = await response.json();

    if (data.error) {
      throw new Error(`Gemini error: ${data.error.message}`);
    }

    const candidate = data.candidates?.[0];
    const content = candidate?.content?.parts?.[0]?.text || '';

    return {
      content,
      model,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount || 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount || 0,
      },
      finishReason: candidate?.finishReason || 'STOP',
      latency: Date.now() - startTime,
    };
  }

  async *stream(params: CompletionParams): AsyncIterable<StreamChunk> {
    const model = params.model || this.config.defaultModel!;

    await this.ensureAuth();

    const contents = this.buildContents(params);

    const response = await this.makeRequest(
      model,
      {
        contents,
        generationConfig: {
          temperature: params.temperature ?? 0.7,
          maxOutputTokens: params.maxTokens ?? 8192,
          topP: params.topP,
          stopSequences: params.stopSequences,
        },
        systemInstruction: params.systemPrompt
          ? { parts: [{ text: params.systemPrompt }] }
          : undefined,
      },
      true
    );

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
        if (!line.trim()) continue;

        // Handle SSE format
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') {
            yield { type: 'done', finishReason: 'stop' };
            continue;
          }

          try {
            const parsed = JSON.parse(data);
            const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) {
              yield { type: 'content', content: text };
            }
            if (parsed.candidates?.[0]?.finishReason) {
              yield { type: 'done', finishReason: parsed.candidates[0].finishReason };
            }
          } catch {
            // Try parsing as direct JSON (non-SSE)
            try {
              const parsed = JSON.parse(line);
              const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
              if (text) {
                yield { type: 'content', content: text };
              }
            } catch {
              // Skip
            }
          }
        }
      }
    }
  }

  async listModels(): Promise<Model[]> {
    return [
      {
        id: 'gemini-2.0-flash-exp',
        name: 'Gemini 2.0 Flash',
        contextWindow: 1048576,
        capabilities: ['text', 'vision', 'code'],
      },
      {
        id: 'gemini-1.5-pro',
        name: 'Gemini 1.5 Pro',
        contextWindow: 2097152,
        capabilities: ['text', 'vision', 'code'],
      },
      {
        id: 'gemini-1.5-flash',
        name: 'Gemini 1.5 Flash',
        contextWindow: 1048576,
        capabilities: ['text', 'vision', 'code'],
      },
      {
        id: 'gemini-1.5-flash-8b',
        name: 'Gemini 1.5 Flash 8B',
        contextWindow: 1048576,
        capabilities: ['text'],
      },
      {
        id: 'gemini-exp-1206',
        name: 'Gemini Experimental',
        contextWindow: 2097152,
        capabilities: ['text', 'vision', 'code', 'reasoning'],
      },
    ];
  }

  async validateCredentials(): Promise<boolean> {
    try {
      await this.ensureAuth();
      const models = await this.listModels();
      return models.length > 0;
    } catch {
      return false;
    }
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private async ensureAuth(): Promise<void> {
    // If using API key, nothing to do
    if (this.config.apiKey) return;

    // Check if OAuth token needs refresh
    if (this.config.accessToken && this.config.expiresAt) {
      const now = Date.now();
      const expiresIn = this.config.expiresAt - now;

      // Refresh if less than 5 minutes remaining
      if (expiresIn < 5 * 60 * 1000 && this.config.refreshToken) {
        await this.refreshOAuthToken();
      }
    }

    if (!this.config.apiKey && !this.config.accessToken) {
      throw new Error('No Gemini credentials configured');
    }
  }

  private async refreshOAuthToken(): Promise<void> {
    if (!this.config.refreshToken) {
      throw new Error('No refresh token available');
    }

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.config.refreshToken,
        client_id: process.env.GOOGLE_CLIENT_ID || '',
      }),
    });

    if (!response.ok) {
      throw new Error('Failed to refresh OAuth token');
    }

    const data = await response.json();
    this.config.accessToken = data.access_token;
    this.config.expiresAt = Date.now() + data.expires_in * 1000;

    if (data.refresh_token) {
      this.config.refreshToken = data.refresh_token;
    }

    // Notify callback
    if (this.onTokenRefresh) {
      this.onTokenRefresh({
        accessToken: this.config.accessToken,
        refreshToken: this.config.refreshToken,
        expiresAt: this.config.expiresAt,
      });
    }
  }

  private buildContents(params: CompletionParams): GeminiMessage[] {
    return params.messages.map((msg) => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
    }));
  }

  private async makeRequest(
    model: string,
    body: Record<string, unknown>,
    stream = false
  ): Promise<Response> {
    const method = stream ? 'streamGenerateContent' : 'generateContent';
    let url: string;
    let headers: Record<string, string>;

    if (this.config.apiKey) {
      // Direct API with key
      url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${method}?key=${this.config.apiKey}`;
      headers = { 'Content-Type': 'application/json' };
    } else if (this.config.accessToken) {
      // OAuth access
      url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${method}`;
      headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.accessToken}`,
      };
    } else {
      throw new Error('No authentication configured');
    }

    if (stream) {
      url += url.includes('?') ? '&alt=sse' : '?alt=sse';
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Gemini API error: ${error}`);
    }

    return response;
  }
}

// ============================================================================
// Default Instance
// ============================================================================

let defaultAdapter: GeminiAdapter | null = null;

export function getGeminiAdapter(): GeminiAdapter {
  if (!defaultAdapter) {
    defaultAdapter = new GeminiAdapter({
      apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
    });
  }
  return defaultAdapter;
}
