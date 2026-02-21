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

// ── Profile ──────────────────────────────────────────────────────

export interface ProfileResponse {
  id: string;
  username?: string;
  name?: string;
  biography?: string;
  followers_count?: number;
  follows_count?: number;
  media_count?: number;
  profile_picture_url?: string;
  website?: string;
}

// ── Comments ─────────────────────────────────────────────────────

export interface CommentReply {
  id: string;
  text: string;
  username: string;
  timestamp: string;
}

export interface CommentItem {
  id: string;
  text: string;
  username: string;
  timestamp: string;
  like_count?: number;
  replies?: {
    data: CommentReply[];
  };
}

export interface CommentsResponse {
  data: CommentItem[];
  paging?: {
    cursors: {
      before: string;
      after: string;
    };
    next?: string;
  };
}

export interface CommentPostResponse {
  id: string;
}

// ── Hashtag search ───────────────────────────────────────────────

export interface HashtagSearchResponse {
  data: { id: string }[];
}

export interface HashtagMediaItem {
  id: string;
  caption?: string;
  media_type?: string;
  media_url?: string;
  timestamp?: string;
  permalink?: string;
  like_count?: number;
  comments_count?: number;
}

export interface HashtagMediaResponse {
  data: HashtagMediaItem[];
  paging?: {
    cursors?: {
      before: string;
      after: string;
    };
    next?: string;
  };
}

// ── Stories ───────────────────────────────────────────────────────

export interface StoryItem {
  id: string;
  media_type?: string;
  media_url?: string;
  timestamp?: string;
  caption?: string;
}

export interface StoriesResponse {
  data: StoryItem[];
}

// ── Media detail ─────────────────────────────────────────────────

export interface MediaDetailResponse {
  id: string;
  caption?: string;
  media_type?: string;
  media_url?: string;
  thumbnail_url?: string;
  timestamp?: string;
  permalink?: string;
  like_count?: number;
  comments_count?: number;
  is_shared_to_feed?: boolean;
}
