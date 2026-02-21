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

// ----- Comment types -----

export interface FacebookComment {
  id: string;
  message?: string;
  from?: {
    name: string;
    id: string;
  };
  created_time?: string;
  like_count?: number;
}

export interface FacebookCommentList {
  data: FacebookComment[];
  paging?: {
    cursors?: {
      before: string;
      after: string;
    };
    next?: string;
  };
}

export interface FacebookCreateCommentResponse {
  id: string;
}

// ----- Page info types -----

export interface FacebookPageInfo {
  id: string;
  name?: string;
  about?: string;
  category?: string;
  fan_count?: number;
  followers_count?: number;
  website?: string;
  phone?: string;
  emails?: string[];
  location?: {
    city?: string;
    country?: string;
    latitude?: number;
    longitude?: number;
    state?: string;
    street?: string;
    zip?: string;
  };
  cover?: {
    id: string;
    source: string;
    offset_x: number;
    offset_y: number;
  };
  picture?: {
    data: {
      url: string;
      is_silhouette: boolean;
    };
  };
}

// ----- Reaction types -----

export interface FacebookReaction {
  id: string;
  name?: string;
  type?: string;
}

export interface FacebookReactionList {
  data: FacebookReaction[];
  paging?: {
    cursors?: {
      before: string;
      after: string;
    };
    next?: string;
  };
  summary?: {
    total_count: number;
  };
}

// ----- Insights types -----

export interface FacebookInsightValue {
  value: number | Record<string, number>;
  end_time?: string;
}

export interface FacebookInsight {
  id: string;
  name: string;
  period: string;
  title: string;
  description: string;
  values: FacebookInsightValue[];
}

export interface FacebookInsightList {
  data: FacebookInsight[];
  paging?: {
    previous?: string;
    next?: string;
  };
}

// ----- Photo types -----

export interface FacebookPublishPhotoResponse {
  id: string;
  post_id?: string;
}
