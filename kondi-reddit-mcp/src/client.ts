import type { ApiConfig, AuthConfig } from './types.js';

export class RedditClient {
  private baseUrl: string;
  private timeout: number;
  private userAgent: string;
  private accessToken: string;

  constructor(apiConfig: ApiConfig, authConfig: AuthConfig) {
    this.baseUrl = apiConfig.base_url.replace(/\/$/, '');
    this.timeout = apiConfig.timeout_ms;
    this.userAgent = apiConfig.user_agent;
    this.accessToken = authConfig.access_token;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': this.userAgent,
    };

    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }

    return headers;
  }

  async get(path: string, params?: Record<string, string>): Promise<unknown> {
    const url = new URL(path, this.baseUrl);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          ...this.getHeaders(),
          'Accept': 'application/json',
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Reddit API ${response.status}: ${response.statusText} — ${body}`);
      }

      return await response.json();
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error(`Request timed out after ${this.timeout}ms`);
        }
        if (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED')) {
          throw new Error(`Could not connect to Reddit API at ${this.baseUrl}`);
        }
        throw error;
      }
      throw new Error('Unknown request error');
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async postForm(path: string, body: Record<string, string>): Promise<unknown> {
    const url = new URL(path, this.baseUrl);

    const formBody = new URLSearchParams(body).toString();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          ...this.getHeaders(),
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
        body: formBody,
        signal: controller.signal,
      });

      if (!response.ok) {
        const responseBody = await response.text();
        throw new Error(`Reddit API ${response.status}: ${response.statusText} — ${responseBody}`);
      }

      return await response.json();
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error(`Request timed out after ${this.timeout}ms`);
        }
        if (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED')) {
          throw new Error(`Could not connect to Reddit API at ${this.baseUrl}`);
        }
        throw error;
      }
      throw new Error('Unknown request error');
    } finally {
      clearTimeout(timeoutId);
    }
  }

  hasAuth(): boolean {
    return this.accessToken.length > 0;
  }
}
