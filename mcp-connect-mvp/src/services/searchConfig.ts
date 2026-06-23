/**
 * Search backend selection. The built-in web search queries a SearXNG instance;
 * this lets the user choose WHERE that instance is:
 *   - 'remote' (default): a SearXNG URL over HTTPS — no Docker, no key, free. Use a
 *     public instance or your own self-hosted one. (Public instances vary in
 *     reliability and some disable the JSON API — switch URL or use 'local' if so.)
 *   - 'local': the bundled SearXNG container via Docker (reliable, but needs Docker).
 *
 * Persisted in localStorage so it survives restarts; read by searchService.
 */
export type SearchBackend = 'remote' | 'local';

export interface SearchConfig {
  backend: SearchBackend;
  /** SearXNG base URL used when backend === 'remote'. */
  remoteUrl: string;
}

const KEY = 'kondi-search-config';
const LOCAL_URL = 'http://localhost:8888';
/** A long-standing public SearXNG instance; users can change it. */
const DEFAULT_REMOTE = 'https://searx.be';

const DEFAULT: SearchConfig = { backend: 'remote', remoteUrl: DEFAULT_REMOTE };

export function getSearchConfig(): SearchConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT };
    const p = JSON.parse(raw) as Partial<SearchConfig>;
    return {
      backend: p.backend === 'local' ? 'local' : 'remote',
      remoteUrl: (p.remoteUrl || DEFAULT_REMOTE).replace(/\/+$/, ''),
    };
  } catch {
    return { ...DEFAULT };
  }
}

export function setSearchConfig(cfg: SearchConfig): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      backend: cfg.backend,
      remoteUrl: (cfg.remoteUrl || DEFAULT_REMOTE).replace(/\/+$/, ''),
    }));
  } catch { /* ignore */ }
}

/** The SearXNG base URL the search MCP server should query, per the current config. */
export function getSearchUrl(): string {
  const c = getSearchConfig();
  return c.backend === 'local' ? LOCAL_URL : c.remoteUrl;
}

/** Whether the current backend needs the local Docker container. */
export function searchNeedsDocker(): boolean {
  return getSearchConfig().backend === 'local';
}

export const SEARCH_LOCAL_URL = LOCAL_URL;
export const SEARCH_DEFAULT_REMOTE = DEFAULT_REMOTE;
