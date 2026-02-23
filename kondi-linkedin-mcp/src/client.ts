import type { ApiConfig, AuthConfig, LinkedInApiError } from './types.js';

export class LinkedInClient {
  private baseUrl: string;
  private timeout: number;
  private accessToken: string;

  constructor(apiConfig: ApiConfig, authConfig: AuthConfig) {
    this.baseUrl = apiConfig.base_url.replace(/\/$/, '');
    this.timeout = apiConfig.timeout_ms;
    this.accessToken = authConfig.access_token;
  }

  private getHeaders(extraHeaders?: Record<string, string>): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.accessToken}`,
      'LinkedIn-Version': '202401',
      'X-Restli-Protocol-Version': '2.0.0',
      'Content-Type': 'application/json',
      ...extraHeaders,
    };
  }

  async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(path, this.baseUrl + '/');
    // Fix double-slash: the URL constructor with a base that has a trailing slash
    // and a path that starts with / will resolve correctly
    const fullUrl = `${this.baseUrl}${path.startsWith('/') ? path : '/' + path}`;
    const parsedUrl = new URL(fullUrl);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        parsedUrl.searchParams.set(key, value);
      }
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(parsedUrl.toString(), {
        method: 'GET',
        headers: this.getHeaders(),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        let apiError: LinkedInApiError;
        try {
          apiError = JSON.parse(errorBody) as LinkedInApiError;
        } catch {
          apiError = { status: response.status, message: errorBody || response.statusText };
        }
        throw new LinkedInRequestError(
          `LinkedIn API error ${response.status}: ${apiError.message}`,
          response.status,
          apiError
        );
      }

      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof LinkedInRequestError) throw error;
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new LinkedInRequestError('Request timed out', 408);
        }
        if (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED')) {
          throw new LinkedInRequestError(
            `Could not connect to LinkedIn API at ${this.baseUrl}`,
            0
          );
        }
        throw new LinkedInRequestError(error.message, 0);
      }
      throw new LinkedInRequestError('Unknown request error', 0);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const fullUrl = `${this.baseUrl}${path.startsWith('/') ? path : '/' + path}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(fullUrl, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        let apiError: LinkedInApiError;
        try {
          apiError = JSON.parse(errorBody) as LinkedInApiError;
        } catch {
          apiError = { status: response.status, message: errorBody || response.statusText };
        }
        throw new LinkedInRequestError(
          `LinkedIn API error ${response.status}: ${apiError.message}`,
          response.status,
          apiError
        );
      }

      // Some LinkedIn endpoints return 201 with a header but no JSON body
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        return (await response.json()) as T;
      }

      // For 201 Created, the ID is often in the x-restli-id header
      const restliId = response.headers.get('x-restli-id');
      return { id: restliId || '', status: response.status } as T;
    } catch (error) {
      if (error instanceof LinkedInRequestError) throw error;
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new LinkedInRequestError('Request timed out', 408);
        }
        if (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED')) {
          throw new LinkedInRequestError(
            `Could not connect to LinkedIn API at ${this.baseUrl}`,
            0
          );
        }
        throw new LinkedInRequestError(error.message, 0);
      }
      throw new LinkedInRequestError('Unknown request error', 0);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async delete(path: string): Promise<void> {
    const fullUrl = `${this.baseUrl}${path.startsWith('/') ? path : '/' + path}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(fullUrl, {
        method: 'DELETE',
        headers: this.getHeaders(),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        let apiError: LinkedInApiError;
        try {
          apiError = JSON.parse(errorBody) as LinkedInApiError;
        } catch {
          apiError = { status: response.status, message: errorBody || response.statusText };
        }
        throw new LinkedInRequestError(
          `LinkedIn API error ${response.status}: ${apiError.message}`,
          response.status,
          apiError
        );
      }
    } catch (error) {
      if (error instanceof LinkedInRequestError) throw error;
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new LinkedInRequestError('Request timed out', 408);
        }
        if (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED')) {
          throw new LinkedInRequestError(
            `Could not connect to LinkedIn API at ${this.baseUrl}`,
            0
          );
        }
        throw new LinkedInRequestError(error.message, 0);
      }
      throw new LinkedInRequestError('Unknown request error', 0);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  hasToken(): boolean {
    return this.accessToken.length > 0;
  }
}

export class LinkedInRequestError extends Error {
  public readonly statusCode: number;
  public readonly apiError?: LinkedInApiError;

  constructor(message: string, statusCode: number, apiError?: LinkedInApiError) {
    super(message);
    this.name = 'LinkedInRequestError';
    this.statusCode = statusCode;
    this.apiError = apiError;
  }
}
