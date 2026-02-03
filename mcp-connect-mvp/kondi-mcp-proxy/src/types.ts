/**
 * Proxy configuration types
 */

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  callbackPort: number;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
}

export interface ApiKeyConfig {
  key: string;
  headerName: string;
  headerValuePrefix: string;
}

export interface BearerTokenConfig {
  token: string;
}

export interface CustomHeadersConfig {
  [headerName: string]: string;
}

export type AuthMethod = 'oauth' | 'api_key' | 'bearer_token' | 'custom_header' | 'none';

export interface ProxyConfig {
  id: string;
  name: string;
  remoteUrl: string;
  transport: 'http' | 'sse' | 'stdio';
  localPort: number;
  authMethod: AuthMethod;
  oauth?: OAuthConfig;
  apiKey?: ApiKeyConfig;
  bearerToken?: BearerTokenConfig;
  customHeaders?: CustomHeadersConfig;
}

export type ProxyStatus =
  | 'connected'
  | 'connecting'
  | 'needs_auth'
  | 'needs_reauth'
  | 'authenticating'
  | 'remote_unreachable'
  | 'error';

export interface AuthInfo {
  authenticated: boolean;
  tokenExpiresAt?: number;
  expiresInSeconds?: number;
  lastRefreshAttempt?: string;
  lastRefreshResult?: 'success' | 'failure';
}

export interface HealthResponse {
  status: ProxyStatus;
  serverId: string;
  serverName: string;
  remoteUrl: string;
  authMethod: AuthMethod;
  transport: string;
  toolCount: number;
  lastActivity?: string;
  error?: string;
  auth?: AuthInfo;
}

export interface AuthResponse {
  status: ProxyStatus;
  message: string;
  browserUrl?: string;
}

export interface CheckResponse {
  status: ProxyStatus;
  message: string;
}

export interface McpMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: any;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}
