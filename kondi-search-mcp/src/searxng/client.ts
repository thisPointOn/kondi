import type { SearxngConfig, SearchParams, SearxngResponse, SearchResult } from '../types.js';

export class SearxngClient {
  private baseUrl: string;
  private timeout: number;

  constructor(config: SearxngConfig) {
    this.baseUrl = config.url.replace(/\/$/, '');
    this.timeout = config.timeout_ms;
  }

  async search(params: SearchParams): Promise<SearxngResponse> {
    const url = new URL('/search', this.baseUrl);
    url.searchParams.set('q', params.query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('categories', params.categories);
    url.searchParams.set('language', params.language);

    if (params.time_range) {
      url.searchParams.set('time_range', params.time_range);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(url.toString(), {
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`SearXNG returned ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as {
        results: Array<{
          title: string;
          url: string;
          content?: string;
          engine: string;
          publishedDate?: string;
        }>;
        search_time?: number;
      };

      const results: SearchResult[] = data.results
        .slice(0, params.count)
        .map((r) => ({
          title: r.title || '',
          url: r.url || '',
          snippet: r.content || '',
          source: r.engine || 'unknown',
          published_date: r.publishedDate || null,
        }));

      return {
        results,
        search_time: data.search_time || 0,
      };
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new Error('Search timed out');
        }
        if (error.message.includes('fetch failed') || error.message.includes('ECONNREFUSED')) {
          throw new Error('Search engine unavailable. Is SearXNG running on ' + this.baseUrl + '?');
        }
        throw error;
      }
      throw new Error('Unknown search error');
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const url = new URL('/search', this.baseUrl);
      url.searchParams.set('q', 'test');
      url.searchParams.set('format', 'json');

      const response = await fetch(url.toString(), {
        signal: AbortSignal.timeout(5000),
        headers: {
          Accept: 'application/json',
        },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }
}
