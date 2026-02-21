import type { ApiConfig, AuthConfig, SlackApiResponse } from './types.js';

export class SlackClient {
  private baseUrl: string;
  private timeout: number;
  private token: string;

  constructor(apiConfig: ApiConfig, authConfig: AuthConfig) {
    this.baseUrl = apiConfig.base_url.replace(/\/$/, '');
    this.timeout = apiConfig.timeout_ms;
    this.token = authConfig.bot_token;
  }

  /**
   * Call a Slack Web API method. All Slack methods use POST with JSON body.
   */
  async call<T extends SlackApiResponse>(method: string, body: Record<string, unknown>): Promise<T> {
    if (!this.token) {
      throw new Error(
        'Slack bot token is not configured. ' +
        'Set KONDI_SLACK_BOT_TOKEN env var or add auth.bot_token to ~/.config/kondi-slack/config.json'
      );
    }

    const url = `${this.baseUrl}/${method}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Slack API HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as T;

      if (!data.ok) {
        throw new Error(`Slack API error: ${data.error || 'unknown_error'}`);
      }

      return data;
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error(`Slack API request timed out after ${this.timeout}ms`);
        }
        if (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED')) {
          throw new Error(`Could not connect to Slack API at ${this.baseUrl}`);
        }
        throw error;
      }
      throw new Error('Unknown Slack API error');
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Verify the bot token works by calling auth.test.
   */
  async authTest(): Promise<boolean> {
    try {
      await this.call('auth.test', {});
      return true;
    } catch {
      return false;
    }
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  hasToken(): boolean {
    return this.token.length > 0;
  }
}
