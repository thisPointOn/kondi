import type {
  Config,
  GraphApiError,
  MediaContainerResponse,
  MediaPublishResponse,
  MediaListResponse,
  InsightsResponse,
} from './types.js';

export class InstagramClient {
  private baseUrl: string;
  private timeout: number;
  private accessToken: string;
  private igUserId: string;

  constructor(config: Config) {
    this.baseUrl = config.api.base_url.replace(/\/$/, '');
    this.timeout = config.api.timeout_ms;
    this.accessToken = config.auth.access_token;
    this.igUserId = config.auth.ig_user_id;
  }

  /** Return the configured IG user ID (or an override). */
  resolveUserId(override?: string): string {
    const userId = override || this.igUserId;
    if (!userId) {
      throw new Error(
        'Instagram User ID not configured. Set KONDI_INSTAGRAM_USER_ID or pass ig_user_id parameter.'
      );
    }
    return userId;
  }

  /** Ensure an access token is available. */
  private resolveToken(): string {
    if (!this.accessToken) {
      throw new Error(
        'Instagram access token not configured. Set KONDI_INSTAGRAM_ACCESS_TOKEN env var or add it to ~/.config/kondi-instagram/config.json'
      );
    }
    return this.accessToken;
  }

  /** Generic GET request against the Graph API. */
  async get<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const token = this.resolveToken();
    const url = new URL(path, this.baseUrl + '/');
    url.searchParams.set('access_token', token);

    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });

      const data = await response.json();

      if (!response.ok) {
        const err = data as GraphApiError;
        throw new Error(
          `Graph API error ${response.status}: ${err.error?.message || response.statusText}`
        );
      }

      return data as T;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timed out after ${this.timeout}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Generic POST request against the Graph API. */
  async post<T>(path: string, params: Record<string, string> = {}): Promise<T> {
    const token = this.resolveToken();
    const url = new URL(path, this.baseUrl + '/');

    const body = new URLSearchParams({ access_token: token, ...params });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: body.toString(),
        signal: controller.signal,
      });

      const data = await response.json();

      if (!response.ok) {
        const err = data as GraphApiError;
        throw new Error(
          `Graph API error ${response.status}: ${err.error?.message || response.statusText}`
        );
      }

      return data as T;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request timed out after ${this.timeout}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ── Convenience methods ──────────────────────────────────────────

  /**
   * Step 1 of photo publish: create a media container.
   * Returns the creation_id used in step 2.
   */
  async createMediaContainer(
    igUserId: string,
    imageUrl: string,
    caption?: string
  ): Promise<MediaContainerResponse> {
    const params: Record<string, string> = { image_url: imageUrl };
    if (caption) {
      params.caption = caption;
    }
    return this.post<MediaContainerResponse>(`${igUserId}/media`, params);
  }

  /**
   * Step 2 of photo publish: publish the media container.
   * Returns the published media id.
   */
  async publishMedia(
    igUserId: string,
    creationId: string
  ): Promise<MediaPublishResponse> {
    return this.post<MediaPublishResponse>(`${igUserId}/media_publish`, {
      creation_id: creationId,
    });
  }

  /** Get recent media for an IG user. */
  async getMedia(igUserId: string, limit: number = 10): Promise<MediaListResponse> {
    return this.get<MediaListResponse>(`${igUserId}/media`, {
      fields: 'id,caption,media_type,media_url,timestamp,permalink',
      limit: String(limit),
    });
  }

  /** Get insights for a specific media post. */
  async getPostInsights(mediaId: string): Promise<InsightsResponse> {
    return this.get<InsightsResponse>(`${mediaId}/insights`, {
      metric: 'impressions,reach,engagement',
    });
  }

  /** Simple connectivity check against the Graph API. */
  async healthCheck(): Promise<boolean> {
    try {
      if (!this.accessToken || !this.igUserId) {
        return false;
      }
      // Lightweight call: request only the id field
      await this.get<{ id: string }>(this.igUserId, { fields: 'id' });
      return true;
    } catch {
      return false;
    }
  }
}
