export interface ApiConfig {
  base_url: string;
  timeout_ms: number;
}

export interface AuthConfig {
  page_access_token: string;
  page_id: string;
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

// ----- Graph API response types -----

export interface FacebookPost {
  id: string;
  message?: string;
  created_time?: string;
  story?: string;
  full_picture?: string;
  permalink_url?: string;
}

export interface FacebookPostDetail {
  id: string;
  message?: string;
  created_time?: string;
  likes?: {
    summary: {
      total_count: number;
      can_like: boolean;
      has_liked: boolean;
    };
  };
}

export interface FacebookPageFeed {
  data: FacebookPost[];
  paging?: {
    cursors?: {
      before: string;
      after: string;
    };
    next?: string;
  };
}

export interface FacebookCreatePostResponse {
  id: string;
}

export interface FacebookDeleteResponse {
  success: boolean;
}

export interface FacebookErrorResponse {
  error: {
    message: string;
    type: string;
    code: number;
    fbtrace_id?: string;
  };
}
