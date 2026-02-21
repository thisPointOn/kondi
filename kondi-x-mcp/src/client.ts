import type {
  Config,
  TweetResponse,
  TweetsResponse,
  PostTweetResponse,
  DeleteTweetResponse,
} from './types.js';

export class XClient {
  private baseUrl: string;
  private timeout: number;
  private bearerToken: string;

  constructor(config: Config) {
    this.baseUrl = config.api.base_url.replace(/\/$/, '');
    this.timeout = config.api.timeout_ms;
    this.bearerToken = config.auth.bearer_token;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    if (!this.bearerToken) {
      throw new Error(
        'Bearer token not configured. Set KONDI_X_BEARER_TOKEN environment variable or configure in ~/.config/kondi-x/config.json'
      );
    }

    const url = `${this.baseUrl}${path}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.bearerToken}`,
        'Content-Type': 'application/json',
      };

      const options: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };

      if (body && (method === 'POST')) {
        options.body = JSON.stringify(body);
      }

      const response = await fetch(url, options);

      if (!response.ok) {
        const errorBody = await response.text();
        let errorDetail: string;
        try {
          const parsed = JSON.parse(errorBody);
          errorDetail = parsed.detail || parsed.title || parsed.error || errorBody;
        } catch {
          errorDetail = errorBody;
        }
        throw new Error(`X API ${response.status}: ${errorDetail}`);
      }

      // DELETE responses may have empty body
      if (method === 'DELETE' && response.status === 204) {
        return { data: { deleted: true } } as T;
      }

      const data = await response.json();
      return data as T;
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error(`Request timed out after ${this.timeout}ms`);
        }
        if (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED')) {
          throw new Error(`Could not connect to X API at ${this.baseUrl}`);
        }
        throw error;
      }
      throw new Error('Unknown request error');
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async postTweet(text: string, replyToTweetId?: string): Promise<PostTweetResponse> {
    const body: Record<string, unknown> = { text };
    if (replyToTweetId) {
      body.reply = { in_reply_to_tweet_id: replyToTweetId };
    }
    return this.request<PostTweetResponse>('POST', '/tweets', body);
  }

  async getTweet(tweetId: string, tweetFields?: string): Promise<TweetResponse> {
    const fields = tweetFields || 'text,created_at,author_id,public_metrics';
    return this.request<TweetResponse>('GET', `/tweets/${tweetId}?tweet.fields=${encodeURIComponent(fields)}`);
  }

  async getUserTweets(
    userId: string,
    maxResults: number = 10,
    tweetFields?: string
  ): Promise<TweetsResponse> {
    const fields = tweetFields || 'text,created_at,author_id,public_metrics';
    const params = new URLSearchParams({
      max_results: String(maxResults),
      'tweet.fields': fields,
    });
    return this.request<TweetsResponse>('GET', `/users/${userId}/tweets?${params.toString()}`);
  }

  async searchTweets(
    query: string,
    maxResults: number = 10,
    tweetFields?: string
  ): Promise<TweetsResponse> {
    const fields = tweetFields || 'text,created_at,author_id,public_metrics';
    const params = new URLSearchParams({
      query,
      max_results: String(maxResults),
      'tweet.fields': fields,
    });
    return this.request<TweetsResponse>('GET', `/tweets/search/recent?${params.toString()}`);
  }

  async deleteTweet(tweetId: string): Promise<DeleteTweetResponse> {
    return this.request<DeleteTweetResponse>('DELETE', `/tweets/${tweetId}`);
  }
}
