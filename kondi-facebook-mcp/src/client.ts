import type {
  ApiConfig,
  AuthConfig,
  FacebookCreatePostResponse,
  FacebookDeleteResponse,
  FacebookErrorResponse,
  FacebookPageFeed,
  FacebookPostDetail,
  FacebookCommentList,
  FacebookCreateCommentResponse,
  FacebookPageInfo,
  FacebookReactionList,
  FacebookInsightList,
  FacebookPublishPhotoResponse,
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
   * GET /{post_id}/comments — get comments on a post.
   */
  async getPostComments(postId: string, limit: number = 25): Promise<FacebookCommentList> {
    const token = this.getAccessToken();
    const url = new URL(`${this.baseUrl}/${postId}/comments`);
    url.searchParams.set('access_token', token);
    url.searchParams.set('fields', 'id,message,from,created_time,like_count');
    url.searchParams.set('limit', String(limit));

    const response = await this.request(url.toString(), { method: 'GET' });
    return response as FacebookCommentList;
  }

  /**
   * POST /{comment_id}/comments — reply to a comment.
   */
  async replyToComment(commentId: string, message: string): Promise<FacebookCreateCommentResponse> {
    const token = this.getAccessToken();
    const url = new URL(`${this.baseUrl}/${commentId}/comments`);
    url.searchParams.set('access_token', token);

    const body: Record<string, string> = { message };

    const response = await this.request(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    return response as FacebookCreateCommentResponse;
  }

  /**
   * GET /{page_id} — get detailed page information.
   */
  async getPageInfo(pageId: string): Promise<FacebookPageInfo> {
    const token = this.getAccessToken();
    const url = new URL(`${this.baseUrl}/${pageId}`);
    url.searchParams.set('access_token', token);
    url.searchParams.set('fields', 'id,name,about,category,fan_count,followers_count,website,phone,emails,location,cover,picture');

    const response = await this.request(url.toString(), { method: 'GET' });
    return response as FacebookPageInfo;
  }

  /**
   * GET /{post_id}/reactions — get reactions on a post.
   */
  async getPostReactions(postId: string, limit: number = 25): Promise<FacebookReactionList> {
    const token = this.getAccessToken();
    const url = new URL(`${this.baseUrl}/${postId}/reactions`);
    url.searchParams.set('access_token', token);
    url.searchParams.set('summary', 'true');
    url.searchParams.set('limit', String(limit));

    const response = await this.request(url.toString(), { method: 'GET' });
    return response as FacebookReactionList;
  }

  /**
   * GET /{page_id}/insights — get page analytics/insights.
   */
  async getPageInsights(
    pageId: string,
    period: string = 'day',
    datePreset: string = 'last_7d'
  ): Promise<FacebookInsightList> {
    const token = this.getAccessToken();
    const url = new URL(`${this.baseUrl}/${pageId}/insights`);
    url.searchParams.set('access_token', token);
    url.searchParams.set('metric', 'page_impressions,page_engaged_users,page_fans,page_views_total');
    url.searchParams.set('period', period);
    url.searchParams.set('date_preset', datePreset);

    const response = await this.request(url.toString(), { method: 'GET' });
    return response as FacebookInsightList;
  }

  /**
   * POST /{page_id}/photos — publish a photo to a page.
   */
  async publishPhoto(
    pageId: string,
    photoUrl: string,
    caption?: string
  ): Promise<FacebookPublishPhotoResponse> {
    const token = this.getAccessToken();
    const url = new URL(`${this.baseUrl}/${pageId}/photos`);
    url.searchParams.set('access_token', token);

    const body: Record<string, string> = { url: photoUrl };
    if (caption) {
      body.caption = caption;
    }

    const response = await this.request(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    return response as FacebookPublishPhotoResponse;
  }

  /**
   * GET /{post_id}/insights — get analytics for a specific post.
   */
  async getPostInsights(postId: string): Promise<FacebookInsightList> {
    const token = this.getAccessToken();
    const url = new URL(`${this.baseUrl}/${postId}/insights`);
    url.searchParams.set('access_token', token);
    url.searchParams.set('metric', 'post_impressions,post_engaged_users,post_clicks,post_reactions_by_type_total');

    const response = await this.request(url.toString(), { method: 'GET' });
    return response as FacebookInsightList;
  }

  /**
   * DELETE /{comment_id} — delete a comment.
   */
  async deleteComment(commentId: string): Promise<FacebookDeleteResponse> {
    const token = this.getAccessToken();
    const url = new URL(`${this.baseUrl}/${commentId}`);
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
