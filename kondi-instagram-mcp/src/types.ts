export interface ApiConfig {
  base_url: string;
  timeout_ms: number;
}

export interface AuthConfig {
  access_token: string;
  ig_user_id: string;
}

export interface ServerConfig {
  transport: 'stdio' | 'sse';
  port: number;
  log_level: 'debug' | 'info' | 'warn' | 'error';
}

export interface Config {
  api: ApiConfig;
  auth: AuthConfig;
  server: ServerConfig;
}

// ── Graph API response types ──────────────────────────────────────

export interface GraphApiError {
  error: {
    message: string;
    type: string;
    code: number;
    error_subcode?: number;
    fbtrace_id?: string;
  };
}

export interface MediaContainerResponse {
  id: string;
}

export interface MediaPublishResponse {
  id: string;
}

export interface MediaItem {
  id: string;
  caption?: string;
  media_type: string;
  media_url?: string;
  timestamp: string;
  permalink?: string;
}

export interface MediaListResponse {
  data: MediaItem[];
  paging?: {
    cursors: {
      before: string;
      after: string;
    };
    next?: string;
  };
}

export interface InsightValue {
  value: number;
}

export interface InsightItem {
  name: string;
  period: string;
  values: InsightValue[];
  title: string;
  description: string;
  id: string;
}

export interface InsightsResponse {
  data: InsightItem[];
}
