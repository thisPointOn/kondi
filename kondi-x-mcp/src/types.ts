export interface ApiConfig {
  base_url: string;
  timeout_ms: number;
}

export interface AuthConfig {
  bearer_token: string;
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

export interface TweetData {
  id: string;
  text: string;
  created_at?: string;
  author_id?: string;
  public_metrics?: {
    retweet_count: number;
    reply_count: number;
    like_count: number;
    quote_count: number;
    bookmark_count?: number;
    impression_count?: number;
  };
  [key: string]: unknown;
}

export interface TweetResponse {
  data: TweetData;
}

export interface TweetsResponse {
  data: TweetData[];
  meta?: {
    result_count: number;
    newest_id?: string;
    oldest_id?: string;
    next_token?: string;
  };
}

export interface PostTweetResponse {
  data: {
    id: string;
    text: string;
  };
}

export interface DeleteTweetResponse {
  data: {
    deleted: boolean;
  };
}

export interface XApiError {
  title: string;
  detail: string;
  type: string;
  status: number;
}
