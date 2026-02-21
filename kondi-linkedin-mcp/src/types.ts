export interface ApiConfig {
  base_url: string;
  timeout_ms: number;
}

export interface AuthConfig {
  access_token: string;
  person_id: string;
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

// --- LinkedIn API response types ---

export interface LinkedInProfile {
  id: string;
  localizedFirstName?: string;
  localizedLastName?: string;
  firstName?: {
    localized: Record<string, string>;
    preferredLocale: { country: string; language: string };
  };
  lastName?: {
    localized: Record<string, string>;
    preferredLocale: { country: string; language: string };
  };
  profilePicture?: {
    displayImage: string;
  };
  vanityName?: string;
}

export interface LinkedInConnection {
  to: string;
  createdAt: number;
}

export interface LinkedInConnectionsResponse {
  elements: LinkedInConnection[];
  paging: {
    count: number;
    start: number;
    total?: number;
  };
}

export interface UgcPostBody {
  author: string;
  lifecycleState: string;
  specificContent: {
    'com.linkedin.ugc.ShareContent': {
      shareCommentary: {
        text: string;
      };
      shareMediaCategory: string;
    };
  };
  visibility: {
    'com.linkedin.ugc.MemberNetworkVisibility': string;
  };
}

export interface UgcPostResponse {
  id: string;
  [key: string]: unknown;
}

export interface LinkedInApiError {
  status: number;
  serviceErrorCode?: number;
  message: string;
}

// --- Posts API types ---

export interface LinkedInPost {
  id?: string;
  author?: string;
  lifecycleState?: string;
  publishedAt?: number;
  createdAt?: number;
  lastModifiedAt?: number;
  visibility?: string;
  commentary?: string;
  content?: unknown;
  distribution?: unknown;
  likeCount?: number;
  commentCount?: number;
  shareCount?: number;
  [key: string]: unknown;
}

export interface LinkedInPostsResponse {
  elements: LinkedInPost[];
  paging: {
    count: number;
    start: number;
    total?: number;
  };
}

// --- Social Actions types ---

export interface LinkedInComment {
  actor?: string;
  created?: { actor?: string; time?: number };
  id?: string;
  message?: { text?: string };
  object?: string;
  parentComment?: string;
  likeCount?: number;
  [key: string]: unknown;
}

export interface LinkedInCommentsResponse {
  elements: LinkedInComment[];
  paging: {
    count: number;
    start: number;
    total?: number;
  };
}

export interface LinkedInLike {
  actor?: string;
  created?: { actor?: string; time?: number };
  object?: string;
  [key: string]: unknown;
}

export interface LinkedInLikesResponse {
  elements: LinkedInLike[];
  paging: {
    count: number;
    start: number;
    total?: number;
  };
}

// --- Organization types ---

export interface LinkedInOrganization {
  id?: number;
  localizedName?: string;
  localizedDescription?: string;
  vanityName?: string;
  logoV2?: unknown;
  industries?: string[];
  staffCountRange?: string;
  websiteUrl?: string;
  foundedOn?: { year?: number };
  specialities?: string[];
  locations?: unknown[];
  [key: string]: unknown;
}
