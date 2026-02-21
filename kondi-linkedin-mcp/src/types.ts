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
