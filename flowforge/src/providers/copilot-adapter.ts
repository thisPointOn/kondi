/**
 * FlowForge GitHub Copilot Adapter
 * Uses GitHub Copilot's API with device code authentication
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

export interface CopilotConfig {
  /** OAuth access token */
  accessToken?: string;
  /** Token expiry time */
  expiresAt?: number;
  /** Default model */
  defaultModel?: string;
  /** GitHub username (for identification) */
  githubUser?: string;
}

interface CopilotDeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

// ============================================================================
// Copilot Adapter
// ============================================================================

export class CopilotAdapter implements LLMProvider {
  id = 'copilot';
  name = 'GitHub Copilot';

  private config: CopilotConfig;
  private copilotToken: string | null = null;
  private copilotTokenExpiry: number = 0;
  private onTokenRefresh?: (tokens: { accessToken: string; expiresAt: number }) => void;

  // GitHub OAuth App credentials (Copilot CLI)
  private static readonly CLIENT_ID = 'Iv1.b507a08c87ecfe98';
  private static readonly COPILOT_API = 'https://api.githubcopilot.com';

  constructor(config?: CopilotConfig) {
    this.config = {
      defaultModel: 'gpt-4o',
      ...config,
    };
  }

  setTokenRefreshCallback(
    callback: (tokens: { accessToken: string; expiresAt: number }) => void
  ): void {
    this.onTokenRefresh = callback;
  }

  /**
   * Start device code flow for authentication
   */
  async startDeviceCodeFlow(): Promise<{
    userCode: string;
    verificationUri: string;
    expiresIn: number;
    pollForToken: () => Promise<boolean>;
  }> {
    const response = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: CopilotAdapter.CLIENT_ID,
        scope: 'read:user',
      }),
    });

    if (!response.ok) {
      throw new Error('Failed to start device code flow');
    }

    const data: CopilotDeviceCodeResponse = await response.json();

    const pollForToken = async (): Promise<boolean> => {
      const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          client_id: CopilotAdapter.CLIENT_ID,
          device_code: data.device_code,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });

      const tokenData = await tokenResponse.json();

      if (tokenData.error === 'authorization_pending') {
        return false;
      }

      if (tokenData.error) {
        throw new Error(tokenData.error_description || tokenData.error);
      }

      if (tokenData.access_token) {
        this.config.accessToken = tokenData.access_token;
        this.config.expiresAt = Date.now() + 8 * 60 * 60 * 1000; // 8 hours

        if (this.onTokenRefresh) {
          this.onTokenRefresh({
            accessToken: tokenData.access_token,
            expiresAt: this.config.expiresAt,
          });
        }

        return true;
      }

      return false;
    };

    return {
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      expiresIn: data.expires_in,
      pollForToken,
    };
  }

  async complete(params: CompletionParams): Promise<CompletionResult> {
    const model = params.model || this.config.defaultModel!;
    const startTime = Date.now();

    await this.ensureCopilotToken();

    const messages = params.systemPrompt
      ? [{ role: 'system', content: params.systemPrompt }, ...params.messages]
      : params.messages;

    const response = await fetch(`${CopilotAdapter.COPILOT_API}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.copilotToken}`,
        'Editor-Version': 'vscode/1.85.0',
        'Editor-Plugin-Version': 'copilot-chat/0.12.0',
        'Openai-Organization': 'github-copilot',
        'Copilot-Integration-Id': 'vscode-chat',
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
      throw new Error(`Copilot error: ${error}`);
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

    await this.ensureCopilotToken();

    const messages = params.systemPrompt
      ? [{ role: 'system', content: params.systemPrompt }, ...params.messages]
      : params.messages;

    const response = await fetch(`${CopilotAdapter.COPILOT_API}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.copilotToken}`,
        'Editor-Version': 'vscode/1.85.0',
        'Editor-Plugin-Version': 'copilot-chat/0.12.0',
        'Openai-Organization': 'github-copilot',
        'Copilot-Integration-Id': 'vscode-chat',
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
      throw new Error(`Copilot error: ${error}`);
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
        id: 'claude-3.5-sonnet',
        name: 'Claude 3.5 Sonnet',
        contextWindow: 200000,
        capabilities: ['text', 'vision', 'code'],
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

  async validateCredentials(): Promise<boolean> {
    if (!this.config.accessToken) {
      return false;
    }

    try {
      await this.ensureCopilotToken();
      return !!this.copilotToken;
    } catch {
      return false;
    }
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private async ensureCopilotToken(): Promise<void> {
    if (!this.config.accessToken) {
      throw new Error('No GitHub access token. Use startDeviceCodeFlow() to authenticate.');
    }

    // Check if Copilot token is still valid
    const now = Date.now();
    if (this.copilotToken && this.copilotTokenExpiry > now + 60000) {
      return;
    }

    // Exchange GitHub token for Copilot token
    const response = await fetch('https://api.github.com/copilot_internal/v2/token', {
      headers: {
        'Authorization': `token ${this.config.accessToken}`,
        'Accept': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error('Failed to get Copilot token. Ensure you have an active Copilot subscription.');
    }

    const data = await response.json();
    this.copilotToken = data.token;
    this.copilotTokenExpiry = data.expires_at * 1000; // Convert to ms
  }
}

// ============================================================================
// Default Instance
// ============================================================================

let defaultAdapter: CopilotAdapter | null = null;

export function getCopilotAdapter(): CopilotAdapter {
  if (!defaultAdapter) {
    defaultAdapter = new CopilotAdapter();
  }
  return defaultAdapter;
}
