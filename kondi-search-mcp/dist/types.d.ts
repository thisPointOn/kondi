export interface SearxngConfig {
    url: string;
    timeout_ms: number;
    default_language: string;
    default_categories: string;
    engines: string[];
}
export interface FetchConfig {
    user_agent: string;
    default_timeout_seconds: number;
    max_content_length: number;
    max_body_size_bytes: number;
    rate_limit_per_domain: number;
    blocked_domains: string[];
    follow_redirects: boolean;
    max_redirects: number;
}
export interface ServerConfig {
    transport: 'stdio' | 'sse';
    port: number;
    log_level: 'debug' | 'info' | 'warn' | 'error';
    log_file: string;
}
export interface Config {
    searxng: SearxngConfig;
    fetch: FetchConfig;
    server: ServerConfig;
}
export interface SearchParams {
    query: string;
    count: number;
    categories: string;
    time_range?: string;
    language: string;
}
export interface SearchResult {
    title: string;
    url: string;
    snippet: string;
    source: string;
    published_date: string | null;
}
export interface SearxngResponse {
    results: SearchResult[];
    search_time: number;
}
export interface FetchParams {
    url: string;
    extract_mode: 'text' | 'raw' | 'markdown';
    max_length: number;
    timeout_seconds: number;
}
export interface FetchResult {
    url: string;
    title: string;
    content: string;
    content_type: string;
    extract_mode: string;
    content_length: number;
    truncated: boolean;
    fetched_at: string;
}
export interface ExtractedContent {
    title: string;
    content: string;
    textContent: string;
}
export interface ValidationResult {
    ok: boolean;
    reason?: string;
}
//# sourceMappingURL=types.d.ts.map