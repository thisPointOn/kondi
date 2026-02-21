import type {
  ApiConfig,
  AuthConfig,
  FacebookCreatePostResponse,
  FacebookDeleteResponse,
  FacebookErrorResponse,
  FacebookPageFeed,
  FacebookPostDetail,
} from './types.js';

export class FacebookClient {
  private baseUrl: string;
  private timeout: number;
  private accessToken: string;
  private defaultPageId: string;

  constructor(apiConfig: ApiConfig, authConfig: AuthConfig) {
    this.baseUrl = apiConfig.base_url.replace(/\/$/, '');
    this.timeout = apiConfig.timeout_ms;
    this.accessToken = authConfig.page_access_token;
    this.defaultPageId = authConfig.page_id;
  }

  private getAccessToken(): string {
    if (!this.accessToken) {
      throw new Error(
        'No page access token configured. Set KONDI_FACEBOOK_PAGE_ACCESS_TOKEN or add auth.page_access_token to ~/.config/kondi-facebook/config.json'
      );
    }
    return this.accessToken;
  }

  getDefaultPageId(): string {
    return this.defaultPageId;
  }

  /**
   * POST /{page_id}/feed — publish a post to a page's feed.
   */
  async createPost(
    pageId: string,
    message: string,
    link?: string
  ): Promise<FacebookCreatePostResponse> {
    const token = this.getAccessToken();
    const url = new URL(`${this.baseUrl}/${pageId}/feed`);
    url.searchParams.set('access_token', token);

    const body: Record<string, string> = { message };
    if (link) {
      body.link = link;
    }

    const response = await this.request(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    return response as FacebookCreatePostResponse;
  }

  /**
   * GET /{page_id}/feed — retrieve recent posts from a page.
   */
  async getPagePosts(pageId: string, limit: number = 10): Promise<FacebookPageFeed> {
    const token = this.getAccessToken();
    const url = new URL(`${this.baseUrl}/${pageId}/feed`);
    url.searchParams.set('access_token', token);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('fields', 'id,message,created_time,story,full_picture,permalink_url');

    const response = await this.request(url.toString(), { method: 'GET' });
    return response as FacebookPageFeed;
  }

  /**
   * GET /{post_id} — get details for a single post.
   */
  async getPost(postId: string): Promise<FacebookPostDetail> {
    const token = this.getAccessToken();
    const url = new URL(`${this.baseUrl}/${postId}`);
    url.searchParams.set('access_token', token);
    url.searchParams.set('fields', 'id,message,created_time,likes.summary(true)');

    const response = await this.request(url.toString(), { method: 'GET' });
    return response as FacebookPostDetail;
  }

  /**
   * DELETE /{post_id} — delete a post.
   */
  async deletePost(postId: string): Promise<FacebookDeleteResponse> {
    const token = this.getAccessToken();
    const url = new URL(`${this.baseUrl}/${postId}`);
    url.searchParams.set('access_token', token);

    const response = await this.request(url.toString(), { method: 'DELETE' });
    return response as FacebookDeleteResponse;
  }

  /**
   * Verify the access token is valid by requesting /me.
   */
  async healthCheck(): Promise<boolean> {
    if (!this.accessToken) {
      return false;
    }

    try {
      const url = new URL(`${this.baseUrl}/me`);
      url.searchParams.set('access_token', this.accessToken);

      const response = await fetch(url.toString(), {
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  // ----- internal helpers -----

  private async request(url: string, init: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });

      const data = await response.json();

      if (!response.ok) {
        const fbError = data as FacebookErrorResponse;
        if (fbError.error) {
          throw new Error(
            `Facebook API error ${fbError.error.code}: ${fbError.error.message} (type: ${fbError.error.type})`
          );
        }
        throw new Error(`Facebook API returned HTTP ${response.status}: ${response.statusText}`);
      }

      return data;
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error('Facebook API request timed out');
        }
        if (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED')) {
          throw new Error('Could not connect to Facebook Graph API at ' + this.baseUrl);
        }
        throw error;
      }
      throw new Error('Unknown Facebook API error');
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
