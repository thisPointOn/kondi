import type { ApiConfig, AuthConfig, TelegramResponse } from './types.js';

export class TelegramClient {
  private baseUrl: string;
  private token: string;
  private timeout: number;

  constructor(apiConfig: ApiConfig, authConfig: AuthConfig) {
    this.baseUrl = apiConfig.base_url.replace(/\/$/, '');
    this.token = authConfig.bot_token;
    this.timeout = apiConfig.timeout_ms;
  }

  /**
   * Call a Telegram Bot API method.
   * All Telegram Bot API calls are POST to {base_url}/bot{token}/{method} with JSON body.
   */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<TelegramResponse<T>> {
    if (!this.token) {
      throw new Error(
        'Bot token is not configured. Set KONDI_TELEGRAM_BOT_TOKEN environment variable or add auth.bot_token to ~/.config/kondi-telegram/config.json'
      );
    }

    const url = `${this.baseUrl}/bot${this.token}/${method}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      // Filter out undefined values from params
      const body: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          body[key] = value;
        }
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const data = (await response.json()) as TelegramResponse<T>;

      if (!data.ok) {
        throw new Error(
          `Telegram API error ${data.error_code || response.status}: ${data.description || response.statusText}`
        );
      }

      return data;
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error(`Telegram API request timed out after ${this.timeout}ms`);
        }
        if (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED')) {
          throw new Error(`Could not connect to Telegram API at ${this.baseUrl}`);
        }
        throw error;
      }
      throw new Error('Unknown Telegram API error');
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Health check: call getMe to verify the bot token is valid.
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.call('getMe');
      return response.ok;
    } catch {
      return false;
    }
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }
}
