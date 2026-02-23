import type { ApiConfig, AuthConfig } from './types.js';

interface TokenData {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

export class RedditClient {
  private baseUrl: string;
  private timeout: number;
  private userAgent: string;
  private accessToken: string;
  private clientId: string;
  private clientSecret: string;
  private username: string;
  private password: string;
  private tokenExpiresAt: number = 0;
  private tokenAcquirePromise: Promise<void> | null = null;

  constructor(apiConfig: ApiConfig, authConfig: AuthConfig) {
    this.baseUrl = apiConfig.base_url.replace(/\/$/, '');
    this.timeout = apiConfig.timeout_ms;
    this.userAgent = apiConfig.user_agent;
    this.accessToken = authConfig.access_token;
    this.clientId = authConfig.client_id;
    this.clientSecret = authConfig.client_secret;
    this.username = authConfig.username;
    this.password = authConfig.password;

    // If we have a manually-provided access token, treat it as valid for now
    // (no expiry tracking for manually-provided tokens)
    if (this.accessToken) {
      this.tokenExpiresAt = Infinity;
    }
  }

  /**
   * Check whether the password grant flow can be used.
   * Requires client_id, client_secret, username, and password.
   */
  private canAcquireToken(): boolean {
    return !!(this.clientId && this.clientSecret && this.username && this.password);
  }

  /**
   * Acquire a new access token via Reddit's OAuth2 password grant.
   * POST https://www.reddit.com/api/v1/access_token
   * Authorization: Basic base64(client_id:client_secret)
   * Body: grant_type=password&username={username}&password={password}
   */
  private async acquireToken(): Promise<void> {
    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

    const body = new URLSearchParams({
      grant_type: 'password',
      username: this.username,
      password: this.password,
    }).toString();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch('https://www.reddit.com/api/v1/access_token', {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': this.userAgent,
        },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const responseBody = await response.text();
        throw new Error(
          `Reddit token acquisition failed ${response.status}: ${response.statusText} — ${responseBody}`
        );
      }

      const data = (await response.json()) as TokenData;

      if (!data.access_token) {
        throw new Error(
          `Reddit token acquisition returned no access_token: ${JSON.stringify(data)}`
        );
      }

      this.accessToken = data.access_token;
      // Set expiry with a 60-second safety margin
      this.tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Token acquisition timed out after ${this.timeout}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Ensure we have a valid access token before making a request.
   * - If a manual token was provided and hasn't expired, use it.
   * - If the password grant credentials are available and the token is
   *   missing or expired, acquire a new one.
   * - Deduplicates concurrent acquisition attempts.
   */
  private async ensureToken(): Promise<void> {
    // Token is still valid
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return;
    }

    // Can we auto-acquire?
    if (!this.canAcquireToken()) {
      return; // No credentials to acquire with; hasAuth() will catch it downstream
    }

    // Deduplicate concurrent requests
    if (!this.tokenAcquirePromise) {
      this.tokenAcquirePromise = this.acquireToken().finally(() => {
        this.tokenAcquirePromise = null;
      });
    }

    await this.tokenAcquirePromise;
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
    await this.ensureToken();

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
    await this.ensureToken();

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
    return this.accessToken.length > 0 || this.canAcquireToken();
  }
}
