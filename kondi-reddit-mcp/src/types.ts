export interface ApiConfig {
  base_url: string;
  timeout_ms: number;
  user_agent: string;
}

export interface AuthConfig {
  access_token: string;
  client_id: string;
  client_secret: string;
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

// --- Request params ---

export interface SubmitPostParams {
  subreddit: string;
  title: string;
  text?: string;
  url?: string;
  kind: 'self' | 'link';
}

export interface GetPostsParams {
  subreddit: string;
  limit: number;
}

export interface GetCommentsParams {
  subreddit: string;
  article_id: string;
  limit: number;
}

export interface SubmitCommentParams {
  parent_fullname: string;
  text: string;
}

// --- Response types ---

export interface RedditPost {
  id: string;
  fullname: string;
  title: string;
  author: string;
  subreddit: string;
  score: number;
  upvote_ratio: number;
  num_comments: number;
  created_utc: number;
  url: string;
  permalink: string;
  selftext: string;
  is_self: boolean;
}

export interface RedditComment {
  id: string;
  fullname: string;
  author: string;
  body: string;
  score: number;
  created_utc: number;
  parent_id: string;
  depth: number;
  permalink: string;
}

export interface SubmitResult {
  success: boolean;
  id?: string;
  fullname?: string;
  url?: string;
  errors?: string[];
}
